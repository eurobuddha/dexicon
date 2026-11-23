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
                                   scripts: ['RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')'], address: MADDR, orderId: '0x0000000000000001', seq: 1, expiry: NOW + 3600 });
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
    // PandaDEX min-remainder floor: taking 33.33333333 of a 33.5 remaining would leave 0.16666667 → refused; of 34.33333333 → 1 left, fine
    T.ok('sell: dust remainder refused', /minimum remainder/.test(F.verifyAsMaker(asView(pS, mSell.concat(tUsd)), oS, oS.coins, '33.5', [MCOINADDR]).reason));
    T.ok('sell: leaving exactly 1 accepted', F.verifyAsMaker(asView(pS, mSell.concat(tUsd)), oS, oS.coins, '34.33333333', [MCOINADDR]).ok);
    T.ok('sell: taking it all accepted', F.verifyAsMaker(asView(pS, mSell.concat(tUsd)), oS, oS.coins, '33.33333333', [MCOINADDR]).ok);
    T.eq('floorTake: all of it', F.floorTake('500', '455.78231293').toFixed(), '455.78231293');
    T.eq('floorTake: 455.78 of 455.78231293 → shrunk to leave 1', F.floorTake('455.78', '455.78231293').toFixed(), '454.78231293');
    T.eq('floorTake: ample remainder untouched', F.floorTake('100', '455.78').toFixed(), '100');
    T.eq('floorTake: 0.5 order cannot be part-taken', F.floorTake('0.2', '0.5').toFixed(), '0');
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

    // --- a 36-dp maker coin: change must fit 44 significant digits (rounded DOWN), never exceed inputs ---
    var fat = [coin('05', F.MINIMA, '999998999.999999999999999999999999999999', MCOINADDR)];
    var oF = order('sell', '0.5', '10', fat);
    var pF = F.plan(oF, '3', fat, [coin('13', F.MXUSD, '5', TADDR)], TADDR);   // 3 @ 0.5 = 1.5 MxUSD
    T.eq('fat change is exact (39 digits, no rounding)', pF.outputs[1].amount, '999998996.999999999999999999999999999999');
    T.ok('fat change <= exact change', F.d(pF.outputs[1].amount).lte(F.d('999998999.999999999999999999999999999999').minus(3)));
    T.eq('plan carries the maker scripts for newscript', pF.scripts.length, 1);

    // --- plan failures ---
    function thr(name, fn) { var t = null; try { fn(); } catch (e) { t = e.message; } T.ok(name + (t ? '' : ' (no throw)'), !!t); return t; }
    T.ok('take > order', /exceeds/.test(thr('take exceeds', function () { F.plan(oS, '101', mSell, tUsd, TADDR); })));
    T.ok('maker coins short', /maker coins/.test(thr('maker short', function () { F.plan(oS, '100', [mSell[1]], tUsd, TADDR); })));
    T.ok('taker wallet short', /your wallet/.test(thr('taker short', function () { F.plan(oS, '100', mSell, [tUsd[1]], TADDR); })));
    T.ok('wrong maker token', /not MINIMA/.test(thr('wrong tok', function () { F.plan(oS, '1', mUsd, tUsd, TADDR); })));
    T.ok('zero take', /positive/.test(thr('zero', function () { F.plan(oS, '0', mSell, tUsd, TADDR); })));

    // --- concurrent takers spread across the maker's backing coins ---
    (function () {
        var coins = [coin('a1', F.MINIMA, '40', MCOINADDR), coin('a2', F.MINIMA, '30', MCOINADDR), coin('a3', F.MINIMA, '20', MCOINADDR), coin('a4', F.MINIMA, '3', MCOINADDR)];
        var o = { side: 'sell', price: '0.5', amount: '90', address: '0x' + 'ab'.repeat(32) };
        var taker = [coin('b1', F.MXUSD, '100', TADDR)];
        var seen = {}, k;
        for (k = 0; k < 64; k++) { var addr = '0x' + ('%02x'.replace('%02x', (k + 16).toString(16))).repeat(32); var p = F.plan(o, '10', coins, taker, addr); seen[p.inputs[0]] = true; T.eq('single sufficient coin per take', p.inputs.length, 2); }
        T.ok('64 takers hit more than one backing coin', Object.keys(seen).length > 1);
        T.ok('never the 3-coin (cannot cover 10 alone)', !seen[coins[3].coinid]);
        var same1 = F.plan(o, '10', coins, taker, '0x' + '11'.repeat(32)).inputs[0], same2 = F.plan(o, '10', coins, taker, '0x' + '11'.repeat(32)).inputs[0];
        T.eq('deterministic for one taker', same1, same2);
        var big = F.plan(o, '85', coins, taker, '0x' + '11'.repeat(32));
        T.eq('a take no single coin covers falls back to largest-first', big.inputs.slice(0, 3), [coins[0].coinid, coins[1].coinid, coins[2].coinid]);
    })();

    // --- security review 7 Nov: maker change only at my input / pay-to addresses; the taker's guard ---
    (function () {
        var HTLC = '0x' + '0c'.repeat(32), ATTACKER = '0x' + 'ab'.repeat(32);
        [HTLC, ATTACKER].forEach(function (sink) {
            var diverted = tamper(pS, function (q) { q.outputs[1].address = sink; });
            T.ok('change diverted to ' + sink + ' refused', !F.verifyAsMaker(asView(diverted, mSell.concat(tUsd)), oS, oS.coins, '100', [MCOINADDR, MADDR, HTLC, ATTACKER]).ok);
        });
        var MYPK = '0x' + 'd1'.repeat(32), MYSCRIPT = 'RETURN SIGNEDBY(' + MYPK + ')';
        var rows = [{ address: TADDR, script: MYSCRIPT, simple: true, publickey: MYPK }, { address: MCOINADDR, script: 'RETURN SIGNEDBY(0x' + 'dd'.repeat(32) + ')', simple: false, publickey: '0x00' }];
        var g = F.takerGuard(rows, pS);
        T.ok('honest order: sign only my key', !g.err && g.keys.length === 1 && g.keys[0] === MYPK);
        T.ok('order listing my script refused', !!F.takerGuard(rows, Object.assign({}, pS, { scripts: [' return signedby(' + MYPK.toLowerCase() + ') '] })).err);
        var mine2 = rows.concat([{ address: MCOINADDR.replace('cc', 'c2'), script: 'x', simple: true, publickey: '0x' + 'd2'.repeat(32) }]);
        T.ok('maker coin at my address refused', !!F.takerGuard(mine2, Object.assign({}, pS, { makerAddrs: [MCOINADDR.replace('cc', 'c2')] })).err);
        var stateful = asView(pS, mSell.concat(tUsd)); stateful.inputs.push({ coinid: '0x' + '77'.repeat(32), address: '0x' + '0c'.repeat(32), tokenid: F.MINIMA, amount: '5', state: [{ port: 0, data: '0x01' }] });
        T.ok('a stateful input is refused', !F.verifyAsMaker(stateful, oS, oS.coins, '100', [MCOINADDR, MADDR]).ok);
        T.ok('plan refuses a maker coin at the paying address', /your own addresses/.test(thr('own coin', function () { F.plan(oS, '10', [coin('05', F.MINIMA, '60', TADDR)], tUsd, TADDR); })));
    })();
})();

/* Security review 30 Oct (mirror of the APK 0.1.48 FillPlanTest): a coin of mine at my pay-to address cannot pass as
   the taker's, and the maker signs only with the order's own keys, never publickey:auto. */
(function () {
    var F = AX.fill, E = AX.envelope, NOW = 1767225600;
    var MADDR = '0x' + 'aa'.repeat(32), MCOINADDR = '0x' + 'cc'.repeat(32), KEY = '0x' + 'dd'.repeat(32);
    function c(id, tok, v, addr) { var x = { coinid: '0x' + id.repeat(32), address: addr, tokenid: tok, spent: false, state: [] }; if (tok === F.MINIMA) x.amount = v; else { x.amount = '0.000001'; x.tokenamount = v; } return x; }
    var o = { side: 'sell', price: '0.0123', address: MADDR }, adv = [c('01', F.MINIMA, '60', MCOINADDR)];
    var txn = { inputs: [adv[0], c('21', F.MXUSD, '0.41', MADDR)],
                outputs: [{ coinid: '0x00', address: '0x' + 'bb'.repeat(32), tokenid: F.MINIMA, amount: '33.33333333' }, { coinid: '0x00', address: MCOINADDR, tokenid: F.MINIMA, amount: '26.66666667' },
                          { coinid: '0x00', address: MADDR, tokenid: F.MXUSD, amount: '0.000001', tokenamount: '0.41' }], state: [] };
    var v = F.verifyAsMaker(txn, o, [adv[0].coinid], '100', [MCOINADDR]);
    T.ok('maker: my pay-to coin cannot pass as the taker\'s', !v.ok && /not advertised/.test(v.reason));
    T.eq('maker: signs with the order\'s own keys only', F.signKeys(['RETURN SIGNEDBY(' + KEY + ')', 'RETURN SIGNEDBY(' + KEY + ')', 'RETURN TRUE', null]), [KEY]);

    // review 7 Nov (H-1): the taker's own input, signed by its own key (the maker refuses to sign otherwise)
    var TADDR = '0x' + 'ee'.repeat(32), TPK = '0x' + 'EF'.repeat(32), TIN = c('31', F.MINIMA, '40', TADDR);
    var takerSigs = [{ publickey: TPK, valid: true }], inMempool = false, mineInMempool = false, outOfWindow = false, extraRows = [], keysFail = false, keyList = [{ publickey: KEY }, { publickey: '0x' + 'ad'.repeat(32) }], IMPORTED = false;
    var sent = [], mds = { cmd: function (x, cb) { sent.push(x); cb({ status: true }); }, cmdR: function (x, cb) {
        sent.push(x);
        // the node's real rows: my keys are simple with their publickey; a take of the TAKER's own order once registered its
        // script (newscript: simple false, publickey 0x00) — a counterparty row, never mine (0.0.159)
        if (x === 'scripts') return cb(null, [{ address: MCOINADDR, script: 'RETURN SIGNEDBY(' + KEY + ')', simple: true, publickey: KEY }, { address: MADDR, script: 'RETURN SIGNEDBY(0x' + 'ad'.repeat(32) + ')', simple: true, publickey: '0x' + 'ad'.repeat(32) },
            { address: TADDR, script: 'RETURN SIGNEDBY(' + TPK + ')', simple: false, publickey: '0x00', track: false }].concat(extraRows));
        if (x === 'keys') return keysFail ? cb(new Error('cmd failed: keys')) : cb(null, { keys: keyList, total: keyList.length });
        if (/^txnview/.test(x)) return cb(null, { transaction: { inputs: [adv[0], TIN], outputs: [], state: [] },
            witness: { scripts: [{ address: MCOINADDR, script: 'RETURN SIGNEDBY(' + KEY + ')' }, { address: TADDR, script: 'RETURN SIGNEDBY(' + TPK + ')' }] } });
        if (/^txncheck/.test(x)) return cb(null, { validamounts: true, valid: { basic: true, mmrproofs: true, scripts: true, signatures: takerSigs } });
        if (/^coins coinid:.* checkmempool:true/.test(x)) { var mc = x.split(' ')[1].slice(7); return cb(null, (mc === TIN.coinid ? inMempool : mineInMempool) ? [] : [mc === TIN.coinid ? TIN : adv[0]]); }
        if (/^coins coinid:/.test(x)) return cb(null, outOfWindow && !IMPORTED ? [] : [TIN]);   // my node sees only its unpruned window
        if (x === 'status') return cb(null, { chain: { block: '2000', length: '500' } });   // tree root 1500
        if (/^coinimport data:0x[0-9A-Fa-f]+ track:false$/.test(x)) { IMPORTED = AX.proofs.named(x.split(' ')[1].slice(5)).coinid === TIN.coinid.toUpperCase().replace('0X', '0x'); return cb(null, {}); }
        cb(null, {});
    } };
    F.cosign(mds, '0A0B', [KEY], function (t, wallet) { T.ok('maker: verifier gets the fresh wallet', wallet.indexOf(MADDR) >= 0);
        T.ok('0.0.159: a counterparty script row (newscript of a take I made) is never "mine"', wallet.indexOf(TADDR) < 0); return { ok: true }; }, function (e) {
        T.ok('maker: cosign completes', !e);
        T.ok('0.0.159: a maker who once took the taker\'s order still co-signs that taker\'s take (' + (e && e.message) + ')', !e && sent.some(function (x) { return /^txnpost/.test(x); }));
        T.ok('maker: never publickey:auto', sent.every(function (x) { return x.indexOf('publickey:auto') < 0; }) && sent.indexOf('txnsign id:' + (sent.filter(function (x) { return /^txnsign/.test(x); })[0] || '').split(' ')[1].slice(3) + ' publickey:' + KEY) >= 0);
    });
    F.cosign(mds, '0A0B', [], function () { return { ok: true }; }, function (e) { T.ok('maker: no key → refused', !!e && /no signing key/.test(e.message)); });
    takerSigs = []; sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('maker: an unsigned take is refused before I sign (H-1)', !!e && /not signed/.test(e.message) && !sent.some(function (x) { return /^txnsign/.test(x); }));
    });
    takerSigs = [{ publickey: TPK, valid: true }]; inMempool = true; sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('maker: a taker input already in the mempool is refused before I sign', !!e && /mempool/.test(e.message) && !sent.some(function (x) { return /^txnsign/.test(x); }));
    });
    inMempool = false; outOfWindow = true; sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        // 0.0.161 (review, MAJOR — phantom fills): it used to be signed on its MMR proof alone, never checked against the mempool
        T.ok('0.0.161: a taker coin this node cannot see is refused with a plain reason, nothing signed (' + (e && e.message) + ')', !!e && /older than this maker's chain window/.test(e.message) && !sent.some(function (x) { return /^txnsign/.test(x); }));
    });
    // 0.0.183 (review, MAJOR 4 (d)): the take carries a proof of the taker's coin: my node imports it (track:false — never
    // relevant to me) ONLY while it cannot see the coin, under the import lock, then checks it against the mempool and signs
    function tproof(coin, addr, created) { return '0x00000020' + coin.slice(2) + '00000020' + addr.slice(2) + '000203EB' + '0000000100' + '01' + '000100' + '0000000105' + '00' + '0001' + ('0' + created.toString(16)).slice(-2) + '000100' + '00'; }
    var PR = {}; PR[TIN.coinid] = tproof(TIN.coinid, TADDR, 100); sent.length = 0; IMPORTED = false;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('0.0.183: a taker coin out of my window, its proof in the take → imported untracked, checked, signed, posted (' + (e && e.message) + ')',
            !e && sent.some(function (x) { return /^coinimport data:0x0+20.* track:false$/.test(x); }) && sent.some(function (x) { return /^txnpost/.test(x); }));
        T.ok('0.0.183: ... looked up again right before the import, the mempool checked after it', sent.filter(function (x) { return x === 'coins coinid:' + TIN.coinid; }).length >= 3 && sent.indexOf('coins coinid:' + TIN.coinid + ' checkmempool:true') > sent.indexOf(sent.filter(function (x) { return /^coinimport/.test(x); })[0]));
    }, null, { proofs: PR });
    var WRONG = {}; WRONG[TIN.coinid] = tproof('0x' + '99'.repeat(32), TADDR, 100); sent.length = 0; IMPORTED = false;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('0.0.183: a proof of another coin never reaches my node: refused, nothing imported, nothing signed (' + (e && e.message) + ')', !!e && /not a proof of that coin/.test(e.message) && !sent.some(function (x) { return /^(coinimport|txnsign)/.test(x); }));
    }, null, { proofs: WRONG });
    var ELSE = {}; ELSE[TIN.coinid] = tproof(TIN.coinid, MADDR, 100); sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('0.0.183: a proof of the coin at another address: refused, nothing imported', !!e && !sent.some(function (x) { return /^(coinimport|txnsign)/.test(x); }));
    }, null, { proofs: ELSE });
    outOfWindow = false; sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('0.0.183: a coin my node sees is NEVER imported (it would turn relevant: a phantom balance), proof or not', !e && !sent.some(function (x) { return /^coinimport/.test(x); }));
    }, null, { proofs: PR });
    // 0.0.184 (review, MAJOR 4 (c)): a MegaMMR maker (`status` megammr:true, read once) looks a taker's coin up with
    // megammr:true — an old coin is then seen with no proof at all; any other node is never sent the parameter
    var MEGASEEN = false, megaMds = { cmd: mds.cmd, cmdR: function (x, cb) {
        if (x === 'status') { sent.push(x); return cb(null, { megammr: true, chain: { block: '2000', length: '500' } }); }
        if (/^coins coinid:.* megammr:true$/.test(x) && !/checkmempool/.test(x)) { sent.push(x); MEGASEEN = true; return cb(null, [TIN]); }
        mds.cmdR(x, cb);
    } };
    outOfWindow = true; IMPORTED = false; sent.length = 0; F._mega();
    F.cosign(megaMds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('0.0.184: a MegaMMR maker sees the old taker coin with megammr:true and signs, no proof, no import (' + (e && e.message) + ')',
            !e && MEGASEEN && sent.indexOf('coins coinid:' + TIN.coinid + ' checkmempool:true megammr:true') >= 0 && !sent.some(function (x) { return /^coinimport/.test(x); }));
    });
    T.eq('0.0.184: ... the status read once', sent.filter(function (x) { return x === 'status'; }).length, 1);
    F._mega(); sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function () { });
    T.ok('0.0.184: a node that is not MegaMMR is never sent megammr:true', !sent.some(function (x) { return /megammr/.test(x); }));
    outOfWindow = false; mineInMempool = true; sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function () { return { ok: true }; }, function (e) {
        T.ok('0.0.161: my own advertised coin already being spent in my mempool → refused before I sign (' + (e && e.message) + ')', !!e && /my coin 0x0101.* is already being spent/.test(e.message) && !sent.some(function (x) { return /^txnsign/.test(x); }));
    });
    mineInMempool = false;
    // 0.0.159: a simple row whose key the node's `keys` list does not hold is not mine either; a failed `keys` read leaves
    // the rows rule (simple + 64-hex publickey) alone
    T.eq('0.0.159: ownRows — simple with a real key only', F.ownRows([{ address: '0x01', simple: true, publickey: KEY }, { address: '0x02', simple: false, publickey: '0x00' }, { address: '0x03', simple: true, publickey: '0x00' }, { address: '0x04', simple: 'true', publickey: '0x' + 'ad'.repeat(32) }], null).map(function (r) { return r.address; }), ['0x01', '0x04']);
    T.eq('0.0.159: ownRows — cross-checked against keys', F.ownRows([{ address: '0x01', simple: true, publickey: KEY }, { address: '0x04', simple: true, publickey: '0x' + 'ad'.repeat(32) }], [{ publickey: KEY.toLowerCase() }]).map(function (r) { return r.address; }), ['0x01']);
    extraRows = [{ address: TADDR, script: 'RETURN SIGNEDBY(' + TPK + ')', simple: true, publickey: TPK }]; sent.length = 0;
    F.cosign(mds, '0A0B', [KEY], function (t, w) { T.ok('0.0.159: a simple row with a key the wallet lacks is foreign', w.indexOf(TADDR) < 0); return { ok: true }; }, function () { });
    keysFail = true;
    F.cosign(mds, '0A0B', [KEY], function (t, w) { T.ok('0.0.159: keys unreadable → simple + key rows count', w.indexOf(TADDR) >= 0 && w.indexOf(MADDR) >= 0); return { ok: true }; }, function () { });
    extraRows = []; keysFail = false;
    // 0.0.160 (review, MINOR): an order whose coins sit at two of my addresses — the take spends a coin at ONE of them: the
    // maker signs with that address's key only (every order key used to sign: a key use each)
    sent.length = 0;
    F.cosign(mds, '0A0B', [KEY, '0x' + 'ad'.repeat(32)], function () { return { ok: true }; }, function (e) {
        T.eq('0.0.160: signs only with the key of its input in the take', [!e, sent.filter(function (x) { return /^txnsign/.test(x); }).map(function (x) { return x.split('publickey:')[1]; })], [true, [KEY]]);
    });
    sent.length = 0;
    F.cosign(mds, '0A0B', ['0x' + 'ad'.repeat(32)], function () { return { ok: true }; }, function (e) {
        T.ok('0.0.160: no order key signs an input of the take → refused, nothing signed', !!e && /none of the order's keys/.test(e.message) && !sent.some(function (x) { return /^txnsign/.test(x); }));
    });
})();

/* Security review 30 Oct (mirror of the APK TokenOverrideTest): the dollar-token override only on a proven test chain. */
(function () {
    var F = AX.fill, MAIN = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90', TOK = '0x' + 'ab'.repeat(32);
    function node(tip) { return { cmdR: function (c, cb) { cb(null, { block: String(tip) }); } }; }
    F.overrideOnTestChain(node(2391696), TOK, function (ok) { T.ok('override: refused on mainnet', !ok && F.MXUSD === MAIN); });
    F.overrideOnTestChain(node(1234), TOK, function (ok) { T.ok('override: applied on a test chain', ok && F.MXUSD === TOK); });
    F.overrideOnTestChain(node(1500000), TOK, function (ok) { T.ok('override: dropped once mainnet is seen', !ok && F.MXUSD === MAIN); });
    F.overrideOnTestChain(node(1234), '', function () { T.eq('override: empty restores mainnet', F.MXUSD, MAIN); });
})();

/* 0.0.159 (review, MAJOR): a coin at a counterparty's RETURN SIGNEDBY row (registered by `newscript` when I took its
   order; simple false, publickey 0x00) that an import made relevant never backs MY order, and a taker never pays with it. */
(function () {
    var M = AX.maker, F = AX.fill, MINE = '0x' + 'a1'.repeat(32), THEIRS = '0x' + 'b2'.repeat(32), PK = '0x' + 'dd'.repeat(32), XPK = '0x' + 'ee'.repeat(32), got = null;
    var mds = { cmdR: function (c, cb) {
        if (c === 'scripts') return cb(null, [{ address: MINE, script: 'RETURN SIGNEDBY(' + PK + ')', simple: true, publickey: PK }, { address: THEIRS, script: 'RETURN SIGNEDBY(' + XPK + ')', simple: false, publickey: '0x00' }]);
        if (c === 'keys') return cb(null, { keys: [{ publickey: PK }] });
        if (/^coins relevant:true checkmempool:true tokenid:/.test(c)) return cb(null, [{ coinid: '0x' + '01'.repeat(32), address: MINE, tokenid: '0x00', amount: '5', state: [] }, { coinid: '0x' + '02'.repeat(32), address: THEIRS, tokenid: '0x00', amount: '9', state: [] }]);
        cb(new Error('unexpected ' + c));
    } };
    M.walletCoins(mds, F.MINIMA, function (e, coins) { got = (coins || []).map(function (c) { return c.address; }); });
    T.eq('0.0.159: only coins at my own key rows are spendable', got, [MINE]);
})();
