/* maker.test.js — my-orders model against a fake node (kv + coins + getaddress) and a fake relay client. */
(function () {
    var M = AX.maker, F = AX.fill, E = AX.envelope;
    var NOW = Math.floor(Date.now() / 1000);
    var me = AX.identity.fromSeed('0x' + '11'.repeat(32), 'decks');
    var ADDR = '0x' + 'aa'.repeat(32), CADDR = '0x' + 'cc'.repeat(32);
    function coin(id, tokenid, value) {
        var c = { coinid: '0x' + id.repeat(32), address: CADDR, tokenid: tokenid, spent: false, state: [], created: '1000' };
        if (tokenid === F.MINIMA) c.amount = value; else { c.amount = '0.000001'; c.tokenamount = value; }
        return c;
    }
    var wallet = { minima: [coin('01', F.MINIMA, '60'), coin('02', F.MINIMA, '50'), coin('03', F.MINIMA, '5')], mxusd: [coin('11', F.MXUSD, '3'), coin('12', F.MXUSD, '2')] };
    var kv = {}, TIP = 1100, posted = [];
    var mds = {
        kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); },   // value-only, like mdsw.kvGet
        kvSet: function (k, v, cb) { kv[k] = v; cb(null); },
        cmdR: function (cmd, cb) {
            if (cmd === 'getaddress') return cb(null, { address: ADDR, miniaddress: 'Mx...' });
            if (cmd === 'scripts') return cb(null, [{ address: CADDR, script: 'RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')', simple: true }]);
            if (cmd === 'block') return cb(null, { block: String(TIP) });
            if (cmd.indexOf('txncreate') === 0 || cmd.indexOf('txninput') === 0 || cmd.indexOf('txnoutput') === 0 || cmd.indexOf('txnsign') === 0) { posted.push(cmd); return cb(null, {}); }
            if (cmd.indexOf('txnpost') === 0) { posted.push(cmd); return cb(null, { txpow: { txpowid: '0x' + 'ab'.repeat(32) } }); }
            if (cmd.indexOf('coins relevant:true tokenid:') === 0) { var t = cmd.split('tokenid:')[1]; return cb(null, t === F.MINIMA ? wallet.minima : wallet.mxusd); }
            cb(new Error('unexpected ' + cmd));
        },
        cmd: function (cmd, cb) { cb({ status: true }); }
    };
    var published = [];
    var relay = { publish: function (raw, cb) { published.push(JSON.parse(raw)); cb([{ url: 'http://r1', ok: true }]); } };

    // create a sell: backing from MINIMA coins largest-first (60+50 ≥ 100)
    var created = null;
    M.create(mds, relay, me, { side: 'sell', price: '0.0123', amount: '100.000000001' }, function (err, o) { T.ok('create ok ' + (err && err.message), !err); created = o; });
    T.eq('amount quantised', created.amount, '100');
    T.eq('backing coins', created.coins, [wallet.minima[0].coinid, wallet.minima[1].coinid]);
    T.eq('address from getaddress', created.address, ADDR);
    T.eq('order carries the coin address script', created.scripts, ['RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')']);
    T.eq('published envelope has scripts', published[0].scripts.length, 1);
    T.ok('orderId is 8 bytes', /^0x[0-9a-f]{16}$/.test(created.orderId));
    T.eq('published once, verifies', E.verify(JSON.stringify(published[0]), NOW).ok, true);
    T.eq('published amount', published[0].amount, '100');
    T.eq('kv saved 1 live', JSON.parse(kv.myorders).length, 1);

    // second sell cannot reuse the same coins → only coin 03 (5) is free → fails for 10
    M.create(mds, relay, me, { side: 'sell', price: '0.02', amount: '10' }, function (err) { T.ok('second sell refused: coins already backing', !!err && /not enough free/.test(err.message)); });
    // a buy uses MxUSD coins: 10 MINIMA @ 0.2 = 2 MxUSD → coin 11 (3)
    var buy = null;
    M.create(mds, relay, me, { side: 'buy', price: '0.2', amount: '10' }, function (err, o) { T.ok('buy ok', !err); buy = o; });
    T.eq('buy backing', buy.coins, [wallet.mxusd[0].coinid]);

    // edit: new price + amount, seq must rise, coins re-selected
    var seqBefore = created.seq;
    M.edit(mds, relay, me, created.orderId, { price: '0.013', amount: '55' }, function (err, o) { T.ok('edit ok', !err); T.ok('seq rose', o.seq > seqBefore); T.eq('edit coins', o.coins, [wallet.minima[0].coinid]); T.eq('edit price', o.price, '0.013'); });
    T.eq('edit published amount', published[published.length - 1].amount, '55');

    // afterFill: 20 filled from coin 01 → remaining 35 but coin 01 spent and no other backing → republish shows the remaining with no coins… refresh re-backs
    M.afterFill(mds, relay, me, created.orderId, '20', [wallet.minima[0].coinid], function (err, o) { T.ok('afterFill ok', !err); T.eq('remaining', o.remaining, '35'); T.eq('coins dropped', o.coins, []); T.eq('still live', o.status, 'live'); });
    T.eq('afterFill published remaining', published[published.length - 1].amount, '35');
    // wallet: coin 01 is gone (spent); refresh re-backs from 50-coin (02, free since the sell dropped 01 and 02 was released on edit)
    wallet.minima = [wallet.minima[1], wallet.minima[2]];
    M.refresh(mds, relay, me, function (err, n) { T.ok('refresh ok', !err); T.ok('refresh republished', n >= 1); });
    var afterRefresh = M.find(JSON.parse(kv.myorders), created.orderId);
    T.eq('re-backed from coin 02', afterRefresh.coins, [wallet.minima[0].coinid]);

    // cancel → amount 0 envelope with higher seq
    M.cancel(mds, relay, me, created.orderId, function (err, o) { T.ok('cancel ok', !err); T.eq('cancelled', o.status, 'cancelled'); });
    var last = published[published.length - 1];
    T.eq('cancel envelope amount 0', last.amount, '0');
    T.ok('cancel verifies', E.verify(JSON.stringify(last), NOW).ok);

    // --- coin age: stale coins are not eligible backing; refresh relocks them and republishes without coins ---
    wallet.minima = [coin('41', F.MINIMA, '500'), coin('42', F.MINIMA, '300')];
    wallet.minima[1].created = '100';                                    // age 1000 > COIN_MAX_AGE 500 at TIP 1100
    T.ok('fresh coin eligible', M.isFresh(wallet.minima[0], TIP, 500));
    T.ok('stale coin not eligible', !M.isFresh(wallet.minima[1], TIP, 500));
    T.eq('backing skips the stale coin', M.backing('sell', '0.1', '400', wallet.minima, [], TIP, 500), [wallet.minima[0].coinid]);
    var thrown = null; try { M.backing('sell', '0.1', '600', wallet.minima, [], TIP, 500); } catch (e) { thrown = e.message; }
    T.ok('cannot back 600 with only 500 fresh', /fresh/.test(thrown || ''));
    var sell2 = null;
    M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '400' }, function (err, o) { T.ok('create with fresh coin ok', !err); sell2 = o; });
    // the backing coin ages out → refresh relocks it (txn spending exactly it to my address) and publishes with no coins
    wallet.minima[0].created = '100';
    posted.length = 0;
    M.refresh(mds, relay, me, function (err, n, relocked) {
        T.ok('refresh ok', !err);
        T.eq('relock txpow returned', relocked, '0x' + 'ab'.repeat(32));
        T.ok('relock spent exactly the stale coin', posted.some(function (c) { return c.indexOf('txninput') === 0 && c.indexOf(wallet.minima[0].coinid) > 0; }) && posted.filter(function (c) { return c.indexOf('txninput') === 0; }).length === 1);
        T.ok('relock pays my own address', posted.some(function (c) { return c.indexOf('txnoutput') === 0 && c.indexOf('amount:500 address:' + ADDR) > 0; }));
        T.ok('relock signed and posted', posted.some(function (c) { return c.indexOf('txnsign') === 0; }) && posted.some(function (c) { return c.indexOf('txnpost') === 0; }));
    });
    var afterRelock = M.find(JSON.parse(kv.myorders), sell2.orderId);
    T.eq('order stays live', afterRelock.status, 'live');
    T.eq('published with no coins until the relock confirms', afterRelock.coins, []);
    T.eq('last publish amount still 400', published[published.length - 1].amount, '400');
    T.eq('last publish has no coins', published[published.length - 1].coins, []);
    // relock confirmed: the fresh coin appears → next refresh re-backs the order
    wallet.minima = [coin('43', F.MINIMA, '500')];
    M.refresh(mds, relay, me, function (err, n) { T.ok('re-back refresh ok', !err); });
    T.eq('re-backed with the fresh coin', M.find(JSON.parse(kv.myorders), sell2.orderId).coins, [wallet.minima[0].coinid]);

    // full fill → status filled
    M.afterFill(mds, relay, me, buy.orderId, '10', [wallet.mxusd[0].coinid], function (err, o) { T.eq('buy filled', o.status, 'filled'); T.eq('remaining 0', o.remaining, '0'); });

    // DUST (owner 2026-10-22): a fill leaving under 1 MINIMA closes the order; refresh closes an old dust order
    T.ok('dust rule', M.dust('0.00231293', '1000') && !M.dust('1', '1000') && !M.dust('0.5', '0.5') && !M.dust('0', '10'));
    var dd = null;
    wallet.minima = [coin('51', F.MINIMA, '500')];
    M.create(mds, relay, me, { side: 'sell', price: '0.003675', amount: '455.78231293' }, function (err, o) { T.ok('dust order created ' + (err && err.message), !err); dd = o; });
    M.afterFill(mds, relay, me, dd.orderId, '455.78', [], function (err, o) { T.eq('0.00231293 left → closed', o.status, 'filled'); T.eq('remaining kept for the record', o.remaining, '0.00231293'); });
    T.eq('closing publishes amount 0', published[published.length - 1].amount, '0');
    var list = JSON.parse(kv.myorders), old = M.find(list, dd.orderId); old.status = 'live'; kv.myorders = JSON.stringify(list);   // as left by a build before the rule
    M.refresh(mds, relay, me, function () {});
    T.eq('refresh closes the old dust order', M.find(JSON.parse(kv.myorders), dd.orderId).status, 'filled');
})();
