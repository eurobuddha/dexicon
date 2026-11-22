/* takeable.test.js — owner 22 Nov 2026: an order this node cannot take is not shown as market (lib/takeable.js). */
(function () {
    var K = AX.takeable;
    var ME = '0x' + 'ab'.repeat(32), MAKER = '0x5243C4B815456066ABCD619F4D5474FBBE224449F38DB4D1F7528CC8F3916296';
    var C1 = '0x' + 'C1'.repeat(32), C2 = '0x' + 'C2'.repeat(32), C3 = '0x' + 'C3'.repeat(32);
    function order(id, side, price, coins, signPk) { return { orderId: id, side: side, price: price, amount: '100', coins: coins, signPk: signPk || MAKER, pubId: 'pk' }; }
    function ok(id) { var r = {}; r[id.toLowerCase()] = { id: id, v: 'ok', atBlock: 1 }; return r; }
    var V = {}; V[C1.toLowerCase()] = { v: 'ok' }; V[C2.toLowerCase()] = { v: 'missing' };

    // --- the pure predicate ---
    T.eq('all coins ok → ok', K.check(order('0x01', 'sell', '1', [C1]), V, ME).state, 'ok');
    var no = K.check(order('0x02', 'sell', '1', [C1, C2]), V, ME);
    T.eq('one coin missing → no (hidden whole)', [no.state, no.coins], ['no', [C2]]);
    T.eq('one coin never checked → unknown', K.check(order('0x03', 'sell', '1', [C1, C3]), V, ME).state, 'unknown');
    T.eq('missing beats unknown', K.check(order('0x04', 'sell', '1', [C3, C2]), V, ME).state, 'no');
    T.eq('coinless → no', K.check(order('0x05', 'sell', '1', []), V, ME).state, 'no');
    T.eq('my own order → ok whatever the verdicts', K.check(order('0x06', 'sell', '1', [C2, C3], ME.toUpperCase().replace('0X', '0x')), V, ME).state, 'ok');
    T.eq('my own coinless order stays off the book (as before)', K.check(order('0x07', 'sell', '1', [], ME), V, ME).state, 'no');
    T.eq('coin ids compare case-insensitively', K.check(order('0x08', 'sell', '1', [C1.toLowerCase()]), ok(C1.toUpperCase().replace('0X', '0x')), ME).state, 'ok');
    T.eq('no verdicts at all → unknown', K.check(order('0x09', 'buy', '1', [C1]), {}, ME).state, 'unknown');

    // --- wanted: best first, both sides interleaved, never my own, each coin once ---
    T.eq('wanted order', K.wanted([order('0xa', 'sell', '2', [C2]), order('0xb', 'sell', '1', [C1]), order('0xc', 'buy', '0.5', [C3, C1]), order('0xd', 'buy', '0.9', ['0x' + 'D0'.repeat(32)], ME)], ME),
        [C3, C1, C2]);

    // --- the cache: a stubbed node, synchronous like the Rhino transport ---
    var node = {}, calls = [], fail = {};
    function cmd(c, cb) {
        calls.push(c);
        var id = c.replace('coins coinid:', '');
        if (fail[id] === 'error') return cb(new Error('cmd failed: ' + c));
        if (fail[id] === 'odd') return cb(null, undefined);   // pending/odd reply: not an answer
        cb(null, node[id] ? [{ coinid: id, amount: '1', spent: false }] : []);
    }
    var changes = 0, vc = new K.Cache(cmd, { onChange: function () { changes++; }, maxPerBlock: 5 });
    vc.onBlock(2431800);
    node[C1] = true;
    vc.warm([C1, C2]);
    T.eq('new coins → one lookup each', calls, ['coins coinid:' + C1, 'coins coinid:' + C2]);
    T.eq('verdicts', [vc.verdicts()[C1.toLowerCase()].v, vc.verdicts()[C2.toLowerCase()].v], ['ok', 'missing']);
    T.ok('the take gets the coin row', vc.coin(C1.toLowerCase()) && vc.coin(C1).coinid === C1);
    T.eq('verdict carries the block it was checked at', vc.verdicts()[C2.toLowerCase()].atBlock, 2431800);
    calls.length = 0; vc.warm([C1, C2]);
    T.eq('same block: no second lookup', calls.length, 0);
    // NEWBLOCK: every verdict is re-checked; a spend flips ok→missing, the node catching up flips missing→ok
    delete node[C1]; node[C2] = true;
    vc.onBlock(2431801); vc.warm([C1, C2]);
    T.eq('re-checked once on the new block', calls.length, 2);
    T.eq('ok → missing and missing → ok', [vc.verdicts()[C1.toLowerCase()].v, vc.verdicts()[C2.toLowerCase()].v], ['missing', 'ok']);
    // an error, or a reply that is not a list, keeps the previous verdict; a never-checked coin stays unknown
    vc.onBlock(2431802); fail[C2] = 'error'; fail[C1] = 'odd'; fail[C3] = 'error';
    vc.warm([C1, C2, C3]);
    T.eq('error keeps ok', vc.verdicts()[C2.toLowerCase()].v, 'ok');
    T.eq('odd reply keeps missing', vc.verdicts()[C1.toLowerCase()].v, 'missing');
    T.ok('error on a new coin → still unknown', !vc.verdicts()[C3.toLowerCase()]);
    T.eq('an order confirmed before stays shown through a failed re-check', K.check(order('0xe', 'sell', '1', [C2]), vc.verdicts(), ME).state, 'ok');
    fail = {};
    // eviction: a verdict wanted at block 2431802 and not again is gone at 2431805 (two whole blocks unused)
    vc.onBlock(2431803); vc.onBlock(2431804);
    T.ok('kept while unused for under 2 blocks', !!vc.verdicts()[C2.toLowerCase()]);
    vc.onBlock(2431805);
    T.ok('evicted after 2 unused blocks', !vc.verdicts()[C2.toLowerCase()] && !vc.verdicts()[C1.toLowerCase()]);
    // the per-block cap: 7 new coins, cap 5 → 5 looked up now, 2 stay unknown until the next block
    var many = [], i; for (i = 0; i < 7; i++) { many.push('0x' + ('E' + i).repeat(32)); node[many[i]] = true; }
    calls.length = 0; vc.warm(many);
    T.eq('cap: 5 lookups this block', calls.length, 5);
    T.ok('cap: the rest stay unknown', !vc.verdicts()[many[5].toLowerCase()] && !vc.verdicts()[many[6].toLowerCase()]);
    T.eq('cap: an order on a capped coin is "checking"', K.summary(K.hidden([order('0xf', 'sell', '1', [many[6]])], vc.verdicts(), ME)), 'checking 1 FAST order…');
    vc.onBlock(2431806); calls.length = 0; vc.warm(many);
    T.eq('next block: best first again, the cap holds', calls.slice(0, 5), many.slice(0, 5).map(function (x) { return 'coins coinid:' + x; }));
    // a refused take: the coin row is fetched again, the shown verdict stands
    vc.recheck([many[0]]);
    T.ok('recheck drops the row', !vc.coin(many[0]));
    T.eq('recheck keeps the verdict', vc.verdicts()[many[0].toLowerCase()].v, 'ok');
    // a busy pass queues the next call (the page's async transport)
    (function () {
        var pending = [], q = new K.Cache(function (c, cb) { pending.push(cb); });
        q.onBlock(1); q.warm([C1]); q.warm([C1, C2]);
        T.eq('one command in flight at a time', pending.length, 1);
        pending.shift()(null, []);
        T.eq('queued call runs after it', pending.length, 1);
    })();

    // --- the real incident (22 Nov 2026): order 0x77da4748491f267c, coin created at 2431726, ~1826 blocks before the
    //     taker's tip: this light node's `coins coinid:` returns an empty list → hidden, with the reason and whole ids
    (function () {
        var COIN = '0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8';
        var ghost = { orderId: '0x77da4748491f267c', side: 'buy', price: '0.0042', amount: '1000', coins: [COIN], signPk: MAKER, pubId: 'pkG' };
        var good = order('0x1111111111111111', 'buy', '0.004', [C1]);
        var q = new K.Cache(function (c, cb) { cb(null, c === 'coins coinid:' + C1 ? [{ coinid: C1 }] : []); });
        q.onBlock(2433552); q.warm(K.wanted([ghost, good], ME));
        var h = K.hidden([ghost, good], q.verdicts(), ME);
        T.eq('incident: the ghost is hidden as not takeable', h.no.map(function (e) { return e.order.orderId; }), ['0x77da4748491f267c']);
        T.eq('incident: the line', K.summary(h), '1 FAST order hidden: not takeable from this node (a backing coin is spent or older than this node\'s chain window)');
        var text = K.describe(h.no[0], q.verdicts()).join('\n');
        T.ok('incident: whole order id, maker key and coin id', text.indexOf('order 0x77da4748491f267c') >= 0 && text.indexOf('maker ' + MAKER) >= 0 && text.indexOf('coin ' + COIN + ' — spent or not seen by this node (checked at block 2433552)') >= 0);
        var shown = [ghost, good].filter(function (o) { return K.check(o, q.verdicts(), ME).state === 'ok'; });
        T.eq('incident: the best bid is the takeable 0.004, not the ghost 0.0042', shown.map(function (o) { return o.price; }), ['0.004']);
    })();
})();
