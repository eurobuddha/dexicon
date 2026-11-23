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
    T.eq('levels clamp', L.desired(pegged('1', '99', '1', '0'), 1, 1).length, 10);   // 10 a side since 0.0.89 (asks only here)
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
    var g = { mid: 0, suspect: 0 }, t0 = 1767225600000;
    T.eq('jump guard first', L.guard(g, 0.003675, t0), 0.003675);
    T.eq('jump held', L.guard(g, 0.01, t0), 0.003675);
    T.eq('jump agrees but not held 60 s', L.guard(g, 0.0101, t0 + 30000), 0.003675);
    T.eq('jump confirmed after 60 s', L.guard(g, 0.0101, t0 + 60000), 0.0101);
    T.eq('a 5 % push is held too', L.guard(g, 0.0106, t0 + 61000), 0.0101);
    T.eq('within 3 % taken at once', L.guard(g, 0.0102, t0 + 62000), 0.0102);
    // review 7 Nov: a steady trend confirms (same side, held 60 s) instead of resetting the timer forever
    T.eq('trend +5 % held', L.guard(g, 0.01071, t0 + 63000), 0.0102);
    T.ok('jump pending', g.suspect > 0);
    T.eq('trend +6 % same side, timer kept', L.guard(g, 0.01081, t0 + 93000), 0.0102);
    T.eq('trend +7 % held 61 s: taken', L.guard(g, 0.01091, t0 + 124000), 0.01091);
    T.ok('no longer pending', !(g.suspect > 0));

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
            if (cmd.indexOf('coins relevant:true checkmempool:true tokenid:') === 0) return cb(null, cmd.split('tokenid:')[1] === F.MINIMA ? wallet.minima : wallet.mxusd);
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
    price.m = 0.0038;   // MEXC +3.4 %: over the 3 % jump clamp → held (review 30 Oct), nothing repriced on one read
    var ids = JSON.parse(kv.mm_ids);
    run();
    // review 7 Nov: while the jump is unconfirmed the pegged ladder is WITHDRAWN — never quoted or refilled at the old price
    T.eq('3.4 % jump: ladder withdrawn while it confirms', live().length, 0);
    T.ok('status says why', /^WITHDRAWN — MEXC moved/.test(kv.mm_status));
    L._state.feed.suspectAt -= 60000;   // …and once it has held for a minute it is followed: both rungs re-quoted
    run();
    T.eq('repriced', live().map(function (o) { return o.price; }).sort(), ['0.003838', '0.003876']);
    price.m = 0;   // a fresh service whose first MEXC fetch is still on its way → the live ladder is kept (28 Oct)
    L._state.feed = { mid: 0, suspect: 0 };
    run();
    T.eq('first fetch pending keeps the ladder', live().length, 2);
    price.lastError = 'price feed timed out';   // feed lost → withdraw
    run();
    T.eq('withdrawn', live().length, 0);
    T.ok('status says withdrawn', /^WITHDRAWN/.test(kv.mm_status));
    price.m = 0.0038; var c2 = JSON.parse(kv.mm_config); c2.enabled = false; kv.mm_config = JSON.stringify(c2);
    run();
    T.eq('off status', kv.mm_status, 'OFF');
    // 0.0.153: a rung cancel whose save fails (the store lock: wired SQL that fails) is kept in mm_ids and retried, and said
    (function () {
        var c3 = JSON.parse(kv.mm_config); c3.enabled = true; kv.mm_config = JSON.stringify(c3); L._state.feed = { mid: 0, suspect: 0 }; price.lastError = '';
        run();
        var had = Object.keys(JSON.parse(kv.mm_ids)).length, logs = [];
        T.ok('0.0.153: the ladder is live again (' + had + ' rungs)', had > 0 && live().length === had);
        ctx.log = function (s) { logs.push(s); };
        mds.sql = function (q, cb) { cb({ status: false, error: 'Database is closed' }); };   // every save now fails loudly
        c3.enabled = false; kv.mm_config = JSON.stringify(c3);
        run();
        T.eq('0.0.153: OFF while saves fail: the rungs stay tracked (retried next pass), still live', [Object.keys(JSON.parse(kv.mm_ids)).length, live().length], [had, had]);
        T.ok('0.0.153: ... and said (status and log)', /cancel failed, retried next pass/.test(kv.mm_status) && logs.some(function (l) { return /ladder cancel \S+ failed: .*could not be used/.test(l); }));
        delete mds.sql; ctx.log = function () { };
        run();
        T.eq('0.0.153: saves work again: the next pass cancels them', [Object.keys(JSON.parse(kv.mm_ids)).length, live().length, kv.mm_status], [0, 0, 'OFF']);
    })();
    // review 22 Nov (M2/MINOR 2): the ladder split never spends a coin of my pending take or one an order is relocking
    (function () {
        var H = coin('h1', F.MINIMA, '600'), R = coin('e1', F.MINIMA, '500'), Q = coin('f1', F.MINIMA, '50'), err = null;
        wallet.minima = [H, R, Q]; kv.myorders = JSON.stringify([{ orderId: '0x0e', status: 'live', side: 'sell', coins: [], relocking: [R.coinid] }]);
        kv.pending_takes = JSON.stringify({ t: { sent: 1, mine: [H.coinid] } }); cmds.length = 0;
        L.split(mds, F.MINIMA, 2, F.d('100'), {}, function (e) { err = e; });
        T.ok('split: a held coin and a relocking coin are never inputs (' + (err && err.message) + ')', !!err && /^only 50 free/.test(err.message) && !cmds.some(function (c) { return /^txninput/.test(c); }));
        delete kv.pending_takes;
    })();
})();

/* 0.0.90 — the price fallback (same cases as the APK's LadderTest.mexcViaCoinGeckoParsesAndKeepsEverySafetyRule): MEXC
   is the only price; MEXC's own ticker via CoinGecko is read ONLY when neither direct MEXC call answers. */
(function () {
    var L = AX.ladder, P = PandaPrice, realHttp = P.http, realRefresh = P.refreshAsync, calls, net;
    var row = { base: 'MINIMA', target: 'USDT', market: { name: 'MEXC', identifier: 'mxc' }, last: 0.00312, bid_ask_spread_percentage: 0.647249,
                last_fetch_at: '2026-11-09T09:53:00+00:00', is_anomaly: false, is_stale: false };
    function alt(k, v) { var o = JSON.parse(JSON.stringify(row)); if (k === 'market') o.market.identifier = v; else o[k] = v; return { tickers: [o] }; }
    var now = 1794218100000;   // 09:55:00 UTC, two minutes after CoinGecko's fetch
    var r = L.parseGeckoMexc({ name: 'Minima', tickers: [row] }, now);
    T.ok('gecko: bid = last − half the spread', Math.abs(r[0] - 0.00312 * (1 - 0.647249 / 200)) < 1e-12);
    T.ok('gecko: ask = last + half the spread', Math.abs(r[1] - 0.00312 * (1 + 0.647249 / 200)) < 1e-12);
    T.eq('gecko: dated by CoinGecko\'s fetch', r[2], 1794217980000);
    T.eq('gecko: a future stamp counts as now', L.parseGeckoMexc({ tickers: [row] }, now - 180000)[2], now - 180000);
    T.eq('gecko: Z stamp', L.parseGeckoMexc(alt('last_fetch_at', '2026-11-09T09:53:00Z'), now)[2], 1794217980000);
    T.eq('gecko: another exchange is no price', L.parseGeckoMexc(alt('market', 'xt'), now), null);
    T.eq('gecko: another pair is no price', L.parseGeckoMexc(alt('target', 'USDC'), now), null);
    T.eq('gecko: stale is no price', L.parseGeckoMexc(alt('is_stale', true), now), null);
    T.eq('gecko: anomaly is no price', L.parseGeckoMexc(alt('is_anomaly', true), now), null);
    T.eq('gecko: no fetch time is no price', L.parseGeckoMexc(alt('last_fetch_at', 'yesterday'), now), null);
    T.eq('gecko: no spread is no price', L.parseGeckoMexc(alt('bid_ask_spread_percentage', null), now), null);
    T.eq('gecko: no tickers is no price', L.parseGeckoMexc({ tickers: [] }, now), null);
    T.ok('gecko: an XT row before the MEXC row is skipped, never averaged',
        L.parseGeckoMexc({ tickers: [alt('market', 'xt').tickers[0], row] }, now)[2] === 1794217980000);

    // the fetch order, against a fake transport: net[url] = reply object, or a string = that transport error
    L.feed(P);
    P.http = function (url, cb) { calls.push(url); var v = net[url]; if (typeof v === 'string' || v === undefined) cb(v || 'network error'); else cb(null, v); };
    function go(n) { var out = {}; calls = []; net = n; P.lastTryMs = 0; P.fetching = false; P.midValue = 0; P.fetchedAt = 0; P.lastError = ''; P.source = 'MEXC';
        P.refreshAsync(function (err, mid) { out.err = err || ''; out.mid = mid || 0; }); return out; }
    var depth = { bids: [['0.0036', '100000']], asks: [['0.0037', '100000']] }, book = { bidPrice: '0.0036', askPrice: '0.0037' };
    function fresh() { var o = JSON.parse(JSON.stringify(row)); o.last_fetch_at = new Date(Date.now() - 120000).toISOString().replace(/\.\d+Z$/, '+00:00'); return { tickers: [o] }; }
    var n1 = {}, o; n1[P.DEPTH_URL] = depth; n1[L.GECKO_MEXC_URL] = fresh();
    o = go(n1);
    T.eq('feed: MEXC depth answers → one call, no fallback', calls, [P.DEPTH_URL]);
    T.ok('feed: MEXC mid, labelled MEXC', Math.abs(o.mid - 0.00365) < 1e-12 && P.source === 'MEXC' && /^MEXC mid /.test(L.feedLine(P)));
    var n2 = {}; n2[P.BOOK_URL] = book; n2[L.GECKO_MEXC_URL] = fresh();
    o = go(n2);
    T.eq('feed: depth down, bookTicker answers → no fallback', calls, [P.DEPTH_URL, P.BOOK_URL]);
    T.ok('feed: bookTicker mid', Math.abs(o.mid - 0.00365) < 1e-12 && P.source === 'MEXC');
    var n3 = {}; n3[P.DEPTH_URL] = { bids: [], asks: [] }; n3[L.GECKO_MEXC_URL] = fresh();
    o = go(n3);
    T.ok('feed: MEXC answers with a thin book → no price, and CoinGecko is NOT asked', !(P.mid() > 0) && calls.indexOf(L.GECKO_MEXC_URL) < 0 && /thin/.test(P.lastError));
    var n4 = {}; n4[L.GECKO_MEXC_URL] = fresh();
    o = go(n4);
    T.eq('feed: both MEXC calls fail → the fallback, last', calls, [P.DEPTH_URL, P.BOOK_URL, L.GECKO_MEXC_URL]);
    T.ok('feed: fallback mid is MEXC\'s last', Math.abs(o.mid - 0.00312) < 1e-12 && o.err === '');
    T.ok('feed: fallback is labelled ' + L.feedLine(P), P.source === 'MEXC via CoinGecko' && /^MEXC via CoinGecko mid \(MEXC direct unreachable\) /.test(L.feedLine(P)));
    T.ok('feed: fallback is aged from CoinGecko\'s fetch, not from now', P.ageMs() >= 119000 && P.ageMs() < 130000);
    o = go(n1);
    T.ok('feed: MEXC back → labelled MEXC again', P.source === 'MEXC' && /^MEXC mid /.test(L.feedLine(P)));
    [['another exchange', alt('market', 'xt')], ['stale', alt('is_stale', true)], ['another pair', alt('target', 'USDC')], ['no reply', 'network error']].forEach(function (c) {
        var n = {}; n[L.GECKO_MEXC_URL] = c[1];
        o = go(n);
        T.ok('feed: both MEXC fail + fallback ' + c[0] + ' → no price (' + P.lastError + ')', !(P.mid() > 0) && !!o.err && /^MEXC network error; via CoinGecko /.test(P.lastError) && /^MEXC: unavailable/.test(L.feedLine(P)));
    });
    var wide = alt('bid_ask_spread_percentage', 50); wide.tickers[0].last_fetch_at = fresh().tickers[0].last_fetch_at;
    var n5 = {}; n5[L.GECKO_MEXC_URL] = wide;
    go(n5);
    T.ok('feed: the fallback passes the same spread rule', !(P.mid() > 0) && /spread too wide/.test(P.lastError));
    calls = []; P.refreshAsync(function () { });
    T.eq('feed: the 30 s gap still holds', calls, []);
    P.http = realHttp; P.refreshAsync = realRefresh; P.midValue = 0; P.fetchedAt = 0; P.lastError = ''; P.lastTryMs = 0;
})();
