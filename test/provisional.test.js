/* provisional.test.js — 0.0.161 (review, MAJOR — phantom fills): a maker fill counted at `txnpost` is PROVISIONAL until it
   is proved mined. The published size never exceeds what can still be sold, a take that never mines gives the size back by
   itself (its coin unspent and out of the mempool 16 blocks after the post), and a fill marked lost that later mines is
   re-applied once. 0.0.179 (review, MAJOR 1 + 2): proved by the take's OWN payment coin (id from the first input, address,
   token, amount), 64 blocks deep; a coin spent by ANOTHER transaction gives the size back; a null tip judges nothing.
   Runs lib/maker.js afterFill / holds / settleFills / reconcileFills / reconcilePostings against a stand-in node that
   models what the real one does: an output coin id is hash(first input, n) for EVERY transaction spending that input; a
   spent coin is never returned; `coins relevant:true` returns only my coins (any age); a null tip answers `block` with an
   error and every `coins` with status true and []; an unknown coin is []. */
(function () {
    var M = AX.maker, F = AX.fill, me = AX.identity.fromSeed('0x' + '44'.repeat(32), 'decks');
    var OID = '0x' + '5a'.repeat(8), C1 = '0x' + 'c1'.repeat(32), C2 = '0x' + 'c2'.repeat(32);
    var TX1 = '0x' + 'a1'.repeat(32), TX2 = '0x' + 'a2'.repeat(32), ADDR = '0x' + 'aa'.repeat(32), MYC = '0x' + 'ab'.repeat(32), TAKER = '0x' + 'ee'.repeat(32);
    var MINE = {}; MINE[ADDR] = true; MINE[MYC] = true;
    var kv = {}, lock = { owner: '' }, tip = 1000, tipNull = false, chain = {}, mempool = {}, pub = [], txpows = [], onchain = {};
    function unq(x) { return x.split("''").join("'"); }
    function sqlr(q) {
        var m;
        if (/^CREATE TABLE IF NOT EXISTS `dx_lock`/.test(q) || /^INSERT INTO `dx_lock`/.test(q)) return { status: true };
        if ((m = /^UPDATE `dx_lock` SET `owner`='([^']*)', `ts`=\d+ WHERE `id`='(\w+)' AND \(`owner`='' OR `owner` IS NULL OR `owner`='([^']*)'\)$/.exec(q))) { if (!lock.owner || lock.owner === m[3]) lock.owner = m[1]; return { status: true }; }
        if ((m = /^UPDATE `dx_lock` SET `owner`='' WHERE `id`='(\w+)' AND `owner`='([^']*)'$/.exec(q))) { if (lock.owner === m[2]) lock.owner = ''; return { status: true }; }
        if (/^SELECT `owner` FROM `dx_lock`/.test(q)) return { status: true, rows: [{ OWNER: lock.owner }] };
        if (/^INSERT INTO ax_kv \(k, v\) SELECT 'myorders'/.test(q)) { if (kv.myorders === undefined) kv.myorders = '[]'; return { status: true }; }
        if ((m = /^UPDATE ax_kv SET v='((?:[^']|'')*)' WHERE k='myorders' AND EXISTS/.exec(q))) { kv.myorders = unq(m[1]); return { status: true }; }
        if (q === "SELECT v FROM ax_kv WHERE k='myorders'") return { status: true, rows: [{ V: kv.myorders }] };
        if (q === "SELECT k, v FROM ax_kv WHERE k LIKE 'posting_%'") return { status: true, rows: Object.keys(kv).filter(function (k) { return k.indexOf('posting_') === 0; }).map(function (k) { return { K: k, V: kv[k] }; }) };
        if (/^SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'/.test(q)) return { status: true, rows: Object.keys(kv).filter(function (k) { return k.indexOf('fill_') === 0; }).map(function (k) { return { K: k, V: kv[k] }; }) };
        if (q === 'SELECT coinid FROM pp_posted_inputs') return { status: false, error: 'no table' };
        return { status: false, error: 'unexpected ' + q };
    }
    function row(id) { var c = chain[id]; return c ? [JSON.parse(JSON.stringify(c))] : []; }
    var mds = {
        kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); }, kvSet: function (k, v, cb) { kv[k] = v; cb && cb(null); }, kvDel: function (k, cb) { delete kv[k]; cb && cb(null); },
        sql: function (q, cb) { cb(sqlr(q)); },
        cmdR: function (c, cb) {
            var id, m;
            if (c === 'block') return tipNull ? cb(new Error('cmd failed: block — no tip')) : cb(null, { block: String(tip) });
            if ((m = /^coins (relevant:true )?(checkmempool:true )?coinid:(0x[0-9A-Fa-f]{64})$/.exec(c))) {
                id = m[3];
                if (tipNull) return cb(null, []);                                    // a null tip: status true and []
                var r = row(id).filter(function (x) { return !m[1] || MINE[x.address]; });
                return cb(null, m[2] && mempool[id] ? [] : r);
            }
            if (c === 'txpow relevant:true max:100') return cb(null, tipNull ? [] : txpows);
            if ((m = /^txpow onchain:(0x[0-9A-Fa-f]{64})$/.exec(c))) return cb(null, onchain[m[1]] ? { found: true, block: String(onchain[m[1]]), tip: String(tip) } : { found: false });
            cb(new Error('unexpected ' + c));
        },
        cmd: function (c, cb) { cb({ status: true }); }
    };
    /** mine a transaction spending `ins` (first one first) with `outs` at block `b`: the inputs leave, each output n gets
     *  the id hash(ins[0], n) — what TxBlock does */
    function mine(ins, outs, b) {
        ins.forEach(function (x) { delete chain[x]; delete mempool[x]; });
        outs.forEach(function (o, n) { var id = F.outputCoinId(ins[0], n); chain[id] = { coinid: id, address: o.address, tokenid: o.tokenid, amount: o.tokenid === F.MINIMA ? o.amount : '0.000001', tokenamount: o.tokenid === F.MINIMA ? undefined : o.amount, created: String(b) }; });
    }
    var relay = { relays: ['r'], publish: function (raw, cb) { pub.push(JSON.parse(raw)); cb([{ url: 'r', ok: true }]); } };
    function order() { return M.find(JSON.parse(kv.myorders), OID); }
    function rec(t) { return JSON.parse(kv['fill_' + t]); }
    function settle() { M.settleFills(mds, relay, me, function () { }, function () { }); }
    function coin(id, v, b) { chain[id] = { coinid: id, address: MYC, tokenid: F.MINIMA, amount: v, created: String(b || 900) }; }
    // a take of `filled` MINIMA @ 0.1 from my coin `c`: the taker gets it, my change back, I get `recv` MxUSD at ADDR (output 2)
    function takeOuts(c, filled, change, recv) { return [{ address: TAKER, tokenid: F.MINIMA, amount: filled }, { address: MYC, tokenid: F.MINIMA, amount: change }, { address: ADDR, tokenid: F.MXUSD, amount: recv }]; }
    function payOf(first, outs) { return { id: F.outputCoinId(first, 2), k: 2, address: ADDR, tokenid: F.MXUSD, amount: outs[2].amount }; }
    function record(t, c, filled, verified, recv, postBlock) {
        var outs = takeOuts(c, filled, '0', recv);
        return { role: 'maker', orderId: OID, side: 'sell', price: '0.1', filled: filled, received: recv, txpowid: t, coins: outs.map(function (o, n) { return F.outputCoinId(c, n); }),
            ts: 1800000000, status: 'settling', verified: verified, prov: true, ins: [c], postBlock: postBlock, pay: payOf(c, outs), first: c };
    }
    coin(C1, '60'); coin(C2, '60');
    kv.myorders = JSON.stringify([{ orderId: OID, side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: [C1, C2], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live', fillsFrom: 1 }]);

    // a REAL node's ids (private -test chain, 23 Nov 2026, minima-1.1.2.31-euro14-block.jar): the genesis coin spent by one
    // transaction with two outputs; `coins relevant:true` then listed them at exactly these ids
    T.eq('0.0.179: output coin ids as a real node derives them (hash of the first input and the output number)',
        [F.outputCoinId('0x6EFEB2DBE01CAB3EB62FB57CAA993599440FFE82BCD027F07D439380B9D8355C', 0), F.outputCoinId('0x6EFEB2DBE01CAB3EB62FB57CAA993599440FFE82BCD027F07D439380B9D8355C', 1)],
        ['0x59DFFF1D0AA4488DB3E95DA2E4053B88897AAEC6FBB6D1463600A5C92191307D', '0x433196F8848C6361C4E921B97B679AD53B7D929F623156E0B2ECFEFCD970BF29']);
    T.ok('0.0.179: output coin ids differ per output and are the same for every transaction spending that input', F.outputCoinId(C1, 0) !== F.outputCoinId(C1, 1) && F.outputCoinId(C1, 2) === F.outputCoinId(C1.toUpperCase().replace('0X', '0x'), 2) && /^0x[0-9A-F]{64}$/.test(F.outputCoinId(C1, 2)));

    // the post: deducted at once (the published size never exceeds what can still be sold), held as provisional
    var err = 'none', R1 = record(TX1, C1, '40', '100', '4', 1000);
    M.afterFill(mds, relay, me, OID, '40', [C1], function (e) { err = e; }, TX1, '100', { b: 1000, p: R1.pay.id });
    kv['fill_' + TX1] = JSON.stringify(R1);
    mempool[C1] = true;
    T.eq('0.0.161: posted → deducted and held provisional', [err, order().remaining, order().coins, order().prov], [null, '60', [C2], [{ t: TX1, f: '40', c: [C1], b: 1000, p: R1.pay.id }]]);
    T.eq('0.0.161: the relays get 60, never more than can still be sold', pub[pub.length - 1].amount, '60');
    var unheld = null; M.holds(mds, function (u) { unheld = u([{ coinid: C1 }, { coinid: C2 }, { coinid: R1.pay.id }]).map(function (c) { return c.coinid; }); });
    T.eq('0.0.161/0.0.179: a provisional fill\'s coin AND its payment coin are held from every chooser', unheld, [C2]);

    tip = 1005; settle();
    T.eq('0.0.161: in the mempool → still provisional', [rec(TX1).status, order().remaining, !!order().prov], ['settling', '60', true]);

    // MAJOR 2: a null tip (resync / megammrsync / restore) answers every `coins` with [] — never "spent", never "done"
    tipNull = true; tip = 1100; settle();
    T.eq('0.0.179: a null tip judges nothing (it read as spent → done)', [rec(TX1).status, order().remaining, !!order().prov], ['settling', '60', true]);
    tipNull = false; tip = 999; settle();
    T.eq('0.0.179: a tip below the post block judges nothing', rec(TX1).status, 'settling');

    // MAJOR 1: my input C1 spent by ANOTHER transaction (my own relock of it) — that transaction has an output at the take's
    // payment id too, but it is not the payment: the take never mined → lost, the size back
    mine([C1], [{ address: MYC, tokenid: F.MINIMA, amount: '60' }, { address: MYC, tokenid: F.MINIMA, amount: '0' }, { address: ADDR, tokenid: F.MXUSD, amount: '1' }], 1006);
    tip = 1007; var n = pub.length; settle();
    T.eq('0.0.179: my input spent by another transaction (it used to read "done") → lost, the size given back',
        [rec(TX1).status, order().remaining, order().prov, order().fills], ['lost', '100', undefined, []]);
    T.ok('0.0.179: ... said why, and re-published at 100 (' + rec(TX1).why + ')', /^spent elsewhere: coin 0x/.test(rec(TX1).why) && pub.length === n + 1 && pub[n].amount === '100');
    settle();
    T.eq('0.0.161: given back once', order().remaining, '100');
    // the review's probe: the lost fill's shared output id is on chain — it must NOT re-apply (remaining 20 where truth is 60)
    tip = 1100; settle(); settle();
    T.eq('0.0.179: never re-applied on a shared output id', [rec(TX1).status, order().remaining], ['lost', '100']);

    // a fill that never mines: unspent and out of the mempool 16 blocks after the post → lost (unchanged)
    var TX3 = '0x' + 'a3'.repeat(32), C3 = '0x' + 'c3'.repeat(32), R3;
    coin(C3, '60'); tip = 1200;
    R3 = record(TX3, C3, '30', '100', '3', 1200);
    M.afterFill(mds, relay, me, OID, '30', [C3], function () { }, TX3, '100', { b: 1200, p: R3.pay.id });
    kv['fill_' + TX3] = JSON.stringify(R3);
    tip = 1210; settle();
    T.eq('0.0.161: out of the mempool but only 10 blocks after the post → still provisional', [rec(TX3).status, order().remaining], ['settling', '70']);
    tip = 1216; settle();
    T.eq('0.0.161: unspent and out of the mempool 16 blocks after the post → lost, the size given back', [rec(TX3).status, order().remaining], ['lost', '100']);
    // it mines after all (a late rebroadcast): its OWN payment shows up → re-applied ONCE, provisional again, done when deep
    mine([C3], takeOuts(C3, '30', '30', '3'), 1220);
    tip = 1221; settle();
    T.eq('0.0.161/0.0.179: a lost fill whose payment proves mined is re-applied, provisional until deep', [rec(TX3).status, rec(TX3).reapplied, rec(TX3).seen, order().remaining], ['settling', true, 1220, '70']);
    settle(); settle();
    T.eq('0.0.161: ... once', order().remaining, '70');
    tip = 1220 + M.CONFIRM_BLOCKS; settle();
    T.eq('0.0.179: ... and done ' + M.CONFIRM_BLOCKS + ' blocks after its payment', [rec(TX3).status, rec(TX3).block, order().prov, order().remaining], ['done', 1220, undefined, '70']);

    // a fill that mines: its own payment is seen → provisional until CONFIRM_BLOCKS deep, then done; nothing given back
    var R2 = record(TX2, C2, '20', '70', '2', 1300);
    tip = 1300; M.afterFill(mds, relay, me, OID, '20', [C2], function () { }, TX2, '70', { b: 1300, p: R2.pay.id });
    kv['fill_' + TX2] = JSON.stringify(R2);
    mine([C2], takeOuts(C2, '20', '40', '2'), 1302); tip = 1303; settle();
    T.eq('0.0.179: mined → seen, still provisional (not deep yet)', [rec(TX2).status, rec(TX2).seen, order().remaining, !!order().prov], ['settling', 1302, '50', true]);
    delete chain[R2.pay.id]; tip = 1302 + M.CONFIRM_BLOCKS - 1; settle();   // I spent the payment before it was deep
    T.eq('0.0.179: the payment spent after it was seen: the sighting stands, still provisional', [rec(TX2).status, rec(TX2).seen], ['settling', 1302]);
    tip = 1302 + M.CONFIRM_BLOCKS; settle();
    T.eq('0.0.179: done at its payment\'s block once deep, the entry dropped, the deduction stands', [rec(TX2).status, rec(TX2).block, order().prov, order().remaining], ['done', 1302, undefined, '50']);

    // a payment spent BEFORE any pass saw it: the mined transaction is found by its first input (txpow relevant + onchain)
    var TX4 = '0x' + 'a4'.repeat(32), C4 = '0x' + 'c4'.repeat(32), MINED4 = '0x' + 'b4'.repeat(32), R4;
    coin(C4, '60'); tip = 1400;
    R4 = record(TX4, C4, '10', '50', '1', 1400);
    M.afterFill(mds, relay, me, OID, '10', [C4], function () { }, TX4, '50', { b: 1400, p: R4.pay.id }); kv['fill_' + TX4] = JSON.stringify(R4);
    mine([C4], takeOuts(C4, '10', '50', '1'), 1401); delete chain[R4.pay.id];
    tip = 1402; settle();
    T.eq('0.0.179: no payment coin and no mined transaction found → no verdict either way', [rec(TX4).status, order().remaining], ['settling', '40']);
    txpows = [{ txpowid: MINED4, body: { txn: { inputs: [{ coinid: C4 }], outputs: takeOuts(C4, '10', '50', '1').map(function (o) { return { address: o.address, tokenid: o.tokenid, amount: o.tokenid === F.MINIMA ? o.amount : '0.000001', tokenamount: o.tokenid === F.MINIMA ? undefined : o.amount }; }) } } }];
    onchain[MINED4] = 1401; tip = 1412; settle();
    T.eq('0.0.179: ... found by its first input on chain → seen at its block', [rec(TX4).status, rec(TX4).seen], ['settling', 1401]);
    // the same first input spent by a different transaction on chain → spent elsewhere
    var TX5 = '0x' + 'a5'.repeat(32), C5 = '0x' + 'c5'.repeat(32), OTHER = '0x' + 'b5'.repeat(32), R5;
    coin(C5, '60'); tip = 1500; R5 = record(TX5, C5, '10', '40', '1', 1500);
    M.afterFill(mds, relay, me, OID, '10', [C5], function () { }, TX5, '40', { b: 1500, p: R5.pay.id }); kv['fill_' + TX5] = JSON.stringify(R5);
    delete chain[C5]; txpows.push({ txpowid: OTHER, body: { txn: { inputs: [{ coinid: C5 }], outputs: [{ address: TAKER, tokenid: F.MINIMA, amount: '60' }] } } }); onchain[OTHER] = 1501;
    tip = 1502; settle();
    T.eq('0.0.179: its first input spent on chain by another transaction → lost, the size back', [rec(TX5).status, order().remaining], ['lost', '40']);

    // a TAKER record (0.0.179: it carries my received coin): never done on another transaction's output at that id
    var TXT = '0x' + 'a6'.repeat(32), MC = '0x' + 'c6'.repeat(32);
    kv['fill_' + TXT] = JSON.stringify({ role: 'taker', orderId: '0x' + '6b'.repeat(8), side: 'buy', price: '0.1', filled: '25', got: '25', txpowid: TXT, coins: [F.outputCoinId(MC, 0)], ts: 1800000000, status: 'settling',
        first: MC, pay: { id: F.outputCoinId(MC, 0), k: 0, address: MYC, tokenid: F.MINIMA, amount: '25' } });
    chain[F.outputCoinId(MC, 0)] = { coinid: F.outputCoinId(MC, 0), address: MYC, tokenid: F.MINIMA, amount: '60', created: '1500' };   // not my 25: another spend of MC
    tip = 1600; settle();
    T.ok('0.0.179: a taker record is not done on another transaction\'s output at its id (it read "done")', rec(TXT).status !== 'done');

    // afterFill failed at the post: the refresh's reconcile deducts the record AND keeps it provisional
    var TX7 = '0x' + 'a7'.repeat(32), list = JSON.parse(kv.myorders); list[0].coins = [];
    kv['fill_' + TX7] = JSON.stringify({ role: 'maker', orderId: OID, side: 'sell', price: '0.1', filled: '5', txpowid: TX7, coins: [], ts: Math.floor(Date.now() / 1000), status: 'settling', verified: '40', prov: true, ins: [C1], postBlock: 1600, pay: { id: '0x' + '9a'.repeat(32), k: 2, address: ADDR, tokenid: F.MXUSD, amount: '0.5' } });
    M.reconcileFills(mds, list, function () { });
    T.eq('0.0.161: reconcile deducts a provisional record and holds it provisional', [list[0].remaining, list[0].prov], ['35', [{ t: TX7, f: '5', c: [C1], b: 1600, p: '0x' + '9a'.repeat(32) }]]);

    // 0.0.162 (review, MINOR): the durable posting record, reconciled from the coins (boot and every settle pass)
    delete kv['fill_' + TX7];
    var C8 = '0x' + 'c8'.repeat(32), C9 = '0x' + 'c9'.repeat(32), old = Math.floor(Date.now() / 1000) - 600, lines = null;
    coin(C8, '60', 1600); coin(C9, '60', 1600); mempool[C9] = true; tip = 1700;
    list = JSON.parse(kv.myorders); list[0].remaining = '40'; list[0].coins = [C8, C9]; delete list[0].prov; kv.myorders = JSON.stringify(list);
    function post(c, extra) { var outs = takeOuts(c, '10', '50', '1'); return JSON.stringify(Object.assign({ orderId: OID, side: 'sell', price: '0.1', ins: [c], outs: outs.map(function (o, k) { return F.outputCoinId(c, k); }), filled: '10', received: '1', paid: '10', verified: '40', taker: '0x' + '77'.repeat(64), ts: old, pay: payOf(c, outs), first: c }, extra || {})); }
    // 0.0.180 (review, MAJOR 2): a NULL tip answers `coins` with [] — that read as "spent on chain: it was posted" and a
    // take that never happened was recovered and deducted; now nothing is judged until the node has a tip >= the record's
    var C10 = '0x' + 'd0'.repeat(32); coin(C10, '60', 1600); list = JSON.parse(kv.myorders); list[0].coins = [C8, C9, C10]; kv.myorders = JSON.stringify(list);
    kv['posting_' + OID] = post(C10, { b: 1650 }); tipNull = true;
    M.reconcilePostings(mds, relay, me, function (l) { lines = l; });
    T.eq('0.0.180: a null tip recovers nothing (it read as posted: a phantom fill deducted)', [order().remaining, !!kv['posting_' + OID]], ['40', true]);
    tipNull = false; tip = 1640;
    M.reconcilePostings(mds, relay, me, function (l) { lines = l; });
    T.eq('0.0.180: ... nor a tip below the record\'s block', [order().remaining, !!kv['posting_' + OID]], ['40', true]);
    tip = 1700; delete kv['posting_' + OID];
    kv['posting_' + OID] = post(C8);
    M.reconcilePostings(mds, relay, me, function (l) { lines = l; });
    T.ok('0.0.162: never posted (my coin unspent, not being spent) → removed, nothing sold (' + lines + ')', kv['posting_' + OID] === undefined && order().remaining === '40' && /was never posted/.test(lines[0]));
    kv['posting_' + OID] = post(C9);
    var P9 = JSON.parse(post(C9)).pay.id;
    M.reconcilePostings(mds, relay, me, function (l) { lines = l; });
    T.eq('0.0.162/0.0.179: posted but never recorded (my coin in the mempool) → recovered under its computed payment coin id, provisional, applied',
        [rec(P9).status, rec(P9).prov, rec(P9).recovered, order().remaining, order().fills.indexOf(P9) >= 0, kv['posting_' + OID]], ['settling', true, true, '30', true, undefined]);
    kv['posting_' + OID] = post(C9, { txpowid: TX7, postBlock: 1700 });
    M.reconcilePostings(mds, relay, me, function (l) { lines = l; });
    T.ok('0.0.162: posted, its fill record missing → written from the posting record (' + lines + ')', rec(TX7).txpowid === TX7 && rec(TX7).prov === true && rec(TX7).pay.id === P9 && kv['posting_' + OID] !== undefined);
    list = JSON.parse(kv.myorders); list[0].fills = list[0].fills.concat([TX7]); kv.myorders = JSON.stringify(list);
    M.reconcilePostings(mds, relay, me, function () { });
    T.eq('0.0.162: removed once the order lists the fill', kv['posting_' + OID], undefined);
    // 0.0.181 (review, MAJOR 3): a posting_ record is validated like a fill_ record before anything is applied — the review's
    // probe: a forged record with filled -50 and a coin the order never had grew the order 100 → 150
    tip = 1800; list = JSON.parse(kv.myorders); list[0].remaining = '100'; list[0].amount = '100'; list[0].coins = [C8]; list[0].fills = []; kv.myorders = JSON.stringify(list);
    var STRANGE = '0x' + 'f0'.repeat(32), forged = [
        ['a negative fill', post(STRANGE, { filled: '-50' })], ['a negative fill on my own coin', post(C8, { filled: '-50' })], ['a fill of 0', post(C8, { filled: '0' })],
        ['junk checked size', post(C8, { verified: '1e9' })], ['a fill over its checked size', post(C8, { filled: '50', verified: '40' })],
        ['a coin the order never had', post(STRANGE)], ['another order\'s key', post(C8, { orderId: '0x' + '6c'.repeat(8) })]];
    forged.forEach(function (x) {
        delete chain[C8]; delete chain[STRANGE];   // "spent": the recover path, which deducted
        kv['posting_' + OID] = x[1]; lines = null;
        M.reconcilePostings(mds, relay, me, function (l) { lines = l; });
        T.ok('0.0.181: a posting record with ' + x[0] + ' is refused and removed, nothing applied (' + lines + ')', order().remaining === '100' && kv['posting_' + OID] === undefined && /refused, nothing applied/.test(String(lines)));
    });
    coin(C8, '60', 1600);
    // 0.0.186 (review, MINOR 1): a posting record whose fill went 'lost' before reconcile is removed (the order refused every
    // take while it stayed, for good: reconcileFills never applies a lost fill)
    var TXL = '0x' + 'af'.repeat(32);
    kv['fill_' + TXL] = JSON.stringify({ role: 'maker', orderId: OID, side: 'sell', price: '0.1', filled: '10', txpowid: TXL, ts: Math.floor(Date.now() / 1000), status: 'lost', verified: '100', prov: true, ins: [C8], postBlock: 1800 });
    kv['posting_' + OID] = post(C8, { txpowid: TXL, postBlock: 1800 }); lines = null;
    M.reconcilePostings(mds, relay, me, function (l) { lines = l; });
    T.ok('0.0.186: a posting record whose fill is lost is removed — the order takes takes again (' + lines + ')', kv['posting_' + OID] === undefined && /never mined/.test(String(lines)));
})();
