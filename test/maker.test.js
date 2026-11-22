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
    var kv = {}, TIP = 1100, TIP_FAILS = false, TIP_FAILS_ONCE = 0, SIGN_FAILS = false, POST_FAILS = null, POST_NO_ID = false, posted = [], ONCHAIN = {};   // ONCHAIN: coin ids `coins relevant:true coinid:` returns (unspent on chain)
    var mds = {
        kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); },   // value-only, like mdsw.kvGet
        kvSet: function (k, v, cb) { kv[k] = v; cb(null); },
        cmdR: function (cmd, cb) {
            if (cmd === 'getaddress') return cb(null, { address: ADDR, miniaddress: 'Mx...' });
            if (cmd === 'scripts') return cb(null, [{ address: CADDR, script: 'RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')', simple: true }]);
            if (cmd === 'block') { if (TIP_FAILS_ONCE > 0) { TIP_FAILS_ONCE--; return cb(new Error('cmd failed: block — no reason given')); } return TIP_FAILS ? cb(new Error('cmd failed: block — no reason given')) : cb(null, { block: String(TIP) }); }
            if (cmd.indexOf('txnsign') === 0 && SIGN_FAILS) { posted.push(cmd); return cb(new Error('the node is locked')); }
            if (cmd.indexOf('txncreate') === 0 || cmd.indexOf('txninput') === 0 || cmd.indexOf('txnoutput') === 0 || cmd.indexOf('txnsign') === 0) { posted.push(cmd); return cb(null, {}); }
            if (cmd.indexOf('txnpost') === 0) { posted.push(cmd); return POST_FAILS ? cb(new Error(POST_FAILS)) : cb(null, POST_NO_ID ? {} : { txpow: { txpowid: '0x' + 'ab'.repeat(32) } }); }
            if (cmd.indexOf('coins relevant:true coinid:') === 0) { var cid = cmd.split('coinid:')[1]; return cb(null, ONCHAIN[cid] ? [{ coinid: cid }] : []); }
            if (cmd.indexOf('coins relevant:true checkmempool:true tokenid:') === 0) { var t = cmd.split('tokenid:')[1]; return cb(null, t === F.MINIMA ? wallet.minima : wallet.mxusd); }
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
    M.create(mds, relay, me, { side: 'sell', price: '0.02', amount: '10' }, function (err) { T.eq('second sell refused: coins already backing — held vs needed (0.0.102)', err && err.message, 'not enough MINIMA: the order needs 10 MINIMA, this wallet holds 5 MINIMA free (not backing another order, not being spent)'); });
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
    wallet.minima[1].created = '100';                                    // age 1000 > COIN_MAX_AGE 900 at TIP 1100
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
        // 0.0.104: keep-fresh is gone — the free stale coin 42 backs nothing and is left alone
        T.eq('relock spent exactly the stale backing coin', posted.filter(function (c) { return c.indexOf('txninput') === 0; }).map(function (c) { return c.split('coinid:')[1].split(' ')[0]; }), [wallet.minima[0].coinid]);
        T.eq('relock keeps the coin size (0.0.103)', posted.filter(function (c) { return c.indexOf('txnoutput') === 0; }).map(function (c) { return c.split('amount:')[1].split(' ')[0]; }), ['500']);
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

    // 22 Nov 2026: a maker whose `block` read failed treated every coin as fresh (age 0) and re-signed orders backed by
    // coins older than COIN_MAX_AGE — the ghost order 0x77da4748491f267c. An unread tip = freshness unknown = never signed.
    (function () {
        kv.myorders = '[]';
        wallet.minima = [coin('61', F.MINIMA, '500')];
        wallet.minima[0].created = '100';                                // age 1000 at TIP: stale, which an unread tip used to hide
        T.ok('unread tip: no coin counts as fresh', !M.isFresh(wallet.minima[0], 0, 500));
        TIP_FAILS = true;
        var n0 = published.length, e1 = null;
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '100' }, function (err) { e1 = err; });
        T.ok('unread tip: create refuses to sign (' + (e1 && e1.message) + ')', !!e1 && /freshness is unknown/.test(e1.message));
        T.eq('unread tip: nothing published', published.length, n0);
        // an order backed while the tip was readable, refreshed while it is not: re-signed with NO coins, nothing relocked
        TIP_FAILS = false; wallet.minima[0].created = '1000';
        var o = null; M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '100' }, function (err, x) { o = x; });
        T.eq('readable tip: backed', o && o.coins, [wallet.minima[0].coinid]);
        wallet.minima[0].created = '100';                                // the coin has aged out; the tip read now fails
        TIP_FAILS = true; posted.length = 0;
        // 0.0.95: the tick is SKIPPED — nothing re-signed (it used to re-sign every order coinless and pull the whole book)
        var n1 = published.length, before = kv.myorders, eR = null;
        M.refresh(mds, relay, me, function (err) { eR = err; });
        T.eq('unread tip twice: nothing re-signed', published.length, n1);
        T.eq('unread tip twice: orders left exactly as they are', kv.myorders, before);
        T.eq('unread tip twice: kept its coins', M.find(JSON.parse(kv.myorders), o.orderId).coins, [wallet.minima[0].coinid]);
        T.ok('unread tip twice: said (' + (eR && eR.message) + ')', !!eR && /refresh skipped/.test(eR.message));
        T.eq('unread tip: nothing relocked blind', posted.length, 0);
        TIP_FAILS = false;
        // one failed read is retried: the refresh then runs normally (the stale coin is relocked, the order re-backed coinless)
        TIP_FAILS_ONCE = 1;
        M.refresh(mds, relay, me, function () {});
        T.eq('one failed tip read is retried: the refresh ran', TIP_FAILS_ONCE, 0);
        T.ok('retried read: the stale coin was relocked', posted.some(function (c) { return /^txnpost/.test(c); }));
        // edit with an unread tip still refuses
        TIP_FAILS = true; var eE = null;
        M.edit(mds, relay, me, o.orderId, { price: '0.2' }, function (err) { eE = err; });
        T.ok('unread tip: edit refuses (' + (eE && eE.message) + ')', !!eE && /freshness is unknown/.test(eE.message));
        TIP_FAILS = false;
    })();

    // 0.0.95: BACKING COIN MAX AGE is clamped to 1..COIN_MAX_AGE — a light node cannot take an order backed by a coin older than its window.
    // 0.0.101: COIN_MAX_AGE is 900 (owner 22 Nov: 500 is too low; the smallest light-node window measured is ~1024 blocks)
    (function () {
        T.eq('max age: COIN_MAX_AGE is 900', M.COIN_MAX_AGE, 900);
        T.eq('max age: 5000 is read as 900', M.maxAgeOf('5000'), 900);
        T.eq('max age: 900 stays 900, 901 is read as 900', [M.maxAgeOf('900'), M.maxAgeOf('901')], [900, 900]);
        T.eq('max age: 120 stays 120', M.maxAgeOf('120'), 120);
        T.eq('max age: empty / 0 / junk → 900', [M.maxAgeOf(''), M.maxAgeOf('0'), M.maxAgeOf('x')], [900, 900, 900]);
        kv.coin_max_age = '5000'; var got = null;
        M.chainCtx(mds, function (tip, maxAge) { got = maxAge; });
        T.eq('max age: chainCtx hands out at most 900', got, 900);
        delete kv.coin_max_age; got = null;
        M.chainCtx(mds, function (tip, maxAge) { got = maxAge; });
        T.eq('max age: nothing saved → 900', got, 900);
        T.ok('max age: a coin 700 blocks old is fresh at the default', M.isFresh({ created: '400' }, 1100, got));
        T.ok('max age: a coin 900 blocks old is fresh, 901 is not', M.isFresh({ created: '200' }, 1100, 5000) && !M.isFresh({ created: '199' }, 1100, 5000));
        T.ok('max age: a coin 1000 blocks old is not fresh even when 5000 is passed', !M.isFresh({ created: '100' }, 1100, 5000));
        // a 700-block coin backs a new order with nothing saved (it was refused as stale under 500)
        var o7 = null, e7 = null, keep = kv.myorders, keepW = wallet.minima;
        kv.myorders = '[]'; wallet.minima = [coin('71', F.MINIMA, '500')]; wallet.minima[0].created = '400';
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '100' }, function (err, o) { e7 = err; o7 = o; });
        T.ok('max age: a 700-block coin backs an order (' + (e7 && e7.message) + ')', !e7 && o7 && o7.coins[0] === wallet.minima[0].coinid);
        kv.myorders = keep; wallet.minima = keepW;
    })();

    // The ladder batch (owner 2026-10-26): every rung backed from ONE snapshot, never one coin for two orders.
    (function () {
        function c(id, v) { return { coinid: '0x' + id.repeat(32), address: CADDR, tokenid: F.MINIMA, amount: v, spent: false, state: [], created: '1000' }; }
        var minima = [c('a1', '1200'), c('a2', '1200')], list = [{ orderId: '0xA', status: 'live', side: 'sell', coins: [minima[0].coinid] }];
        var a = M.allocate([
            { key: 'A1', orderId: '0xA', side: 'sell', price: '0.0035', amount: '1200' },
            { key: 'A2', orderId: null, side: 'sell', price: '0.0036', amount: '1200' },
            { key: 'A3', orderId: null, side: 'sell', price: '0.0037', amount: '1200' }], minima, [], list, 1100, 500);
        T.ok('batch: edit backed', !a[0].err && a[0].coins.length === 1);
        T.ok('batch: new rung backed', !a[1].err && a[1].coins.length === 1);
        T.ok('batch: no coin shared', a[0].coins[0] !== a[1].coins[0]);
        T.ok('batch: third rung finds nothing', /^not enough/.test(a[2].err || ''));
        var b = M.allocate([{ key: 'X', orderId: null, side: 'sell', price: '0.0035', amount: '1200' }], minima,
                           [], [{ orderId: '0xA', status: 'live', coins: [minima[0].coinid] }, { orderId: '0xB', status: 'live', coins: [minima[1].coinid] }], 1100, 500);
        T.ok('batch: never takes another live order\'s coin', !!b[0].err);
    })();

    // 26 Oct: relays kept CANCELLED orders live because their cancels never arrived — the sweep must find them.
    (function () {
        var ME = '0x' + 'ab'.repeat(32), OTHER = '0x' + 'cd'.repeat(32);
        var list = [{ orderId: '0x01', status: 'cancelled', seq: 5 }, { orderId: '0x02', status: 'filled', seq: 5 },
                    { orderId: '0x03', status: 'live', seq: 9 }, { orderId: '0x04', status: 'live', seq: 4 }];
        var relayHas = [{ signPk: ME, orderId: '0x01', seq: 4 }, { signPk: ME, orderId: '0x02', seq: 4 }, { signPk: ME, orderId: '0x03', seq: 4 },
                        { signPk: ME, orderId: '0x04', seq: 4 }, { signPk: ME, orderId: '0x05', seq: 4 }, { signPk: OTHER, orderId: '0x01', seq: 4 }];
        T.eq('sync: cancelled, filled and outdated mine only', M.stale(relayHas, ME, list).map(function (o) { return o.orderId; }), ['0x01', '0x02', '0x03']);
    })();

    // 28 Oct: the relays restarted (book in memory) and the whole ladder vanished; a live, unexpired order the relay
    // lacks must be re-sent, an expired or cancelled one not.
    (function () {
        var ME = '0x' + 'ab'.repeat(32), NOW = Math.floor(Date.now() / 1000);
        var list = [{ orderId: '0x07', status: 'live', seq: 5, expiry: NOW + 3600 }, { orderId: '0x08', status: 'live', seq: 5, expiry: NOW - 10 },
                    { orderId: '0x09', status: 'cancelled', seq: 5, expiry: NOW + 3600 }];
        T.eq('sync: re-sends a live order the relay lost', M.stale([], ME, list).map(function (o) { return o.orderId; }), ['0x07']);
    })();

    // 0.0.102 (owner 22 Nov 2026): refusing an order because its coins are old, or making the user wait a block to place
    // it, is unacceptable. create/edit place at once; coins too old are relocked now and the order goes live after a block.
    (function () {
      try {
        function txn(re) { return posted.filter(function (c) { return re.test(c); }); }
        kv.myorders = '[]'; posted.length = 0;
        wallet.minima = [coin('81', F.MINIMA, '300'), coin('82', F.MINIMA, '200')];
        wallet.minima[0].created = '100'; wallet.minima[1].created = '150';   // ages 1000 and 950 at TIP 1100: both stale
        var n0 = published.length, o = null, err = null, note = null;
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '400' }, function (e, x, r, nt) { err = e; o = x; note = nt; });
        T.ok('instant: placed at once on stale coins (' + (err && err.message) + ')', !err && !!o && o.status === 'live');
        T.eq('instant: the caller is told', note, 'placed; goes live to takers after the next block (refreshing your coins)');
        T.eq('instant: published once, coinless, the full amount', [published.length - n0, published[published.length - 1].coins, published[published.length - 1].amount], [1, [], '400']);
        T.eq('instant: saved live, coinless, relocking exactly the chosen coins', o && [o.coins, o.relocking], [[], [wallet.minima[0].coinid, wallet.minima[1].coinid]]);
        var ins = txn(/^txninput/);
        T.ok('instant: the relock started at once, spending exactly those coins', ins.length === 2 && ins[0].indexOf(wallet.minima[0].coinid) > 0 && ins[1].indexOf(wallet.minima[1].coinid) > 0 && txn(/^txnpost/).length === 1);
        T.eq('instant: the relock pays the order\'s own address, one coin per input (0.0.103: sizes kept)', txn(/^txnoutput/), ['txnoutput id:' + txn(/^txncreate/)[0].split('id:')[1] + ' amount:300 address:' + ADDR, 'txnoutput id:' + txn(/^txncreate/)[0].split('id:')[1] + ' amount:200 address:' + ADDR]);
        T.ok('instant: kv holds the relocking coins', o && M.find(JSON.parse(kv.myorders), o.orderId).relocking.length === 2);
        T.ok('instant: the service re-backs on the next block', M.awaitingBacking(JSON.parse(kv.myorders)));
        // the relock is in the mempool (checkmempool hides its inputs): refresh relocks nothing more, keeps it coinless
        wallet.minima = []; posted.length = 0;
        var rr = null; M.refresh(mds, relay, me, function (e, n, rl, errs) { rr = [e, rl, errs]; });
        T.eq('instant: nothing relocked twice while the first is unconfirmed', [posted.length, rr[1], rr[2]], [0, null, []]);
        T.eq('instant: still coinless', M.find(JSON.parse(kv.myorders), o.orderId).coins, []);
        // the relock confirmed: the new coin (created this block) backs the order
        wallet.minima = [coin('83', F.MINIMA, '500')]; wallet.minima[0].created = String(TIP);
        M.refresh(mds, relay, me, function () {});
        var ob = M.find(JSON.parse(kv.myorders), o.orderId);
        T.eq('instant: re-backed on the new coin, relocking cleared', [ob.coins, ob.relocking], [[wallet.minima[0].coinid], undefined]);
        T.eq('instant: republished with the coin', published[published.length - 1].coins, [wallet.minima[0].coinid]);
        T.ok('instant: nothing awaits backing', !M.awaitingBacking(JSON.parse(kv.myorders)));
      } catch (e) { T.ok('section threw: ' + e, false); }
    })();
    (function () {   // a genuinely short balance still refuses, plainly; an unread tip keeps the 0.0.92 refusal
      try {
        kv.myorders = '[]'; posted.length = 0;
        wallet.minima = [coin('84', F.MINIMA, '30'), coin('85', F.MINIMA, '20')]; wallet.minima[0].created = '100';   // 30 stale + 20 fresh
        var n0 = published.length, err = null;
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '60' }, function (e) { err = e; });
        T.eq('short: refused plainly, held vs needed', err && err.message, 'not enough MINIMA: the order needs 60 MINIMA, this wallet holds 50 MINIMA free (not backing another order, not being spent)');
        T.eq('short: nothing published, nothing relocked', [published.length - n0, posted.length], [0, 0]);
        wallet.mxusd = [coin('86', F.MXUSD, '1')]; wallet.mxusd[0].created = '100';
        M.create(mds, relay, me, { side: 'buy', price: '0.5', amount: '3' }, function (e) { err = e; });
        T.eq('short: MxUSD the same', err && err.message, 'not enough MxUSD: the order needs 1.5 MxUSD, this wallet holds 1 MxUSD free (not backing another order, not being spent)');
        TIP_FAILS = true; wallet.minima[0].amount = '100';
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '60' }, function (e) { err = e; });
        T.ok('short: an unread tip still refuses (' + (err && err.message) + ')', !!err && /freshness is unknown/.test(err.message));
        T.eq('short: an unread tip relocks nothing', posted.length, 0);
        TIP_FAILS = false;
      } catch (e) { T.ok('section threw: ' + e, false); }
    })();
    (function () {   // a relock failure is never swallowed; the order stays coinless until a retry works
      try {
        kv.myorders = '[]'; posted.length = 0;
        wallet.minima = [coin('87', F.MINIMA, '500')]; wallet.minima[0].created = '100';
        SIGN_FAILS = true; wallet.mxusd = [];
        var o = null, err = null, note = '';
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '100' }, function (e, x, r, nt) { err = e; o = x; note = nt; });
        T.ok('relock fails: still placed (' + (err && err.message) + ')', !err && !!o && o.status === 'live');
        T.ok('relock fails: told (' + note + ')', /^placed, but refreshing your coins failed \(txnsign: the node is locked\)/.test(note));
        T.eq('relock fails: kept on the order', o && M.find(JSON.parse(kv.myorders), o.orderId).relockError, 'txnsign: the node is locked');
        var errs = null, pubBefore = published.length; posted.length = 0;
        // 0.0.106: the failed coin backs off (2 blocks, then 4, …): the same block's refresh does not sign again
        M.refresh(mds, relay, me, function (e, n, rl, x) { errs = x; });
        T.ok('relock fails: no retry inside its backoff', !posted.some(function (c) { return /^txnsign/.test(c); }) && errs.length === 0);
        T.eq('relock fails: the error stays on the order meanwhile', M.find(JSON.parse(kv.myorders), o.orderId).relockError, 'txnsign: the node is locked');
        TIP += 2; posted.length = 0;
        M.refresh(mds, relay, me, function (e, n, rl, x) { errs = x; });
        T.ok('relock fails: refresh retried it after the backoff', posted.some(function (c) { return /^txnsign/.test(c); }));
        T.eq('relock fails: refresh returns it', errs, ['relock of ' + wallet.minima[0].coinid + ' failed: txnsign: the node is locked']);
        T.eq('relock fails: never republished on the stale coin', published.slice(pubBefore).map(function (p) { return p.coins; }), [[], []]);
        TIP += 2; posted.length = 0; SIGN_FAILS = false;
        M.refresh(mds, relay, me, function (e, n, rl, x) { errs = x; });
        T.ok('relock fails: the backoff doubled (4 blocks)', posted.length === 0);
        TIP += 2; posted.length = 0;
        M.refresh(mds, relay, me, function (e, n, rl, x) { errs = x; });
        T.ok('relock fails: the next retry works', posted.some(function (c) { return /^txnpost/.test(c); }) && errs.length === 0);
        T.eq('relock fails: the error is cleared', M.find(JSON.parse(kv.myorders), o.orderId).relockError, undefined);
        TIP = 1100; kv.relock_backoff = '{}';
      } catch (e) { T.ok('section threw: ' + e, false); }
    })();
    (function () {   // edit: the same, and re-pricing again while its own relock confirms
      try {
        kv.myorders = '[]'; posted.length = 0;
        wallet.minima = [coin('88', F.MINIMA, '500')];   // created 1000: fresh
        var o = null; M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '100' }, function (e, x) { o = x; });
        T.eq('edit: backed fresh', o.coins, [wallet.minima[0].coinid]);
        wallet.minima[0].created = '100'; posted.length = 0;
        var err = null, note = null, oe = null;
        M.edit(mds, relay, me, o.orderId, { price: '0.2' }, function (e, x, nt) { err = e; oe = x; note = nt; });
        T.ok('edit: stale coins do not refuse an edit (' + (err && err.message) + ')', !err);
        T.eq('edit: told', note, M.PENDING_NOTICE);
        T.eq('edit: coinless, relocking its coin, re-priced', oe && [oe.coins, oe.relocking, oe.price], [[], [wallet.minima[0].coinid], '0.2']);
        T.ok('edit: relock started', posted.some(function (c) { return /^txnpost/.test(c); }));
        wallet.minima = []; posted.length = 0;
        M.edit(mds, relay, me, o.orderId, { price: '0.3' }, function (e, x, nt) { err = e; note = nt; });
        T.ok('edit in flight: re-priced, still waiting (' + (err && err.message) + ')', !err && note === M.PENDING_NOTICE && posted.length === 0);
        M.edit(mds, relay, me, o.orderId, { price: '0.3', amount: '101' }, function (e) { err = e; });
        T.ok('edit in flight: never for more than the relock brings back', !!err && /^not enough MINIMA/.test(err.message));
      } catch (e) { T.ok('section threw: ' + e, false); }
    })();

    // 0.0.104 (review 22 Nov, probe P1): keep-fresh is removed. It self-sent a FREE coin past two-thirds of the limit and
    // the same refresh then re-backed a coinless order on that very coin (byTok was the pre-relock snapshot). Now a fresh
    // coin is never self-sent, it simply backs the order; relock() keeps one output per input.
    (function () {
      try {
        kv.myorders = '[]'; posted.length = 0; ONCHAIN = {};
        var Fc = coin('f1', F.MINIMA, '40'); Fc.created = String(TIP - 650);   // fresh (650 <= 900), past the old keep-fresh due (600)
        wallet.minima = [Fc]; wallet.mxusd = [];
        kv.myorders = JSON.stringify([{ orderId: '0x0101010101010101', side: 'sell', price: '0.1', amount: '30', remaining: '30', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' }]);
        M.refresh(mds, relay, me, function () {});
        var o = JSON.parse(kv.myorders)[0];
        T.eq('no keep-fresh: a fresh free coin is never self-sent', posted.filter(function (c) { return /^txn/.test(c); }), []);
        T.eq('no keep-fresh: the order is backed by it', o.coins, [Fc.coinid]);
        T.eq('no keep-fresh: no keep_fresh_pending record', kv.keep_fresh_pending, undefined);
        // two orders' stale coins relocked in one pass come back as two coins (one output per input), never merged
        var S1 = coin('s1', F.MINIMA, '30'), S2 = coin('s2', F.MINIMA, '20'); S1.created = S2.created = '100';
        wallet.minima = [S1, S2]; posted.length = 0;
        kv.myorders = JSON.stringify([{ orderId: '0x0a', side: 'sell', price: '0.1', amount: '30', remaining: '30', coins: [S1.coinid], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' },
                                      { orderId: '0x0b', side: 'sell', price: '0.1', amount: '20', remaining: '20', coins: [S2.coinid], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' }]);
        M.refresh(mds, relay, me, function () {});
        T.eq('relock: one output per input, sizes kept', posted.filter(function (c) { return /^txnoutput/.test(c); }).map(function (c) { return c.split('amount:')[1].split(' ')[0]; }), ['30', '20']);
        T.eq('relock: neither order re-signed on a coin being relocked', JSON.parse(kv.myorders).map(function (x) { return x.coins; }), [[], []]);
      } catch (e) { T.ok('section threw: ' + e, false); }
    })();
    // review 22 Nov (M2, probe P2): ONE held rule for every coin chooser — a coin of my pending take / void, or reserved
    // by the resting engine, is never relocked, backed on or allocated; another order's relocking coin is never allocated.
    (function () {
      try {
        function ins() { return posted.filter(function (c) { return /^txninput/.test(c); }); }
        posted.length = 0; ONCHAIN = {}; wallet.mxusd = [];
        var D = coin('d1', F.MINIMA, '500'); D.created = '100';   // stale: create would relock it
        wallet.minima = [D]; kv.myorders = '[]';
        kv.pending_takes = JSON.stringify({ t1: { sent: Date.now(), mine: [D.coinid] } });
        var o = null, err = null; M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '100' }, function (e, x) { err = e; o = x; });
        T.ok('held: create never relocks the coin of my pending take (' + (err && err.message) + ')', !o && !!err && /^not enough MINIMA/.test(err.message) && ins().length === 0);
        delete kv.pending_takes;
        // refresh: a fresh coin being voided never backs a coinless order; a stale backing coin reserved by the resting engine is not relocked
        var V = coin('d2', F.MINIMA, '500'), P = coin('d3', F.MINIMA, '400'); P.created = '100';
        wallet.minima = [V, P]; kv.void_takes = JSON.stringify({ t2: { mine: [V.coinid] } });
        globalThis.PandaCoinLock = { isReserved: function (id) { return id === P.coinid.toLowerCase(); } };
        kv.myorders = JSON.stringify([{ orderId: '0x0c', side: 'sell', price: '0.1', amount: '30', remaining: '30', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' },
                                      { orderId: '0x0d', side: 'sell', price: '0.1', amount: '30', remaining: '30', coins: [P.coinid], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' }]);
        posted.length = 0; M.refresh(mds, relay, me, function () {});
        T.eq('held: refresh backs nothing on a voided coin and relocks no reserved coin', [JSON.parse(kv.myorders).map(function (x) { return x.coins; }), ins().length], [[[], []], 0]);
        delete kv.void_takes; delete globalThis.PandaCoinLock;
        // the ladder batch: never another order's relocking coin, never a coin of my pending take
        var R = coin('d4', F.MINIMA, '500'), K = coin('d5', F.MINIMA, '450');
        var a = M.allocate([{ key: 'A1', orderId: null, side: 'sell', price: '0.1', amount: '100' }], [R], [], [{ orderId: '0x0e', status: 'live', coins: [], relocking: [R.coinid] }], TIP, 900);
        T.ok('held: allocate never takes another order\'s relocking coin', !!a[0].err);
        kv.myorders = '[]'; kv.pending_takes = JSON.stringify({ t3: { sent: Date.now(), mine: [K.coinid] } });
        var errs = null; M.batch(mds, relay, me, [{ key: 'A1', side: 'sell', price: '0.1', amount: '100' }], [K], [], function (e) { errs = e; });
        T.ok('held: the batch never backs a rung on my pending take\'s coin', !!errs && /^not enough/.test(errs.A1 || '') && JSON.parse(kv.myorders).length === 0);
        delete kv.pending_takes;
      } catch (e) { T.ok('section threw: ' + e, false); }
    })();
    // review 22 Nov (M3, probe P3): a relock is capped at 20 inputs and 5 signing addresses (the node's consolidate limits;
    // a TxPoW over 64 KB is refused only after signing), the rest goes in later passes, and a failed set backs off
    // (2 blocks doubling to 64) instead of being re-signed every refresh. MINOR 7: no txpowid = possibly posted.
    (function () {
      try {
        function cnt(re) { return posted.filter(function (c) { return re.test(c); }).length; }
        function mk(id, v, created, addr) { var c = coin(id, F.MINIMA, v); c.created = String(created); if (addr) c.address = addr; return c; }
        kv.relock_backoff = '{}'; wallet.mxusd = []; posted.length = 0;
        var many = [], i; for (i = 0; i < 32; i++) many.push(mk((i < 16 ? '0' : '') + i.toString(16), '1', 150 - i));
        wallet.minima = many.slice();
        kv.myorders = JSON.stringify([{ orderId: '0x0202020202020202', side: 'sell', price: '0.1', amount: '30', remaining: '30', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live', relocking: many.map(function (c) { return c.coinid; }) }]);
        POST_FAILS = 'TxPoW size too large.. 70000/65536';
        for (i = 0; i < 5; i++) M.refresh(mds, relay, me, function () {});
        // the first pass signs 20, the second the other 12 (successive passes); then both sets back off: 2 signatures, not 5 × 32 inputs
        T.eq('relock cap: each failing set is signed once in its window (5 refreshes in one block)', [cnt(/^txnsign/), cnt(/^txninput/)], [2, 32]);
        T.ok('relock cap: the failed set is in kv relock_backoff, 2 blocks', (JSON.parse(kv.relock_backoff || '{}')[many[0].coinid.toLowerCase()] || {}).until === TIP + 2);
        POST_FAILS = null; kv.relock_backoff = '{}'; posted.length = 0;
        var errs = null; M.refresh(mds, relay, me, function (e, n, rl, x) { errs = x; });
        T.eq('relock cap: 32 relocking coins → 20 now', [cnt(/^txninput/), cnt(/^txnpost/), errs], [20, 1, []]);
        wallet.minima = many.slice(20); posted.length = 0;   // the first 20 are in the mempool now
        M.refresh(mds, relay, me, function () {});
        T.eq('relock cap: the other 12 in the next pass', cnt(/^txninput/), 12);
        // 7 signing addresses → the first relock spends coins of 5 of them only
        var A7 = [], got = null; for (i = 0; i < 7; i++) A7.push(mk('7' + i, '1', 100, '0x' + (String(i) + 'a').repeat(32)));
        A7.push(mk('80', '1', 100, A7[0].address)); posted.length = 0; kv.relock_backoff = '{}';
        M.relock(mds, A7, ADDR, function (e, t, sent) { got = sent; });
        T.eq('relock cap: at most 5 signing addresses (a 6th and 7th address wait; a coin of an address already in still joins)', got, [A7[0].coinid, A7[1].coinid, A7[2].coinid, A7[3].coinid, A7[4].coinid, A7[7].coinid]);
        // MINOR 7: posted without a txpowid → no failure, no relockError, no retry until the window passed and the coin is still here
        kv.relock_backoff = '{}'; var P = mk('90', '50', 100); wallet.minima = [P]; posted.length = 0; POST_NO_ID = true;
        kv.myorders = JSON.stringify([{ orderId: '0x0303030303030303', side: 'sell', price: '0.1', amount: '30', remaining: '30', coins: [P.coinid], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' }]);
        errs = null; M.refresh(mds, relay, me, function (e, n, rl, x) { errs = x; });
        T.eq('no txpowid: not reported as a failure, no relockError', [errs, M.find(JSON.parse(kv.myorders), '0x0303030303030303').relockError], [[], undefined]);
        posted.length = 0; M.refresh(mds, relay, me, function () {});
        T.eq('no txpowid: not re-signed at once', cnt(/^txnsign/), 0);
        POST_NO_ID = false; TIP += 2; posted.length = 0;
        M.refresh(mds, relay, me, function () {});
        T.eq('no txpowid: still unspent after the window → relocked again', cnt(/^txnpost/), 1);
        TIP = 1100; kv.relock_backoff = '{}';
      } catch (e) { T.ok('section threw: ' + e, false); }
      POST_FAILS = null; POST_NO_ID = false;
    })();
})();
