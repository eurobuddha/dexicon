/* ladder.test.js — the FAST market maker: ladder maths (same cases as the APK's LadderTest) and the runner against a
   fake node + relay: rungs go live, a MEXC move reprices them, a split backs a one-coin wallet, OFF / no price withdraw. */
(function () {
    var L = AX.ladder, F = AX.fill, M = AX.maker;
    function pegged(step, levels, ask, bid) { var c = L.blankConfig(); c.enabled = true; c.peg = true; c.step = step; c.levels = levels; c.askSize = ask; c.bidSize = bid; return c; }
    function s(r) { return r.key + ' ' + r.side + ' ' + F.plain(r.amount) + ' @ ' + F.plain(r.price); }

    var r = L.desired(pegged('1', '2', '100', '50'), 0.003675, 1);
    T.eq('4 rungs', r.length, 4);
    T.eq('A1 exact', s(r[0]), 'A1 sell 100 @ 0.00371175');
    T.eq('B1 exact', s(r[1]), 'B1 buy 50 @ 0.00363825');
    var h = L.desired(pegged('0.5', '1', '1', '1'), 0.003675, 1);
    T.eq('ask rounds up', F.plain(h[0].price), '0.00369338');
    T.eq('bid rounds down', F.plain(h[1].price), '0.00365662');
    T.eq('stale widens ×5', F.plain(L.desired(pegged('1', '1', '1', '0'), 0.003675, 5)[0].price), '0.00385875');
    var sk = pegged('1', '1', '1', '0'); sk.skew = '-2';
    T.eq('skew', F.plain(L.desired(sk, 0.003675, 1)[0].price), '0.00363752');
    T.ok('one-sided', L.desired(pegged('1', '3', '0', '10'), 0.01, 1).every(function (x) { return x.side === 'buy'; }));
    T.eq('bid past the mid dropped', L.desired(pegged('60', '2', '0', '1'), 0.01, 1).length, 1);
    T.eq('no price → nothing', L.desired(pegged('1', '1', '1', '1'), 0, 1).length, 0);
    T.eq('levels clamp', L.desired(pegged('1', '99', '1', '0'), 1, 1).length, 6);
    var m = L.blankConfig(); m.enabled = true; m.asks[0] = ['0.003675', '455.78231293']; m.bids[1] = ['0.0035', '10']; m.asks[2] = ['0.004', ''];
    T.eq('manual rows', L.desired(m, 0, 1).map(s), ['A1 sell 455.78231293 @ 0.003675', 'B2 buy 10 @ 0.0035']);
    var want = L.desired(pegged('1', '1', '100', '0'), 1, 1)[0];
    T.ok('small drift no edit', !L.needsEdit(want, '1.0105', '100', true, '1'));
    T.ok('drift ≥ 1 % edits', L.needsEdit(want, '1.03', '100', true, '1'));
    T.ok('part-filled tops up', L.needsEdit(want, '1.01', '40', true, '1'));
    T.ok('manual exact', L.needsEdit(want, '1.0105', '100', false, '1'));
    T.ok('validate step 0', !!L.validate(pegged('0', '1', '1', '1')));
    var v = pegged('1', '1', '1', '1'); v.skew = 'abc'; T.ok('validate skew', !!L.validate(v)); v.skew = '-3'; T.eq('valid', L.validate(v), null);
    T.eq('widen 1 → 10', [L.wideningFactor(5 * 60000), L.wideningFactor(90 * 60000)], [1, 10]);
    var g = { mid: 0, suspect: 0 };
    T.eq('jump guard first', L.guard(g, 0.003675), 0.003675);
    T.eq('jump held', L.guard(g, 0.01), 0.003675);
    T.eq('jump confirmed', L.guard(g, 0.0101), 0.0101);

    // ---- runner against a fake node + relay ----
    var CADDR = '0x' + 'cc'.repeat(32), ADDR = '0x' + 'aa'.repeat(32), me = AX.identity.fromSeed('0x' + '22'.repeat(32), 'decks');
    function coin(id, tok, val) { var c = { coinid: '0x' + id.repeat(32), address: CADDR, tokenid: tok, spent: false, state: [], created: '1000' }; if (tok === F.MINIMA) c.amount = val; else { c.amount = '0.000001'; c.tokenamount = val; } return c; }
    var wallet = { minima: [coin('01', F.MINIMA, '1000')], mxusd: [coin('11', F.MXUSD, '5')] }, kv = {}, cmds = [];
    var mds = {
        kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); }, kvSet: function (k, v, cb) { kv[k] = v; cb(null); },
        cmdR: function (cmd, cb) {
            cmds.push(cmd);
            if (cmd === 'getaddress') return cb(null, { address: ADDR });
            if (cmd === 'scripts') return cb(null, [{ address: CADDR, script: 'RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')', simple: true }]);
            if (cmd === 'block') return cb(null, { block: '1100' });
            if (/^txn(create|input|output|sign)/.test(cmd)) return cb(null, {});
            if (cmd.indexOf('txnpost') === 0) return cb(null, { txpow: { txpowid: '0x' + 'ef'.repeat(32) } });
            if (cmd.indexOf('coins relevant:true tokenid:') === 0) return cb(null, cmd.split('tokenid:')[1] === F.MINIMA ? wallet.minima : wallet.mxusd);
            cb(new Error('unexpected ' + cmd));
        },
        cmd: function (cmd, cb) { cmds.push(cmd); cb({ status: true }); }
    };
    var pub = [], relay = { publish: function (raw, cb) { pub.push(JSON.parse(raw)); cb([{ url: 'r', ok: true }]); } };
    var price = { m: 0.003675, age: 1000, mid: function () { return this.m; }, ageMs: function () { return this.age; }, refreshAsync: function () { }, lastError: '' };
    var ctx = { mds: mds, relay: relay, me: me, price: price, log: function () { } };
    L._state.feed = { mid: 0, suspect: 0 }; L._state.lastSplit = {};
    function run() { kv.mm_dirty = '1'; L.pass(ctx, function () { }); }
    function live() { return JSON.parse(kv.myorders || '[]').filter(function (o) { return o.status === 'live'; }); }

    kv.mm_config = JSON.stringify(pegged('1', '2', '100', '0'));   // 2 asks of 100 MINIMA, one 1000-MINIMA coin
    run();
    T.eq('A1 live on the single coin', live().length, 1);
    T.ok('A2 short → the side is re-cut into 2 × 100 ' + kv.mm_status, /split MINIMA into 2 × 100/.test(kv.mm_status));
    T.ok('split txn: outputs of 100 + change 800', cmds.indexOf('txnoutput id:' + cmds.filter(function (c) { return /^txncreate id:sp/.test(c); })[0].split('id:')[1] + ' amount:100 address:' + ADDR) >= 0);
    T.ok('split deletes its txn', cmds.some(function (c) { return /^txndelete id:sp/.test(c); }));
    // the split confirms: the wallet now has the 100 + 900 coins (the old one is spent)
    T.ok('change output 800', cmds.some(function (c) { return /^txnoutput id:sp\S+ amount:800 /.test(c); }));
    wallet.minima = [coin('02', F.MINIMA, '100'), coin('03', F.MINIMA, '100'), coin('04', F.MINIMA, '800')];
    run();
    T.ok('A1 re-backed off the spent coin', live().every(function (o) { return o.coins.indexOf(coin('01', F.MINIMA, '1').coinid) < 0; }));
    T.eq('both asks live', live().map(function (o) { return o.price; }).sort(), ['0.00371175', '0.0037485']);
    var n = pub.length;
    run();
    T.eq('nothing changed → nothing published', pub.length, n);
    price.m = 0.0038;   // MEXC +3.4 % (≥ 1 %) → both rungs repriced by edit, same order ids
    var ids = JSON.parse(kv.mm_ids);
    run();
    T.eq('repriced', live().map(function (o) { return o.price; }).sort(), ['0.003838', '0.003876']);
    T.eq('same orders (edit, not new)', JSON.parse(kv.mm_ids), ids);
    price.m = 0;   // feed lost → withdraw
    L._state.feed = { mid: 0, suspect: 0 };
    run();
    T.eq('withdrawn', live().length, 0);
    T.ok('status says withdrawn', /^WITHDRAWN/.test(kv.mm_status));
    price.m = 0.0038; var c2 = JSON.parse(kv.mm_config); c2.enabled = false; kv.mm_config = JSON.stringify(c2);
    run();
    T.eq('off status', kv.mm_status, 'OFF');
})();
