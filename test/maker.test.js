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
    var PROVABLE = {}, EXPORTS = [];   // 0.0.113: coin ids `coinexport coinid:` proves (none by default: every coin as before)
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
            if (cmd.indexOf('coinexport coinid:') === 0) { var xc = cmd.split('coinid:')[1]; EXPORTS.push(xc); return PROVABLE[xc] ? cb(null, { data: ('0x00000020' + xc.slice(2) + '00000020' + CADDR.slice(2) + '0123456789ABCDEF'.repeat(50)).slice(0, 900) }) : cb(new Error('cmd failed: coinexport coinid:' + xc + ' — Coin not found coinid : ' + xc)); }
            if (cmd.indexOf('coins relevant:true coinid:') === 0) { var cid = cmd.split('coinid:')[1]; return cb(null, ONCHAIN[cid] ? [{ coinid: cid }] : []); }
            if (cmd.indexOf('coins relevant:true checkmempool:true tokenid:') === 0) { var t = cmd.split('tokenid:')[1]; return cb(null, t === F.MINIMA ? wallet.minima : wallet.mxusd); }
            cb(new Error('unexpected ' + cmd));
        },
        cmd: function (cmd, cb) { cb({ status: true }); },
        sql: function (q, cb) {   // 0.0.144: the dx_lock and the fenced myorders write are wired (a failing lock SQL fails the save)
            var lr = lockSqlFor(kv, MLK)(q); if (lr) return cb(lr);
            if (q === "SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'") return cb({ status: true, rows: Object.keys(kv).filter(function (k) { return k.indexOf('fill_') === 0; }).map(function (k) { return { K: k, V: kv[k] }; }) });
            cb(q === 'SELECT coinid FROM pp_posted_inputs' ? { status: true, rows: CLAIMED.map(function (c) { return { COINID: c }; }) } : { status: false, error: 'no table' });
        }
    };
    var MLK = { row: null }, CLAIMED = [];   // MLK: the main stub's dx_lock row; CLAIMED: pp_posted_inputs (resting/input-claims.js durable claims)
    var published = [];
    var relay = { publish: function (raw, cb) { published.push(JSON.parse(raw)); cb([{ url: 'http://r1', ok: true }]); } };
    /** The node's SQL for exactly the lock / write shapes lib/maker.js sends (the 0.0.132 and the 0.0.142 shapes): st is
     *  the kv store ({k: v}), lk.row the dx_lock row of 'myorders' ({owner, ts}, null before INSERT). */
    function lockSqlFor(st, lk) {
        function unq(x) { return x.split("''").join("'"); }
        return function (stmt) {
            var m;
            if (/^CREATE TABLE IF NOT EXISTS `dx_lock`/.test(stmt)) return { status: true };
            if (/^INSERT INTO `dx_lock`/.test(stmt)) { if (!lk.row) lk.row = { owner: '', ts: 0 }; return { status: true }; }
            if ((m = /^UPDATE `dx_lock` SET `owner`='([^']*)', `ts`=(\d+) WHERE `id`='myorders' AND \(`owner`='' OR `owner` IS NULL OR `ts` < (-?\d+)\)$/.exec(stmt))) { if (!lk.row.owner || lk.row.ts < Number(m[3])) { lk.row.owner = m[1]; lk.row.ts = Number(m[2]); } return { status: true, results: false }; }
            if ((m = /^UPDATE `dx_lock` SET `owner`='([^']*)', `ts`=(\d+) WHERE `id`='myorders' AND \(`owner`='' OR `owner` IS NULL OR `owner`='([^']*)'\)$/.exec(stmt))) { if (!lk.row.owner || lk.row.owner === m[3]) { lk.row.owner = m[1]; lk.row.ts = Number(m[2]); } return { status: true, results: false }; }
            if ((m = /^UPDATE `dx_lock` SET `owner`='' WHERE `id`='myorders' AND `owner`='([^']*)'$/.exec(stmt))) { if (lk.row.owner === m[1]) lk.row.owner = ''; return { status: true, results: false }; }
            if (/^SELECT `owner` FROM `dx_lock`/.test(stmt)) return { status: true, rows: [{ OWNER: lk.row.owner }] };
            if (stmt === "INSERT INTO ax_kv (k, v) SELECT 'myorders', '[]' WHERE NOT EXISTS (SELECT 1 FROM ax_kv WHERE k='myorders')") { if (st.myorders === undefined) st.myorders = '[]'; return { status: true, results: false }; }
            if ((m = /^UPDATE ax_kv SET v='((?:[^']|'')*)' WHERE k='myorders' AND EXISTS \(SELECT 1 FROM `dx_lock` WHERE `id`='myorders' AND `owner`='([^']*)'\)$/.exec(stmt))) { if (lk.row && lk.row.owner === m[2] && st.myorders !== undefined) st.myorders = unq(m[1]); return { status: true, results: false }; }
            if (stmt === "SELECT v FROM ax_kv WHERE k='myorders'") return { status: true, rows: st.myorders === undefined ? [] : [{ V: st.myorders }] };
            return null;
        };
    }

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
    M.afterFill(mds, relay, me, created.orderId, '20', [wallet.minima[0].coinid], function (err, o) { T.ok('afterFill ok', !err); T.eq('remaining', o.remaining, '35'); T.eq('coins dropped', o.coins, []); T.eq('still live', o.status, 'live'); }, '0x' + 'f1'.repeat(32));
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
    M.afterFill(mds, relay, me, buy.orderId, '10', [wallet.mxusd[0].coinid], function (err, o) { T.eq('buy filled', o.status, 'filled'); T.eq('remaining 0', o.remaining, '0'); }, '0x' + 'f2'.repeat(32));

    // DUST (owner 2026-10-22): a fill leaving under 1 MINIMA closes the order; refresh closes an old dust order
    T.ok('dust rule', M.dust('0.00231293', '1000') && !M.dust('1', '1000') && !M.dust('0.5', '0.5') && !M.dust('0', '10'));
    var dd = null;
    wallet.minima = [coin('51', F.MINIMA, '500')];
    M.create(mds, relay, me, { side: 'sell', price: '0.003675', amount: '455.78231293' }, function (err, o) { T.ok('dust order created ' + (err && err.message), !err); dd = o; });
    M.afterFill(mds, relay, me, dd.orderId, '455.78', [], function (err, o) { T.eq('0.00231293 left → closed', o.status, 'filled'); T.eq('remaining kept for the record', o.remaining, '0.00231293'); }, '0x' + 'f3'.repeat(32));
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
        wallet.minima = []; posted.length = 0; ONCHAIN[oe.relocking[0]] = true;   // its relock is in the mempool: unspent on chain
        M.edit(mds, relay, me, o.orderId, { price: '0.3' }, function (e, x, nt) { err = e; note = nt; });
        T.ok('edit in flight: re-priced, still waiting (' + (err && err.message) + ')', !err && note === M.PENDING_NOTICE && posted.length === 0);
        M.edit(mds, relay, me, o.orderId, { price: '0.3', amount: '101' }, function (e) { err = e; });
        T.ok('edit in flight: never for more than the relock brings back', !!err && /^not enough MINIMA/.test(err.message));
        // review 22 Nov (MINOR 1): the relock CONFIRMED (its input spent on chain) and the new coin went elsewhere: not in flight
        ONCHAIN = {}; err = null; note = null;
        M.edit(mds, relay, me, o.orderId, { price: '0.4' }, function (e, x, nt) { err = e; note = nt; });
        T.ok('edit after the relock confirmed elsewhere: refused, not "still waiting" (' + (err && err.message) + ')', !!err && /^not enough MINIMA/.test(err.message) && note !== M.PENDING_NOTICE);
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
    // review 22 Nov (M4): page and service each load myorders, wait on relays, and saved the WHOLE list — the later save
    // undid the other's work. Interleaved on the stand-in store: a relay that holds refresh's publishes until released.
    (function () {
      try {
        var q = [], slow = { publish: function (raw, cb) { q.push(function () { published.push(JSON.parse(raw)); cb([{ url: 'r', ok: true }]); }); } };
        function drain() { while (q.length) q.shift()(); }
        function lastFor(id) { var e = null; published.forEach(function (p) { if (p.orderId === id) e = p; }); return e; }
        function liveSeqs(id) { return published.filter(function (p) { return p.orderId === id && p.amount !== '0'; }).map(function (p) { return p.seq; }); }
        kv.relock_backoff = '{}'; wallet.mxusd = []; posted.length = 0;
        var X1 = coin('c1', F.MINIMA, '100'), Y1 = coin('c2', F.MINIMA, '100'), Z1 = coin('c3', F.MINIMA, '100');
        wallet.minima = [X1, Y1, Z1];
        function two() { return JSON.stringify([{ orderId: '0x0f01', side: 'sell', price: '0.1', amount: '50', remaining: '50', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' },
                                                { orderId: '0x0f02', side: 'sell', price: '0.1', amount: '50', remaining: '50', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' }]); }
        // 1. the user cancels X while refresh's re-sign of X is on its way to the relays: the cancel wins, locally and on the relays
        kv.myorders = two();
        M.refresh(mds, slow, me, function () {});
        T.eq('M4: refresh is waiting on the relay with its re-sign of X', q.length, 1);
        var ce = null; M.cancel(mds, relay, me, '0x0f01', function (e) { ce = e; });
        drain();
        var X = M.find(JSON.parse(kv.myorders), '0x0f01');
        T.ok('M4: cancel during refresh — stored cancelled (' + (ce && ce.message) + ')', !ce && X.status === 'cancelled');
        T.ok('M4: cancel during refresh — the relays end on the cancel, above every live re-sign', lastFor('0x0f01').amount === '0' && liveSeqs('0x0f01').every(function (sq) { return sq < lastFor('0x0f01').seq; }));
        T.eq('M4: refresh still re-backed the other order', M.find(JSON.parse(kv.myorders), '0x0f02').coins.length, 1);
        // 2. the user cancels Y while refresh waits on X: refresh never re-signs Y
        kv.myorders = two(); var n0 = published.length;
        M.refresh(mds, slow, me, function () {});
        M.cancel(mds, relay, me, '0x0f02', function () {});
        drain();
        T.eq('M4: an order cancelled during refresh is never re-signed live by it', published.slice(n0).filter(function (p) { return p.orderId === '0x0f02' && p.amount !== '0'; }).length, 0);
        T.eq('M4: and stays cancelled', M.find(JSON.parse(kv.myorders), '0x0f02').status, 'cancelled');
        // 3. the user creates an order while refresh waits: it survives refresh's save
        kv.myorders = two(); var made = null;
        M.refresh(mds, slow, me, function () {});
        M.create(mds, relay, me, { side: 'sell', price: '0.2', amount: '10' }, function (e, o) { made = o; });
        drain();
        T.ok('M4: an order created during refresh survives it', !!made && !!M.find(JSON.parse(kv.myorders), made.orderId) && JSON.parse(kv.myorders).length === 3);
        // 4. refresh saved first, the page's cancel saves after: the cancel still wins and goes out above refresh's seq
        kv.myorders = two(); var slowC = { publish: slow.publish }, n4 = published.length;
        M.cancel(mds, slowC, me, '0x0f01', function () {});   // the cancel waits on the relay…
        M.refresh(mds, relay, me, function () {});            // …while a whole refresh re-signs X and saves
        drain();
        X = M.find(JSON.parse(kv.myorders), '0x0f01');
        var mine4 = published.slice(n4).filter(function (p) { return p.orderId === '0x0f01'; }), last4 = mine4[mine4.length - 1];   // this case's publishes only (seqs are clock seconds)
        T.ok('M4: refresh first, cancel second — stored cancelled, relays end on the cancel', X.status === 'cancelled' && last4.amount === '0' && mine4.every(function (p) { return p.amount === '0' || p.seq < last4.seq; }));
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 23 Nov (M4): a user edit racing a fill must never put a filled or part-filled order back at its old size,
    // and no merge brings a filled order back; (MINOR) a field another writer changed is not silently overwritten, and a
    // change that lost a conflict never wins the same caller's next save.
    (function () {
      try {
        var q = [], slow = { publish: function (raw, cb) { q.push(function () { published.push(JSON.parse(raw)); cb([{ url: 'r', ok: true }]); }); } };
        function drain() { while (q.length) q.shift()(); }
        var from = 0;   // each case reads only its own publishes (seqs are clock seconds: an earlier case may hold a higher one)
        function lastFor(id) { var e = null; published.slice(from).forEach(function (p) { if (p.orderId === id && (!e || p.seq > e.seq)) e = p; }); return e; }
        kv.relock_backoff = '{}'; wallet.mxusd = []; posted.length = 0; kv.legacy_fresh = '';
        var A1 = coin('e1', F.MINIMA, '100'), A2 = coin('e2', F.MINIMA, '200');
        wallet.minima = [A1, A2];
        function one(rem) { return JSON.stringify([{ orderId: '0x0e01', side: 'sell', price: '0.1', amount: '100', remaining: rem || '100', coins: [A1.coinid], scripts: ['RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')'], address: ADDR, seq: 1, expiry: 9e9, status: 'live' }]); }
        function stored() { return M.find(JSON.parse(kv.myorders), '0x0e01'); }
        // the fill lands INSIDE the user action: between its load and its save (the hook runs once, on the action's
        // `scripts` read of the wallet — after its load, before it saves)
        var hook = null, mdsH = Object.create(mds);
        mdsH.cmdR = function (c, cb) { if (c === 'scripts' && hook) { var h = hook; hook = null; h(); } mds.cmdR(c, cb); };
        // 1. part-filled while editing: the edit is refused, NOTHING of it reaches a relay, the order stays at what is left
        kv.myorders = one(); var ee = null, eo = null; from = published.length;
        hook = function () { M.afterFill(mds, relay, me, '0x0e01', '60', [A1.coinid], function () {}, '0x' + '61'.repeat(32), '100'); };
        M.edit(mdsH, relay, me, '0x0e01', { price: '0.11' }, function (e, x) { ee = e; eo = x; });
        T.eq('M4: part-filled while editing — the edit is refused, saying what is left', ee && ee.message, 'part of this order filled while you were editing (40 MINIMA left) — nothing was changed; edit it again');
        T.eq('M4: part-filled while editing — stored at what the fill left, the old price', [stored().remaining, stored().price, stored().status], ['40', '0.1', 'live']);
        T.eq('M4: part-filled while editing — the relays end on 40 at the top seq', lastFor('0x0e01').amount, '40');
        T.eq('MINOR-6: the refused edit never reached a relay (no envelope at its price)', published.slice(from).filter(function (p) { return p.orderId === '0x0e01' && p.price === '0.11'; }).length, 0);
        // 2. filled while editing: never live again, nothing of the edit published
        kv.myorders = one(); ee = null; from = published.length;
        hook = function () { M.afterFill(mds, relay, me, '0x0e01', '100', [A1.coinid], function () {}, '0x' + '62'.repeat(32), '100'); };
        M.edit(mdsH, relay, me, '0x0e01', { price: '0.11', amount: '150' }, function (e) { ee = e; });
        T.eq('M4: filled while editing — refused', ee && ee.message, 'this order filled while you were editing — nothing was changed');
        T.eq('M4: filled while editing — stays filled, the relays end on amount 0', [stored().status, lastFor('0x0e01').amount], ['filled', '0']);
        T.eq('MINOR-6: ... and no envelope of the refused edit (150 @ 0.11) was published', published.slice(from).filter(function (p) { return p.orderId === '0x0e01' && p.amount === '150'; }).length, 0);
        // 3. the edit saves first, the fill (loaded before it) second: the fill is applied to the edit, capped by what it left
        kv.myorders = one(); ee = null; from = published.length;
        M.afterFill(mds, slow, me, '0x0e01', '60', [A1.coinid], function () {}, '0x' + '65'.repeat(32));
        M.edit(mds, relay, me, '0x0e01', { price: '0.11', amount: '150' }, function (e) { ee = e; });
        drain();
        T.eq('M4: edited while filling — the edit lands, the fill re-applied: min(150, 100) − 60 left', [ee, stored().remaining, stored().price, stored().status], [null, '40', '0.11', 'live']);
        T.eq('M4: edited while filling — the fill\'s spent coin is dropped from the edit\'s coins', stored().coins.indexOf(A1.coinid), -1);
        T.eq('M4: edited while filling — the relays end on 40', lastFor('0x0e01').amount, '40');
        // 3b. 0.0.139: the edit landed between the take's check and afterFill's LOAD (no conflict at all): the fill still
        // counts against the size the take was checked against — an order that sold all of it never shows 150 − 100 = 50
        kv.myorders = one(); ee = null;
        M.edit(mds, relay, me, '0x0e01', { price: '0.11', amount: '150' }, function (e) { ee = e; });
        var fe3 = 'x'; M.afterFill(mds, relay, me, '0x0e01', '100', [A1.coinid], function (e) { fe3 = e; }, '0x' + '63'.repeat(32), '100');
        T.eq('0.0.139: an edit before the fill\'s load: min(150, 100) − 100 = 0, the order closed', [fe3, stored().status, stored().remaining], [null, 'filled', '0']);
        // 4. a cancel racing the last fill: the filled record stands, the cancel says so, nothing cancelled is published
        kv.myorders = one(); ee = null; from = published.length;
        var mdsC = Object.create(mds), seenC = 0;
        // the last fill lands between the cancel's load and its save (0.0.144: just before the cancel takes the store lock)
        mdsC.sql = function (q, cb) { if (/^UPDATE `dx_lock` SET `owner`='w/.test(q) && ++seenC === 1) M.afterFill(mds, relay, me, '0x0e01', '100', [A1.coinid], function () {}, '0x' + '64'.repeat(32), '100'); mds.sql(q, cb); };
        M.cancel(mdsC, relay, me, '0x0e01', function (e) { ee = e; });
        T.eq('M4: cancel racing the last fill — stored filled, told', [stored().status, ee && ee.message], ['filled', 'this order filled before the cancel landed — nothing to cancel']);
        // 5. MINOR: a field another writer changed meanwhile (relockError, no seq change) survives a save that left it alone
        kv.myorders = one(); var L1 = null; M.load(mds, function (e, l) { L1 = l; });
        var st = JSON.parse(kv.myorders); st[0].relockError = 'relock: txnsign: the node is locked'; kv.myorders = JSON.stringify(st);
        L1[0].expiry = 9e9 + 1;
        M.save(mds, L1, function () {}, false);
        T.eq('MINOR: relockError set by another writer is not overwritten', [stored().relockError, stored().expiry], ['relock: txnsign: the node is locked', 9e9 + 1]);
        // 6. MINOR: a change that lost a conflict never wins this caller's next save
        kv.myorders = JSON.stringify(JSON.parse(one()).concat([{ orderId: '0x0e02', side: 'sell', price: '0.2', amount: '5', remaining: '5', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live' }]));
        var L2 = null; M.load(mds, function (e, l) { L2 = l; });
        st = JSON.parse(kv.myorders); st[0].status = 'cancelled'; st[0].seq = 7; kv.myorders = JSON.stringify(st);   // the page cancelled it
        L2[0].expiry = 1; L2[0].seq = 3;                                                                                // a background re-sign
        var lostIds = null; M.save(mds, L2, function (e, b, lost) { lostIds = lost; }, false);
        T.eq('MINOR: the background change lost', [lostIds, stored().status], [['0x0e01'], 'cancelled']);
        M.find(L2, '0x0e02').price = '0.21'; M.find(L2, '0x0e02').seq = 2;
        M.save(mds, L2, function () {}, false);
        T.eq('MINOR: its next save (another order changed) leaves the cancel standing', [stored().status, stored().seq, M.find(JSON.parse(kv.myorders), '0x0e02').price], ['cancelled', 7, '0.21']);
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 23 Nov (MINOR): on the page PandaCoinLock / PoolInputClaims do not exist (index.html loads neither): holds()
    // reads the service's kv mirror and the durable claims table instead, so create never picks a reserved coin
    (function () {
      try {
        T.ok('page context: no PandaCoinLock, no PoolInputClaims here', typeof PandaCoinLock === 'undefined' && typeof PoolInputClaims === 'undefined');
        kv.myorders = '[]'; kv.relock_backoff = '{}'; kv.legacy_fresh = '0'; wallet.mxusd = []; TIP = 1100;
        var R1 = coin('f1', F.MINIMA, '500'), R2 = coin('f2', F.MINIMA, '400'), R3 = coin('f3', F.MINIMA, '300');
        wallet.minima = [R1, R2, R3];
        var lock = {}; lock[R1.coinid.toLowerCase()] = Date.now() + 60000; lock[R3.coinid.toLowerCase()] = Date.now() - 1;   // R3's reservation expired
        kv.coinlock_held = JSON.stringify(lock); CLAIMED = [R2.coinid.toLowerCase()];
        var o = null, err = null;
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '250' }, function (e, x) { err = e; o = x; });
        T.eq('MINOR: the page skips a coin the service reserved (kv coinlock_held) and one claimed by a posted resting txn', [err && err.message, o && o.coins], [null, [R3.coinid]]);
        kv.coinlock_held = '{}'; CLAIMED = []; kv.myorders = '[]';
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 23 Nov (MAJOR-1): save()'s read and write of kv myorders must not interleave with another writer's — the page and
    // the service, both directions, at every offset. An async stand-in for the node's kv + SQL (one step per command,
    // FIFO) runs the page's cancel of Y and the service's fill of X side by side.
    (function () {
      try {
        var store = {}, q = [], realNow = Date.now, fake = 0;   // (lockReady is per runtime: the row is made by the first save of this file)
        function later(f) { q.push(f); }
        function drain() { var n = 0; while (q.length && n++ < 100000) q.shift()(); }
        var LK = { row: { owner: '', ts: 0 } };
        function lockSql(stmt) { return lockSqlFor(store, LK)(stmt) || { status: false, error: 'unexpected ' + stmt }; }
        var amds = {
            kvGet: function (k, d, cb) { later(function () { cb(store[k] === undefined ? d : store[k]); }); },
            kvSet: function (k, v, cb) { later(function () { store[k] = v; cb(null); }); },
            sql: function (stmt, cb) { later(function () { cb(lockSql(stmt)); }); } };
        function start() { return JSON.stringify([{ orderId: 'X', side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: ['0xc1'], status: 'live', seq: 1 },
                                                   { orderId: 'Y', side: 'sell', price: '0.2', amount: '50', remaining: '50', coins: ['0xc2'], status: 'live', seq: 1 }]); }
        var bad = [];
        [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8].forEach(function (k) {   // -1: both start at once (the second's read lands inside the first's read→write gap)
            ['page first', 'service first'].forEach(function (order) {
                store = { myorders: start() }; LK.row = LK.row ? { owner: '', ts: 0 } : null; q = [];
                var page = null, svc = null, done = 0;
                M.load(amds, function (e, l) { page = l; }); M.load(amds, function (e, l) { svc = l; }); drain();
                M.find(page, 'Y').status = 'cancelled'; M.find(page, 'Y').seq = 2;                                       // the page cancels Y
                var x = M.find(svc, 'X'); x.status = 'filled'; x.remaining = '0'; x.seq = 2;                              // the service: X filled
                var a = order === 'page first' ? function () { M.save(amds, page, function () { done++; }, true); } : function () { M.save(amds, svc, function () { done++; }, false); };
                var b = order === 'page first' ? function () { M.save(amds, svc, function () { done++; }, false); } : function () { M.save(amds, page, function () { done++; }, true); };
                a(); if (k < 0) b(); else { for (var i = 0; i < k; i++) later(function () { }); later(b); }   // the second writer starts k steps later
                drain();
                var st = JSON.parse(store.myorders), X = M.find(st, 'X'), Y = M.find(st, 'Y');
                if (done !== 2 || X.status !== 'filled' || X.remaining !== '0' || Y.status !== 'cancelled') bad.push(order + ' +' + k + ': X ' + X.status + '/' + X.remaining + ', Y ' + Y.status);
            });
        });
        T.eq('MAJOR-1: the page\'s cancel of Y and the service\'s fill of X both land, whoever writes first, at every offset', bad, []);
        // a lock that is never released (a holder that died) is taken over once THIS writer has seen it unchanged for the
        // TTL by its own clock; one that is fresh makes the save fail loudly
        Date.now = function () { return realNow() + fake; };
        store = { myorders: start() }; LK.row = { owner: 'someone-else', ts: realNow() }; q = [];
        var L = null, err = null; M.load(amds, function (e, l) { L = l; }); drain();
        M.find(L, 'Y').status = 'cancelled'; M.save(amds, L, function (e) { err = e; }, true); drain();
        T.ok('MAJOR-1: a lock held by another writer: the save fails loudly, nothing written (' + (err && err.message) + ')', !!err && /held by another writer/.test(err.message) && M.find(JSON.parse(store.myorders), 'Y').status === 'live');
        LK.row = { owner: 'died', ts: realNow() - 60000 }; err = 'x';
        M.save(amds, L, function (e) { err = e; }, true); drain();
        T.ok('lease (0.0.142): a holder\'s old `ts` is not judged — a lock first seen now is not taken over at once (' + (err && err.message) + ')', !!err && /held by another writer/.test(err.message) && LK.row.owner === 'died');
        fake += 16000; err = 'x';
        M.save(amds, L, function (e) { err = e; }, true); drain();
        T.ok('MAJOR-1: a stale lock (seen unchanged for the TTL by this writer\'s clock) is taken over and the save lands', err === null && M.find(JSON.parse(store.myorders), 'Y').status === 'cancelled' && LK.row.owner === '');
        // lease (0.0.142): a page whose clock runs an hour slow holds the lock (its ts looks an hour old): the service must
        // not take it over — it waits, and fails loudly; the page's save then lands
        store = { myorders: start() }; LK.row = { owner: '', ts: 0 }; q = []; fake = 0;
        var Lp = null, Ls = null, ep = 'x', es = 'x'; M.load(amds, function (e, l) { Lp = l; }); M.load(amds, function (e, l) { Ls = l; }); drain();
        M.find(Lp, 'Y').status = 'cancelled'; M.find(Lp, 'Y').seq = 2;
        LK.row = { owner: 'wpage.1', ts: realNow() - 3600000 };                                // the page holds it, its clock an hour behind
        M.find(Ls, 'Y').price = '0.25'; M.find(Ls, 'Y').seq = 3;                                  // a background re-price of Y meanwhile
        M.save(amds, Ls, function (e) { es = e; }, false); drain();
        T.ok('lease (0.0.142): a holder whose clock is behind is not robbed — the other save fails loudly (' + (es && es.message) + ')', !!es && /held by another writer/.test(es.message) && M.find(JSON.parse(store.myorders), 'Y').price === '0.2');
        // the stalled holder: the page takes the lock and reads, then stalls past the TTL; the service sees its token unchanged
        // for 15 s by its own clock, takes over and saves X filled; the page then wakes and writes — it must write NOTHING
        store = { myorders: start() }; LK.row = { owner: '', ts: 0 }; q = []; fake = 0;
        var P = null, S = null, pe = 'x', se = 'x', stalled = null;
        M.load(amds, function (e, l) { P = l; }); M.load(amds, function (e, l) { S = l; }); drain();
        M.find(P, 'Y').status = 'cancelled'; M.find(P, 'Y').seq = 2;
        var xs = M.find(S, 'X'); xs.status = 'filled'; xs.remaining = '0'; xs.seq = 2;
        var pmds = Object.create(amds), reads = 0;
        pmds.kvGet = function (k, d, cb) { if (k === 'myorders' && ++reads === 1) { stalled = function () { amds.kvGet(k, d, cb); }; return; } amds.kvGet(k, d, cb); };   // the page's read inside its lock stalls
        pmds.sql = function (stmt, cb) { if (stmt === "SELECT v FROM ax_kv WHERE k='myorders'" && !stalled && reads === 0) { reads++; stalled = function () { amds.sql(stmt, cb); }; return; } amds.sql(stmt, cb); };
        M.save(pmds, P, function (e) { pe = e; }, true); drain();
        T.ok('lease: the page holds the lock, stalled', !!stalled && /^w/.test(LK.row.owner));
        M.save(amds, S, function (e) { se = e; }, false); drain();
        T.ok('lease: the service waits on the stalled page (' + (se && se.message) + ')', !!se && /held by another writer/.test(se.message));
        fake += 16000; se = 'x';
        M.save(amds, S, function (e) { se = e; }, false); drain();
        T.ok('lease: after 15 s by the service\'s clock it takes over and saves X filled (' + (se && se.message) + ')', se === null && M.find(JSON.parse(store.myorders), 'X').status === 'filled');
        var sf = stalled; stalled = null; sf(); drain();
        var st2 = JSON.parse(store.myorders);
        T.ok('lease (0.0.142): the stalled page wakes and writes NOTHING — X stays filled, the page is told (' + (pe && pe.message) + ')', M.find(st2, 'X').status === 'filled' && M.find(st2, 'X').remaining === '0' && !!pe && pe !== 'x' && M.find(st2, 'Y').status === 'live');
        Date.now = realNow;
      } catch (e) { Date.now = realNow; T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 23 Nov (MINOR-3): afterFill that loses every round must say so (never a silent success), and refresh deducts the
    // fill from its kv fill_ record — once (idempotent, the applied txpowids are kept on the order)
    (function () {
      try {
        var TX = '0x' + 'AA'.repeat(32), TX2 = '0x' + 'BB'.repeat(32), t = Math.floor(Date.now() / 1000);
        wallet.minima = [coin('d1', F.MINIMA, '500')]; wallet.mxusd = []; TIP = 1100; kv.relock_backoff = '{}'; kv.legacy_fresh = '0';
        kv.myorders = JSON.stringify([{ orderId: 'Z', side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: [wallet.minima[0].coinid], scripts: ['RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')'], address: ADDR, seq: 1, expiry: 9e9, status: 'live', fillsFrom: t - 60 },
                                      { orderId: 'W', side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: [wallet.minima[0].coinid], scripts: ['RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')'], address: ADDR, seq: 1, expiry: 9e9, status: 'live', fillsFrom: t - 60 }]);
        kv['fill_' + TX] = JSON.stringify({ role: 'maker', orderId: 'Z', side: 'sell', price: '0.1', filled: '30', txpowid: TX, ts: t, status: 'settling' });
        kv['fill_' + TX2] = JSON.stringify({ role: 'maker', orderId: 'W', side: 'sell', price: '0.1', filled: '20', txpowid: TX2, ts: t, status: 'settling' });
        // a user edit lands inside every one of afterFill's saves (its read inside the lock sees a moved stored copy)
        var reads = 0, mdsE = Object.create(mds), lastQ = '';
        mdsE.sql = function (q, cb) {   // 0.0.144: the save reads the stored list by SQL right after taking the lock
            if (q === "SELECT v FROM ax_kv WHERE k='myorders'" && /^SELECT `owner` FROM `dx_lock`/.test(lastQ)) { reads += 2; var st = JSON.parse(kv.myorders), z = M.find(st, 'Z'); z.seq += 10; z.price = String(0.1 + reads / 1000); kv.myorders = JSON.stringify(st); }
            lastQ = q; mds.sql(q, cb);
        };
        var fe = 'none';
        M.afterFill(mdsE, relay, me, 'Z', '30', [], function (e) { fe = e; }, TX);
        T.ok('MINOR-3: afterFill that lost every round reports an ERROR (' + (fe && fe.message) + ')', fe && /was NOT applied to order Z/.test(fe.message));
        T.eq('MINOR-3: ... and the stored remaining is not deducted yet', M.find(JSON.parse(kv.myorders), 'Z').remaining, '100');
        // W's fill applied normally: its txpowid is kept on the order
        M.afterFill(mds, relay, me, 'W', '20', [], function () { }, TX2);
        T.eq('MINOR-3: an applied fill is recorded on the order', [M.find(JSON.parse(kv.myorders), 'W').remaining, M.find(JSON.parse(kv.myorders), 'W').fills], ['80', [TX2]]);
        M.refresh(mds, relay, me, function () { });
        T.eq('MINOR-3: refresh deducts the unapplied fill from its record, once; the applied one is not deducted again', [M.find(JSON.parse(kv.myorders), 'Z').remaining, M.find(JSON.parse(kv.myorders), 'W').remaining], ['70', '80']);
        M.refresh(mds, relay, me, function () { });
        T.eq('MINOR-3: a second refresh changes nothing (idempotent)', [M.find(JSON.parse(kv.myorders), 'Z').remaining, M.find(JSON.parse(kv.myorders), 'Z').fills], ['70', [TX]]);
        delete kv['fill_' + TX]; delete kv['fill_' + TX2]; kv.myorders = '[]';
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 23 Nov (0.0.143): the node's Rhino has no setTimeout and MDS.sql calls back synchronously; the lock retry must
    // be a loop of constant depth (it recursed: 200 tries ≈ 1000 frames, past Rhino's 1024), fail loudly when its budget
    // is spent, and a fill whose save failed that way must not be lost (refresh deducts it from its fill_ record, once)
    (function () {
      var realNow = Date.now, fake = 0;
      try {
        var t = Math.floor(realNow() / 1000), TX3 = '0x' + 'C3'.repeat(32), LK2 = { row: { owner: 'wother.1', ts: realNow() } }, depth = 0, maxDepth = 0;
        kv.myorders = JSON.stringify([{ orderId: 'V', side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live', fillsFrom: t - 60 }]);
        kv['fill_' + TX3] = JSON.stringify({ role: 'maker', orderId: 'V', side: 'sell', price: '0.1', filled: '25', txpowid: TX3, ts: t, status: 'settling', verified: '100' });
        var smds = Object.create(mds);
        smds.sql = function (q, cb) { depth++; maxDepth = Math.max(maxDepth, depth); try { var r = lockSqlFor(kv, LK2)(q); if (r) cb(r); else mds.sql(q, cb); } finally { depth--; } };
        Date.now = function () { fake += 5; return realNow() + fake; };
        var fe = 'none', threw = null;
        try { M.afterFill(smds, relay, me, 'V', '25', [], function (e) { fe = e; }, TX3, '100'); } catch (e) { threw = e; }
        Date.now = realNow;
        T.ok('0.0.143: a held lock with synchronous SQL and no setTimeout: no throw, the caller gets the error (' + (threw || (fe && fe.message)) + ')', !threw && !!fe && /held by another writer/.test(fe.message));
        T.ok('0.0.143: the retry loop keeps a constant stack depth (max nested SQL calls ' + maxDepth + ')', maxDepth <= 6);
        T.eq('0.0.143: ... nothing deducted by the failed save', M.find(JSON.parse(kv.myorders), 'V').remaining, '100');
        LK2.row.owner = '';
        M.refresh(smds, relay, me, function () { });
        M.refresh(smds, relay, me, function () { });
        T.eq('0.0.143: the fill whose save failed is deducted by the next refresh, once', M.find(JSON.parse(kv.myorders), 'V').remaining, '75');
        delete kv['fill_' + TX3]; kv.myorders = '[]';
      } catch (e) { Date.now = realNow; T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 23 Nov (0.0.144): wired SQL that fails never means "unlocked": the save fails loudly and is logged; and the
    // save's read of the stored list is never a failed read taken for '[]' (it wrote a list missing every stored order)
    (function () {
      var logs = [];
      try {
        globalThis.MDS = { log: function (s) { logs.push(s); } };
        var two = JSON.stringify([{ orderId: 'K1', side: 'sell', price: '0.1', amount: '10', remaining: '10', coins: [], status: 'live', seq: 1 },
                                  { orderId: 'K2', side: 'sell', price: '0.2', amount: '10', remaining: '10', coins: [], status: 'live', seq: 1 }]);
        kv.myorders = two;
        var dead = Object.create(mds), L = null, err = 'x';
        dead.sql = function (q, cb) { cb({ status: false, error: 'Database is closed' }); };
        M.load(mds, function (e, l) { L = l; });
        L.push({ orderId: 'K3', side: 'sell', price: '0.3', amount: '5', remaining: '5', coins: [], status: 'live', seq: 1 });
        M.save(dead, L, function (e) { err = e; }, true);
        T.ok('0.0.144: the lock SQL fails: the save fails loudly (' + (err && err.message) + ') and writes nothing', !!err && /could not be used \(Database is closed\)/.test(err.message) && kv.myorders === two);
        T.ok('0.0.144: ... and it is logged', logs.some(function (l) { return /myorders store lock could not be used/.test(l); }));
        // the read under the lock fails (kvGet would answer its default '[]')
        var blind = Object.create(mds), reads = 0; err = 'x';
        blind.kvGet = function (k, d, cb) { if (k === 'myorders' && ++reads > 1) return cb(d); mds.kvGet(k, d, cb); };
        blind.sql = function (q, cb) { if (q === "SELECT v FROM ax_kv WHERE k='myorders'") return cb({ status: false, error: 'read timed out' }); mds.sql(q, cb); };
        M.load(blind, function (e, l) { L = l; });
        L.push({ orderId: 'K3', side: 'sell', price: '0.3', amount: '5', remaining: '5', coins: [], status: 'live', seq: 1 });
        M.save(blind, L, function (e) { err = e; }, true);
        T.ok('NIT (0.0.144): a failed read of the stored list fails the save (' + (err && err.message) + ') — never a list missing the stored orders', !!err && /could not be read/.test(err.message) && kv.myorders === two);
        kv.myorders = '{"not":"a list"'; err = 'x';
        M.load(mds, function (e, l) { L = l; });
        L.push({ orderId: 'K3', side: 'sell', price: '0.3', amount: '5', remaining: '5', coins: [], status: 'live', seq: 1 });
        M.save(mds, L, function (e) { err = e; }, true);
        T.ok('NIT (0.0.144): an unreadable stored value fails the save (' + (err && err.message) + ') and is left as it is', !!err && /unreadable/.test(err.message) && kv.myorders === '{"not":"a list"');
        kv.myorders = '[]';
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
      delete globalThis.MDS;
    })();
    // review 23 Nov (0.0.145): reconcileFills follows the 0.0.139 rule — a fill counts against the size its take was
    // checked against (`verified` on the fill_ record), not against an edit saved after the check
    (function () {
      try {
        var t = Math.floor(Date.now() / 1000), TX4 = '0x' + 'E5'.repeat(32), TX5 = '0x' + 'E6'.repeat(32);
        // the take was checked at 100 and sold all 100; its afterFill failed; the owner's edit to 150 was saved meanwhile
        kv.myorders = JSON.stringify([{ orderId: 'R', side: 'sell', price: '0.1', amount: '150', remaining: '150', coins: [], scripts: [], address: ADDR, seq: 5, expiry: 9e9, status: 'live', fillsFrom: t - 60 },
                                      { orderId: 'Q', side: 'sell', price: '0.1', amount: '80', remaining: '80', coins: [], scripts: [], address: ADDR, seq: 5, expiry: 9e9, status: 'live', fillsFrom: t - 60 }]);
        kv['fill_' + TX4] = JSON.stringify({ role: 'maker', orderId: 'R', side: 'sell', price: '0.1', filled: '100', txpowid: TX4, ts: t, status: 'settling', verified: '100' });
        kv['fill_' + TX5] = JSON.stringify({ role: 'maker', orderId: 'Q', side: 'sell', price: '0.1', filled: '30', txpowid: TX5, ts: t, status: 'settling' });   // a record from before 0.0.145
        M.refresh(mds, relay, me, function () { });
        var st = JSON.parse(kv.myorders);
        T.eq('0.0.145: an unapplied fill checked at 100 (sold 100) closes the order an edit raised to 150: min(150, 100) − 100', [M.find(st, 'R').remaining, M.find(st, 'R').status], ['0', 'filled']);
        T.eq('0.0.145: a record without `verified` (before 0.0.145): stored − filled', M.find(st, 'Q').remaining, '50');
        delete kv['fill_' + TX4]; delete kv['fill_' + TX5]; kv.myorders = '[]';
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 23 Nov (0.0.146, the previous reviewer's desk case): a host that calls afterFill WITHOUT the fill's txpowid
    // (DexiconPro's service.desktop.js) — the fill must be deducted exactly once, never by afterFill and again by refresh
    (function () {
      try {
        var t = Math.floor(Date.now() / 1000), TX6 = '0x' + 'A6'.repeat(32), fe = 'none';
        kv.myorders = JSON.stringify([{ orderId: 'D', side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: [], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live', fillsFrom: t - 60 }]);
        kv['fill_' + TX6] = JSON.stringify({ role: 'maker', orderId: 'D', side: 'sell', price: '0.1', filled: '40', txpowid: TX6, ts: t, status: 'settling', verified: '100' });
        M.afterFill(mds, relay, me, 'D', '40', [], function (e) { fe = e; });   // desk-style: no txpowid, no verified
        T.ok('0.0.146: afterFill without a txpowid fails loudly (' + (fe && fe.message) + ')', !!fe && /needs its txpowid/.test(fe.message));
        M.refresh(mds, relay, me, function () { });
        M.refresh(mds, relay, me, function () { });
        T.eq('0.0.146: the fill is deducted exactly once (by refresh, from its record)', M.find(JSON.parse(kv.myorders), 'D').remaining, '60');
        delete kv['fill_' + TX6]; kv.myorders = '[]';
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
    // review 22 Nov (MINOR 5): NEWBLOCK refreshes only for an order coinless BECAUSE a relock of its coins is pending
    T.ok('awaitingBacking: a coinless order with nothing relocking does not refresh every block', !M.awaitingBacking([{ status: 'live', coins: [] }]));
    T.ok('awaitingBacking: a coinless order whose relock is pending does', M.awaitingBacking([{ status: 'live', coins: [], relocking: ['0x01'] }]));
    // review 22 Nov (NIT): placement never self-sends a coin that is already fresh — it is held for the order in
    // `relocking` (no other order takes it) and backs it once the stale ones come back.
    (function () {
      try {
        kv.myorders = '[]'; kv.relock_backoff = '{}'; posted.length = 0; ONCHAIN = {}; wallet.mxusd = [];
        var Fr = coin('b3', F.MINIMA, '300'), St = coin('b4', F.MINIMA, '200'); St.created = '100';   // Fr fresh, St stale
        wallet.minima = [Fr, St];
        var o = null; M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '400' }, function (e, x) { o = x; });
        T.eq('placement: only the stale coin is relocked', posted.filter(function (c) { return /^txninput/.test(c); }).map(function (c) { return c.split('coinid:')[1].split(' ')[0]; }), [St.coinid]);
        T.eq('placement: the fresh coin is held for the order', o && o.relocking, [Fr.coinid, St.coinid]);
        var e2 = null; M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '250' }, function (e) { e2 = e; });
        T.ok('placement: no other order takes the held fresh coin', !!e2 && /^not enough MINIMA/.test(e2.message));
        wallet.minima = [Fr, coin('b5', F.MINIMA, '200')]; wallet.minima[1].created = String(TIP);   // the relock confirmed
        M.refresh(mds, relay, me, function () {});
        T.eq('placement: re-backed on the held coin plus the relocked one', M.find(JSON.parse(kv.myorders), o.orderId).coins, [Fr.coinid, wallet.minima[1].coinid]);
      } catch (e) { T.ok('section threw: ' + e, false); }
    })();
    // 0.0.113, the coin proof hand-over (owner 22 Nov 2026: keeping backing coins young by self-sends is "the opposite of
    // fast"): a coin my node can PROVE backs an order at any age — placed live at once, never relocked for its age. kv
    // legacy_fresh on keeps the 0.0.110 rule. A coin whose proof fails keeps the 0.0.110 rule.
    (function () {
      try {
        function ins() { return posted.filter(function (c) { return /^txninput/.test(c); }).map(function (c) { return c.split('coinid:')[1].split(' ')[0]; }); }
        AX.proofs._reset(); kv.myorders = '[]'; kv.relock_backoff = '{}'; kv.legacy_fresh = '0'; posted.length = 0; ONCHAIN = {}; wallet.mxusd = []; TIP = 5000; EXPORTS.length = 0;
        var Old1 = coin('c1', F.MINIMA, '300'), Old2 = coin('c2', F.MINIMA, '200');   // created 1000: age 4000, far past 900
        wallet.minima = [Old1, Old2]; PROVABLE = {}; PROVABLE[Old1.coinid] = true; PROVABLE[Old2.coinid] = true;
        var n0 = published.length, o = null, note = null, err = null;
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '400' }, function (e, x, r, nt) { err = e; o = x; note = nt; });
        T.ok('proved: placed (' + (err && err.message) + ')', !err && !!o && o.status === 'live');
        T.eq('proved: live to takers at once — nothing to wait for', note, '');
        T.eq('proved: published WITH its old coins', published[published.length - 1].coins, [Old1.coinid, Old2.coinid]);
        T.eq('proved: nothing relocked, nothing relocking', [ins(), o.relocking], [[], undefined]);
        T.eq('proved: each stale coin was exported once', EXPORTS.slice().sort(), [Old1.coinid, Old2.coinid].sort());
        // the refresh keeps it: no relock, no coinless re-sign; the export is remembered (no command)
        EXPORTS.length = 0; TIP = 5001; var rr = null;
        M.refresh(mds, relay, me, function (e, n, rl, errs) { rr = [e, rl, errs]; });
        T.eq('proved: refresh relocks nothing and keeps the coins', [ins(), rr[1], M.find(JSON.parse(kv.myorders), o.orderId).coins], [[], null, [Old1.coinid, Old2.coinid]]);
        T.eq('proved: a proof is remembered (no export on the next block)', EXPORTS, []);
        // a coin whose proof fails: the 0.0.110 rule — relocked, the order coinless until it is back
        AX.proofs._reset(); delete PROVABLE[Old2.coinid]; posted.length = 0; TIP = 5002;
        M.refresh(mds, relay, me, function () { });
        T.eq('no proof: that coin is relocked as before', ins(), [Old2.coinid]);
        T.eq('no proof: the order is re-signed coinless meanwhile', published[published.length - 1].coins, []);
        // legacy_fresh on: proved coins are ignored — exactly 0.0.110 (relocked, coinless, live after a block)
        AX.proofs._reset(); kv.myorders = '[]'; kv.relock_backoff = '{}'; kv.legacy_fresh = '1'; posted.length = 0; EXPORTS.length = 0;
        wallet.minima = [Old1, Old2]; PROVABLE[Old2.coinid] = true;
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '400' }, function (e, x, r, nt) { o = x; note = nt; });
        T.eq('legacy_fresh: coinless, both relocked, the caller told to wait a block', [o.coins, ins(), note], [[], [Old1.coinid, Old2.coinid], 'placed; goes live to takers after the next block (refreshing your coins)']);
        T.eq('legacy_fresh: no export at all', EXPORTS, []);
        // the ladder batch (allocate) backs on proved coins too
        AX.proofs._reset(); kv.myorders = '[]'; kv.legacy_fresh = '0'; posted.length = 0;
        var made = null; M.batch(mds, relay, me, [{ key: 'r1', side: 'sell', price: '0.2', amount: '250' }], [Old1, Old2], [], function (errs, mk) { made = [errs, mk]; });
        T.eq('batch: backed on a proved old coin at once', [made[0], made[1].r1 && made[1].r1.coins], [{}, [Old1.coinid]]);
        // review 23 Nov (M5): legacy_fresh is ON unless set off — an unset kv keeps the 0.0.110 rule (Android takers)
        AX.proofs._reset(); kv.myorders = '[]'; kv.relock_backoff = '{}'; delete kv.legacy_fresh; posted.length = 0; EXPORTS.length = 0;
        wallet.minima = [Old1, Old2];
        M.create(mds, relay, me, { side: 'sell', price: '0.1', amount: '400' }, function (e, x, r, nt) { o = x; note = nt; });
        T.eq('M5: legacy_fresh unset = ON: coinless, relocked, told to wait a block, nothing exported', [o.coins, ins(), note, EXPORTS], [[], [Old1.coinid, Old2.coinid], 'placed; goes live to takers after the next block (refreshing your coins)', []]);
        T.eq('M5: on = unset, \'\', 1, on, TRUE, junk; off = 0, false, off, no (any case, spaces)', ['', '1', 'on', 'TRUE', ' 1', 'x', '0', 'false', 'OFF', ' no ', 'False'].map(M.legacyOn), [true, true, true, true, true, true, false, false, false, false, false]);
        TIP = 1100; kv.legacy_fresh = '0'; PROVABLE = {}; AX.proofs._reset();
      } catch (e) { T.ok('section threw: ' + e + (e.stack || ''), false); }
    })();
})();
