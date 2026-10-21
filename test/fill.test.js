/* fill.test.js — the money math: taker plan and maker verification, rounding in the maker's favour. */
(function () {
    var F = AX.fill, E = AX.envelope;
    var NOW = 1800000000 - 3600;
    var maker = AX.identity.fromSeed('0x' + '11'.repeat(32), 'decks');
    var MADDR = '0x' + 'aa'.repeat(32), TADDR = '0x' + 'bb'.repeat(32), MCOINADDR = '0x' + 'cc'.repeat(32);
    function coin(id, tokenid, value, address) {
        var c = { coinid: '0x' + id.repeat(32), address: address, tokenid: tokenid, spent: false, state: [] };
        if (tokenid === F.MINIMA) c.amount = value; else { c.amount = '0.000001'; c.tokenamount = value; }
        return c;
    }
    function order(side, price, amount, coins) {
        var raw = E.order(maker, { market: 'MINIMA/MxUSD', side: side, price: price, amount: amount, coins: coins.map(function (c) { return c.coinid; }),
                                   address: MADDR, orderId: '0x0000000000000001', seq: 1, expiry: NOW + 3600 });
        return E.verify(raw, NOW).env;
    }
    /** Turn a plan into the txnview `transaction` shape the maker will see. */
    function asView(p, allCoins) {
        var byId = {}; allCoins.forEach(function (c) { byId[c.coinid] = c; });
        return { inputs: p.inputs.map(function (id) { return byId[id]; }),
                 outputs: p.outputs.map(function (o) { var c = { coinid: '0x00', address: o.address, tokenid: o.tokenid }; if (o.tokenid === F.MINIMA) c.amount = o.amount; else { c.amount = '0.000001'; c.tokenamount = o.amount; } return c; }),
                 state: [] };
    }

    // --- SELL order: maker sells 100 MINIMA @ 0.0123 MxUSD; taker takes 33.333333339 (grain → 33.33333333) ---
    var mSell = [coin('01', F.MINIMA, '60', MCOINADDR), coin('02', F.MINIMA, '50', MCOINADDR)];
    var tUsd = [coin('11', F.MXUSD, '0.3', TADDR), coin('12', F.MXUSD, '0.2', TADDR)];
    var oS = order('sell', '0.0123', '100', mSell);
    var pS = F.plan(oS, '33.333333339', mSell, tUsd, TADDR);
    T.eq('sell: filled quantised to 8dp', pS.filled, '33.33333333');
    T.eq('sell: taker pays MxUSD rounded UP', pS.takerGives, '0.41');              // 33.33333333*0.0123 = 0.409999999959 → up (plain() drops trailing zeros)
    T.eq('sell: maker gives MINIMA', pS.makerGives, '33.33333333');
    T.eq('sell: maker coin picked largest-first', pS.inputs[0], mSell[0].coinid);
    T.eq('sell: outputs', pS.outputs.map(function (o) { return o.tokenid === F.MINIMA ? 'M:' + o.amount + '@' + o.address.slice(0, 6) : 'U:' + o.amount + '@' + o.address.slice(0, 6); }),
         ['M:33.33333333@0xbbbb', 'M:26.66666667@0xcccc', 'U:0.41@0xaaaa', 'U:0.09@0xbbbb']);  // 0.3 alone can't cover 0.41 → both coins (0.5), change 0.09
    T.eq('sell: taker change', pS.takerChange, '0.09');
    var vS = F.verifyAsMaker(asView(pS, mSell.concat(tUsd)), oS, oS.coins, '100', [MCOINADDR, MADDR]);
    T.ok('sell: maker accepts its own plan', vS.ok);
    T.eq('sell: maker sees filled', vS.filled, '33.33333333');
    T.eq('sell: maker sees received', vS.received, '0.41');

    // Underpayment, overfill, foreign coin, wrong address, wrong token → refused.
    function tamper(p, fn) { var q = JSON.parse(JSON.stringify(p)); fn(q); return q; }
    var under = tamper(pS, function (q) { q.outputs[2].amount = '0.40999999'; });
    T.ok('sell: underpayment refused', !F.verifyAsMaker(asView(under, mSell.concat(tUsd)), oS, oS.coins, '100', [MCOINADDR]).ok);
    T.ok('sell: overfill vs remaining refused', !F.verifyAsMaker(asView(pS, mSell.concat(tUsd)), oS, oS.coins, '30', [MCOINADDR]).ok);
    var extra = coin('03', F.MINIMA, '5', MCOINADDR);
    var foreign = tamper(pS, function (q) { q.inputs.push(extra.coinid); q.outputs[0].amount = '38.33333333'; });
    T.ok('sell: my unadvertised coin refused', !F.verifyAsMaker(asView(foreign, mSell.concat(tUsd, [extra])), oS, oS.coins, '100', [MCOINADDR]).ok);
    var wrongAddr = tamper(pS, function (q) { q.outputs[2].address = TADDR; });
    T.ok('sell: payment to wrong address refused', !F.verifyAsMaker(asView(wrongAddr, mSell.concat(tUsd)), oS, oS.coins, '100', [MCOINADDR]).ok);
    var wrongTok = tamper(pS, function (q) { q.outputs[2].tokenid = '0x' + 'ee'.repeat(32); });
    T.ok('sell: payment in wrong token refused', !F.verifyAsMaker(asView(wrongTok, mSell.concat(tUsd)), oS, oS.coins, '100', [MCOINADDR]).ok);
    var stolenChange = tamper(pS, function (q) { q.outputs[1].address = TADDR; });   // maker change redirected to taker
    T.ok('sell: redirected maker change refused (fill > remaining-at-price)', !F.verifyAsMaker(asView(stolenChange, mSell.concat(tUsd)), oS, oS.coins, '100', [MCOINADDR]).ok);

    // --- BUY order: maker buys 200 MINIMA @ 0.0150 with MxUSD coins; taker sells 10 MINIMA ---
    var mUsd = [coin('21', F.MXUSD, '2', MCOINADDR), coin('22', F.MXUSD, '1.5', MCOINADDR)];
    var tMin = [coin('31', F.MINIMA, '7', TADDR), coin('32', F.MINIMA, '4', TADDR)];
    var oB = order('buy', '0.015', '200', mUsd);
    var pB = F.plan(oB, '10.000000009', mUsd, tMin, TADDR);
    T.eq('buy: filled', pB.filled, '10');
    T.eq('buy: maker pays MxUSD rounded DOWN', pB.makerGives, '0.15');
    T.eq('buy: taker gives MINIMA', pB.takerGives, '10');
    T.eq('buy: taker change', pB.takerChange, '1');
    var vB = F.verifyAsMaker(asView(pB, mUsd.concat(tMin)), oB, oB.coins, '200', [MCOINADDR]);
    T.ok('buy: maker accepts', vB.ok);
    T.eq('buy: maker filled = MINIMA received', vB.filled, '10');
    var overpay = tamper(pB, function (q) { q.outputs[0].amount = '0.15000001'; q.outputs[1].amount = '1.84999999'; });
    T.ok('buy: paying above price refused', !F.verifyAsMaker(asView(overpay, mUsd.concat(tMin)), oB, oB.coins, '200', [MCOINADDR]).ok);
    T.ok('buy: overfill refused', !F.verifyAsMaker(asView(pB, mUsd.concat(tMin)), oB, oB.coins, '5', [MCOINADDR]).ok);

    // --- plan failures ---
    function thr(name, fn) { var t = null; try { fn(); } catch (e) { t = e.message; } T.ok(name + (t ? '' : ' (no throw)'), !!t); return t; }
    T.ok('take > order', /exceeds/.test(thr('take exceeds', function () { F.plan(oS, '101', mSell, tUsd, TADDR); })));
    T.ok('maker coins short', /maker coins/.test(thr('maker short', function () { F.plan(oS, '100', [mSell[1]], tUsd, TADDR); })));
    T.ok('taker wallet short', /your wallet/.test(thr('taker short', function () { F.plan(oS, '100', mSell, [tUsd[1]], TADDR); })));
    T.ok('wrong maker token', /not MINIMA/.test(thr('wrong tok', function () { F.plan(oS, '1', mUsd, tUsd, TADDR); })));
    T.ok('zero take', /positive/.test(thr('zero', function () { F.plan(oS, '0', mSell, tUsd, TADDR); })));
})();
