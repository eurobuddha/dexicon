/**
 * maker — MY orders: the kv-backed model shared by the page (which creates/edits/cancels) and the service
 * (which co-signs fills, republishes on coin changes and refreshes expiry). Backing coins are selected from the
 * wallet's state-free, unspent coins of the token the order gives away (sell → MINIMA, buy → MxUSD).
 * Rhino-safe (ES5). Requires AX.mds, AX.fill, AX.envelope, AX.relay. Attaches to AX.maker.
 *
 * kv 'myorders' = JSON array of { orderId, side, price, amount, remaining, coins:[coinid], address, seq, expiry, status }
 *   status: 'live' | 'cancelled' | 'filled'. seq increases on every republish (edit, cancel, refresh, coin change).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var F = AX.fill, E = AX.envelope;
    var MARKET = 'MINIMA/MxUSD', EXPIRY_SECONDS = 23 * 3600, MAX_COINS = 32;

    function now() { return Math.floor(Date.now() / 1000); }
    function nextSeq(o) { var s = now(); return s > (o.seq || 0) ? s : (o.seq || 0) + 1; }

    function load(mds, cb) {
        mds.kvGet('myorders', '[]', function (v) {   // mdsw.kvGet calls back with the VALUE only
            var list = []; try { list = JSON.parse(v || '[]'); } catch (e) { list = []; }
            cb(null, list);
        });
    }
    function save(mds, list, cb) { mds.kvSet('myorders', JSON.stringify(list), function (err) { cb(err); }); }

    /** Spendable, state-free, unspent coins of one token (relevant:true = mine). cb(err, coins). */
    function walletCoins(mds, tokenid, cb) {
        mds.cmdR('coins relevant:true tokenid:' + tokenid, function (err, r) {
            if (err) return cb(err);
            var rows = Object.prototype.toString.call(r) === '[object Array]' ? r : [];
            var out = [];
            for (var i = 0; i < rows.length; i++) {
                var c = rows[i];
                if (!c || c.spent === true || (c.state && c.state.length) || String(c.tokenid).toLowerCase() !== tokenid.toLowerCase()) continue;
                out.push(c);
            }
            cb(null, out);
        });
    }

    /** Coins a maker needs to back `side`/`price`/`amount`, excluding coins already backing other live orders. */
    function backing(side, price, amount, coins, excludeIds) {
        var give = side === 'sell' ? F.d(amount) : F.up8(F.d(amount).times(F.d(price)));
        var ex = {}; for (var i = 0; i < (excludeIds || []).length; i++) ex[String(excludeIds[i]).toLowerCase()] = true;
        var free = coins.filter(function (c) { return !ex[String(c.coinid).toLowerCase()]; });
        var p = F.pick(free, give, MAX_COINS);
        if (!p) throw new Error('not enough free ' + (side === 'sell' ? 'MINIMA' : 'MxUSD') + ' coins to back ' + F.plain(give) + (side === 'sell' ? ' MINIMA' : ' MxUSD'));
        return p.coins.map(function (c) { return c.coinid; });
    }

    function coinsBackingOthers(list, exceptId) {
        var ids = [];
        for (var i = 0; i < list.length; i++) if (list[i].status === 'live' && list[i].orderId !== exceptId) ids = ids.concat(list[i].coins || []);
        return ids;
    }

    function envelopeFor(me, o) {
        return E.order(me, { market: MARKET, side: o.side, price: o.price, amount: o.status === 'live' ? o.remaining : '0',
                             coins: o.status === 'live' ? o.coins : [], address: o.address, orderId: o.orderId, seq: o.seq, expiry: o.expiry });
    }

    /** Publish one order's current state to the relays and persist. cb(err, results). */
    function publish(mds, relay, me, o, cb) {
        var raw;
        try { raw = envelopeFor(me, o); } catch (e) { return cb(e); }
        relay.publish(raw, function (results) {
            var ok = 0; for (var i = 0; i < results.length; i++) if (results[i].ok) ok++;
            cb(ok ? null : new Error('no relay accepted the order' + (results.length ? ': ' + results[0].error : ' (no relays)')), results);
        });
    }

    /** Create: select backing coins, sign, publish, save. cb(err, order). */
    function create(mds, relay, me, params, cb) {
        var side = params.side, price = F.plain(F.d(params.price)), amount = F.plain(F.down8(F.d(params.amount)));
        if (side !== 'buy' && side !== 'sell') return cb(new Error('side must be buy or sell'));
        if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(price) || F.d(price).lte(0)) return cb(new Error('price must be a positive decimal with at most 8 dp'));
        if (F.d(amount).lte(0)) return cb(new Error('amount must be positive'));
        load(mds, function (e0, list) {
            mds.cmdR('getaddress', function (e1, addr) {
                if (e1 || !addr || !addr.address) return cb(e1 || new Error('getaddress failed'));
                walletCoins(mds, side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, coins) {
                    if (e2) return cb(e2);
                    var ids;
                    try { ids = backing(side, price, amount, coins, coinsBackingOthers(list, null)); } catch (e) { return cb(e); }
                    var bytes = new Uint8Array(8);
                    fillRandom(bytes);
                    var o = { orderId: '0x' + AX.hex.to(bytes), side: side, price: price, amount: amount, remaining: amount, coins: ids,
                              address: addr.address, seq: now(), expiry: now() + EXPIRY_SECONDS, status: 'live', created: now() };
                    publish(mds, relay, me, o, function (e3, results) {
                        if (e3) return cb(e3);
                        list.push(o);
                        save(mds, list, function (e4) { cb(e4, o, results); });
                    });
                });
            });
        });
    }
    /** orderId only needs uniqueness, not secrecy: browser CSPRNG when present, else Math.random (Rhino). */
    function fillRandom(u8) {
        if (g.crypto && g.crypto.getRandomValues) { g.crypto.getRandomValues(u8); return; }
        for (var i = 0; i < u8.length; i++) u8[i] = Math.floor(Math.random() * 256);
    }

    /** Cancel: amount 0 with a higher seq, publish, mark cancelled. */
    function cancel(mds, relay, me, orderId, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o) return cb(new Error('unknown order'));
            o.status = 'cancelled'; o.seq = nextSeq(o); o.expiry = now() + 600;
            publish(mds, relay, me, o, function (e1) { save(mds, list, function (e2) { cb(e1 || e2, o); }); });
        });
    }

    /** Edit price and/or amount: re-select backing, higher seq, publish. */
    function edit(mds, relay, me, orderId, params, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o || o.status !== 'live') return cb(new Error('order is not live'));
            var price = params.price !== undefined ? F.plain(F.d(params.price)) : o.price;
            var amount = params.amount !== undefined ? F.plain(F.down8(F.d(params.amount))) : o.remaining;
            if (F.d(price).lte(0) || F.d(amount).lte(0)) return cb(new Error('price and amount must be positive'));
            walletCoins(mds, o.side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, coins) {
                if (e2) return cb(e2);
                var ids;
                try { ids = backing(o.side, price, amount, coins, coinsBackingOthers(list, orderId)); } catch (e) { return cb(e); }
                o.price = price; o.amount = amount; o.remaining = amount; o.coins = ids; o.seq = nextSeq(o); o.expiry = now() + EXPIRY_SECONDS;
                publish(mds, relay, me, o, function (e3) { save(mds, list, function (e4) { cb(e3 || e4, o); }); });
            });
        });
    }

    /**
     * After a fill the maker signed: reduce remaining, drop the spent coins (the change coin joins once it
     * confirms, via refresh), republish or mark filled. cb(err, order).
     */
    function afterFill(mds, relay, me, orderId, filled, spentCoinIds, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o) return cb(new Error('unknown order'));
            var rem = F.d(o.remaining).minus(F.d(filled));
            var spent = {}; for (var i = 0; i < spentCoinIds.length; i++) spent[String(spentCoinIds[i]).toLowerCase()] = true;
            o.coins = (o.coins || []).filter(function (c) { return !spent[String(c).toLowerCase()]; });
            o.remaining = rem.gt(0) ? F.plain(rem) : '0';
            if (rem.lte(0) || !o.coins.length) { o.status = rem.lte(0) ? 'filled' : 'live'; }
            o.seq = nextSeq(o);
            if (o.status === 'filled') { o.expiry = now() + 600; }
            publish(mds, relay, me, o, function (e1) { save(mds, list, function (e2) { cb(e1 || e2, o); }); });
        });
    }

    /**
     * Periodic refresh (service): for every live order make sure its coins still exist unspent and cover the
     * remaining amount (re-select if not), and republish when coins changed or expiry is within 2 hours.
     * cb(err, republishedCount).
     */
    function refresh(mds, relay, me, cb) {
        load(mds, function (e0, list) {
            var live = list.filter(function (o) { return o.status === 'live'; });
            if (!live.length) return cb(null, 0);
            var byTok = { sell: null, buy: null }, n = 0, changed = false;
            walletCoins(mds, F.MINIMA, function (eA, minima) {
                walletCoins(mds, F.MXUSD, function (eB, mxusd) {
                    if (eA || eB) return cb(eA || eB);
                    byTok.sell = minima || []; byTok.buy = mxusd || [];
                    var i = 0;
                    function step() {
                        if (i >= live.length) return save(mds, list, function (e) { cb(e, n); });
                        var o = live[i++];
                        var have = {}; byTok[o.side].forEach(function (c) { have[String(c.coinid).toLowerCase()] = true; });
                        var stillThere = (o.coins || []).every(function (c) { return have[String(c).toLowerCase()]; });
                        var covers = false;
                        try { var cov = F.pick(byTok[o.side].filter(function (c) { return (o.coins || []).indexOf(c.coinid) >= 0; }), o.side === 'sell' ? F.d(o.remaining) : F.up8(F.d(o.remaining).times(F.d(o.price))), MAX_COINS); covers = !!cov; } catch (e) { covers = false; }
                        var needRepub = !stillThere || !covers || (o.expiry - now() < 2 * 3600);
                        if (!stillThere || !covers) {
                            try { o.coins = backing(o.side, o.price, o.remaining, byTok[o.side], coinsBackingOthers(list, o.orderId)); }
                            catch (e) { o.status = 'cancelled'; o.remaining = o.remaining; }   // cannot back it any more → withdraw
                        }
                        if (!needRepub) return step();
                        o.seq = nextSeq(o); o.expiry = now() + (o.status === 'live' ? EXPIRY_SECONDS : 600);
                        publish(mds, relay, me, o, function () { n++; step(); });
                    }
                    step();
                });
            });
        });
    }

    function find(list, orderId) { for (var i = 0; i < list.length; i++) if (list[i].orderId === orderId) return list[i]; return null; }

    AX.maker = { MARKET: MARKET, load: load, save: save, walletCoins: walletCoins, backing: backing, envelopeFor: envelopeFor,
                 publish: publish, create: create, cancel: cancel, edit: edit, afterFill: afterFill, refresh: refresh, find: find };
})(typeof globalThis !== 'undefined' ? globalThis : this);
