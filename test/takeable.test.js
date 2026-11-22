/* takeable.test.js — owner 22 Nov 2026: an order this node cannot take is not shown as market (lib/takeable.js). */
(function () {
    var K = AX.takeable;
    var ME = '0x' + 'ab'.repeat(32), MAKER = '0x5243C4B815456066ABCD619F4D5474FBBE224449F38DB4D1F7528CC8F3916296';
    var C1 = '0x' + 'C1'.repeat(32), C2 = '0x' + 'C2'.repeat(32), C3 = '0x' + 'C3'.repeat(32);
    // 0.0.98: an order is 'ok' only when the node's rows show its coins at its own scripts, of its side's token, covering
    // it: every test order publishes RETURN SIGNEDBY(its maker key) and the stub node answers each coin with a row at
    // that script's address (reg/row), the maker's token, 1000000 of it
    var META = {};
    function reg(o) {
        o.scripts = o.scripts || ['RETURN SIGNEDBY(' + String(o.signPk).toUpperCase().replace('0X', '0x') + ')'];
        (o.coins || []).forEach(function (c) { if (!META[c.toLowerCase()]) META[c.toLowerCase()] = { side: o.side, script: o.scripts[0] }; });
        return o;
    }
    function row(id) {
        var m = META[String(id).toLowerCase()] || { side: 'sell', script: 'RETURN SIGNEDBY(' + MAKER + ')' };
        return m.side === 'sell' ? { coinid: id, address: K.scriptAddress(m.script), tokenid: '0x00', amount: '1000000', spent: false, state: [] }
            : { coinid: id, address: K.scriptAddress(m.script), tokenid: AX.fill.MXUSD, amount: '0.00000001', tokenamount: '1000000', spent: false, state: [] };
    }
    function order(id, side, price, coins, signPk) { return reg({ orderId: id, side: side, price: price, amount: '100', coins: coins, signPk: signPk || MAKER, pubId: 'pk' }); }
    function ok(id) { var r = {}; r[id.toLowerCase()] = { id: id, v: 'ok', atBlock: 1, coin: row(id) }; return r; }
    var V = {}; V[C1.toLowerCase()] = { v: 'ok', coin: row(C1) }; V[C2.toLowerCase()] = { v: 'missing' };

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
        cb(null, node[id] ? [row(id)] : []);
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
        var q = new K.Cache(function (c, cb) { cb(null, c.indexOf('checkmempool:true') >= 0 ? [] : [row(C1)]); });
        q.onBlock(1); warmAll(q, [order('0xmp', 'sell', '1', [C1])]);
        T.eq('mempool spend: hidden', K.check(order('0xmp', 'sell', '1', [C1]), q.verdicts(), ME).state, 'no');
    })();

    // --- scope: only what can reach the screen (10 levels) or a sweep (12 orders) is looked up or counted ---
    (function () {
        var bk = [], q, n = 0;
        for (i = 0; i < 40; i++) bk.push(order('0xs' + i, 'sell', '1.' + (i < 10 ? '0' : '') + i, [('0x5A' + (100 + i) + '5'.repeat(64)).slice(0, 66)]));
        var sc = K.scope(bk, {}, ME);
        T.eq('scope: 10 levels + 12 more orders a side', sc.sell.length, 22);
        q = new K.Cache(function (c, cb) { n++; cb(null, [row(idOf(c))]); }); q.onBlock(1); warmAll(q, bk);
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
        function ncmd(c, cb) { lookups++; var id = idOf(c); cb(null, chain[id] ? [row(id)] : []); }
        var q = new K.Cache(ncmd, {}), tip = 1000;
        var honest = reg({ orderId: '0x1111111111111111', side: 'buy', price: '0.004', amount: '50', coins: [hex(1, 'A')], signPk: '0x' + 'ff'.repeat(32) });
        chain[honest.coins[0]] = true;
        var bk = [honest];
        q.onBlock(++tip); warmAll(q, bk);
        T.eq('starve 1: the honest bid is confirmed', K.check(honest, q.verdicts(), ME).state, 'ok');
        function junk(i, side, price) { var cs = [], j; for (j = 0; j < 32; j++) cs.push(hex(i * 100 + j, 'J')); return reg({ orderId: '0x' + ('ee' + i).padStart(16, '0'), side: side, price: price, amount: '1', coins: cs, signPk: '0x' + ('e' + i).repeat(32).slice(0, 64) }); }
        bk = [junk(1, 'buy', '0.009'), junk(2, 'buy', '0.008'), junk(3, 'sell', '0.0001'), junk(4, 'sell', '0.0002'), honest];
        var honest2 = reg({ orderId: '0x2222222222222222', side: 'sell', price: '0.005', amount: '50', coins: [hex(2, 'A')], signPk: '0x' + 'fe'.repeat(32) });
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
            o.coins = [0, 1, 2, 3].map(function (j) { return hex(5000 + i * 10 + j, 'B'); }); reg(o); o.coins.forEach(function (c) { chain[c] = true; }); big.push(o);
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
        var ghost = reg({ orderId: '0x77da4748491f267c', side: 'buy', price: '0.0042', amount: '1000', coins: [COIN], signPk: MAKER, pubId: 'pkG' });
        var C4 = '0x' + 'C4'.repeat(32), good = order('0x1111111111111111', 'buy', '0.004', [C4]);
        var q = new K.Cache(function (c, cb) { cb(null, c === 'coins coinid:' + C4 + ' checkmempool:true' ? [row(C4)] : []); });
        q.onBlock(2433552); q.warm(K.wanted([ghost, good], ME, q.verdicts()));
        var h = K.hidden([ghost, good], q.verdicts(), ME);
        T.eq('incident: the ghost is hidden as not takeable', h.no.map(function (e) { return e.order.orderId; }), ['0x77da4748491f267c']);
        T.eq('incident: the line', K.summary(h), '1 FAST order hidden: not takeable from this node (a backing coin is spent or older than this node\'s chain window)');
        var text = K.describe(h.no[0], q.verdicts()).join('\n');
        T.ok('incident: whole order id, maker key and coin id', text.indexOf('order 0x77da4748491f267c') >= 0 && text.indexOf('maker ' + MAKER) >= 0 && text.indexOf('coin ' + COIN + ' — spent or not seen by this node (checked at block 2433552)') >= 0);
        var shown = [ghost, good].filter(function (o) { return K.check(o, q.verdicts(), ME).state === 'ok'; });
        T.eq('incident: the best bid is the takeable 0.004, not the ghost 0.0042', shown.map(function (o) { return o.price; }), ['0.004']);
    })();
    // --- 0.0.98: 'ok' means the node has shown this order can be taken AS DISPLAYED ---
    (function () {
        // the node's own answers for these scripts are pinned in doors/htlc.js (AtomiX, byte-identical to MinimaHtlc.java)
        T.eq('scriptAddress = the node\'s address (AtomiX HTLC v1.2)', K.scriptAddress(AX.htlc.SCRIPT), '0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A');
        T.eq('scriptAddress = the node\'s address (AtomiX HTLC v1.3)', K.scriptAddress(AX.htlc.SCRIPT_V13), '0x62BDD2BBDAC47C133D4A2ABCC87D86A710FF40D28A1ECD2EF4C3A9A7C76EB575');
        var KA = '0x' + 'A1'.repeat(32), SA = 'RETURN SIGNEDBY(' + KA + ')', D1 = '0x' + 'D1'.repeat(32), D2 = '0x' + 'D2'.repeat(32);
        function ask(amount, coins, scripts) { return { orderId: '0x00000000000000a1', side: 'sell', price: '0.004', amount: amount, coins: coins, scripts: scripts, signPk: KA, pubId: 'pk' }; }
        function bid(amount, price, coins, scripts) { return { orderId: '0x00000000000000b1', side: 'buy', price: price, amount: amount, coins: coins, scripts: scripts, signPk: KA, pubId: 'pk' }; }
        function vv(rows) { var r = {}; rows.forEach(function (x) { r[x.coinid.toLowerCase()] = { v: 'ok', coin: x, atBlock: 9 }; }); return r; }
        var at = K.scriptAddress(SA);
        function mini(id, amt, extra) { var x = { coinid: id, address: at, tokenid: '0x00', amount: amt, spent: false, state: [] }; for (var k in extra || {}) x[k] = extra[k]; return x; }
        function usd(id, amt, extra) { var x = { coinid: id, address: at, tokenid: AX.fill.MXUSD, amount: '0.00000001', tokenamount: amt, spent: false, state: [] }; for (var k in extra || {}) x[k] = extra[k]; return x; }
        T.eq('(all) an ask backed by its own MINIMA at its own script → ok', K.check(ask('50', [D1], [SA]), vv([mini(D1, '50')]), ME).state, 'ok');
        T.eq('(a) a row the node returns spent → no', K.check(ask('50', [D1], [SA]), vv([mini(D1, '50', { spent: true })]), ME).state, 'no');
        T.eq('(b) an ask listing an MxUSD coin → no', K.check(ask('50', [D1], [SA]), vv([usd(D1, '50')]), ME).reason, 'maker coin ' + D1 + ' is not MINIMA');
        T.eq('(b) a bid listing a MINIMA coin → no', K.check(bid('50', '0.004', [D1], [SA]), vv([mini(D1, '50')]), ME).reason, 'maker coin ' + D1 + ' is not MxUSD');
        T.eq('(c) a coin carrying state → no', K.check(ask('50', [D1], [SA]), vv([mini(D1, '50', { state: [{ port: 0, data: '0x01' }] })]), ME).reason, 'maker coin ' + D1 + ' spent or carries state');
        var other = mini(D1, '50', { address: '0x' + 'B0'.repeat(32) });
        T.eq('(d) a coin of somebody else (not at the order\'s script) → no, with the whole ids', K.check(ask('50', [D1], [SA]), vv([other]), ME).reason, 'coin ' + D1 + ' is at 0x' + 'B0'.repeat(32) + ', not at the address of any script this order publishes');
        T.eq('(d) an order publishing no scripts → no', K.check(ask('50', [D1], []), vv([mini(D1, '50')]), ME).state, 'no');
        T.eq('(d) addresses compare case-insensitively', K.check(ask('50', [D1], [SA]), vv([mini(D1, '50', { address: at.toLowerCase() })]), ME).state, 'ok');
        var KB = '0x' + 'B2'.repeat(32), SB = 'RETURN SIGNEDBY(' + KB + ')';
        T.eq('(d) two coins at two of its scripts → ok', K.check(ask('50', [D1, D2], [SA, SB]), vv([mini(D1, '25'), mini(D2, '25', { address: K.scriptAddress(SB) })]), ME).state, 'ok');
        T.eq('(e) an ask whose coins cover less than its amount → no, exact decimals', K.check(ask('1000000', [D1], [SA]), vv([mini(D1, '1')]), ME).reason, 'backing coins cover only 1 of 1000000 MINIMA');
        T.eq('(e) an ask covered exactly → ok', K.check(ask('50.12345678', [D1], [SA]), vv([mini(D1, '50.12345678')]), ME).state, 'ok');
        // bid 3.33333333 @ 0.3 needs up8(0.999999999) = 1 MxUSD
        T.eq('(e) a bid needs up8(amount × price): 1 covers 3.33333333 @ 0.3', K.check(bid('3.33333333', '0.3', [D1], [SA]), vv([usd(D1, '1')]), ME).state, 'ok');
        T.eq('(e) one grain less → no', K.check(bid('3.33333333', '0.3', [D1], [SA]), vv([usd(D1, '0.99999999')]), ME).reason, 'backing coins cover only 0.99999999 of 1 MxUSD');
        T.eq('a bad coin hides the order even before its other coins are checked', K.check(ask('50', [D1, D2], [SA]), vv([usd(D1, '50')]), ME).state, 'no');
        // (f) one coin backs at most one shown order: first by price, then time (earlier expiry = signed earlier)
        var f1 = ask('50', [D1], [SA]), f2 = ask('50', [D1], [SA]), f3 = ask('50', [D1], [SA]), vf = vv([mini(D1, '50')]);
        f1.orderId = '0x00000000000000f1'; f1.price = '0.005'; f2.orderId = '0x00000000000000f2'; f2.price = '0.004'; f2.expiry = 200; f3.orderId = '0x00000000000000f3'; f3.price = '0.004'; f3.expiry = 100;
        var vis = K.visible([f1, f2, f3], vf, ME);
        T.eq('(f) only the best-priced, earliest order listing a coin is shown', Object.keys(vis), [K.okey(f3)]);
        var hf = K.hidden([f1, f2, f3], vf, ME);
        T.eq('(f) the others are hidden, saying which order took the coin', hf.no.map(function (e) { return e.check.reason; }), ['its backing coin ' + D1 + ' already backs order 0x00000000000000f3 (first by price, then time)', 'its backing coin ' + D1 + ' already backs order 0x00000000000000f3 (first by price, then time)']);
        // another maker reusing a shown orderId is not shown with it
        var dup = ask('50', [D2], [SA]); dup.signPk = '0x' + 'C9'.repeat(32);
        T.eq('another maker reusing a shown orderId is a different order', Object.keys(K.visible([ask('50', [D1], [SA]), dup], vv([mini(D1, '50')]), ME)), [K.okey(ask('50', [D1], [SA]))]);

        // the reviewer's S4: 22 forged asks at better prices listing ONE real 1-MINIMA coin of somebody else, 10 honest asks
        var chain = {}, q = new K.Cache(function (c, cb) { var id = c.split(' ')[1].slice(7).toLowerCase(); cb(null, chain[id] ? [chain[id]] : []); }), i, honest = [], forged = [], book;
        var foreign = '0x' + 'E0'.repeat(32); chain[foreign.toLowerCase()] = { coinid: foreign, address: '0x' + 'B0B0'.repeat(16), tokenid: '0x00', amount: '1', spent: false, state: [] };
        for (i = 0; i < 10; i++) {
            var hk = '0x' + ('E1' + i).padEnd(64, '7'), hs = 'RETURN SIGNEDBY(' + hk + ')', hc = '0x' + ('E2' + i).padEnd(64, '8');
            chain[hc.toLowerCase()] = { coinid: hc, address: K.scriptAddress(hs), tokenid: '0x00', amount: '50', spent: false, state: [] };
            honest.push({ orderId: '0x' + ('1' + i).padStart(16, '0'), side: 'sell', price: '0.006' + i, amount: '50', coins: [hc], scripts: [hs], signPk: hk, pubId: 'pk' });
        }
        for (i = 0; i < 22; i++) forged.push({ orderId: '0x' + ('2' + (10 + i)).padStart(16, '0'), side: 'sell', price: '0.004' + (10 + i), amount: '1000000', coins: [foreign], scripts: ['RETURN SIGNEDBY(0x' + 'CC'.repeat(32) + ')'], signPk: '0x' + 'cc'.repeat(32), pubId: 'pk' });
        book = honest.concat(forged);
        for (i = 0; i < 3; i++) { q.onBlock(4000 + i); warmAll(q, book); }
        vis = K.visible(book, q.verdicts(), ME);
        T.eq('S4: no forged ask is shown', forged.filter(function (o) { return vis[K.okey(o)]; }).length, 0);
        T.eq('S4: all 10 honest asks are shown', honest.filter(function (o) { return vis[K.okey(o)]; }).length, 10);
        T.ok('S4: the line says why', /^22 FAST orders hidden: not takeable from this node \(a backing coin is not at one of the order's own scripts\)/.test(K.summary(K.hidden(book, q.verdicts(), ME))));

        // a take that failed on the order (flag): 'no' with the node's reason until re-signed or 10 blocks pass
        var fo = ask('50', [D1], [SA]), fq = new K.Cache(function (c, cb) { cb(null, [mini(D1, '50')]); });
        fq.onBlock(10); warmAll(fq, [fo]);
        T.eq('flag: shown before', K.check(fo, fq.verdicts(), ME).state, 'ok');
        fq.flag(fo, 'the take failed: SERIOUS ERROR script missing for simple address : 0x' + 'B0'.repeat(32));
        T.eq('flag: no, with the node\'s reason', [K.check(fo, fq.verdicts(), ME).state, K.check(fo, fq.verdicts(), ME).reason], ['no', 'the take failed: SERIOUS ERROR script missing for simple address : 0x' + 'B0'.repeat(32)]);
        T.ok('flag: its coin rows are fetched again', fq.coin(D1) === null);
        var re = ask('49', [D1], [SA]);
        T.eq('flag: a re-signed order (other size) is a new question', K.check(re, fq.verdicts(), ME).state, 'ok');
        for (i = 11; i < 20; i++) { fq.onBlock(i); warmAll(fq, [fo]); }
        T.eq('flag: still no after 9 blocks', K.check(fo, fq.verdicts(), ME).state, 'no');
        fq.onBlock(20); warmAll(fq, [fo]);
        T.eq('flag: asked again after 10 blocks', K.check(fo, fq.verdicts(), ME).state, 'ok');
    })();
})();
