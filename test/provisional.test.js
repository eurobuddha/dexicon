/* provisional.test.js — 0.0.161 (review, MAJOR — phantom fills): a maker fill counted at `txnpost` is PROVISIONAL until its
   input is spent on chain. The published size never exceeds what can still be sold, a take that never mines gives the size
   back by itself (its coin unspent and out of the mempool 16 blocks after the post), and a fill marked lost that later
   mines is re-applied once. Runs lib/maker.js afterFill / holds / settleFills / reconcileFills against a stub node. */
(function () {
    var M = AX.maker, F = AX.fill, me = AX.identity.fromSeed('0x' + '44'.repeat(32), 'decks');
    var OID = '0x' + '5a'.repeat(8), C1 = '0x' + 'c1'.repeat(32), C2 = '0x' + 'c2'.repeat(32), OUT1 = '0x' + '01'.repeat(32), OUT2 = '0x' + '02'.repeat(32);
    var TX1 = '0x' + 'a1'.repeat(32), TX2 = '0x' + 'a2'.repeat(32), ADDR = '0x' + 'aa'.repeat(32);
    var kv = {}, lock = { owner: '' }, tip = 1000, chain = {}, mempool = {}, pub = [];   // chain: coin id → row (unspent on chain)
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
        if (/^SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'/.test(q)) return { status: true, rows: Object.keys(kv).filter(function (k) { return k.indexOf('fill_') === 0; }).map(function (k) { return { K: k, V: kv[k] }; }) };
        if (q === 'SELECT coinid FROM pp_posted_inputs') return { status: false, error: 'no table' };
        return { status: false, error: 'unexpected ' + q };
    }
    var mds = {
        kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); }, kvSet: function (k, v, cb) { kv[k] = v; cb && cb(null); },
        sql: function (q, cb) { cb(sqlr(q)); },
        cmdR: function (c, cb) {
            var id;
            if (c === 'block') return cb(null, { block: String(tip) });
            if (/^coins relevant:true checkmempool:true coinid:/.test(c)) { id = c.split('coinid:')[1]; return cb(null, chain[id] && !mempool[id] ? [chain[id]] : []); }
            if (/^coins (relevant:true )?coinid:/.test(c)) { id = c.split('coinid:')[1]; return cb(null, chain[id] ? [chain[id]] : []); }
            cb(new Error('unexpected ' + c));
        },
        cmd: function (c, cb) { cb({ status: true }); }
    };
    var relay = { relays: ['r'], publish: function (raw, cb) { pub.push(JSON.parse(raw)); cb([{ url: 'r', ok: true }]); } };
    function order() { return M.find(JSON.parse(kv.myorders), OID); }
    function rec(t) { return JSON.parse(kv['fill_' + t]); }
    function settle() { M.settleFills(mds, relay, me, function () { }, function () { }); }
    chain[C1] = { coinid: C1, created: '900' }; chain[C2] = { coinid: C2, created: '900' };
    kv.myorders = JSON.stringify([{ orderId: OID, side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: [C1, C2], scripts: [], address: ADDR, seq: 1, expiry: 9e9, status: 'live', fillsFrom: 1 }]);

    // the post: deducted at once (the published size never exceeds what can still be sold), held as provisional
    var err = 'none';
    M.afterFill(mds, relay, me, OID, '40', [C1], function (e) { err = e; }, TX1, '100', { b: 1000 });
    kv['fill_' + TX1] = JSON.stringify({ role: 'maker', orderId: OID, side: 'sell', price: '0.1', filled: '40', txpowid: TX1, coins: [OUT1], ts: 1800000000, status: 'settling', verified: '100', prov: true, ins: [C1], postBlock: 1000 });
    mempool[C1] = true;
    T.eq('0.0.161: posted → deducted and held provisional', [err, order().remaining, order().coins, order().prov], [null, '60', [C2], [{ t: TX1, f: '40', c: [C1], b: 1000 }]]);
    T.eq('0.0.161: the relays get 60, never more than can still be sold', pub[pub.length - 1].amount, '60');
    var unheld = null; M.holds(mds, function (u) { unheld = u([{ coinid: C1 }, { coinid: C2 }]).map(function (c) { return c.coinid; }); });
    T.eq('0.0.161: a provisional fill\'s coin is held from every chooser', unheld, [C2]);

    tip = 1005; settle();
    T.eq('0.0.161: in the mempool → still provisional', [rec(TX1).status, order().remaining, !!order().prov], ['settling', '60', true]);
    delete mempool[C1]; tip = 1010; settle();   // dropped (a double-spent taker coin): out of the mempool, unspent
    T.eq('0.0.161: out of the mempool but only 10 blocks after the post → still provisional', [rec(TX1).status, order().remaining], ['settling', '60']);
    tip = 1016; var n = pub.length; settle();
    T.eq('0.0.161: unspent and out of the mempool 16 blocks after the post → lost, the size given back', [rec(TX1).status, order().remaining, order().prov, order().fills], ['lost', '100', undefined, []]);
    T.ok('0.0.161: ... said, and re-published at 100', /^never mined: my coin 0x/.test(rec(TX1).why) && pub.length === n + 1 && pub[n].amount === '100');
    settle();
    T.eq('0.0.161: given back once', order().remaining, '100');

    // the lost fill mines after all (a late rebroadcast, a reorg): its output shows up on chain → re-applied ONCE
    delete chain[C1]; chain[OUT1] = { coinid: OUT1, created: '1020' }; tip = 1021; settle();
    T.eq('0.0.161: a lost fill that mines is re-applied', [rec(TX1).status, rec(TX1).reapplied, rec(TX1).block, order().remaining], ['done', true, 1020, '60']);
    settle(); settle();
    T.eq('0.0.161: ... once', order().remaining, '60');

    // a fill that mines: its input is spent on chain → done, provisional entry dropped, nothing given back
    M.afterFill(mds, relay, me, OID, '20', [C2], function () { }, TX2, '60', { b: 1021 });
    kv['fill_' + TX2] = JSON.stringify({ role: 'maker', orderId: OID, side: 'sell', price: '0.1', filled: '20', txpowid: TX2, coins: [OUT2], ts: 1800000100, status: 'settling', verified: '60', prov: true, ins: [C2], postBlock: 1021 });
    delete chain[C2]; chain[OUT2] = { coinid: OUT2, created: '1022' }; tip = 1040; settle();
    T.eq('0.0.161: mined → done at its output\'s block, the entry dropped, the deduction stands', [rec(TX2).status, rec(TX2).block, order().prov, order().remaining], ['done', 1022, undefined, '40']);

    // afterFill failed at the post: the refresh's reconcile deducts the record AND keeps it provisional
    var TX3 = '0x' + 'a3'.repeat(32), list = JSON.parse(kv.myorders); list[0].coins = [];
    kv['fill_' + TX3] = JSON.stringify({ role: 'maker', orderId: OID, side: 'sell', price: '0.1', filled: '5', txpowid: TX3, coins: [], ts: Math.floor(Date.now() / 1000), status: 'settling', verified: '40', prov: true, ins: [C1], postBlock: 1040 });
    M.reconcileFills(mds, list, function () { });
    T.eq('0.0.161: reconcile deducts a provisional record and holds it provisional', [list[0].remaining, list[0].prov], ['35', [{ t: TX3, f: '5', c: [C1], b: 1040 }]]);
})();
