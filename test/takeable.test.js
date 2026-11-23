/* takeable.test.js — owner 22 Nov 2026: an order this node cannot take is not shown as market (lib/takeable.js).
 * 0.0.98: 'ok' = takeable AS DISPLAYED (token, state, own scripts, cover, one coin one order).
 * 0.0.99: one queue per block height, 128 lookups a height, the guarantees P1-P5. */
(function () {
    var K = AX.takeable, F = AX.fill;
    var ME = '0x' + 'ab'.repeat(32), MAKER = '0x5243C4B815456066ABCD619F4D5474FBBE224449F38DB4D1F7528CC8F3916296';
    function hex(n, p) { return '0x' + (p + n.toString(16)).padStart(64, '0').slice(-64).toUpperCase(); }
    function sig(pk) { return 'RETURN SIGNEDBY(0x' + String(pk).slice(2).toUpperCase() + ')'; }
    var oid = 1;
    /** An honest order: it publishes RETURN SIGNEDBY(its maker key). */
    function order(side, price, coins, opts) {
        var o = { orderId: '0x' + (oid++).toString(16).padStart(16, '0'), side: side, price: String(price), amount: '10', coins: coins, signPk: MAKER, pubId: 'pk', seq: 1 }, k;
        for (k in opts || {}) o[k] = opts[k];
        if (!o.scripts) o.scripts = [sig(o.signPk)];
        return o;
    }
    /** The row the node returns for a coin of `o`: at its script, in its token, `amt` of it (default 1000000). */
    function rowFor(o, id, amt, extra) {
        var r = o.side === 'sell' ? { coinid: id, address: K.scriptAddress(o.scripts[0]), tokenid: '0x00', amount: amt || '1000000', spent: false, state: [] }
            : { coinid: id, address: K.scriptAddress(o.scripts[0]), tokenid: F.MXUSD, amount: '0.00000001', tokenamount: amt || '1000000', spent: false, state: [] }, k;
        for (k in extra || {}) r[k] = extra[k];
        return r;
    }
    /** A stub node: chain[lc id] = row (unspent), pool[lc id] = true (being spent: hidden from checkmempool:true). */
    function Node() {
        var n = { chain: {}, pool: {}, fail: {}, calls: [], lookups: 0, rejectPool: false };
        n.add = function (o, amt) { o.coins.forEach(function (c) { n.chain[c.toLowerCase()] = rowFor(o, c, amt); }); return o; };
        n.cmd = function (c, cb) {
            n.calls.push(c); n.lookups++;
            var id = c.split(' ')[1].replace('coinid:', '').toLowerCase(), withPool = c.indexOf('checkmempool:true') >= 0;
            if (n.rejectPool && withPool) return cb(new Error('cmd failed: ' + c + ' — Invalid parameter : checkmempool'));
            if (n.fail[id] === 'error' || n.fail['*']) return cb(new Error('cmd failed: ' + c));
            if (n.fail[id] === 'odd') return cb(null, undefined);
            cb(null, n.chain[id] && !(withPool && n.pool[id]) ? [n.chain[id]] : []);
        };
        return n;
    }
    function look(id) { return 'coins coinid:' + id + ' checkmempool:true'; }
    function block(vc, book, tip, node) { if (node) node.lookups = 0; vc.onBlock(tip); vc.warm(book, ME); return node ? node.lookups : 0; }
    function state(vc, o) { return K.check(o, vc.verdicts(), ME).state; }
    function shown(vc, book) { return K.visible(book, vc.verdicts(), ME); }
    function isShown(vc, book, o) { return !!shown(vc, book)[K.okey(o)]; }
    /** The verdict of one order whose coins the node answers with `rows` (id → row; absent = not found). */
    function verdict(o, rows) {
        var vc = new K.Cache(function (c, cb) { var id = c.split(' ')[1].replace('coinid:', ''); cb(null, rows[id] ? [rows[id]] : []); });
        vc.onBlock(1); vc.warm([o], ME);
        return K.check(o, vc.verdicts(), ME);
    }

    // --- scriptAddress: the node's own address of a script, no node call ---
    // the node's answers for these scripts are pinned in doors/htlc.js (AtomiX, byte-identical to MinimaHtlc.java)
    T.eq('scriptAddress = the node\'s address (AtomiX HTLC v1.2)', K.scriptAddress(AX.htlc.SCRIPT), '0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A');
    T.eq('scriptAddress = the node\'s address (AtomiX HTLC v1.3)', K.scriptAddress(AX.htlc.SCRIPT_V13), '0x62BDD2BBDAC47C133D4A2ABCC87D86A710FF40D28A1ECD2EF4C3A9A7C76EB575');

    // --- 0.0.98: 'ok' means the node has shown this order can be taken AS DISPLAYED ---
    (function () {
        var KA = '0x' + 'A1'.repeat(32), SA = sig(KA), D1 = '0x' + 'D1'.repeat(32), D2 = '0x' + 'D2'.repeat(32), at = K.scriptAddress(SA);
        function ask(amount, coins, scripts) { return { orderId: '0x00000000000000a1', side: 'sell', price: '0.004', amount: amount, coins: coins, scripts: scripts, signPk: KA, pubId: 'pk' }; }
        function bid(amount, price, coins, scripts) { return { orderId: '0x00000000000000b1', side: 'buy', price: price, amount: amount, coins: coins, scripts: scripts, signPk: KA, pubId: 'pk' }; }
        function mini(id, amt, extra) { var x = { coinid: id, address: at, tokenid: '0x00', amount: amt, spent: false, state: [] }; for (var k in extra || {}) x[k] = extra[k]; return x; }
        function usd(id, amt, extra) { var x = { coinid: id, address: at, tokenid: F.MXUSD, amount: '0.00000001', tokenamount: amt, spent: false, state: [] }; for (var k in extra || {}) x[k] = extra[k]; return x; }
        function rs(list) { var r = {}; list.forEach(function (x) { r[x.coinid] = x; }); return r; }
        T.eq('(all) an ask backed by its own MINIMA at its own script → ok', verdict(ask('50', [D1], [SA]), rs([mini(D1, '50')])).state, 'ok');
        T.eq('(a) a coin the node does not return unspent → no', verdict(ask('50', [D1], [SA]), {}).reason, 'a backing coin is spent or older than this node\'s chain window');
        T.eq('(a) a row marked spent → no', verdict(ask('50', [D1], [SA]), rs([mini(D1, '50', { spent: true })])).state, 'no');
        T.eq('(b) an ask listing an MxUSD coin → no', verdict(ask('50', [D1], [SA]), rs([usd(D1, '50')])).reason, 'maker coin ' + D1 + ' is not MINIMA');
        T.eq('(b) a bid listing a MINIMA coin → no', verdict(bid('50', '0.004', [D1], [SA]), rs([mini(D1, '50')])).reason, 'maker coin ' + D1 + ' is not MxUSD');
        T.eq('(c) a coin carrying state → no', verdict(ask('50', [D1], [SA]), rs([mini(D1, '50', { state: [{ port: 0, data: '0x01' }] })])).reason, 'maker coin ' + D1 + ' spent or carries state');
        T.eq('(d) a coin of somebody else (not at the order\'s script) → no, with the whole ids', verdict(ask('50', [D1], [SA]), rs([mini(D1, '50', { address: '0x' + 'B0'.repeat(32) })])).reason,
            'coin ' + D1 + ' is at 0x' + 'B0'.repeat(32) + ', not at the address of any script this order publishes');
        T.eq('(d) an order publishing no scripts → no', verdict(ask('50', [D1], []), rs([mini(D1, '50')])).state, 'no');
        T.eq('(d) addresses compare case-insensitively', verdict(ask('50', [D1], [SA]), rs([mini(D1, '50', { address: at.toLowerCase() })])).state, 'ok');
        var KB = '0x' + 'B2'.repeat(32), SB = sig(KB);
        T.eq('(d) two coins at two of its scripts → ok', verdict(ask('50', [D1, D2], [SA, SB]), rs([mini(D1, '25'), mini(D2, '25', { address: K.scriptAddress(SB) })])).state, 'ok');
        T.eq('(e) an ask whose coins cover less than its amount → no, exact decimals', verdict(ask('1000000', [D1], [SA]), rs([mini(D1, '1')])).reason, 'backing coins cover only 1 of 1000000 MINIMA');
        T.eq('(e) an ask covered exactly → ok', verdict(ask('50.12345678', [D1], [SA]), rs([mini(D1, '50.12345678')])).state, 'ok');
        // bid 3.33333333 @ 0.3 needs up8(0.999999999) = 1 MxUSD
        T.eq('(e) a bid needs up8(amount × price): 1 covers 3.33333333 @ 0.3', verdict(bid('3.33333333', '0.3', [D1], [SA]), rs([usd(D1, '1')])).state, 'ok');
        T.eq('(e) one grain less → no', verdict(bid('3.33333333', '0.3', [D1], [SA]), rs([usd(D1, '0.99999999')])).reason, 'backing coins cover only 0.99999999 of 1 MxUSD');
        // abandoned at the first failing coin: a bad first coin costs ONE lookup, the second is never asked
        var calls = [], vc = new K.Cache(function (c, cb) { calls.push(c); cb(null, [usd(D1, '50')]); });
        vc.onBlock(1); vc.warm([ask('50', [D1, D2], [SA])], ME);
        T.eq('left at its first failing coin', calls, [look(D1)]);
        T.eq('coinless → no', K.check(ask('1', [], [SA]), vc.verdicts(), ME).state, 'no');
        T.eq('my own order → ok whatever the verdicts', K.check({ orderId: '0x06', side: 'sell', price: '1', amount: '1', coins: [D2], signPk: ME.toUpperCase().replace('0X', '0x') }, vc.verdicts(), ME).state, 'ok');
        T.eq('never checked → unknown', K.check(ask('50', [D2], [SA]), vc.verdicts(), ME).state, 'unknown');

        // (f) one coin backs at most one shown order: first by price, then time (earlier expiry = signed earlier)
        var f1 = ask('50', [D1], [SA]), f2 = ask('50', [D1], [SA]), f3 = ask('50', [D1], [SA]);
        f1.orderId = '0x00000000000000f1'; f1.price = '0.005'; f2.orderId = '0x00000000000000f2'; f2.price = '0.004'; f2.expiry = 200; f3.orderId = '0x00000000000000f3'; f3.price = '0.004'; f3.expiry = 100;
        var fv = new K.Cache(function (c, cb) { cb(null, [mini(D1, '50')]); }); fv.onBlock(1); fv.warm([f1, f2, f3], ME);
        T.eq('(f) only the best-priced, earliest order listing a coin is shown', Object.keys(shown(fv, [f1, f2, f3])), [K.okey(f3)]);
        var hf = K.hidden([f1, f2, f3], fv.verdicts(), ME);
        T.eq('(f) the others are hidden, saying which order took the coin', hf.list.map(function (e) { return e.check.reason; }), ['its backing coin ' + D1 + ' already backs order 0x00000000000000f3 (first by price, then time)', 'its backing coin ' + D1 + ' already backs order 0x00000000000000f3 (first by price, then time)']);
        // another maker reusing a shown orderId is a different order
        var a1 = ask('50', [D1], [SA]), dup = ask('50', [D2], [SA]); dup.signPk = '0x' + 'C9'.repeat(32);
        var dv = new K.Cache(function (c, cb) { cb(null, c.indexOf(D1) >= 0 ? [mini(D1, '50')] : []); }); dv.onBlock(1); dv.warm([a1, dup], ME);
        T.eq('another maker reusing a shown orderId is a different order', Object.keys(shown(dv, [a1, dup])), [K.okey(a1)]);

        // the reviewer's S4: 22 forged asks at better prices listing ONE real 1-MINIMA coin of somebody else, 10 honest asks
        var node = Node(), q = new K.Cache(node.cmd), i, honest = [], forged = [], book, vis;
        var foreign = '0x' + 'E0'.repeat(32); node.chain[foreign.toLowerCase()] = { coinid: foreign, address: '0x' + 'B0B0'.repeat(16), tokenid: '0x00', amount: '1', spent: false, state: [] };
        for (i = 0; i < 10; i++) honest.push(node.add(order('sell', '0.006' + i, [hex(i, 'E2')], { amount: '50', signPk: hex(i, 'E1') }), '50'));
        for (i = 0; i < 22; i++) forged.push(order('sell', '0.004' + (10 + i), [foreign], { amount: '1000000', signPk: '0x' + 'cc'.repeat(32) }));
        book = honest.concat(forged);
        for (i = 0; i < 3; i++) block(q, book, 4000 + i);
        vis = shown(q, book);
        T.eq('S4: no forged ask is shown', forged.filter(function (o) { return vis[K.okey(o)]; }).length, 0);
        T.eq('S4: all 10 honest asks are shown', honest.filter(function (o) { return vis[K.okey(o)]; }).length, 10);
        T.ok('S4: the line says why', /^22 FAST orders hidden: not takeable from this node \(a backing coin is not at one of the order's own scripts\)$/.test(K.summary(K.hidden(book, q.verdicts(), ME))));
    })();

    // --- the cache: lookups, mempool, errors, rows, flag ---
    (function () {
        var logs = [], node = Node(), vc = new K.Cache(node.cmd, { log: function (s) { logs.push(s); } });
        var A = node.add(order('sell', '1', [hex(1, 'C1')])), B = order('sell', '2', [hex(2, 'C1')]);
        block(vc, [A, B], 100);
        T.eq('one lookup per coin, mempool checked (a new order: one command)', node.calls, [look(A.coins[0]), look(B.coins[0])]);
        T.eq('verdicts', [state(vc, A), state(vc, B)], ['ok', 'no']);
        T.ok('a take gets the row read at this height', vc.coin(A.coins[0]) && vc.coin(A.coins[0]).coinid === A.coins[0]);
        node.calls.length = 0; vc.warm([A, B], ME);
        T.eq('same height: nothing asked again', node.calls, []);
        vc.onBlock(101);
        T.ok('P3: a new height — no take may use the older row', vc.coin(A.coins[0]) === null);
        node.calls.length = 0; vc.warm([A, B], ME);
        T.eq('next height: only the shown order is re-confirmed; the missing one waits 10 heights', node.calls, [look(A.coins[0])]);
        var b; for (b = 102; b < 110; b++) block(vc, [A, B], b);
        node.add(B); node.calls.length = 0; block(vc, [A, B], 110);
        T.eq('10 heights after its check the "no" is asked again', node.calls, [look(A.coins[0]), look(B.coins[0])]);
        T.eq('…and the node caught up', state(vc, B), 'ok');
        // mempool: a coin of a shown order being spent is 'no' for 2 heights only (the second lookup tells it from gone)
        var Cm = node.add(order('sell', '3', [hex(3, 'C1')]));
        block(vc, [A, B, Cm], 111);
        T.eq('shown first', state(vc, Cm), 'ok');
        node.pool[Cm.coins[0].toLowerCase()] = true; node.calls.length = 0;
        block(vc, [A, B, Cm], 112);
        T.ok('a shown order\'s coin not returned: asked again without the mempool check', node.calls.indexOf('coins coinid:' + Cm.coins[0]) >= 0);
        T.eq('a coin being spent (mempool) → no, said so', K.check(Cm, vc.verdicts(), ME).reason, 'a backing coin is being spent (mempool): ' + Cm.coins[0]);
        delete node.pool[Cm.coins[0].toLowerCase()];
        block(vc, [A, B, Cm], 113);
        T.eq('not asked again at once', state(vc, Cm), 'no');
        block(vc, [A, B, Cm], 114);
        T.eq('2 heights later its spend never mined: shown again', state(vc, Cm), 'ok');
        // errors: an 'ok' stays shown through failed re-checks until it is 3 heights old (P1); a new order stays unknown
        var Dn = order('sell', '4', [hex(4, 'C1')]); node.add(Dn);
        node.fail['*'] = true; block(vc, [A, Dn], 115);
        T.eq('error keeps ok', state(vc, A), 'ok');
        T.eq('error on a new order → unknown, with the node\'s words', [state(vc, Dn), K.check(Dn, vc.verdicts(), ME).reason.indexOf('the node did not answer for coin ' + Dn.coins[0]) === 0], ['unknown', true]);
        block(vc, [A, Dn], 116); block(vc, [A, Dn], 117);
        T.eq('still shown 3 heights after its last confirmation', state(vc, A), 'ok');
        block(vc, [A, Dn], 118);
        T.eq('P1: more than 3 heights unconfirmed → hidden ("checking")', state(vc, A), 'unknown');
        T.ok('…and it says why', /^not re-confirmed for more than 3 blocks \(last at block 114\)$/.test(K.check(A, vc.verdicts(), ME).reason));
        node.fail = {};
        node.fail[A.coins[0].toLowerCase()] = 'odd'; block(vc, [A], 119);
        T.eq('a reply that is not a list is not an answer', state(vc, A), 'unknown');
        node.fail = {}; block(vc, [A], 120);
        T.eq('the node answers again → shown at once', state(vc, A), 'ok');
        // checkmempool rejected: the plain lookup for the session, said once
        var n2 = Node(), v2 = new K.Cache(n2.cmd, { log: function (s) { logs.push(s); } }), P = n2.add(order('sell', '1', [hex(9, 'C2')])), Q = n2.add(order('sell', '2', [hex(10, 'C2')]));
        n2.rejectPool = true; block(v2, [P, Q], 5);
        T.eq('fallback: checkmempool tried once, then plain lookups', n2.calls, [look(P.coins[0]), 'coins coinid:' + P.coins[0], 'coins coinid:' + Q.coins[0]]);
        T.eq('fallback: the orders are shown', [state(v2, P), state(v2, Q)], ['ok', 'ok']);
        T.eq('fallback: said once in the log', logs.length, 1);
        T.ok('fallback: the log says why', /rejects .*checkmempool/.test(logs[0]));
        // ask: the take's own lookup refreshes the row; recheck drops rows; refresh re-judges
        vc.recheck([A.coins[0]]);
        T.ok('recheck drops the row (the next take asks again)', vc.coin(A.coins[0]) === null);
        T.eq('recheck keeps the verdict', state(vc, A), 'ok');
        var got; vc.ask(A.coins[0], function (e, r) { got = r; });
        T.ok('ask fetches it for the take', got && vc.coin(A.coins[0]).coinid === A.coins[0]);
        T.eq('refresh re-judges from this height\'s rows', vc.refresh(A, ME).state, 'ok');
        // flag: a take that failed for the order's own reason
        vc.flag(A, 'the take failed: SERIOUS ERROR script missing for simple address : 0x' + 'B0'.repeat(32));
        T.eq('flag: no, with the node\'s reason', [state(vc, A), K.check(A, vc.verdicts(), ME).reason], ['no', 'the take failed: SERIOUS ERROR script missing for simple address : 0x' + 'B0'.repeat(32)]);
        T.ok('flag: its rows are dropped', vc.coin(A.coins[0]) === null);
        var A2 = {}, k; for (k in A) A2[k] = A[k]; A2.amount = '9';
        T.eq('flag: a re-signed order (other size) is a new question', state(vc, A2), 'unknown');
        for (b = 121; b < 130; b++) block(vc, [A], b);
        T.eq('flag: still no 9 heights later', state(vc, A), 'no');
        block(vc, [A], 130);
        T.eq('flag: asked again after 10 heights', state(vc, A), 'ok');
        // eviction: an order gone from the book for more than 2 heights is forgotten
        block(vc, [], 131); block(vc, [], 132);
        T.ok('kept while gone for 2 heights', !!vc.verdicts().orders[K.okey(A)]);
        block(vc, [], 133);
        T.ok('evicted after that', !vc.verdicts().orders[K.okey(A)]);
        // one command in flight at a time; a warm asked meanwhile re-runs with the LATEST book in the same height
        var pending = [], aq = new K.Cache(function (c, cb) { pending.push({ c: c, cb: cb }); }), X = order('sell', '1', [hex(1, 'C3')]), Y = order('sell', '2', [hex(2, 'C3')]);
        aq.onBlock(1); aq.warm([X], ME); aq.warm([X, Y], ME);
        T.eq('one command in flight at a time', pending.length, 1);
        pending.shift().cb(null, [rowFor(X, X.coins[0])]);
        T.eq('the queued warm runs next, with the new order', pending.length === 1 && pending[0].c, look(Y.coins[0]));
    })();

    // --- layout: the display scope counts 'ok' orders only ---
    (function () {
        var node = Node(), vc = new K.Cache(node.cmd), bk = [], i;
        for (i = 0; i < 40; i++) bk.push(node.add(order('sell', '1.' + (i < 10 ? '0' : '') + i, [hex(i, '5A')])));
        block(vc, bk, 1, node);
        T.eq('scope: 10 levels + 12 more orders a side are shown', Object.keys(shown(vc, bk)).length, 22);
        block(vc, bk, 2, node);
        T.eq('scope: once it is full, orders past it are neither looked up nor counted', [node.lookups, K.summary(K.hidden(bk, vc.verdicts(), ME))], [22, '']);
        // 30 unknown/junk orders at BETTER prices never take a slot nor evict a shown order
        var junk = []; for (i = 0; i < 30; i++) junk.push(order('sell', '0.' + (50 + i), [hex(i, '5B')], { signPk: '0x' + 'ee'.repeat(32) }));
        var all = junk.concat(bk);
        T.eq('unknown orders at better prices: the 22 shown stay shown', Object.keys(shown(vc, all)).length, 22);
        T.eq('…and are counted as checking', K.hidden(all, vc.verdicts(), ME).unknown, 30);
        block(vc, all, 3);
        T.eq('once they are "no": still the same 22 shown', bk.slice(0, 22).every(function (x) { return isShown(vc, all, x); }), true);
        T.eq('the hidden line counts all 30, lists them', [K.hidden(all, vc.verdicts(), ME).no, K.report(K.hidden(all, vc.verdicts(), ME)).entries.length], [30, 30]);
        // ten orders at ONE price fill one level only
        var same = []; for (i = 0; i < 12; i++) same.push(node.add(order('buy', '2', [hex(i, '5C')])));
        var deep = []; for (i = 0; i < 30; i++) deep.push(node.add(order('buy', '1.' + (10 + i), [hex(i, '5D')])));
        block(vc, same.concat(deep), 4);
        T.eq('orders at one price are one level: 12 + 9 levels + 12 more', Object.keys(shown(vc, same.concat(deep))).length, 12 + 9 + 12);
        // the expanded list: at most 50 orders, then "and N more", whole ids
        var many = []; for (i = 0; i < 60; i++) many.push(order('sell', '1', [hex(1000 + i, '5E')], { orderId: '0x' + (0x1000 + i).toString(16).padStart(16, '0') }));
        block(vc, many, 5);
        var r = K.report(K.hidden(many, vc.verdicts(), ME));
        T.eq('report: 60 hidden counted', [r.no, r.unknown], [60, 0]);
        T.eq('report: 50 listed, 10 more', [r.entries.length, r.more], [50, 10]);
        T.ok('report: whole ids, the block it was checked at', r.entries[0].join('\n').indexOf('coin ' + many[0].coins[0] + ' — the coin the reason names') >= 0 && r.entries[0][0].indexOf('(checked at block 5)') > 0);
    })();

    // --- the guarantees, modelled on the reviewer's s1-s5 / s3b (P1-P5) ---
    (function () {
        var EE = '0x' + 'ee'.repeat(32);
        // P4: budget per HEIGHT — many warms and repeated NEWBLOCKs for the same height never exceed 128
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), bk = [], i;
            for (i = 0; i < 400; i++) bk.push(order(i % 2 ? 'buy' : 'sell', i % 2 ? '0.00' + (400 - i) : '0.01' + i, [hex(i, '6A')], { signPk: EE }));
            vc.onBlock(500); node.lookups = 0;
            for (i = 0; i < 5; i++) { vc.warm(bk, ME); vc.onBlock(500); vc.onBlock(499); vc.warm(bk, ME); }
            T.ok('P4: lookups at one height <= 128 (' + node.lookups + ')', node.lookups <= 128 && node.lookups >= 126);
            vc.onBlock(501); node.lookups = 0; vc.warm(bk, ME);
            T.ok('P4: the next height has a fresh budget (' + node.lookups + ')', node.lookups >= 126 && node.lookups <= 128);
            // a catch-up burst: NEWBLOCKs 1 s apart neither reset the budget nor age the verdicts
            var n2 = Node(), v2 = new K.Cache(n2.cmd), H = n2.add(order('sell', '0.0001', [hex(1, '6B')])), book2 = [H].concat(bk);
            v2.onBlock(1000, 0); v2.warm(book2, ME);
            T.eq('burst: shown before', state(v2, H), 'ok');
            n2.lookups = 0;
            for (i = 1; i <= 20; i++) { v2.onBlock(1000 + i, i * 1000); v2.warm(book2, ME); }
            T.ok('burst: 20 catch-up heights share ONE budget (' + n2.lookups + ' lookups)', n2.lookups <= 2);
            T.eq('burst: the shown order keeps its verdict while the tip moves', state(v2, H), 'ok');
            T.eq('burst: not settled while NEWBLOCKs keep coming', v2.settle(25000), false);
            T.eq('burst: settled once SETTLE_MS pass without one (the page\'s 10-second timer)', v2.settle(30000), true);
            n2.lookups = 0; v2.warm(book2, ME);
            T.ok('burst: then a fresh budget, aged to the new tip (' + n2.lookups + ')', n2.lookups >= 120 && state(v2, H) === 'ok');
        })();
        // P1 + P2 (shown): a shown book of D <= 96 lookups is re-confirmed EVERY height, with new junk arriving
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), bk = [], i, b, flick = 0, maxL = 0, junk = [], tip = 3000, stale = 0, all;
            for (i = 0; i < 40; i++) bk.push(node.add(order(i % 2 ? 'buy' : 'sell', i % 2 ? '0.004' + (90 - i) : '0.005' + (10 + i), [hex(i, '7A'), hex(i + 100, '7A')])));
            for (b = 0; b < 2; b++) block(vc, bk, ++tip);
            for (b = 0; b < 30; b++) {
                for (i = 0; i < 150; i++) junk.push(order(i % 2 ? 'buy' : 'sell', i % 2 ? (i % 4 === 1 ? '0.009' : '0.001') + b + i : (i % 4 === 0 ? '0.0001' : '0.02') + b + i, [hex(b * 1000 + i, '7B')], { signPk: EE }));
                all = bk.concat(junk.slice(-1500));
                maxL = Math.max(maxL, block(vc, all, ++tip, node));
                if (!bk.every(function (o) { return isShown(vc, all, o); })) flick++;
                bk.forEach(function (o) { var e = vc.verdicts().orders[K.okey(o)]; if (!e || tip - e.height > 0) stale++; });
            }
            T.eq('P2: 40 shown orders (80 lookups) + 150 new junk orders a height at better and worse prices: never hidden', flick, 0);
            T.eq('P1/P2: every shown order re-confirmed at every height', stale, 0);
            T.ok('P4: never over 128 lookups a height (' + maxL + ')', maxL <= 128);
        })();
        // P2 (tier 1): an honest order whose lookup FAILS once, while 150 new junk orders a height arrive at better prices
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), H = node.add(order('sell', '0.006', [hex(1, '8A')])), junk = [], b, i, at = 0, tip = 2000, all;
            node.fail[H.coins[0].toLowerCase()] = 'error';
            block(vc, [H], ++tip);                                       // its lookup fails once, before the flood
            T.eq('S2: unknown after the failed lookup', state(vc, H), 'unknown');
            node.fail = {};
            for (b = 1; b <= 20; b++) {
                for (i = 0; i < 150; i++) junk.push(order('sell', '0.005' + b + i, [hex(b * 1000 + i, '8B')], { signPk: EE }));
                all = [H].concat(junk.slice(-3000));
                block(vc, all, ++tip);
                if (!at && isShown(vc, all, H)) at = b;
            }
            T.eq('P2: an order whose first lookup errored is shown at the next height despite the flood (reviewer S2: NEVER)', at, 1);
        })();
        // P2: a shown order re-signed with new coins (the maker's refresh) under the same flood is shown again next height
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), H = node.add(order('buy', '0.004', [0, 1, 2, 3].map(function (j) { return hex(j, '9A'); }))), junk = [], b, i, at = 0, tip = 1000, cur = H, k, all;
            block(vc, [H], ++tip); block(vc, [H], ++tip);
            T.eq('re-back: shown before', isShown(vc, [H], H), true);
            for (b = 1; b <= 20; b++) {
                for (i = 0; i < 150; i++) junk.push(order('buy', '0.005' + b + i, [hex(b * 1000 + i, '9B')], { signPk: EE }));
                if (b === 1) { cur = {}; for (k in H) cur[k] = H[k]; cur.seq = 2; cur.coins = [10, 11, 12, 13].map(function (j) { return hex(j, '9A'); }); node.add(cur); }
                all = [cur].concat(junk.slice(-3000));
                block(vc, all, ++tip);
                if (!at && isShown(vc, all, cur)) at = b;
            }
            T.eq('P2: a re-backed shown order is shown again at the first height after its re-sign (reviewer S1/S1b: NEVER)', at, 1);
        })();
        // P2: the reviewer's S9 — 22 fresh junk asks at better prices before every height: the honest asks stay shown
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), honest = [], junk = [], hist = '', b, i, tip = 9000, all;
            for (i = 0; i < 5; i++) honest.push(node.add(order('sell', '0.006' + i, [hex(i, 'A9')])));
            for (b = 0; b < 3; b++) block(vc, honest, ++tip);
            for (b = 1; b <= 20; b++) {
                for (i = 0; i < 22; i++) junk.push(order('sell', '0.001' + b + i, [hex(b * 100 + i, 'F9')], { signPk: EE }));
                all = honest.concat(junk);
                block(vc, all, ++tip);
                hist += honest.filter(function (o) { return isShown(vc, all, o); }).length;
            }
            T.eq('S9: 5 of 5 honest asks shown at every height (reviewer: 5,5 then 0 for 18 heights)', hist, '55555555555555555555');
        })();
        // reviewer S3: a shown order whose re-checks fail 4 heights, then the node is healthy, junk stream: hidden at the
        // 4th unconfirmed height (P1), shown again at the first healthy one (it is tier 1; r2 never showed it again)
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), H = node.add(order('sell', '0.006', [hex(1, 'AD')])), junk = [], st = '', b, tip = 3000;
            block(vc, [H], ++tip);
            for (b = 1; b <= 12; b++) {
                if (b === 1) node.fail[H.coins[0].toLowerCase()] = 'error';
                if (b === 5) node.fail = {};
                junk.push(order('sell', '0.005', [hex(200 + b, 'AE')], { signPk: EE }));
                block(vc, [H].concat(junk), ++tip);
                st += state(vc, H)[0];
            }
            T.eq('S3: per-height state (o ok, u checking)', st, 'ooouoooooooo');
        })();
        // the reviewer's s3b (async, a warm on every book change): a pass still running when the height moves on stops —
        // its queue was built for the old height — and the next one serves tier 1 first at the new height
        (function () {
            var pending = [], issued = [], chain = {}, H = order('sell', '0.006', [hex(1, 'AF')]), junk = [], i, fail = true;
            chain[H.coins[0].toLowerCase()] = rowFor(H, H.coins[0]);
            var vc = new K.Cache(function (c, cb) { issued.push(c); pending.push(function () { var id = c.split(' ')[1].slice(7).toLowerCase(); if (fail && id === H.coins[0].toLowerCase()) return cb(new Error('cmd failed: ' + c)); cb(null, chain[id] ? [chain[id]] : []); }); });
            vc.onBlock(1); vc.warm([H], ME); pending.shift()();
            T.eq('s3b: H unknown after its failed lookup', state(vc, H), 'unknown');
            fail = false;
            for (i = 0; i < 300; i++) junk.push(order('sell', '0.005' + i, [hex(i, 'B0')], { signPk: EE }));
            vc.warm([H].concat(junk), ME); for (i = 0; i < 5; i++) pending.shift()();   // a pass over the junk is in flight
            vc.onBlock(2); var at = issued.length; vc.warm([H].concat(junk), ME);
            while (pending.length && issued.length < at + 3) pending.shift()();
            T.ok('s3b: at the new height H is asked within its first 2 lookups (' + issued.slice(at, at + 3).join(' | ') + ')', issued.slice(at, at + 2).indexOf(look(H.coins[0])) >= 0);
            while (pending.length) pending.shift()();
            T.eq('s3b: and shown', state(vc, H), 'ok');
        })();
        // P5: a normal book — 20 orders a side, 2 coins each: 80 lookups a height, nothing else
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), bk = [], i, ls = [];
            for (i = 0; i < 40; i++) bk.push(node.add(order(i % 2 ? 'buy' : 'sell', i % 2 ? '0.004' + (60 - i) : '0.005' + (10 + i), [hex(i, 'B5'), hex(i + 100, 'B5')])));
            for (i = 0; i < 4; i++) ls.push(block(vc, bk, 7000 + i, node));
            T.eq('P5: lookups per height on a normal book', ls, [80, 80, 80, 80]);
        })();
        // 0.0.169 (review, MINOR): 300 never-checked junk asks of ONE maker at better prices and a new honest ask of another
        // maker below them: the honest one is among the first lookups of the height (round robin over makers), not 300th
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), bk = [], i, J = '0x' + 'ee'.repeat(32);
            for (i = 0; i < 300; i++) bk.push(order('sell', '0.001' + (100 + i), [hex(i, 'D5')], { signPk: J }));
            var H = node.add(order('sell', '0.009', [hex(1, 'D6')]));
            bk.push(H); vc.onBlock(9100);
            var rest = vc.queue(bk, ME).rest, at = rest.indexOf(H);
            T.ok('0.0.169: a new honest order is not starved by one maker\'s junk at better prices (position ' + at + ')', at >= 0 && at < 2);
        })();
        // O(n log n): a 5000-order book (4990 junk with 32 coins each, all known 'no') — the queue and the views
        (function () {
            var node = Node(), vc = new K.Cache(node.cmd), bk = [], i, j, t, cs;
            for (i = 0; i < 4990; i++) { cs = []; for (j = 0; j < 32; j++) cs.push(hex(i * 64 + j, 'C5')); bk.push(order('sell', '0.001' + i, cs, { signPk: EE })); }
            for (i = 0; i < 10; i++) bk.push(node.add(order('sell', '0.006' + i, [hex(i, 'C6')])));
            for (i = 0; i < 45; i++) block(vc, bk, 8000 + i);           // 128 junk orders a height (one command each): 39 heights
            t = Date.now(); vc.queue(bk, ME); K.visible(bk, vc.verdicts(), ME); K.hidden(bk, vc.verdicts(), ME); t = Date.now() - t;
            T.ok('5000 orders: queue + visible + hidden in ' + t + ' ms (< 1500)', t < 1500);
            T.eq('5000 orders: the 10 honest asks shown, the junk counted (list capped at 50)', [Object.keys(shown(vc, bk)).length, K.hidden(bk, vc.verdicts(), ME).no, K.hidden(bk, vc.verdicts(), ME).list.length], [10, 4990, 50]);
        })();
    })();

    // --- the real incident (22 Nov 2026): order 0x77da4748491f267c, coin created at 2431726, ~1826 blocks before the
    //     taker's tip: this light node's `coins coinid:` returns an empty list → hidden, with the reason and whole ids
    (function () {
        var COIN = '0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8';
        var ghost = order('buy', '0.0042', [COIN], { orderId: '0x77da4748491f267c', amount: '1000', pubId: 'pkG' });
        var node = Node(), good = node.add(order('buy', '0.004', ['0x' + 'C4'.repeat(32)], { orderId: '0x1111111111111111' }));
        var q = new K.Cache(node.cmd);
        q.onBlock(2433552); q.warm([ghost, good], ME);
        var h = K.hidden([ghost, good], q.verdicts(), ME);
        T.eq('incident: the ghost is hidden as not takeable', h.list.map(function (e) { return e.order.orderId; }), ['0x77da4748491f267c']);
        T.eq('incident: the line', K.summary(h), '1 FAST order hidden: not takeable from this node (a backing coin is spent or older than this node\'s chain window)');
        var text = K.describe(h.list[0]).join('\n');
        T.ok('incident: whole order id, maker key and coin id', text.indexOf('order 0x77da4748491f267c') >= 0 && text.indexOf('maker ' + MAKER) >= 0 && text.indexOf('coin ' + COIN + ' — the coin the reason names') >= 0 && text.indexOf('(checked at block 2433552)') > 0);
        T.eq('incident: the best bid is the takeable 0.004, not the ghost 0.0042', Object.keys(shown(q, [ghost, good])), [K.okey(good)]);
    })();
    // 0.0.129, the coin-key attestation in the layout: an address attested for another identity, or a refused signature,
    // hides the order; a missing one hides it only with requireAttest; an attested order is marked
    (function () {
        var A = '0x' + 'A1'.repeat(32), C = '0x' + 'C1'.repeat(32), coinX = hex(0xC0FFEE, 'c');
        var real = order('sell', '0.005', [coinX], { signPk: A, pubId: '0x' + '00'.repeat(32) + A.slice(2) });
        var copy = order('sell', '0.004', [coinX], { signPk: C, pubId: '0x' + '00'.repeat(32) + C.slice(2), scripts: real.scripts.slice() });   // better price, the real maker's script
        var other = order('sell', '0.006', [hex(0xC0FFEF, 'c')], { signPk: A, scripts: ['RETURN SIGNEDBY(0x' + 'B2'.repeat(32) + ')'] });
        var rows = {}; rows[coinX] = rowFor(real, coinX); rows[other.coins[0]] = rowFor(other, other.coins[0]);
        var vc = new K.Cache(function (c, cb) { var id = c.split(' ')[1].replace('coinid:', ''); cb(null, rows[id] ? [rows[id]] : []); }), asked = [];
        vc.onAttest = function (o) { asked.push(o.orderId); };
        vc.onBlock(1); vc.warm([real, copy, other], ME);
        var ad = K.scriptAddress(real.scripts[0]).toLowerCase();
        T.ok('attest layout: every takeable order is offered for an attestation request', asked.length === 3);
        var l0 = K.layout([real, copy, other], vc.verdicts(), ME);
        T.ok('attest layout: none attested yet, require off: shown as today (the copycat first by price)', !!l0.shown[K.okey(copy)] && !l0.shown[K.okey(real)]);
        vc.attest(ad, A, true);
        var l1 = K.layout([real, copy, other], vc.verdicts(), ME), xr = l1.sides.sell.filter(function (x) { return x.order === real; })[0];
        T.ok('attest layout: the real maker attested the address: its order is shown and marked attested', !!l1.shown[K.okey(real)] && xr.check.attested === true);
        T.eq('attest layout: the copycat on that address is hidden, saying why, and no longer displaces the real order', [!!l1.shown[K.okey(copy)], l1.list.filter(function (x) { return x.order === copy; }).map(function (x) { return x.check.reason; })],
            [false, ['its maker has not proved it controls this coin (address ' + ad + ' is attested by its key for another maker, ' + A.toLowerCase() + ')']]);
        vc.attest(ad, C, false);
        T.ok('attest layout: a refused signature hides that order too', !K.layout([copy], vc.verdicts(), ME).shown[K.okey(copy)]);
        T.ok('attest layout: an order with no attestation yet is shown while require_attest is off', !!K.layout([other], vc.verdicts(), ME).shown[K.okey(other)]);
        vc.requireAttest = true;
        var l2 = K.layout([real, other], vc.verdicts(), ME);
        T.ok('attest layout: require_attest on: the unattested order is hidden, the attested one shown', !l2.shown[K.okey(other)] && !!l2.shown[K.okey(real)]);
        T.ok('attest layout: ... with the plain reason', /^its maker has not proved it controls this coin \(no attestation of address 0x[0-9a-f]{64} yet\)$/.test(l2.list[0].check.reason));
    })();
    // 0.0.114: on a MegaMMR node (status.megammr) every lookup searches the MegaMMR, where an old coin is found without a proof
    (function () {
        var calls = [], mo = order('sell', '0.004', [hex(0xA1, 'a')]), mv = new K.Cache(function (c, cb) { calls.push(c); cb(null, [rowFor(mo, mo.coins[0])]); });
        mv.megammr = true; mv.onBlock(1); mv.warm([mo], ME);
        T.eq('megammr: a coin in the tree is found by the plain (cheap) lookup first', calls, ['coins coinid:' + mo.coins[0] + ' checkmempool:true']);
        T.eq('megammr: found, the order is takeable', K.check(mo, mv.verdicts(), ME).state, 'ok');
        // review 23 Nov (MINOR): an OLD coin (not in the tree) is then asked of the MegaMMR, at most MEGA_PER_BLOCK a height
        var old = [], i; for (i = 0; i < 20; i++) old.push(order('sell', String(0.004 + i / 1000), [hex(0xB00 + i, 'b')]));
        calls = []; var mm = new K.Cache(function (c, cb) { calls.push(c); var id = c.split(' ')[1].slice(7), o2 = old.filter(function (x) { return x.coins[0] === id; })[0]; cb(null, c.indexOf('megammr:true') > 0 ? [rowFor(o2, id)] : []); });
        mm.megammr = true; mm.onBlock(1); mm.warm(old, ME);
        T.eq('MINOR megammr: at most MEGA_PER_BLOCK (16) MegaMMR walks a height', [K.MEGA_PER_BLOCK, calls.filter(function (c) { return c.indexOf('megammr:true') > 0; }).length], [16, 16]);
        T.eq('MINOR megammr: the old coin is found there: takeable; the 4 past the budget are re-checked next height', [old.filter(function (o) { return K.check(o, mm.verdicts(), ME).state === 'ok'; }).length, old.filter(function (o) { return K.check(o, mm.verdicts(), ME).state === 'unknown'; }).length], [16, 4]);
        mm.onBlock(2); mm.warm(old, ME);
        T.eq('MINOR megammr: ... and taken up at the next height', old.filter(function (o) { return K.check(o, mm.verdicts(), ME).state === 'ok'; }).length, 20);
        var keep = []; for (i = 3; i <= 8; i++) { calls = []; mm.onBlock(i); mm.warm(old, ME); keep.push(old.filter(function (o) { return K.check(o, mm.verdicts(), ME).state === 'ok'; }).length + '/' + calls.filter(function (c) { return c.indexOf('megammr:true') > 0; }).length); }
        T.eq('MINOR megammr: 20 shown old-coin orders stay confirmed, never more than 16 walks a height (ok/walks per height)', keep, ['20/16', '20/16', '20/16', '20/16', '20/16', '20/16']);
        // review 23 Nov (MINOR-2): the coins of 20 SHOWN old-coin orders are spent: each re-check is the tree, the MegaMMR,
        // then the mempool/gone look on the MegaMMR again — that second walk counts too: never more than 16 a height
        var gone = {}; old.forEach(function (o) { gone[o.coins[0]] = true; });
        var walks = [], mm2 = mm, prevCmd = mm2.cmd;
        mm2.cmd = function (c, cb) { calls.push(c); var id = c.split(' ')[1].slice(7); if (gone[id]) return cb(null, []); prevCmd(c, cb); };
        for (i = 9; i <= 11; i++) { calls = []; mm2.onBlock(i); mm2.warm(old, ME); walks.push(calls.filter(function (c) { return c.indexOf('megammr:true') > 0; }).length); }
        T.ok('MINOR-2: spent old coins re-checked: at most MEGA_PER_BLOCK MegaMMR walks a height, the second look counted (' + walks.join(', ') + ')', walks.every(function (w) { return w <= K.MEGA_PER_BLOCK; }) && walks[0] > 0);
        var lv = new K.Cache(function (c, cb) { calls.push(c); cb(null, []); }); calls = []; lv.onBlock(1); lv.warm([mo], ME);
        T.eq('not megammr: the plain lookup', calls, ['coins coinid:' + mo.coins[0] + ' checkmempool:true']);
    })();
})();
