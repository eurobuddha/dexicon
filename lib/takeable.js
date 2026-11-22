/**
 * takeable — owner 22 Nov 2026: "If an order is not tradable, it shouldn't be displayed anywhere as a real market."
 * A FAST order lists its backing coins by id; a taker can only take it when THIS node can see every one of them
 * unspent (`coins coinid:` on a light node finds a third-party coin only when it was created inside the node's tree,
 * the last ~1024 blocks, and is unspent at its tip). Order 0x77da4748491f267c showed as market while its coin
 * 0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8 was ~1826 blocks old: no light node could take it.
 *
 *   check(order, verdicts, mySignPk)  PURE. {state:'ok'|'unknown'|'no', reason, coins}. 'ok' only when EVERY listed
 *                                     coin has an 'ok' verdict; one 'missing' coin → 'no'; any never-checked coin →
 *                                     'unknown'. No coins → 'no'. My own order (with coins) → 'ok' (shown, never taken).
 *   wanted(orders, mySignPk)          PURE. Every coin id to look up, best price first, both sides interleaved.
 *   hidden(orders, verdicts, mySignPk) / summary(h)   PURE. The orders hidden and the line under the book.
 *   Cache(cmd)                        the verdicts: keyed by coin id, looked up one `coins coinid:` at a time,
 *                                     re-checked once per block, evicted after 2 blocks unused, capped per block.
 *
 * Identifiers are never shortened. Rhino-safe (ES5). Attaches to AX.takeable.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    /** A verdict nobody asked for in this many blocks is dropped (the order left the book). */
    var KEEP_BLOCKS = 2;
    /** At most this many `coins coinid:` commands per block (book changes and the block's re-check share it). The ladder
     *  shows 10 levels a side and an order lists at most 32 coins; a normal book is a few dozen coins. Coins past the cap
     *  wait for the next block: their orders stay 'unknown' (hidden, counted in the "checking" line). */
    var MAX_LOOKUPS_PER_BLOCK = 128;
    /** A lookup with no answer in this long is abandoned like an error: it never becomes a 'missing' verdict. */
    var TIMEOUT_MS = 20000;
    var WHY_NO = 'a backing coin is spent or older than this node\'s chain window';

    function lc(s) { return String(s || '').toLowerCase(); }
    function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

    function check(order, verdicts, mySignPk) {
        var coins = (order && order.coins) || [], unknown = [], missing = [], i, v;
        if (!coins.length) return { state: 'no', reason: 'lists no backing coins (its maker is re-backing it)', coins: [] };
        if (mySignPk && lc(order.signPk) === lc(mySignPk)) return { state: 'ok', reason: 'your own order (shown, never taken)', own: true, coins: [] };
        for (i = 0; i < coins.length; i++) {
            v = verdicts && verdicts[lc(coins[i])];
            if (v && v.v === 'missing') missing.push(String(coins[i]));
            else if (!v || v.v !== 'ok') unknown.push(String(coins[i]));
        }
        if (missing.length) return { state: 'no', reason: WHY_NO, coins: missing };
        if (unknown.length) return { state: 'unknown', reason: 'not yet checked by this node', coins: unknown };
        return { state: 'ok', reason: '', coins: [] };
    }

    function wanted(orders, mySignPk) {
        var sides = { buy: [], sell: [] }, out = [], seen = {}, i, j, o, k;
        for (i = 0; i < (orders || []).length; i++) {
            o = orders[i];
            if (!o || !(o.coins || []).length || (mySignPk && lc(o.signPk) === lc(mySignPk)) || !sides[o.side]) continue;
            sides[o.side].push(o);
        }
        sides.sell.sort(function (a, b) { return parseFloat(a.price) - parseFloat(b.price); });
        sides.buy.sort(function (a, b) { return parseFloat(b.price) - parseFloat(a.price); });
        for (i = 0; i < Math.max(sides.buy.length, sides.sell.length); i++) {
            [sides.buy[i], sides.sell[i]].forEach(function (x) {
                if (!x) return;
                for (j = 0; j < x.coins.length; j++) { k = lc(x.coins[j]); if (!seen[k]) { seen[k] = 1; out.push(String(x.coins[j])); } }
            });
        }
        return out;
    }

    /** Orders with coins that are not shown: {no:[{order, check}], unknown:[{order, check}]}. Coinless orders and my own
     *  are left out (coinless ones were never on the book; mine always are). */
    function hidden(orders, verdicts, mySignPk) {
        var out = { no: [], unknown: [] }, i, o, c;
        for (i = 0; i < (orders || []).length; i++) {
            o = orders[i];
            if (!o || !(o.coins || []).length) continue;
            c = check(o, verdicts, mySignPk);
            if (c.state === 'no') out.no.push({ order: o, check: c });
            else if (c.state === 'unknown') out.unknown.push({ order: o, check: c });
        }
        return out;
    }
    function plural(n) { return n + ' FAST order' + (n === 1 ? '' : 's'); }
    /** The line under the book ('' when nothing is hidden). */
    function summary(h) {
        var parts = [];
        if (h.no.length) parts.push(plural(h.no.length) + ' hidden: not takeable from this node (' + WHY_NO + ')');
        if (h.unknown.length) parts.push('checking ' + plural(h.unknown.length) + '…');
        return parts.join(' · ');
    }
    /** One hidden order as plain text lines, every identifier whole. */
    function describe(entry, verdicts) {
        var o = entry.order, lines = [o.side.toUpperCase() + ' ' + o.amount + ' MINIMA @ ' + o.price + ' — ' + (entry.check.state === 'no' ? 'not takeable: ' : '') + entry.check.reason,
            'order ' + o.orderId, 'maker ' + o.signPk], i, v;
        for (i = 0; i < (o.coins || []).length; i++) {
            v = verdicts && verdicts[lc(o.coins[i])];
            lines.push('coin ' + o.coins[i] + ' — ' + (!v || (v.v !== 'ok' && v.v !== 'missing') ? 'not yet checked' : (v.v === 'ok' ? 'seen unspent' : 'spent or not seen by this node')
                + (v.atBlock > 0 ? ' (checked at block ' + v.atBlock + ')' : '')));
        }
        return lines;
    }

    /**
     * The verdict cache. cmd(command, cb(err, response)) runs ONE node command (AX.mds.cmdR). verdicts() maps a lower-case
     * coin id → {id (whole, as listed), v:'ok'|'missing', atBlock, coin (the node's row, for the take)}.
     * - warm(ids): looks up, one at a time in the order given, every id with no verdict or one from an earlier block;
     *   a call while a pass runs is queued (the newest ids win). onChange() after each verdict that changed.
     * - onBlock(tip): a new block — every verdict is due for its re-check; ones unused for KEEP_BLOCKS blocks are dropped.
     * - an error, a timeout or a reply that is not a list leaves the previous verdict as it was (none stays none).
     */
    function Cache(cmd, opts) {
        opts = opts || {};
        this.cmd = cmd; this.onChange = opts.onChange || function () { };
        this.maxPerBlock = opts.maxPerBlock || MAX_LOOKUPS_PER_BLOCK;
        this.v = {}; this.gen = 0; this.tip = 0; this.spent = 0; this.busy = false; this.next = null;
        this.used = {};   // lc id → gen it was last wanted
    }
    Cache.prototype.verdicts = function () { return this.v; };
    Cache.prototype.coin = function (id) { var e = this.v[lc(id)]; return e && e.v === 'ok' && e.coin ? e.coin : null; };
    /** A coin the take path fetched itself (it is unspent and visible now). */
    Cache.prototype.put = function (c) { if (c && c.coinid) this.v[lc(c.coinid)] = { id: String(c.coinid), v: 'ok', atBlock: this.tip, gen: this.gen, coin: c }; };
    /** A maker refused: fetch these coins again before the next take; the shown verdict stands until the re-check. */
    Cache.prototype.recheck = function (ids) { for (var i = 0; i < (ids || []).length; i++) { var e = this.v[lc(ids[i])]; if (e) { e.coin = null; e.gen = -1; } } };
    Cache.prototype.onBlock = function (tip) {
        var k;
        this.gen++; this.spent = 0;
        if (tip > 0) this.tip = tip;
        for (k in this.used) if (this.used.hasOwnProperty(k) && this.used[k] < this.gen - KEEP_BLOCKS) { delete this.used[k]; delete this.v[k]; }
    };
    /** True while this coin has no verdict from the current block. */
    Cache.prototype.due = function (id) { var e = this.v[lc(id)]; return !e || e.gen < this.gen; };
    Cache.prototype.warm = function (ids, done) {
        var self = this, i, queue = [];
        for (i = 0; i < (ids || []).length; i++) { this.used[lc(ids[i])] = this.gen; if (this.due(ids[i])) queue.push(String(ids[i])); }
        if (this.busy) { this.next = { ids: ids, done: done }; return; }
        this.busy = true;
        (function step(n) {
            while (n < queue.length && !self.due(queue[n])) n++;   // answered by an earlier pass in this block
            if (n >= queue.length || self.spent >= self.maxPerBlock) {
                self.busy = false;
                if (self.next) { var nx = self.next; self.next = null; self.warm(nx.ids, nx.done); }
                if (done) done();
                return;
            }
            var id = queue[n], key = lc(id), gen = self.gen, settled = false, timer = null;
            self.spent++;
            function answer(err, rows) {
                if (settled) return;
                settled = true;
                if (timer !== null) g.clearTimeout(timer);
                var c = isArr(rows) ? rows[0] : null, before = self.v[key], v;
                if (!err && isArr(rows) && self.used[key] !== undefined) {
                    v = c && c.coinid && c.spent !== true ? 'ok' : 'missing';
                    self.v[key] = { id: id, v: v, atBlock: self.tip, gen: gen, coin: v === 'ok' ? c : null };
                    if (!before || before.v !== v) self.onChange(id, v);
                }
                step(n + 1);
            }
            if (typeof g.setTimeout === 'function') timer = g.setTimeout(function () { answer(new Error('timeout')); }, TIMEOUT_MS);
            try { self.cmd('coins coinid:' + id, answer); } catch (e) { answer(e); }
        })(0);
    };

    AX.takeable = { check: check, wanted: wanted, hidden: hidden, summary: summary, describe: describe, Cache: Cache,
                    KEEP_BLOCKS: KEEP_BLOCKS, MAX_LOOKUPS_PER_BLOCK: MAX_LOOKUPS_PER_BLOCK, TIMEOUT_MS: TIMEOUT_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
