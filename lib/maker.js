/**
 * maker — MY orders: the kv-backed model shared by the page (which creates/edits/cancels) and the service
 * (which co-signs fills, republishes on coin changes and refreshes expiry). Backing coins are selected from the
 * wallet's state-free, unspent coins of the token the order gives away (sell → MINIMA, buy → MxUSD).
 * Rhino-safe (ES5). Requires AX.mds, AX.fill, AX.envelope, AX.relay. Attaches to AX.maker.
 *
 * kv 'myorders' = JSON array of { orderId, side, price, amount, remaining, coins:[coinid], address, seq, expiry, status }
 *   status: 'live' | 'cancelled' | 'filled'. seq increases on every republish (edit, cancel, refresh, coin change).
 *   relocking:[coinid] = coins being refreshed by a self-send for this order (it is published coinless meanwhile);
 *   relockError = why the last relock of them failed (refresh retries it; the order stays coinless until it works).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var F = AX.fill, E = AX.envelope;
    // owner 7 Nov, the maker heartbeat (mirror of APK 0.2.77): orders live 60 min and are re-signed once under 50 min remain,
    // so a silent maker drops off every relay within 60 min; takers hide orders not re-signed in 65 min (relay.js LIVE_SECONDS)
    var MARKET = 'MINIMA/MxUSD', EXPIRY_SECONDS = 60 * 60, REFRESH_BEFORE_SECONDS = 50 * 60, MAX_COINS = 32;
    /** A light-node taker proves a coin only inside its chain window. Backing coins older than this are re-locked by a
     *  self-send before they fall out of every taker's view. kv 'coin_max_age' overrides, lower only: a saved value above
     *  it is read as COIN_MAX_AGE (maxAgeOf).
     *  0.0.101 (owner 22 Nov 2026: 500 is too low): 900. MEASURED 22 Nov on a light node of this family (-isclient -mobile,
     *  minima-core fork, GlobalParams MINIMA_CASCADE_START_DEPTH 1024): tip 2433919, cascade start 2432821, so 1098 blocks
     *  of chain held, and a coin created 2193 blocks back was not visible; upstream classic Minima holds 2048. The smallest
     *  taker window is therefore ~1024 blocks. 900 leaves 124 blocks (~1.7 h) for a take on a coin at the limit to be
     *  built, co-signed and mined before the coin leaves that window. */
    var COIN_MAX_AGE = 900;
    var WHY_MAX_AGE = 'a light node cannot take an order backed by a coin older than its chain window';
    /** The saved BACKING COIN MAX AGE as used: 1..COIN_MAX_AGE blocks; empty, 0 or junk → COIN_MAX_AGE. */
    function maxAgeOf(v) { var m = parseInt(v, 10); return m > 0 ? Math.min(m, COIN_MAX_AGE) : COIN_MAX_AGE; }
    /** A remainder under 1 MINIMA after a fill is dust nobody can usefully take: the order closes instead of dangling
     *  on every relay (owner, 2026-10-22). Takers also lift a whole order rather than leave less than this behind. */
    var DUST = '1';
    function dust(remaining, amount) { var r = F.d(remaining); return r.gt(0) && r.lt(F.d(DUST)) && r.lt(F.d(amount)); }

    function now() { return Math.floor(Date.now() / 1000); }
    function nextSeq(o) { var s = now(); return s > (o.seq || 0) ? s : (o.seq || 0) + 1; }

    function parseList(v) { try { var l = JSON.parse(v || '[]'); return Object.prototype.toString.call(l) === '[object Array]' ? l : []; } catch (e) { return []; } }
    /** The list, plus list._base: a copy of what was loaded (an array's named property is not serialised), so save()
     *  can tell which orders THIS caller changed. */
    function load(mds, cb) {
        mds.kvGet('myorders', '[]', function (v) {   // mdsw.kvGet calls back with the VALUE only
            var list = parseList(v); list._base = parseList(v);
            cb(null, list);
        });
    }
    /** Review 22 Nov (M4): the page and the service each load the list, wait on relays, then saved the WHOLE list, so the
     *  later save wiped the other's work (a cancel made during a refresh was undone; an order created during one vanished).
     *  save() re-reads the stored list and merges PER ORDER: an order this caller did not change keeps the stored copy;
     *  a new one is added; one changed here AND moved in the store since load (status or seq) is a conflict — a user
     *  action (`mine`: create / cancel / edit) wins, a background pass (refresh, afterFill, the ladder batch, the relay
     *  sync) loses. Either way the winner's seq is raised above the loser's, and the winner is returned in `bumped` to
     *  be published again (the loser may already have reached a relay at its seq). cb(err, bumped). */
    function save(mds, list, cb, mine) {
        var base = list._base;
        if (!base) return mds.kvSet('myorders', JSON.stringify(list), function (err) { cb(err, []); });   // not from load(): as before
        mds.kvGet('myorders', '[]', function (v) {
            var out = parseList(v), bumped = [];
            list.forEach(function (o) {
                var b = find(base, o.orderId), c = find(out, o.orderId);
                if (!c) { if (!b) out.push(o); return; }                        // new here → added; gone from the store → stays gone
                if (b && JSON.stringify(b) === JSON.stringify(o)) return;      // not changed by this caller: the stored copy stands
                if (b && c.status === b.status && c.seq === b.seq) { out[out.indexOf(c)] = o; return; }
                var win = mine ? o : c, lose = mine ? c : o;
                if (win.seq <= lose.seq) { win.seq = lose.seq + 1; bumped.push(win); }
                out[out.indexOf(c)] = win;
            });
            mds.kvSet('myorders', JSON.stringify(out), function (err) { list._base = parseList(JSON.stringify(out)); cb(err, bumped); });
        });
    }
    /** save(), then publish every order it raised above a conflicting copy (a failed publish is re-sent by syncRelays,
     *  which sees the relay hold a lower seq). cb(err). */
    function commit(mds, relay, me, list, mine, cb) {
        save(mds, list, function (err, bumped) {
            var i = 0;
            (function next() { if (err || i >= bumped.length) return cb(err); publish(mds, relay, me, bumped[i++], function () { next(); }); })();
        }, mine);
    }
    /** M4: did the stored copy of `o` move (status or seq) since `list` was loaded? Then it is not ours to re-sign. cb(moved). */
    function movedSince(mds, list, o, cb) {
        var b = list._base && find(list._base, o.orderId);
        if (!b) return cb(false);
        mds.kvGet('myorders', '[]', function (v) { var c = find(parseList(v), o.orderId); cb(!c || c.status !== b.status || c.seq !== b.seq); });
    }

    var SIMPLE = /^RETURN SIGNEDBY\(0x[0-9A-Fa-f]{64}\)$/;
    /** address(lower) → simple script text, from the node's `scripts` list. cb(err, map). */
    function simpleScripts(mds, cb) {
        mds.cmdR('scripts', function (err, r) {
            if (err) return cb(err);
            var rows = Object.prototype.toString.call(r) === '[object Array]' ? r : [], map = {};
            for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].address && SIMPLE.test(String(rows[i].script))) map[String(rows[i].address).toLowerCase()] = rows[i].script;
            cb(null, map);
        });
    }

    /** Spendable, state-free, unspent coins of one token (relevant:true = mine). Only coins at SIMPLE addresses are
     *  usable as backing: a taker needs the address script (published in the order) and txnsign auto signs simple
     *  inputs only. Each coin gets `.script` attached. cb(err, coins). */
    function walletCoins(mds, tokenid, cb) {
        simpleScripts(mds, function (e0, scripts) {
            if (e0) return cb(e0);
            mds.cmdR('coins relevant:true checkmempool:true tokenid:' + tokenid, function (err, r) {   // checkmempool: a coin a pending txn spends is already gone
                if (err) return cb(err);
                var rows = Object.prototype.toString.call(r) === '[object Array]' ? r : [];
                var out = [];
                for (var i = 0; i < rows.length; i++) {
                    var c = rows[i];
                    if (!c || c.spent === true || (c.state && c.state.length) || String(c.tokenid).toLowerCase() !== tokenid.toLowerCase()) continue;
                    var sc = scripts[String(c.address).toLowerCase()];
                    if (!sc) continue;
                    c.script = sc; out.push(c);
                }
                cb(null, out);
            });
        });
    }

    /** Distinct address scripts for a set of coins (the order's `scripts`). */
    function scriptsFor(coins, ids) {
        var want = {}; for (var i = 0; i < ids.length; i++) want[String(ids[i]).toLowerCase()] = true;
        var seen = {}, out = [];
        for (i = 0; i < coins.length; i++) { var c = coins[i]; if (want[String(c.coinid).toLowerCase()] && c.script && !seen[c.script]) { seen[c.script] = true; out.push(c.script); } }
        return out;
    }

    /** Age in blocks of a coin at `tip` (0 when unknown). */
    function ageOf(c, tip) { var cr = parseInt(c.created, 10); return (tip > 0 && cr > 0) ? Math.max(0, tip - cr) : 0; }
    /** 22 Nov 2026: a tip that could not be read (0) means freshness is UNKNOWN, never fresh. It used to read as age 0,
     *  so a maker whose `block` read failed re-signed orders backed by coins far older than COIN_MAX_AGE: a live maker
     *  publishing an order no light-node taker can see. */
    function isFresh(c, tip, maxAge) { return tip > 0 && ageOf(c, tip) <= Math.min(maxAge || COIN_MAX_AGE, COIN_MAX_AGE); }

    /** Coins a maker needs to back `side`/`price`/`amount`, excluding coins already backing other live orders.
     *  Only FRESH coins (age ≤ maxAge at `tip`) qualify when tip is known: a stale coin is invisible to light-node takers. */
    function backing(side, price, amount, coins, excludeIds, tip, maxAge) {
        var give = side === 'sell' ? F.d(amount) : F.up8(F.d(amount).times(F.d(price)));
        if (!(tip > 0)) throw new Error('chain tip unreadable, so coin freshness is unknown: not signing an order with backing coins of unknown age');
        var ex = {}; for (var i = 0; i < (excludeIds || []).length; i++) ex[String(excludeIds[i]).toLowerCase()] = true;
        var free = coins.filter(function (c) { return !ex[String(c.coinid).toLowerCase()] && isFresh(c, tip || 0, maxAge); });
        var p = F.pick(free, give, MAX_COINS);
        if (!p) throw new Error('not enough free, fresh ' + (side === 'sell' ? 'MINIMA' : 'MxUSD') + ' coins to back ' + F.plain(give) + (side === 'sell' ? ' MINIMA' : ' MxUSD'));
        return p.coins.map(function (c) { return c.coinid; });
    }

    function giveOf(side, price, amount) { return side === 'sell' ? F.d(amount) : F.up8(F.d(amount).times(F.d(price))); }
    /** 0.0.102 (owner 22 Nov 2026: refusing an order because its coins are old, or making the user wait a block before
     *  placing it, is unacceptable). Backing for create/edit: fresh coins as before → {coins, relock: [], relocking: []}.
     *  When fresh coins cannot cover it, the free coins of ANY age that can → {coins: [], relocking: all their ids,
     *  relock: the STALE ones only}: the caller relocks those at once (0.0.110: a fresh coin among them is held for the
     *  order in `relocking` but never self-sent) and publishes the order coinless; refresh re-backs it after the next block.
     *  Throws for an unread tip (0.0.92) and when the free coins cannot cover it at all, saying held vs needed. Pure. */
    function placement(side, price, amount, coins, excludeIds, tip, maxAge) {
        try { return { coins: backing(side, price, amount, coins, excludeIds, tip, maxAge), relock: [], relocking: [] }; }
        catch (e) { if (!(tip > 0)) throw e; }
        var give = giveOf(side, price, amount), name = side === 'sell' ? 'MINIMA' : 'MxUSD', ex = {}, held = F.d(0), i;
        for (i = 0; i < (excludeIds || []).length; i++) ex[String(excludeIds[i]).toLowerCase()] = true;
        var free = coins.filter(function (c) { return !ex[String(c.coinid).toLowerCase()]; });
        for (i = 0; i < free.length; i++) held = held.plus(F.coinValue(free[i]));
        var p = F.pick(free, give, MAX_COINS);
        if (!p) throw new Error(held.gte(give)
            ? 'not enough ' + name + ' in ' + MAX_COINS + ' coins: the order needs ' + F.plain(give) + ' ' + name + ' and the ' + F.plain(held) + ' ' + name + ' free is spread over ' + free.length + ' coins — consolidate first'
            : 'not enough ' + name + ': the order needs ' + F.plain(give) + ' ' + name + ', this wallet holds ' + F.plain(held) + ' ' + name + ' free (not backing another order, not being spent)');
        return { coins: [], relock: p.coins.filter(function (c) { return !isFresh(c, tip, maxAge); }), relocking: p.coins.map(function (c) { return c.coinid; }) };
    }
    var PENDING_NOTICE = 'placed; goes live to takers after the next block (refreshing your coins)';
    /** create/edit: start the relock of the coins placement() chose, at once. A failure is kept on the order (refresh
     *  retries it; the order stays coinless meanwhile, never re-signed on a stale coin) and told. cb(notice). */
    function startRelock(mds, o, coins, address, cb) {
        if (!coins.length) return cb('');
        relock(mds, coins, address, function (e) {
            if (e && !e.pending) { o.relockError = e.message; return cb('placed, but refreshing your coins failed (' + e.message + '): it goes live to takers once a retry succeeds (retried automatically, backing off after each failure)'); }
            delete o.relockError; cb(PENDING_NOTICE);
        });
    }

    /** Current tip block + configured max coin age. cb(tip, maxAge). A failed tip read is retried once; tip 0 means it
     *  is still unknown (callers refuse to sign, or skip the refresh). */
    function chainCtx(mds, cb) {
        function readTip(tries) {
            mds.cmdR('block', function (err, b) {
                var tip = (!err && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
                if (!tip && tries > 1) return readTip(tries - 1);
                mds.kvGet('coin_max_age', '', function (v) { cb(tip, maxAgeOf(v)); });
            });
        }
        readTip(2);
    }

    /**
     * Re-lock stale coins: ONE transaction spending exactly these coins back to my own address (same token), so they
     * become fresh coins light-node takers can prove. The node signs all inputs (they are mine). cb(err, txpowid).
     * 0.0.103: one output per input, of the same amount — a relock keeps the wallet's coin sizes. It used to merge them
     * into one coin, so two orders whose stale coins were relocked together came back with ONE coin, which backs one
     * order only (a coin backs at most one order): the other stayed coinless.
     */
    /** 0.0.106 (review 22 Nov, M3): one relock is capped at the node's own `consolidate` limits, 20 inputs from at most 5
     *  distinct signing addresses (a TxPoW over 64 KB is rejected only AFTER signing); the rest goes in later passes.
     *  After ANY failure its coins back off (kv relock_backoff, coinid → {until, wait}): 2 blocks, doubling to 64. Every
     *  caller (placement, refresh, both voids) goes through here, so a failure after txnsign is never re-signed inside
     *  its window. cb(err, txpowid, sentIds): err.backoff = every coin given is still waiting (nothing signed);
     *  err.pending = posted without a txpowid, possibly in the mempool: the coins are looked at again after the window. */
    var RELOCK_MAX_INPUTS = 20, RELOCK_MAX_SIGNERS = 5, BACKOFF_FIRST = 2, BACKOFF_MAX = 64;
    function relock(mds, coins, toAddress, cb) {
        if (!coins.length) return cb(null, null, []);
        mds.cmdR('block', function (eb, b) {
            var tip = (!eb && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
            if (!tip) return cb(new Error('relock: chain tip unreadable, so its backoff cannot be judged'), null, []);
            // ponytail: read-modify-write of one kv key shared by page and service; a lost entry costs one early retry
            mds.kvGet('relock_backoff', '{}', function (v) {
                var bo = {}, batch = [], signers = {}, nS = 0, until = 0, i, k;
                try { bo = JSON.parse(v || '{}') || {}; } catch (e) { bo = {}; }
                for (i = 0; i < coins.length && batch.length < RELOCK_MAX_INPUTS; i++) {
                    var c = coins[i], w = bo[String(c.coinid).toLowerCase()], a = String(c.address).toLowerCase();
                    if (w && tip < w.until) { until = Math.max(until, w.until); continue; }
                    if (!signers[a]) { if (nS >= RELOCK_MAX_SIGNERS) continue; signers[a] = true; nS++; }
                    batch.push(c);
                }
                if (!batch.length) { var eW = new Error('relock: backing off after a failure, retried from block ' + until); eW.backoff = true; return cb(eW, null, []); }
                var ids = batch.map(function (x) { return x.coinid; });
                function done(err, txpowid) {
                    for (k in bo) if (tip - bo[k].until > 1000) delete bo[k];
                    var wait = 0;
                    batch.forEach(function (x) {
                        var key = String(x.coinid).toLowerCase(), was = bo[key];
                        if (!err && txpowid) return delete bo[key];
                        wait = Math.min(BACKOFF_MAX, was ? was.wait * 2 : BACKOFF_FIRST);
                        bo[key] = { until: tip + wait, wait: wait };
                    });
                    // MINOR 7: no txpowid after a post is "possibly posted", not a failure to retry at once
                    if (!err && !txpowid) { err = new Error('relock: posted without a txpowid, possibly in the mempool: its coins are looked at again from block ' + (tip + wait)); err.pending = true; }
                    mds.kvSet('relock_backoff', JSON.stringify(bo), function () { cb(err, txpowid || null, ids); });
                }
                var tok = batch[0].tokenid, id = 'rl' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), n = 0;
                var steps = ['txncreate id:' + id];
                for (i = 0; i < batch.length; i++) steps.push('txninput id:' + id + ' coinid:' + batch[i].coinid + ' scriptmmr:true');
                for (i = 0; i < batch.length; i++) steps.push('txnoutput id:' + id + ' amount:' + F.plain(F.coinValue(batch[i])) + ' address:' + toAddress + (String(tok).toLowerCase() === F.MINIMA ? '' : ' tokenid:' + tok));
                steps.push('txnsign id:' + id + ' publickey:auto');
                (function step() {
                    if (n >= steps.length) {
                        return mds.cmdR('txnpost id:' + id, function (e, post) {
                            var txpowid = post && post.txpow && post.txpow.txpowid;
                            mds.cmd('txndelete id:' + id, function () { done(e ? new Error('txnpost: ' + e.message) : null, txpowid); });
                        });
                    }
                    var c = steps[n++];
                    mds.cmdR(c, function (e) { if (e) return mds.cmd('txndelete id:' + id, function () { done(new Error(c.split(' ')[0] + ': ' + e.message)); }); step(); });
                })();
            });
        });
    }

    /** review 22 Nov (M2): ONE "held" rule for every coin chooser (placement, refresh re-backing and relocks, the ladder
     *  batch, the ladder split): a coin in a take of mine awaiting its maker or being voided (kv pending_takes / void_takes
     *  `mine`), or reserved by the resting engine (PandaCoinLock, PoolInputClaims), is never picked. Coins backing or
     *  relocking for another live order are excluded by the callers (coinsBackingOthers, allocate's taken).
     *  cb(unheld) where unheld(coins) → those of `coins` not held. */
    function holds(mds, cb) {
        var ids = {};
        mds.kvGet('pending_takes', '{}', function (pt) { mds.kvGet('void_takes', '{}', function (vt) {
            [pt, vt].forEach(function (v) { var m = {}; try { m = JSON.parse(v || '{}') || {}; } catch (e) { m = {}; }
                Object.keys(m).forEach(function (k) { ((m[k] && m[k].mine) || []).forEach(function (id) { ids[String(id).toLowerCase()] = true; }); }); });
            cb(function (coins) {
                return (coins || []).filter(function (c) {
                    var k = String(c.coinid).toLowerCase();
                    return !ids[k] && !(g.PandaCoinLock && g.PandaCoinLock.isReserved(k)) && !(g.PoolInputClaims && g.PoolInputClaims.blocked([k]));
                });
            });
        }); });
    }

    function coinsBackingOthers(list, exceptId) {
        var ids = [];
        for (var i = 0; i < list.length; i++) if (list[i].status === 'live' && list[i].orderId !== exceptId) ids = ids.concat(list[i].coins || [], list[i].relocking || []);
        return ids;
    }

    function envelopeFor(me, o) {
        return E.order(me, { market: MARKET, side: o.side, price: o.price, amount: o.status === 'live' ? o.remaining : '0',
                             coins: o.status === 'live' ? o.coins : [], scripts: o.status === 'live' ? (o.scripts || []) : [],
                             address: o.address, orderId: o.orderId, seq: o.seq, expiry: o.expiry });
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

    /** Create: select backing coins, sign, publish, save. cb(err, order, relayResults, notice). notice is '' when the order
     *  is live to takers now, else what placement() needed (its coins are being refreshed: live after the next block). */
    function create(mds, relay, me, params, cb) {
        var side = params.side, price = F.plain(F.d(params.price)), amount = F.plain(F.down8(F.d(params.amount)));
        if (side !== 'buy' && side !== 'sell') return cb(new Error('side must be buy or sell'));
        if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(price) || F.d(price).lte(0)) return cb(new Error('price must be a positive decimal with at most 8 dp'));
        if (F.d(amount).lte(0)) return cb(new Error('amount must be positive'));
        load(mds, function (e0, list) {
            mds.cmdR('getaddress', function (e1, addr) {
                if (e1 || !addr || !addr.address) return cb(e1 || new Error('getaddress failed'));
                walletCoins(mds, side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, all) {
                    if (e2) return cb(e2);
                    holds(mds, function (unheld) { var coins = unheld(all);
                    chainCtx(mds, function (tip, maxAge) {
                    var pl;
                    try { pl = placement(side, price, amount, coins, coinsBackingOthers(list, null), tip, maxAge); } catch (e) { return cb(e); }
                    var bytes = new Uint8Array(8);
                    fillRandom(bytes);
                    var o = { orderId: '0x' + AX.hex.to(bytes), side: side, price: price, amount: amount, remaining: amount, coins: pl.coins, scripts: scriptsFor(coins, pl.coins),
                              address: addr.address, seq: now(), expiry: now() + EXPIRY_SECONDS, status: 'live', created: now() };
                    if (pl.relocking.length) o.relocking = pl.relocking;
                    publish(mds, relay, me, o, function (e3, results) {
                        if (e3) return cb(e3);   // nothing relocked: an order no relay took is not placed
                        startRelock(mds, o, pl.relock, addr.address, function (notice) {
                            list.push(o);
                            commit(mds, relay, me, list, true, function (e4) { cb(e4, o, results, notice); });
                        });
                    });
                    });
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
            publish(mds, relay, me, o, function (e1) {
                // 'stale seq' = the relay already holds this order at the same or a newer seq — a cancel sent twice in one second.
                if (e1 && /stale seq$/.test(String(e1.message || e1))) e1 = null;
                commit(mds, relay, me, list, true, function (e2) { cb(e1 || e2, o); });
            });
        });
    }

    /** Review 22 Nov (MINOR 1): is a relock of `o`'s coins still on its way, judged from the coins themselves? Yes when one
     *  of its `relocking` coins is missing from the wallet (read with checkmempool) yet unspent on chain: it sits in the
     *  mempool. A coin spent on chain means the relock confirmed (its new coin is free, or went to another order). It
     *  used to be "none of them in the wallet", which stayed true after the relock confirmed. cb(yes). */
    function relockInFlight(mds, o, wallet, cb) {
        var gone = (o.relocking || []).filter(function (id) { return !wallet.some(function (c) { return String(c.coinid).toLowerCase() === String(id).toLowerCase(); }); });
        (function next() {
            if (!gone.length) return cb(false);
            mds.cmdR('coins relevant:true coinid:' + gone.shift(), function (e, rows) { if (!e && rows && rows.length) return cb(true); next(); });
        })();
    }

    /** Edit price and/or amount: re-select backing (placement(), as create), higher seq, publish. cb(err, order, notice). */
    function edit(mds, relay, me, orderId, params, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o || o.status !== 'live') return cb(new Error('order is not live'));
            var price = params.price !== undefined ? F.plain(F.d(params.price)) : o.price;
            var amount = params.amount !== undefined ? F.plain(F.down8(F.d(params.amount))) : o.remaining;
            if (F.d(price).lte(0) || F.d(amount).lte(0)) return cb(new Error('price and amount must be positive'));
            walletCoins(mds, o.side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, all) {
                if (e2) return cb(e2);
                holds(mds, function (unheld) { var coins = unheld(all);
                chainCtx(mds, function (tip, maxAge) {
                var pl;
                try { pl = placement(o.side, price, amount, coins, coinsBackingOthers(list, orderId), tip, maxAge); }
                catch (e) {
                    // its own relock is still confirming: re-priced, still waiting (never for more than the relock brings back)
                    if (!(tip > 0) || (o.coins || []).length || giveOf(o.side, price, amount).gt(giveOf(o.side, o.price, o.remaining))) return cb(e);
                    return relockInFlight(mds, o, all, function (yes) { if (!yes) return cb(e); go({ coins: [], relock: [], relocking: [] }, true); });
                }
                go(pl, false);
                function go(pl, waiting) {
                o.price = price; o.amount = amount; o.remaining = amount; o.coins = pl.coins; o.scripts = scriptsFor(coins, pl.coins); o.seq = nextSeq(o); o.expiry = now() + EXPIRY_SECONDS;
                if (pl.relocking.length) o.relocking = pl.relocking;
                else if (!waiting) { delete o.relocking; delete o.relockError; }
                publish(mds, relay, me, o, function (e3) {
                    // a refused publish relocks nothing now: refresh relocks o.relocking within a minute
                    (e3 ? function (m, x, c, a, k) { k(''); } : startRelock)(mds, o, pl.relock, o.address, function (notice) {
                        commit(mds, relay, me, list, true, function (e4) { cb(e3 || e4, o, notice || (waiting ? PENDING_NOTICE : '')); });
                    });
                });
                }
                });
                });
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
            if (rem.lte(0) || dust(rem, o.amount)) o.status = 'filled';   // dust left over closes the order
            o.seq = nextSeq(o);
            if (o.status === 'filled') { o.expiry = now() + 600; }
            publish(mds, relay, me, o, function (e1) { commit(mds, relay, me, list, false, function (e2) { cb(e1 || e2, o); }); });
        });
    }

    /**
     * Periodic refresh (service): for every live order make sure its coins still exist unspent, are FRESH and cover
     * the remaining amount (re-select if not), re-lock stale backing coins by a self-send, and republish when coins
     * changed or expiry is within 2 hours. cb(err, republishedCount, relockedTxpowid, relockErrors[]).
     * 0.0.102: an order's `relocking` coins back in the wallet (a relock that failed or was dropped) are relocked again;
     * a relock failure is no longer swallowed: it is returned and kept on the order (relockError).
     * 0.0.104: keep-fresh (0.0.103) is gone; every coin this pass's relocks sent is out of the re-backing candidates,
     * whether its relock worked or not, so an order is never re-signed on a coin being spent.
     */
    function refresh(mds, relay, me, cb) {
        load(mds, function (e0, list) {
            var live = list.filter(function (o) { return o.status === 'live'; });
            if (!live.length) return cb(null, 0, null);
            var byTok = { sell: null, buy: null }, n = 0;
            walletCoins(mds, F.MINIMA, function (eA, minima) {
                walletCoins(mds, F.MXUSD, function (eB, mxusd) {
                    if (eA || eB) return cb(eA || eB);
                    holds(mds, function (unheld) {
                    byTok.sell = unheld(minima); byTok.buy = unheld(mxusd);   // M2: a held coin is neither relocked nor re-backed on
                    chainCtx(mds, function (tip, maxAge) {
                    // 0.0.95: the tip could not be read (twice): coin freshness is unknown, so this tick is SKIPPED and every
                    // order is left as signed (an envelope lives at most 60 minutes and its coins were fresh when signed).
                    // It used to re-sign every order coinless, pulling the maker's whole book for a minute.
                    if (!(tip > 0)) return cb(new Error('chain tip unreadable, so coin freshness is unknown: refresh skipped, orders left as they are'), 0, null);
                    mds.cmdR('getaddress', function (eG, addr) {
                    var myAddr = (!eG && addr && addr.address) || null;
                    // 1. stale coins backing live orders → one relock txn per token (they come back fresh after a block; the
                    //    orders keep their (now unspendable) coin ids until the next refresh re-backs them). relock() takes
                    //    at most 20 of them from 5 signing addresses; the rest go in the next passes.
                    var stale = [], seen = {};
                    live.forEach(function (o) { var mine = (o.coins || []).concat(o.relocking || []); byTok[o.side].forEach(function (c) {
                        if (tip > 0 && mine.indexOf(c.coinid) >= 0 && !isFresh(c, tip, maxAge)) {   // unknown age is not stale: never relock blind
                            if (!seen[c.coinid]) { seen[c.coinid] = true; stale.push(c); }
                            o.relocking = o.relocking || []; if (o.relocking.indexOf(c.coinid) < 0) o.relocking.push(c.coinid);
                        }
                    }); });
                    var byToken = {}; stale.forEach(function (c) { var t = String(c.tokenid).toLowerCase(); (byToken[t] = byToken[t] || []).push(c); });
                    var toks = Object.keys(byToken), ti = 0, relocked = null, relockErrs = [], sent = {};
                    if (toks.length && !myAddr) relockErrs.push('relock: getaddress failed (' + (eG ? eG.message : 'no address') + ')');
                    (function relockNext() {
                        if (ti >= toks.length || !myAddr) return orders();
                        var tok = toks[ti++], ids = byToken[tok].map(function (c) { return c.coinid; });
                        ids.forEach(function (id) { sent[String(id).toLowerCase()] = true; });
                        relock(mds, byToken[tok], myAddr, function (eR, txpowid, sentIds) {
                            // a coin set still backing off sends nothing and keeps its order's error; "possibly posted" is no failure
                            if (txpowid) relocked = txpowid;
                            else if (eR && !eR.backoff && !eR.pending) relockErrs.push('relock of ' + sentIds.join(', ') + ' failed: ' + eR.message);
                            live.forEach(function (o) { if ((o.relocking || []).some(function (id) { return sentIds.indexOf(id) >= 0; })) { if (eR && !eR.pending) o.relockError = eR.message; else delete o.relockError; } });
                            relockNext();
                        });
                    })();
                    function orders() {
                    // review 22 Nov (M1): byTok is the pre-relock snapshot; a coin sent above must never back an order
                    ['sell', 'buy'].forEach(function (sd) { byTok[sd] = byTok[sd].filter(function (c) { return !sent[String(c.coinid).toLowerCase()]; }); });
                    var i = 0;
                    function step() {
                        if (i >= live.length) return commit(mds, relay, me, list, false, function (e) { cb(e, n, relocked, relockErrs); });
                        var o = live[i++];
                        // M4: an order the page cancelled or edited since this pass loaded the list is never re-signed here
                        movedSince(mds, list, o, function (moved) { if (moved) step(); else one(o); });
                    }
                    function one(o) {
                        if (dust(o.remaining, o.amount)) { o.status = 'filled'; o.seq = nextSeq(o); o.expiry = now() + 600; return publish(mds, relay, me, o, function () { n++; step(); }); }   // a dust remainder from before the rule
                        var have = {}; byTok[o.side].forEach(function (c) { if (isFresh(c, tip, maxAge)) have[String(c.coinid).toLowerCase()] = true; });
                        var stillThere = (o.coins || []).every(function (c) { return have[String(c).toLowerCase()]; });
                        var covers = false;
                        try { var cov = F.pick(byTok[o.side].filter(function (c) { return (o.coins || []).indexOf(c.coinid) >= 0 && isFresh(c, tip, maxAge); }), o.side === 'sell' ? F.d(o.remaining) : F.up8(F.d(o.remaining).times(F.d(o.price))), MAX_COINS); covers = !!cov; } catch (e) { covers = false; }
                        var needRepub = !stillThere || !covers || (o.expiry - now() < REFRESH_BEFORE_SECONDS);
                        var oldSeq = o.seq, oldExp = o.expiry, oldCoins = o.coins, oldScripts = o.scripts, oldRl = o.relocking, oldRe = o.relockError;
                        if (!stillThere || !covers) {
                            try { o.coins = backing(o.side, o.price, o.remaining, byTok[o.side], coinsBackingOthers(list, o.orderId), tip, maxAge); o.scripts = scriptsFor(byTok[o.side], o.coins); delete o.relocking; delete o.relockError; }
                            catch (e) {
                                // Nothing fresh to back it with right now (e.g. the relock is still confirming): keep the order
                                // but publish it with NO coins — takers skip it; next refresh re-backs it.
                                o.coins = []; o.scripts = [];
                            }
                        }
                        if (!needRepub) return step();
                        o.seq = nextSeq(o); o.expiry = now() + EXPIRY_SECONDS;
                        // review 7 Nov (M2): only a re-sign some relay accepted is kept; a rejected one stays due for the next pass
                        publish(mds, relay, me, o, function (pe) { if (!pe) n++; else { o.seq = oldSeq; o.expiry = oldExp; o.coins = oldCoins; o.scripts = oldScripts; if (oldRl) o.relocking = oldRl; if (oldRe) o.relockError = oldRe; } step(); });
                    }
                    step();
                    }
                    });
                    });
                    });
                });
            });
        });
    }

    /** Back every op from ONE wallet snapshot, in order, never giving a coin to two orders (mirror of
     *  MakerEngine.allocate): an op may reuse its own order's coins, never another live order's or one an earlier op
     *  just took. ops: [{key, orderId|null, side, price, amount}]. Returns [{coins}|{err}]. Pure. */
    function allocate(ops, minima, mxusd, list, tip, maxAge) {
        var taken = {}, own = {}, out = [], i, j;
        // M2/MINOR 2: an order's relocking coins are its own too, never another op's
        for (i = 0; i < list.length; i++) if (list[i].status === 'live') { own[list[i].orderId] = (list[i].coins || []).concat(list[i].relocking || []); own[list[i].orderId].forEach(function (id) { taken[String(id).toLowerCase()] = true; }); }
        for (i = 0; i < ops.length; i++) {
            var op = ops[i], mine = (op.orderId && own[op.orderId]) || [], ownLc = {}, excl = [], k;
            for (j = 0; j < mine.length; j++) ownLc[String(mine[j]).toLowerCase()] = true;
            for (k in taken) if (!ownLc[k]) excl.push(k);
            try {
                var ids = backing(op.side, op.price, op.amount, op.side === 'sell' ? minima : mxusd, excl, tip, maxAge);
                for (k in ownLc) delete taken[k];
                for (j = 0; j < ids.length; j++) taken[String(ids[j]).toLowerCase()] = true;
                out.push({ coins: ids });
            } catch (e) { out.push({ err: e.message }); }
        }
        return out;
    }

    /** The whole ladder in one go (owner 2026-10-26, like the minimaXT overlay's single book update): ONE address,
     *  ONE tip, backing planned from the caller's wallet snapshot, every envelope signed, then published back to back
     *  and saved ONCE. Edits are kept whatever the relays said (as edit()); creates only when a relay accepted.
     *  cb(errors {key: message}, made {key: order}). */
    function batch(mds, relay, me, ops, minima, mxusd, cb) {
        var errors = {}, made = {};
        if (!ops.length) return cb(errors, made);
        var anyCreate = ops.some(function (o) { return !o.orderId; });
        var go = function (addr) {
            load(mds, function (e0, list) { holds(mds, function (unheld) {
                minima = unheld(minima); mxusd = unheld(mxusd);
                chainCtx(mds, function (tip, maxAge) {
                    var norm = [], i;
                    for (i = 0; i < ops.length; i++) {
                        try {
                            var price = F.plain(F.d(ops[i].price)), amount = F.plain(F.down8(F.d(ops[i].amount)));
                            if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(price) || F.d(price).lte(0) || F.d(amount).lte(0)) throw new Error('bad');
                            norm.push({ key: ops[i].key, orderId: ops[i].orderId, side: ops[i].side, price: price, amount: amount });
                        } catch (e) { errors[ops[i].key] = 'bad price or amount'; }
                    }
                    var alloc = allocate(norm, minima, mxusd, list, tip, maxAge), send = [];
                    for (i = 0; i < norm.length; i++) {
                        var op = norm[i], a = alloc[i], o;
                        if (a.err) { errors[op.key] = a.err; continue; }
                        if (!op.orderId) {
                            if (!addr) { errors[op.key] = 'getaddress failed'; continue; }
                            var bytes = new Uint8Array(8); fillRandom(bytes);
                            o = { orderId: '0x' + AX.hex.to(bytes), side: op.side, address: addr, status: 'live', created: now(), seq: now() };
                        } else {
                            o = find(list, op.orderId);
                            if (!o || o.status !== 'live') { errors[op.key] = 'order is not live'; continue; }
                            o.seq = nextSeq(o);
                        }
                        o.price = op.price; o.amount = op.amount; o.remaining = op.amount; o.coins = a.coins;
                        o.scripts = scriptsFor(op.side === 'sell' ? minima : mxusd, a.coins); o.expiry = now() + EXPIRY_SECONDS;
                        send.push({ op: op, o: o });
                    }
                    var k = 0;
                    (function next() {
                        if (k >= send.length) return commit(mds, relay, me, list, false, function () { cb(errors, made); });
                        var s = send[k++];
                        publish(mds, relay, me, s.o, function (e) {
                            if (e) errors[s.op.key] = e.message; else made[s.op.key] = s.o;
                            if (!s.op.orderId && !e) list.push(s.o);
                            next();
                        });
                    })();
                });
            }); });
        };
        if (!anyCreate) return go(null);
        mds.cmdR('getaddress', function (e, a) { go(!e && a && a.address ? a.address : null); });
    }

    /** Of one relay's live orders, which of MINE must be re-sent: any it shows live that is cancelled / filled here,
     *  an older version of one that is live here, or one live here (and unexpired) that the relay does not hold at
     *  all — a relay keeps its book in memory, so a restart drops every order (28 Oct). Mirror of MakerEngine.stale. */
    function stale(relayHas, mySignPk, list) {
        var out = [], held = {};
        relayHas.forEach(function (e) {
            if (String(e.signPk).toLowerCase() !== String(mySignPk).toLowerCase()) return;
            held[e.orderId] = true;
            var o = find(list, e.orderId);
            if (o && (o.status !== 'live' || o.seq > e.seq)) out.push(o);
        });
        list.forEach(function (o) { if (o.status === 'live' && o.expiry > now() + 60 && !held[o.orderId]) out.push(o); });
        return out;
    }

    /** Make every relay agree with this node (owner 2026-10-26: a cancelled order must never stay live on any relay).
     *  cb({checked, fixed, failed, lines}). */
    function syncRelays(mds, relay, me, cb) {
        var rep = { checked: 0, fixed: 0, failed: 0, lines: [] }, urls = relay.relays.slice(), touched = false, mySignPk = '0x' + AX.hex.to(me.signPk);
        load(mds, function (e0, list) {
            (function nextRelay() {
                if (!urls.length) return touched ? commit(mds, relay, me, list, false, function () { cb(rep); }) : cb(rep);
                var url = urls.shift();
                relay.snapshot(url, function (err, has) {
                    if (err) return nextRelay();
                    rep.checked++;
                    var fix = stale(has, mySignPk, list);
                    (function nextFix() {
                        if (!fix.length) return nextRelay();
                        var o = fix.shift(), raw;
                        if (o.status !== 'live' && o.expiry <= now() + 60) { o.expiry = now() + 600; touched = true; }   // a cancel must still be valid to land
                        try { raw = envelopeFor(me, o); } catch (e) { rep.failed++; return nextFix(); }
                        relay.publishTo(url, raw, function (r) {
                            if (r.ok || r.error === 'stale seq') { rep.fixed++; rep.lines.push('relay ' + url + ' still showed ' + o.orderId + ' — re-sent (' + o.status + ')'); }
                            else { rep.failed++; rep.lines.push('relay ' + url + ' still shows ' + o.orderId + ' and refused the fix: ' + r.error); }
                            nextFix();
                        });
                    })();
                });
            })();
        });
    }

    function find(list, orderId) { for (var i = 0; i < list.length; i++) if (list[i] && list[i].orderId === orderId) return list[i]; return null; }
    /** A live order published coinless BECAUSE a relock of its coins is pending (`relocking`, placed or edited on coins
     *  being refreshed, or whose backing aged out): the service re-backs it on the next block, not at the minute's refresh
     *  (service.js rebackOnBlock). 0.0.109 (review 22 Nov, MINOR 5): any other coinless order (nothing on its way, e.g.
     *  the wallet is short) waits for the minute's refresh; it used to run a refresh on every block. */
    function awaitingBacking(list) { return (list || []).some(function (o) { return o.status === 'live' && !(o.coins || []).length && (o.relocking || []).length > 0; }); }

    AX.maker = { MARKET: MARKET, COIN_MAX_AGE: COIN_MAX_AGE, WHY_MAX_AGE: WHY_MAX_AGE, maxAgeOf: maxAgeOf, load: load, save: save, walletCoins: walletCoins, holds: holds, simpleScripts: simpleScripts, scriptsFor: scriptsFor, backing: backing,
                 placement: placement, PENDING_NOTICE: PENDING_NOTICE, awaitingBacking: awaitingBacking, ageOf: ageOf, isFresh: isFresh, chainCtx: chainCtx, relock: relock, RELOCK_MAX_INPUTS: RELOCK_MAX_INPUTS, RELOCK_MAX_SIGNERS: RELOCK_MAX_SIGNERS, envelopeFor: envelopeFor,
                 publish: publish, create: create, cancel: cancel, edit: edit, afterFill: afterFill, refresh: refresh, find: find, DUST: DUST, dust: dust, allocate: allocate, batch: batch, stale: stale, syncRelays: syncRelays };
})(typeof globalThis !== 'undefined' ? globalThis : this);
