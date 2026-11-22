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

    // --- wanted: the lookup plan, best price first (exact decimals), both sides interleaved, never my own ---
    var W = K.wanted([order('0xa', 'sell', '2', [C2]), order('0xb', 'sell', '1', [C1]), order('0xc', 'buy', '0.5', [C3, C1]), order('0xd', 'buy', '0.9', ['0x' + 'D0'.repeat(32)], ME)], ME, {});
    T.eq('wanted: orders best first, sides interleaved', W.orders.map(function (o) { return o.orderId; }), ['0xc', '0xb', '0xa']);
    T.eq('wanted: every coin in scope is used, never my own', W.used, [C3, C1, C1, C2]);
    T.eq('wanted: nothing shown yet, nothing to re-check', W.recheck, []);
    // exact decimal order: 0.10000000000000000001 is above 0.1, which parseFloat cannot tell apart
    T.eq('wanted: exact price order, no floats', K.wanted([order('0xf1', 'buy', '0.1', [C1]), order('0xf2', 'buy', '0.10000000000000000001', [C2])], ME, {}).orders.map(function (o) { return o.orderId; }), ['0xf2', '0xf1']);

    // --- the cache: a stubbed node, synchronous like the Rhino transport ---
    var node = {}, calls = [], fail = {}, REJECT_POOL = false;
    function idOf(c) { return c.split(' ')[1].replace('coinid:', ''); }
    function cmd(c, cb) {
        calls.push(c);
        var id = idOf(c);
        if (REJECT_POOL && c.indexOf('checkmempool') >= 0) return cb(new Error('cmd failed: ' + c + ' — Invalid parameter : checkmempool'));
        if (fail[id] === 'error') return cb(new Error('cmd failed: ' + c));
        if (fail[id] === 'odd') return cb(null, undefined);   // pending/odd reply: not an answer
        cb(null, node[id] ? [{ coinid: id, amount: '1', spent: false }] : []);
    }
    function look(id) { return 'coins coinid:' + id + ' checkmempool:true'; }
    function warmAll(c, book) { c.warm(K.wanted(book, ME, c.verdicts())); }
    var changes = 0, vc = new K.Cache(cmd, { onChange: function () { changes++; }, maxPerBlock: 5 });
    var bookA = [order('0xa1', 'sell', '1', [C1]), order('0xa2', 'sell', '2', [C2])];
    vc.onBlock(2431800);
    node[C1] = true;
    warmAll(vc, bookA);
    T.eq('new coins → one lookup each, mempool checked', calls, [look(C1), look(C2)]);
    T.eq('verdicts', [vc.verdicts()[C1.toLowerCase()].v, vc.verdicts()[C2.toLowerCase()].v], ['ok', 'missing']);
    T.ok('the take gets the coin row confirmed in this block', vc.coin(C1.toLowerCase()) && vc.coin(C1).coinid === C1);
    T.eq('verdict carries the block it was checked at', vc.verdicts()[C2.toLowerCase()].atBlock, 2431800);
    calls.length = 0; warmAll(vc, bookA);
    T.eq('same block: no second lookup', calls.length, 0);
    // NEWBLOCK: the shown order is re-checked (a spend hides it); a missing coin is NOT asked again for 10 blocks
    delete node[C1]; node[C2] = true;
    vc.onBlock(2431801);
    T.ok('a new block: no take may use the older row', vc.coin(C1) === null);
    warmAll(vc, bookA);
    T.eq('shown order re-checked; missing coin left alone', calls, [look(C1)]);
    T.eq('ok → missing at once; missing stays missing', [vc.verdicts()[C1.toLowerCase()].v, vc.verdicts()[C2.toLowerCase()].v], ['missing', 'missing']);
    var b;
    for (b = 2431802; b < 2431810; b++) { vc.onBlock(b); calls.length = 0; warmAll(vc, bookA); }
    T.eq('a missing verdict is not re-queried for 10 blocks', calls, []);
    vc.onBlock(2431810); calls.length = 0; warmAll(vc, bookA);
    T.eq('10 blocks after its check: the missing coin is asked again', calls, [look(C2)]);
    T.eq('the node caught up: missing → ok', vc.verdicts()[C2.toLowerCase()].v, 'ok');
    vc.onBlock(2431811); calls.length = 0; warmAll(vc, bookA);
    T.eq('the other missing coin, checked a block later, is asked a block later', calls, [look(C2), look(C1)]);
    // on demand: a recheck asks a missing coin at once
    vc.onBlock(2431812); calls.length = 0; warmAll(vc, bookA);
    T.eq('not due: only the shown order is re-checked', calls, [look(C2)]);
    node[C1] = true; calls.length = 0; vc.recheck([C1]); warmAll(vc, bookA);
    T.eq('recheck: the missing coin is asked at once', calls, [look(C1)]);
    T.eq('recheck: and found', vc.verdicts()[C1.toLowerCase()].v, 'ok');
    // an error, or a reply that is not a list, keeps the previous verdict; a never-checked coin stays unknown
    vc.onBlock(2431813); fail[C2] = 'error'; fail[C1] = 'odd'; fail[C3] = 'error';
    var bookB = bookA.concat([order('0xa3', 'sell', '3', [C3])]);
    warmAll(vc, bookB);
    T.eq('error keeps ok', vc.verdicts()[C2.toLowerCase()].v, 'ok');
    T.eq('odd reply keeps ok', vc.verdicts()[C1.toLowerCase()].v, 'ok');
    T.ok('error on a new coin → still unknown', !vc.verdicts()[C3.toLowerCase()]);
    T.ok('a plain error (it echoes the command) is not a rejected checkmempool', vc.mempool === true);
    T.eq('an order confirmed before stays shown through one failed re-check', K.check(order('0xe', 'sell', '1', [C2]), vc.verdicts(), ME).state, 'ok');
    T.ok('…but no take may use its row', vc.coin(C2) === null);
    // an 'ok' that cannot be re-confirmed for 3 blocks is dropped: the order is "checking" again (never a lasting ghost)
    vc.onBlock(2431814); warmAll(vc, bookB); vc.onBlock(2431815); warmAll(vc, bookB);
    T.eq('still shown after 2 unconfirmed blocks', K.check(bookA[1], vc.verdicts(), ME).state, 'ok');
    vc.onBlock(2431816);
    T.eq('3 unconfirmed blocks → unknown (hidden, counted as checking)', K.check(bookA[1], vc.verdicts(), ME).state, 'unknown');
    fail = {};
    // eviction: a verdict wanted and not again is gone after two whole blocks unused
    vc.onBlock(2431817); warmAll(vc, bookA);
    vc.onBlock(2431818); vc.onBlock(2431819);
    T.ok('kept while unused for under 2 blocks', !!vc.verdicts()[C1.toLowerCase()]);
    vc.onBlock(2431820);
    T.ok('evicted after 2 unused blocks', !vc.verdicts()[C2.toLowerCase()] && !vc.verdicts()[C1.toLowerCase()]);
    // a take's own lookup is evicted like the others (it used to stay forever)
    vc.ask(C1, function () { });
    T.ok('ask records a verdict usable by the take now', !!vc.coin(C1));
    vc.onBlock(2431821); vc.onBlock(2431822); vc.onBlock(2431823);
    T.ok('…and is evicted after 2 unused blocks', !vc.verdicts()[C1.toLowerCase()]);
    // the per-block cap and the cursor: 7 new orders, cap 5 → 5 now, the next block resumes at the 6th, not the best
    var many = [], manyBook = [], i; for (i = 0; i < 7; i++) { many.push('0x' + ('E' + i).repeat(32)); node[many[i]] = true; manyBook.push(order('0xm' + i, 'sell', String(1 + i), [many[i]])); }
    calls.length = 0; warmAll(vc, manyBook);
    T.eq('cap: 5 lookups this block', calls.length, 5);
    T.ok('cap: the rest stay unknown', !vc.verdicts()[many[5].toLowerCase()] && !vc.verdicts()[many[6].toLowerCase()]);
    T.eq('cap: an order on a capped coin is "checking"', K.summary(K.hidden([manyBook[6]], vc.verdicts(), ME)), 'checking 1 FAST order…');
    vc.onBlock(2431824); calls.length = 0; warmAll(vc, manyBook);
    T.eq('next block: shown orders re-checked first (3/4 of the budget), then the queue resumes at the 6th, not the best', calls, [look(many[0]), look(many[1]), look(many[2]), look(many[3]), look(many[5])]);
    vc.onBlock(2431825); calls.length = 0; warmAll(vc, manyBook);
    T.eq('oldest check first, then the 7th', [calls[0], calls[4]], [look(many[4]), look(many[6])]);
    T.ok('cursor: all seven shown after three blocks', manyBook.every(function (o) { return K.check(o, vc.verdicts(), ME).state === 'ok'; }));
    // a refused take: the coin row is fetched again, the shown verdict stands
    vc.recheck([many[0]]);
    T.ok('recheck drops the row', !vc.coin(many[0]));
    T.eq('recheck keeps the verdict', vc.verdicts()[many[0].toLowerCase()].v, 'ok');
    // a busy pass queues the next call (the page's async transport)
    (function () {
        var pending = [], q = new K.Cache(function (c, cb) { pending.push(cb); });
        q.onBlock(1); warmAll(q, [order('0xq1', 'sell', '1', [C1])]); warmAll(q, [order('0xq1', 'sell', '1', [C1]), order('0xq2', 'sell', '2', [C2])]);
        T.eq('one command in flight at a time', pending.length, 1);
        pending.shift()(null, []);
        T.eq('queued call runs after it', pending.length, 1);
    })();
    // short-circuit: an order is left at its first missing coin — a 32-coin junk order costs one lookup
    (function () {
        var junk = [], n = 0, q;
        for (i = 0; i < 32; i++) junk.push('0x' + ('9' + (i < 10 ? '0' : '') + i).slice(-2).repeat(32));
        q = new K.Cache(function (c, cb) { n++; cb(null, []); }); q.onBlock(1);
        warmAll(q, [order('0xjunk', 'buy', '9', junk)]);
        T.eq('short-circuit: one lookup for a 32-coin junk order', n, 1);
        T.eq('short-circuit: the order is not takeable', K.check(order('0xjunk', 'buy', '9', junk), q.verdicts(), ME).state, 'no');
    })();
    // checkmempool: a node that rejects it gets the plain lookup for the session, said once; the book is not hidden
    (function () {
        var logs = [], q = new K.Cache(cmd, { log: function (s) { logs.push(s); } }), bk = [order('0xp1', 'sell', '1', [C1]), order('0xp2', 'sell', '2', ['0x' + 'E1'.repeat(32)])];
        node[C1] = true; REJECT_POOL = true; calls.length = 0; q.onBlock(5); warmAll(q, bk);
        T.eq('fallback: checkmempool tried once, then plain lookups', calls, [look(C1), 'coins coinid:' + C1, 'coins coinid:' + '0x' + 'E1'.repeat(32)]);
        T.eq('fallback: the order is still shown', K.check(bk[0], q.verdicts(), ME).state, 'ok');
        T.eq('fallback: said once in the log', logs.length, 1);
        T.ok('fallback: the log says why', /rejects .*checkmempool/.test(logs[0]));
        REJECT_POOL = false;
    })();
    // a coin being spent in the mempool is not takeable: checkmempool:true makes the node leave it out
    (function () {
        var q = new K.Cache(function (c, cb) { cb(null, c.indexOf('checkmempool:true') >= 0 ? [] : [{ coinid: C1 }]); });
        q.onBlock(1); warmAll(q, [order('0xmp', 'sell', '1', [C1])]);
        T.eq('mempool spend: hidden', K.check(order('0xmp', 'sell', '1', [C1]), q.verdicts(), ME).state, 'no');
    })();

    // --- scope: only what can reach the screen (10 levels) or a sweep (12 orders) is looked up or counted ---
    (function () {
        var bk = [], q, n = 0;
        for (i = 0; i < 40; i++) bk.push(order('0xs' + i, 'sell', '1.' + (i < 10 ? '0' : '') + i, ['0x' + ('A' + (i < 10 ? '0' : '') + i).slice(-2).repeat(32)]));
        var sc = K.scope(bk, {}, ME);
        T.eq('scope: 10 levels + 12 more orders a side', sc.sell.length, 22);
        q = new K.Cache(function (c, cb) { n++; cb(null, [{ coinid: idOf(c) }]); }); q.onBlock(1); warmAll(q, bk);
        T.eq('scope: only those are looked up', n, 22);
        T.eq('scope: nothing past it counts as checking', K.summary(K.hidden(bk, q.verdicts(), ME)), '');
        T.eq('scope: shown = the 22', Object.keys(K.visible(bk, q.verdicts(), ME)).length, 22);
        // ten orders at ONE price fill one level only
        var same = []; for (i = 0; i < 12; i++) same.push(order('0xt' + i, 'buy', '2', ['0x' + ('B' + (i < 10 ? '0' : '') + i).slice(-2).repeat(32)]));
        T.eq('scope: orders at one price are one level', K.scope(same.concat(bk.map(function (o) { return order(o.orderId, 'buy', o.price, o.coins); })), {}, ME).buy.length, 12 + 9 + 12);
    })();

    // --- the expanded list: at most 50 orders, then "and N more", whole ids ---
    (function () {
        var bk = [], v = {}, h, r;
        for (i = 0; i < 60; i++) { var id = '0x' + (1000 + i).toString(16).toUpperCase() + 'F'.repeat(61); bk.push(order('0xh' + i, 'sell', '1', [id])); v[id.toLowerCase()] = { v: 'missing', atBlock: 7 }; }
        h = K.hidden(bk, v, ME); r = K.report(h, v);
        T.eq('report: 60 hidden counted', [r.no, r.unknown], [60, 0]);
        T.eq('report: 50 listed, 10 more', [r.entries.length, r.more], [50, 10]);
        T.ok('report: whole coin ids', r.entries[0].join('\n').indexOf('coin ' + bk[0].coins[0] + ' — ') >= 0);
    })();

    // --- the reviewer's starvation cases (22 Nov 2026) ---
    (function () {
        function hex(n, p) { return '0x' + (p + n.toString(16)).padStart(64, '0').slice(-64).toUpperCase(); }
        var chain = {}, lookups = 0;
        function ncmd(c, cb) { lookups++; var id = idOf(c); cb(null, chain[id] ? [{ coinid: id, amount: '100', spent: false }] : []); }
        var q = new K.Cache(ncmd, {}), tip = 1000;
        var honest = { orderId: '0x1111111111111111', side: 'buy', price: '0.004', amount: '50', coins: [hex(1, 'A')], signPk: '0x' + 'ff'.repeat(32) };
        chain[honest.coins[0]] = true;
        var bk = [honest];
        q.onBlock(++tip); warmAll(q, bk);
        T.eq('starve 1: the honest bid is confirmed', K.check(honest, q.verdicts(), ME).state, 'ok');
        function junk(i, side, price) { var cs = [], j; for (j = 0; j < 32; j++) cs.push(hex(i * 100 + j, 'J')); return { orderId: '0x' + ('ee' + i).padStart(16, '0'), side: side, price: price, amount: '1', coins: cs, signPk: '0x' + ('e' + i).repeat(32).slice(0, 64) }; }
        bk = [junk(1, 'buy', '0.009'), junk(2, 'buy', '0.008'), junk(3, 'sell', '0.0001'), junk(4, 'sell', '0.0002'), honest];
        var honest2 = { orderId: '0x2222222222222222', side: 'sell', price: '0.005', amount: '50', coins: [hex(2, 'A')], signPk: '0x' + 'fe'.repeat(32) };
        chain[honest2.coins[0]] = true; bk.push(honest2);
        delete chain[honest.coins[0]];                     // the honest bid's coin is SPENT
        var hiddenAt = 0, staleRow = false, perBlock = [];
        for (b = 1; b <= 5; b++) {
            lookups = 0; q.onBlock(++tip); warmAll(q, bk); perBlock.push(lookups);
            if (!hiddenAt && K.check(honest, q.verdicts(), ME).state !== 'ok') hiddenAt = b;
            if (q.coin(honest.coins[0])) staleRow = true;
        }
        T.ok('starve 1: the spent honest bid is hidden within 3 blocks (block ' + hiddenAt + ')', hiddenAt > 0 && hiddenAt <= 3);
        T.ok('starve 1: no take ever gets its stale row', !staleRow);
        T.eq('starve 1: the new honest ask is shown', K.check(honest2, q.verdicts(), ME).state, 'ok');
        T.ok('starve 1: junk costs one lookup per order, then nothing for 10 blocks (' + perBlock.join(',') + ')', perBlock[0] <= 6 && perBlock[2] <= 2);
        T.eq('starve 1: the four junk orders and the spent bid are listed as not takeable', K.hidden(bk, q.verdicts(), ME).no.length, 5);

        // 40 honest orders × 4 real coins (160 coins) — more than one block's budget
        var q2 = new K.Cache(ncmd, {}), big = [];
        for (i = 0; i < 40; i++) {
            var o = { orderId: '0x' + String(3000 + i).padStart(16, '0'), side: i % 2 ? 'sell' : 'buy', price: i % 2 ? '0.005' + String(i).padStart(2, '0') : '0.004' + String(99 - i).padStart(2, '0'), amount: '10', signPk: '0x' + 'ab'.repeat(32).replace(/^ab/, 'cd') };
            o.coins = [0, 1, 2, 3].map(function (j) { return hex(5000 + i * 10 + j, 'B'); }); o.coins.forEach(function (c) { chain[c] = true; }); big.push(o);
        }
        for (b = 0; b < 3; b++) { q2.onBlock(++tip); warmAll(q2, big); }
        var inScope = K.scope(big, q2.verdicts(), ME), fit = inScope.buy.length + inScope.sell.length;
        T.eq('starve 2: every one of the 40 fits the display scope', fit, 40);
        T.eq('starve 2: none stuck in checking', K.summary(K.hidden(big, q2.verdicts(), ME)), '');
        T.eq('starve 2: all 40 shown', Object.keys(K.visible(big, q2.verdicts(), ME)).length, 40);
        // the deepest order's coins are spent: re-checked (oldest first), hidden; never left 'ok' for good
        var tail = big[39]; tail.coins.forEach(function (c) { delete chain[c]; });
        for (b = 0; b < 3; b++) { q2.onBlock(++tip); warmAll(q2, big); }
        T.eq('starve 2: the deepest order, spent, is hidden', K.check(tail, q2.verdicts(), ME).state, 'no');
        T.ok('starve 2: every shown coin was re-checked inside the last 3 blocks', big.slice(0, 39).every(function (o) { return o.coins.every(function (c) { var v = q2.verdicts()[c.toLowerCase()]; return v && v.v === 'ok' && tip - v.atBlock < 3; }); }));
    })();

    // --- the real incident (22 Nov 2026): order 0x77da4748491f267c, coin created at 2431726, ~1826 blocks before the
    //     taker's tip: this light node's `coins coinid:` returns an empty list → hidden, with the reason and whole ids
    (function () {
        var COIN = '0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8';
        var ghost = { orderId: '0x77da4748491f267c', side: 'buy', price: '0.0042', amount: '1000', coins: [COIN], signPk: MAKER, pubId: 'pkG' };
        var good = order('0x1111111111111111', 'buy', '0.004', [C1]);
        var q = new K.Cache(function (c, cb) { cb(null, c === 'coins coinid:' + C1 + ' checkmempool:true' ? [{ coinid: C1 }] : []); });
        q.onBlock(2433552); q.warm(K.wanted([ghost, good], ME, q.verdicts()));
        var h = K.hidden([ghost, good], q.verdicts(), ME);
        T.eq('incident: the ghost is hidden as not takeable', h.no.map(function (e) { return e.order.orderId; }), ['0x77da4748491f267c']);
        T.eq('incident: the line', K.summary(h), '1 FAST order hidden: not takeable from this node (a backing coin is spent or older than this node\'s chain window)');
        var text = K.describe(h.no[0], q.verdicts()).join('\n');
        T.ok('incident: whole order id, maker key and coin id', text.indexOf('order 0x77da4748491f267c') >= 0 && text.indexOf('maker ' + MAKER) >= 0 && text.indexOf('coin ' + COIN + ' — spent or not seen by this node (checked at block 2433552)') >= 0);
        var shown = [ghost, good].filter(function (o) { return K.check(o, q.verdicts(), ME).state === 'ok'; });
        T.eq('incident: the best bid is the takeable 0.004, not the ghost 0.0042', shown.map(function (o) { return o.price; }), ['0.004']);
    })();
})();
