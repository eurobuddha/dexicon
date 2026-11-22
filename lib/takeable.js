/**
 * takeable — owner 22 Nov 2026: "If an order is not tradable, it shouldn't be displayed anywhere as a real market."
 * A FAST order lists its backing coins by id; a taker can only take it when THIS node can see every one of them
 * unspent (`coins coinid:` on a light node finds a third-party coin only when it was created inside the node's tree,
 * the last ~1024 blocks, and is unspent at its tip). Order 0x77da4748491f267c showed as market while its coin
 * 0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8 was ~1826 blocks old: no light node could take it.
 *
 *   check(order, verdicts, mySignPk)  PURE. {state:'ok'|'unknown'|'no', reason, why, coins}. 'ok' means the node has
 *                                     shown this order can be taken AS DISPLAYED (0.0.98): the rows its `coins coinid:`
 *                                     returned show EVERY listed coin (a) unspent and out of the mempool, (b)+(c) of the
 *                                     token the maker gives and state-free (AX.fill.makerCoinProblem — the rule plan()
 *                                     refuses a take on), (d) at the address of one of the order's own published
 *                                     `scripts` (scriptAddress: computed here, no node call), and (e) together covering
 *                                     what it displays (ask: amount MINIMA; bid: up8(amount × price) MxUSD). One
 *                                     missing or bad coin → 'no' with the reason; a never-checked coin → 'unknown'. No
 *                                     coins → 'no'. A take that failed on the order (flag) → 'no'. My own order → 'ok'.
 *   scope(orders, verdicts, mySignPk) PURE. Per side, best price first (exact decimal order), the orders that can reach
 *                                     the screen or a take: the ones filling LADDER_LEVELS price levels, then
 *                                     SWEEP_MAX_ORDERS more. Orders already known 'no' ride along uncounted. Orders past
 *                                     the scope are not shown, not looked up and not counted as "checking". (f) A coin
 *                                     backs at most ONE shown order: the first 'ok' order listing it, by price then time
 *                                     (expiry: the earlier signed first), takes it; any later order listing it is 'no'.
 *   visible(orders, verdicts, me)     PURE. {orderId: true} for the orders that are market: in scope and 'ok', and mine.
 *   wanted(orders, me, verdicts)      PURE. The lookup plan for Cache.warm: {recheck, orders, used}.
 *   hidden(...) / summary(h) / report(h, verdicts)   PURE. The in-scope orders hidden, the line under the book, and
 *                                     the expanded list (at most LIST_MAX orders, each with whole ids, then the count).
 *   Cache(cmd, opts)                  the verdicts: keyed by coin id, looked up one command at a time (see warm).
 *
 * Identifiers are never shortened. Rhino-safe (ES5). Needs Decimal (vendor/decimal.js). Attaches to AX.takeable.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    /** A verdict nobody asked for in this many blocks is dropped (the order left the book or the scope). */
    var KEEP_BLOCKS = 2;
    /** At most this many lookups per block (book changes and the block's re-checks share it). */
    var MAX_LOOKUPS_PER_BLOCK = 128;
    /** ui/pd_app.js renderBookRows draws 10 price levels a side. */
    var LADDER_LEVELS = 10;
    /** One click takes from at most this many orders (ui/app.js reads it from here). */
    var SWEEP_MAX_ORDERS = 12;
    /** An 'ok' verdict not re-confirmed for more than this many blocks is dropped: the order is "checking" again. */
    var STALE_BLOCKS = 3;
    /** A 'missing' coin is asked again only every this many blocks (it turns 'ok' only when the node catches up). */
    var MISSING_EVERY = 10;
    /** The expanded hidden list shows at most this many orders. */
    var LIST_MAX = 50;
    /** A lookup with no answer in this long is abandoned like an error: it never becomes a 'missing' verdict. */
    var TIMEOUT_MS = 20000;
    var WHY_NO = 'a backing coin is spent or older than this node\'s chain window';
    var WHY_SCRIPT = 'a backing coin is not at one of the order\'s own scripts';
    var WHY_TOKEN = 'a backing coin is the wrong token or carries state';
    var WHY_COVER = 'its backing coins do not cover what it offers';
    var WHY_TWICE = 'its backing coin already backs another order';
    var WHY_TAKE = 'a take of it failed';

    function lc(s) { return String(s || '').toLowerCase(); }
    function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }
    function noop() { }
    function own(o, mySignPk) { return !!mySignPk && lc(o.signPk) === lc(mySignPk); }
    function priceOf(o) { try { var d = new g.Decimal(String(o.price)); return d.gt(0) ? d : null; } catch (e) { return null; } }
    /** One order, one key: relays key orders by maker + orderId (two makers may use the same orderId). */
    function okey(o) { return lc(o.signPk) + '|' + lc(o.orderId); }
    /** What a verdict is about: a re-signed order with other coins, scripts, size or price is a new question. */
    function fp(o) { return [o.side, o.price, o.amount, (o.coins || []).join(','), (o.scripts || []).join('|')].join('#'); }

    /** UTF-8 bytes of a string as a plain array (no TextEncoder in Rhino). */
    function utf8(str) {
        var out = [], i, c;
        for (i = 0; i < str.length; i++) {
            c = str.charCodeAt(i);
            if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) { c = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00); }
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
            else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return out;
    }
    /** The node's address of a script, as `newscript` registers it (objects/Address.java): the root of a one-leaf MMR =
     *  SHA3-256( MiniNumber 0 · MiniString(script) · MiniNumber 0 ), where MiniNumber 0 = bytes 00 01 00 (scale, length,
     *  unscaled) and MiniString = 4-byte big-endian length + UTF-8. No node call. Pinned against the AtomiX HTLC
     *  addresses the node reports (test/takeable.test.js). '0x' + 64 upper-case hex, cached per script text (bounded).
     *  Needs AXSHA3 (doors/sha3.js, loaded by index.html). */
    var ADDR = {}, ADDR_N = 0, ADDR_MAX = 4096;
    function scriptAddress(script) {
        var k = String(script), hit = ADDR[k], b, n;
        if (hit) return hit;
        b = utf8(k); n = b.length;
        hit = '0x' + String(g.AXSHA3.sha3_256([0, 1, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].concat(b, [0, 1, 0]))).toUpperCase();
        if (ADDR_N >= ADDR_MAX) { ADDR = {}; ADDR_N = 0; }
        ADDR[k] = hit; ADDR_N++;
        return hit;
    }
    /** Why this coin row cannot back this order as displayed ('' when it can): (b)(c) via AX.fill, (d) its address. */
    function coinProblem(order, row, addrs) {
        var why = AX.fill.makerCoinProblem(order, row);
        if (why) return { why: WHY_TOKEN, reason: why };
        if (!addrs[lc(row.address)]) return { why: WHY_SCRIPT, reason: 'coin ' + row.coinid + ' is at ' + row.address + ', not at the address of any script this order publishes' };
        return null;
    }

    function check(order, verdicts, mySignPk) {
        var coins = (order && order.coins) || [], unknown = [], missing = [], rows = [], i, v, flag, addrs = {}, bad, F = AX.fill, sum, need;
        if (!coins.length) return { state: 'no', reason: 'lists no backing coins (its maker is re-backing it)', why: 'coinless', coins: [] };
        if (own(order, mySignPk)) return { state: 'ok', reason: 'your own order (shown, never taken)', own: true, coins: [] };
        flag = verdicts && verdicts['order:' + okey(order)];
        if (flag && flag.fp === fp(order)) return { state: 'no', reason: flag.reason, why: WHY_TAKE, coins: [] };
        for (i = 0; i < coins.length; i++) {
            v = verdicts && verdicts[lc(coins[i])];
            if (v && v.v === 'missing') missing.push(String(coins[i]));
            else if (!v || v.v !== 'ok' || !v.coin) unknown.push(String(coins[i]));
            else rows.push(v.coin);
        }
        if (missing.length) return { state: 'no', reason: WHY_NO, why: WHY_NO, coins: missing };
        for (i = 0; i < (order.scripts || []).length; i++) addrs[lc(scriptAddress(order.scripts[i]))] = true;
        for (i = 0; i < rows.length; i++) if ((bad = coinProblem(order, rows[i], addrs))) return { state: 'no', reason: bad.reason, why: bad.why, coins: [String(rows[i].coinid)] };
        if (unknown.length) return { state: 'unknown', reason: 'not yet checked by this node', coins: unknown };
        sum = F.d(0); for (i = 0; i < rows.length; i++) sum = sum.plus(F.coinValue(rows[i]));
        need = order.side === 'sell' ? F.d(order.amount) : F.up8(F.d(order.amount).times(F.d(order.price)));
        if (sum.lt(need)) return { state: 'no', reason: 'backing coins cover only ' + sum.toFixed() + ' of ' + need.toFixed() + (order.side === 'sell' ? ' MINIMA' : ' MxUSD'), why: WHY_COVER, coins: [] };
        return { state: 'ok', reason: '', coins: [] };
    }

    function scope(orders, verdicts, mySignPk) {
        var sides = { buy: [], sell: [] }, out = { buy: [], sell: [] }, i, o, p;
        for (i = 0; i < (orders || []).length; i++) {
            o = orders[i];
            if (!o || !(o.coins || []).length || own(o, mySignPk) || !sides[o.side]) continue;
            p = priceOf(o);
            if (p) sides[o.side].push({ order: o, p: p });
        }
        function time(a, b) { return (Number(a.order.expiry) || 0) - (Number(b.order.expiry) || 0) || (okey(a.order) < okey(b.order) ? -1 : okey(a.order) > okey(b.order) ? 1 : 0); }
        sides.sell.sort(function (a, b) { return a.p.cmp(b.p) || time(a, b); });
        sides.buy.sort(function (a, b) { return b.p.cmp(a.p) || time(a, b); });
        var claimed = {};   // (f) lc coin id → the order that takes it
        ['buy', 'sell'].forEach(function (s) {
            var levels = 0, last = null, extra = 0, j, k, x, c, fresh, cs;
            for (j = 0; j < sides[s].length; j++) {
                x = sides[s][j]; c = check(x.order, verdicts, mySignPk); cs = x.order.coins;
                if (c.state === 'ok') {
                    for (k = 0; k < cs.length && !claimed[lc(cs[k])]; k++) { }
                    if (k < cs.length) c = { state: 'no', reason: 'its backing coin ' + cs[k] + ' already backs order ' + claimed[lc(cs[k])] + ' (first by price, then time)', why: WHY_TWICE, coins: [String(cs[k])] };
                    else for (k = 0; k < cs.length; k++) claimed[lc(cs[k])] = String(x.order.orderId);
                }
                if (c.state !== 'no') {
                    fresh = last === null || x.p.cmp(last) !== 0;
                    if (extra === 0 && (levels < LADDER_LEVELS || !fresh)) { if (fresh) { levels++; last = x.p; } }
                    else if (extra < SWEEP_MAX_ORDERS) extra++;
                    else break;
                }
                out[s].push({ order: x.order, check: c });
            }
        });
        return out;
    }

    /** {okey(order): true} — keyed by maker + orderId, so another maker reusing a shown orderId is not shown with it. */
    function visible(orders, verdicts, mySignPk) {
        var sc = scope(orders, verdicts, mySignPk), out = {}, all = sc.buy.concat(sc.sell), i, o;
        for (i = 0; i < all.length; i++) if (all[i].check.state === 'ok') out[okey(all[i].order)] = true;
        for (i = 0; i < (orders || []).length; i++) { o = orders[i]; if (o && (o.coins || []).length && own(o, mySignPk)) out[okey(o)] = true; }
        return out;
    }

    /** {recheck: coin ids of the shown orders, orders: [{orderId, coins}] not shown yet (unknown or 'no'), used: every
     *  coin id in scope}; best price first, both sides interleaved. */
    function wanted(orders, mySignPk, verdicts) {
        var sc = scope(orders, verdicts, mySignPk), plan = { recheck: [], orders: [], used: [] }, i;
        function add(x) {
            if (!x) return;
            var coins = x.order.coins.map(String);
            plan.used = plan.used.concat(coins);
            if (x.check.state === 'ok') plan.recheck = plan.recheck.concat(coins);
            else plan.orders.push({ orderId: String(x.order.orderId), coins: coins });
        }
        for (i = 0; i < Math.max(sc.buy.length, sc.sell.length); i++) { add(sc.buy[i]); add(sc.sell[i]); }
        return plan;
    }

    /** In-scope orders that are not shown: {no:[{order, check}], unknown:[{order, check}]}. Coinless orders and my own
     *  are left out (coinless ones were never on the book; mine always are), and so is everything past the scope. */
    function hidden(orders, verdicts, mySignPk) {
        var sc = scope(orders, verdicts, mySignPk), all = sc.buy.concat(sc.sell), out = { no: [], unknown: [] }, i;
        for (i = 0; i < all.length; i++) {
            if (all[i].check.state === 'no') out.no.push(all[i]);
            else if (all[i].check.state === 'unknown') out.unknown.push(all[i]);
        }
        return out;
    }
    function plural(n) { return n + ' FAST order' + (n === 1 ? '' : 's'); }
    /** The line under the book ('' when nothing is hidden). */
    function summary(h) {
        var parts = [];
        var whys = {}, n = 0, w;
        for (var i = 0; i < h.no.length; i++) { w = h.no[i].check.why || WHY_NO; if (!whys[w]) { whys[w] = 1; n++; } }
        if (h.no.length) parts.push(plural(h.no.length) + ' hidden: not takeable from this node (' + (n === 1 ? w : 'tap for each reason') + ')');
        if (h.unknown.length) parts.push('checking ' + plural(h.unknown.length) + '…');
        return parts.join(' · ');
    }
    /** One hidden order as plain text lines, every identifier whole. */
    function describe(entry, verdicts) {
        var o = entry.order, lines = [o.side.toUpperCase() + ' ' + o.amount + ' MINIMA @ ' + o.price + ' — ' + (entry.check.state === 'no' ? 'not takeable: ' : '') + entry.check.reason,
            'order ' + o.orderId, 'maker ' + o.signPk], i, v;
        for (i = 0; i < (o.coins || []).length; i++) {
            v = verdicts && verdicts[lc(o.coins[i])];
            lines.push('coin ' + o.coins[i] + ' — ' + (!v || (v.v !== 'ok' && v.v !== 'missing') ? 'not yet checked' : (v.v === 'ok' ? 'seen unspent' + (entry.check.state === 'no' && (entry.check.coins || []).indexOf(String(o.coins[i])) >= 0 ? ', refused (the reason above)' : '') : 'spent or not seen by this node')
                + (v.atBlock > 0 ? ' (checked at block ' + v.atBlock + ')' : '')));
        }
        return lines;
    }
    /** The hidden summary in one object: {no, unknown (counts), summary (the line), entries: [[lines]] (the first
     *  LIST_MAX orders, 'no' first, whole ids), more (how many are not listed)}. */
    function report(h, verdicts) {
        var all = h.no.concat(h.unknown), entries = [], i;
        for (i = 0; i < Math.min(all.length, LIST_MAX); i++) entries.push(describe(all[i], verdicts));
        return { no: h.no.length, unknown: h.unknown.length, summary: summary(h), entries: entries, more: all.length - entries.length };
    }

    /**
     * The verdict cache. cmd(command, cb(err, response)) runs ONE node command (AX.mds.cmdR). verdicts() maps a lower-case
     * coin id → {id (whole, as listed), v:'ok'|'missing', atBlock, gen, coin (the node's row, for the take)}.
     * Each lookup is `coins coinid:<id> checkmempool:true` (a coin already being spent is not takeable); a node that
     * rejects checkmempool gets the plain lookup for the rest of the session, said once through opts.log.
     * warm(plan) spends the block's budget (MAX_LOOKUPS_PER_BLOCK) in this order:
     *  1. re-check the coins of the SHOWN orders not yet confirmed in this block, oldest check first (at most 3/4 of the
     *     budget while step 2 still has work, so a large shown book can never starve a new order for good);
     *  2. the orders not shown yet, continuing from where the previous block stopped (a round: each order once, then
     *     again from the best price); an order's coins are asked one at a time and the order is left at its first
     *     missing coin (a junk order costs one lookup); a 'missing' coin is asked again only every MISSING_EVERY blocks
     *     or at once after recheck(); a coin already 'ok' is not asked again here.
     * onBlock(tip): a new generation. A verdict unused for KEEP_BLOCKS blocks is dropped; an 'ok' not re-confirmed for
     * more than STALE_BLOCKS blocks (lookups failing or never reached) is dropped too, so its order is hidden again.
     * coin(id) returns the row only when it was confirmed in the CURRENT generation: a take never rests on an older
     * lookup (ask() fetches it again). An error, a timeout or a reply that is not a list records nothing.
     */
    function Cache(cmd, opts) {
        opts = opts || {};
        this.cmd = cmd; this.onChange = opts.onChange || noop; this.log = opts.log || noop;
        this.maxPerBlock = opts.maxPerBlock || MAX_LOOKUPS_PER_BLOCK;
        this.v = {}; this.gen = 0; this.tip = 0; this.spent = 0; this.busy = false; this.next = null;
        this.used = {};     // lc id → gen it was last wanted
        this.round = {};    // orderId → true once visited in the current round (the cursor)
        this.mempool = true;
        this.rev = 0;       // bumps whenever a verdict changes (repaint caching)
    }
    Cache.prototype.verdicts = function () { return this.v; };
    Cache.prototype.coin = function (id) { var e = this.v[lc(id)]; return e && e.v === 'ok' && e.coin && e.gen === this.gen && !e.force ? e.coin : null; };
    Cache.prototype.lookupCmd = function (id) { return 'coins coinid:' + id + (this.mempool ? ' checkmempool:true' : ''); };
    Cache.prototype.set = function (id, v, coin, gen) {
        var key = lc(id), before = this.v[key];
        this.v[key] = { id: String(id), v: v, atBlock: this.tip, gen: gen, coin: coin };
        this.used[key] = Math.max(this.used[key] || 0, this.gen);
        if (!before || before.v !== v || before.atBlock !== this.tip || before.force) this.rev++;
        if (!before || before.v !== v) this.onChange(id, v);
    };
    /** A take could not use these coins: fetch them again before the next take and re-check them first; the shown
     *  verdict stands until then. A 'missing' coin among them is asked again at once, not after MISSING_EVERY. */
    Cache.prototype.recheck = function (ids) { for (var i = 0; i < (ids || []).length; i++) { var e = this.v[lc(ids[i])]; if (e) { e.force = true; this.rev++; } } };   // the row stays for the verdict; coin() serves no take from it
    /** A take of this order failed for a reason that is not the taker's own (the build or plan said so): the order is
     *  'no' with that reason until it is re-signed (other coins/size/price) or MISSING_EVERY blocks pass; its coins are
     *  fetched again (recheck) so the next look is fresh. */
    Cache.prototype.flag = function (order, reason) {
        this.v['order:' + okey(order)] = { v: 'flag', fp: fp(order), reason: String(reason), gen: this.gen, atBlock: this.tip };
        this.recheck(order.coins || []); this.rev++; this.onChange(order.orderId, 'no');
    };
    Cache.prototype.onBlock = function (tip) {
        var k, e;
        this.gen++; this.spent = 0;
        if (tip > 0) this.tip = tip;
        for (k in this.used) if (this.used.hasOwnProperty(k) && this.used[k] < this.gen - KEEP_BLOCKS) { delete this.used[k]; if (this.v[k]) { delete this.v[k]; this.rev++; } }
        for (k in this.v) {
            e = this.v[k];
            if (this.v.hasOwnProperty(k) && e.v === 'ok' && this.gen - e.gen > STALE_BLOCKS) { delete this.v[k]; this.rev++; this.onChange(e.id, 'unknown'); }
            else if (this.v.hasOwnProperty(k) && e.v === 'flag' && this.gen - e.gen >= MISSING_EVERY) { delete this.v[k]; this.rev++; }
        }
    };
    /** True while this coin should be asked: no verdict, a recheck asked for, an 'ok' from an earlier block, or a
     *  'missing' at least MISSING_EVERY blocks old. */
    Cache.prototype.due = function (id) {
        var e = this.v[lc(id)];
        if (!e || e.force) return true;
        return e.v === 'ok' ? e.gen < this.gen : this.gen - e.gen >= MISSING_EVERY;
    };
    /** One lookup now, outside the budget (the warm pass and the take both use it). cb(err, row, or null when the node
     *  does not return the coin unspent and out of the mempool); the verdict is recorded. */
    Cache.prototype.ask = function (id, cb) {
        var self = this, gen = this.gen, settled = false, timer = null, withPool = this.mempool;
        function answer(err, rows) {
            if (settled) return;
            settled = true;
            if (timer !== null) g.clearTimeout(timer);
            // CommandRunner: "Invalid parameter : checkmempool" (AX.mds errors also echo the command, so match the reason)
            if (err && withPool && /invalid param[a-z]*\s*:\s*checkmempool/i.test(String(err.message || err))) {
                if (self.mempool) {
                    self.mempool = false;
                    self.log('This node rejects `coins coinid: checkmempool:true`: FAST orders are checked with the plain `coins coinid:` lookup for the rest of this session, so a coin already being spent in the mempool can show as takeable until it is mined.');
                }
                return self.ask(id, cb);
            }
            if (err || !isArr(rows)) return cb(err || new Error('no answer for coin ' + id), null);
            var c = rows[0], ok = !!(c && c.coinid && c.spent !== true);
            self.set(id, ok ? 'ok' : 'missing', ok ? c : null, gen);
            cb(null, ok ? c : null);
        }
        if (typeof g.setTimeout === 'function') timer = g.setTimeout(function () { answer(new Error('timeout')); }, TIMEOUT_MS);
        try { this.cmd(this.lookupCmd(id), answer); } catch (e) { answer(e); }
    };
    Cache.prototype.warm = function (plan, done) {
        var self = this, i, k, seen = {}, re = [], todo, p1cap, ri = 0, oi = 0, ci = 0;
        plan = plan || { recheck: [], orders: [], used: [] };
        for (i = 0; i < plan.used.length; i++) this.used[lc(plan.used[i])] = this.gen;
        if (this.busy) { this.next = { plan: plan, done: done }; return; }
        this.busy = true;
        for (i = 0; i < plan.recheck.length; i++) { k = lc(plan.recheck[i]); if (!seen[k]) { seen[k] = 1; re.push(String(plan.recheck[i])); } }
        function age(id) { var x = self.v[lc(id)]; return !x || x.force ? -1 : x.gen; }
        re.sort(function (a, b) { return age(a) - age(b); });
        function forced(o) { for (var j = 0; j < o.coins.length; j++) { var x = self.v[lc(o.coins[j])]; if (x && x.force) return true; } return false; }
        todo = plan.orders.filter(function (o) { return !self.round[o.orderId] || forced(o); });
        if (!todo.length) { this.round = {}; todo = plan.orders.slice(); }
        p1cap = this.maxPerBlock - Math.floor(this.maxPerBlock / 4);
        function finish() {
            self.busy = false;
            if (self.next) { var nx = self.next; self.next = null; self.warm(nx.plan, nx.done); }
            if (done) done();
        }
        function leave() { self.round[todo[oi].orderId] = true; oi++; ci = 0; }
        function step() {
            var o, e;
            for (;;) {
                if (self.spent >= self.maxPerBlock) return finish();
                while (ri < re.length && !self.due(re[ri])) ri++;
                if (ri < re.length && (self.spent < p1cap || oi >= todo.length)) { self.spent++; return self.ask(re[ri++], function () { step(); }); }
                if (oi >= todo.length) return finish();
                o = todo[oi];
                if (ci >= o.coins.length) { leave(); continue; }
                e = self.v[lc(o.coins[ci])];
                if (e && e.v === 'ok' && !e.force) { ci++; continue; }
                if (e && e.v === 'missing' && !self.due(o.coins[ci])) { leave(); continue; }
                self.spent++;
                return self.ask(o.coins[ci], function (err, row) { if (err || !row) leave(); else ci++; step(); });
            }
        }
        step();
    };

    AX.takeable = { check: check, scope: scope, scriptAddress: scriptAddress, okey: okey, visible: visible, wanted: wanted, hidden: hidden, summary: summary, describe: describe, report: report, Cache: Cache,
                    KEEP_BLOCKS: KEEP_BLOCKS, MAX_LOOKUPS_PER_BLOCK: MAX_LOOKUPS_PER_BLOCK, LADDER_LEVELS: LADDER_LEVELS, SWEEP_MAX_ORDERS: SWEEP_MAX_ORDERS,
                    STALE_BLOCKS: STALE_BLOCKS, MISSING_EVERY: MISSING_EVERY, LIST_MAX: LIST_MAX, TIMEOUT_MS: TIMEOUT_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
