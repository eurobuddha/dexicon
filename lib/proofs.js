/**
 * proofs — the coin proof hand-over (owner 22 Nov 2026: a maker must never have to keep its backing coins young).
 *
 * A light-node taker sees a third-party coin only inside its ~1024-block window, so an order backed by an older coin could
 * not be taken. But the maker's node can prove any of its own unspent coins (`coinexport coinid:`, pinned at its tip-256,
 * tip-8 on a -test chain) and the taker's node verifies that proof against its OWN chain (`coinimport data: track:false`:
 * the byte-exact coin, token descriptor included); after it `coins coinid:` and `txninput coinid: scriptmmr:true` find the
 * coin as if it were young (for one window after the proof block). Proven on a private chain, 22 Nov 2026.
 *
 * The proof cannot ride in the order: every relay (maxima dexrelay Envelope.java), every earlier Dexicon (lib/envelope.js
 * verify) and the Android verifier (envelope/Envelope.java) refuse an order whose keys are not exactly the spec set, signed
 * or not. So it travels as sealed messages, pulled when a taker needs it:
 *   taker → maker  {k:'proofs?', coins:[coinid]}         a coin of an order is not visible to the taker's node
 *   maker → taker  {k:'proofs', proofs:{coinid: data}}   coinexport of each asked coin that backs one of the maker's live
 *                                                        orders (more messages when they do not fit in one)
 * A maker on an earlier version (service.js tick, Android MakerService.onInbox) ignores an unknown k: the order then stays
 * hidden from that taker exactly as before.
 *
 * Nothing a maker sends is trusted. A taker imports only a proof it asked THAT maker for, whose bytes name the asked coin
 * at one of the order's own script addresses, at most IMPORTS_PER_BLOCK a block; its node verifies the rest (a stale or
 * forged proof is refused: "Invalid MMR Proof"). The coin is then judged by the unchanged takeable rules (token, state,
 * address, cover, unspent) and taken by the unchanged fill.js (takerGuard, then the maker's verifyAsMaker). Garbage proofs
 * buy an attacker nothing but its own hidden orders and a bounded number of refused imports.
 *
 * Rhino-safe (ES5). Read when they run: AX.fill (exportable), AX.takeable (the taker half). Attaches to AX.proofs.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    /** At most this many coins in one request (an order backs with at most 32). */
    var MAX_ASK = 32;
    /** A proof's data (0x + hex). MEASURED 580–888 chars on a -test chain; ~2.5–3.5K estimated on mainnet (unmeasured). */
    var MAX_PROOF_CHARS = 16000;
    /** Proof data per reply message. Sealing quadruples it (lib/identity.js seal: the plaintext travels hex-encoded inside the
     *  sealed payload, and the blob is hex again). 0.0.120 (M1): 14000 chars → a ~58K-char msg, so two of them fit one
     *  poll's REPLY_CHARS_PER_POLL (it was 60000 → ~241K, one message ~5 s of sealing in Rhino). */
    var REPLY_MAX_CHARS = 14000;
    /** Maker: coinexport commands per request batch (one inbox poll), whatever the number of senders. */
    var EXPORTS_PER_POLL = 64;
    /** Maker, review 23 Nov (M1): sealing + signing a ~240K-char reply costs ~5 s in Rhino, and anyone can ask (a taker
     *  cannot be authenticated: permissionless). So one poll seals at most REPLIES_PER_POLL messages and
     *  REPLY_CHARS_PER_POLL sealed chars, and spends at most TIME_BOX_MS on exports and sealing; what is left waits in a
     *  queue (QUEUE_SENDERS senders, MAX_ASK distinct coins each) for the next polls, after their takes. */
    var REPLIES_PER_POLL = 2, REPLY_CHARS_PER_POLL = 120000, TIME_BOX_MS = 3000, QUEUE_SENDERS = 16;
    /** Taker: requests and imports per block height, and how many heights before a coin is asked for again. */
    var ASKS_PER_BLOCK = 8, IMPORTS_PER_BLOCK = 16, ASK_EVERY = 10;
    /** 0.0.118: a coin is imported only when it was created more than this many blocks before the node's tree root
     *  (`status` chain.block - chain.length). The root only rises, so a coin under it stays under it; the margin covers
     *  the status read and the import being two commands, and off-by-one between `length` and the root block. */
    var ROOT_MARGIN = 4;

    function lc(s) { return String(s || '').toLowerCase(); }
    function isId(s) { return typeof s === 'string' && /^0x[0-9A-Fa-f]{64}$/.test(s); }
    function noop() { }

    /** The coin id and address a proof's bytes name, or null. CoinProof = Coin.writeDataStream then the MMR proof; a Coin
     *  starts with its coin id then its address, each MiniData.writeHashToStream = 4-byte length (0x20) + 32 bytes.
     *  0.0.118: also `created`, the block the coin was created in, read further on (Coin.writeDataStream: amount
     *  MiniNumber, tokenid hash, storestate byte, MMR entry (MiniNumber scale + MiniData), spent byte, then the created
     *  MiniNumber); -1 when the bytes do not parse that far, or the coin says it is spent. */
    function named(d) {
        if (typeof d !== 'string' || d.length < 146 || d.length > MAX_PROOF_CHARS || !/^0x[0-9A-Fa-f]+$/.test(d)) return null;
        if (d.substr(2, 8) !== '00000020' || d.substr(74, 8) !== '00000020') return null;
        return { coinid: '0x' + d.substr(10, 64).toUpperCase(), address: '0x' + d.substr(82, 64).toUpperCase(), created: createdOf(d) };
    }
    /** MiniNumber.writeDataStream = scale byte, length byte, the unscaled two's-complement big-endian bytes. */
    function createdOf(d) {
        var at = 146, n = d.length;
        function byte() { if (at + 2 > n) throw 0; var b = parseInt(d.substr(at, 2), 16); at += 2; return b; }
        function skip(k) { if (k < 0 || at + 2 * k > n) throw 0; at += 2 * k; }
        function int4() { var v = 0, i; for (i = 0; i < 4; i++) v = v * 256 + byte(); return v; }
        function num() { var scale = byte(), len = byte(), v = 0, i; if (len > 32) throw 0; for (i = 0; i < len; i++) v = v * 256 + byte(); return { scale: scale, len: len, v: v }; }
        try {
            num();                         // amount
            skip(int4());                  // tokenid (writeHashToStream: 4-byte length + bytes)
            byte();                        // storestate
            num(); skip(int4());           // MMR entry: scale MiniNumber, then the unscaled bytes as MiniData
            if (byte() !== 0) return -1;   // spent
            var c = num();
            // a block number: scale 0, at most 6 bytes (so exact in a double), positive
            return c.scale === 0 && c.len > 0 && c.len <= 6 && !(parseInt(d.substr(at - 2 * c.len, 2), 16) & 0x80) ? c.v : -1;
        } catch (e) { return -1; }
    }

    // ---------------- maker ----------------

    /** One export per coin per block height (the same height always gives the same proof). */
    var EXP = {}, EXP_TIP = 0;
    function exportAt(mds, id, tip, cb) {
        if (tip !== EXP_TIP) { EXP = {}; EXP_TIP = tip; }
        var hit = EXP[lc(id)];
        if (hit) return cb(hit.err, hit.data, true);
        mds.cmdR('coinexport coinid:' + id, function (e, r) {
            var d = r && r.data, n = named(d);
            var res = !e && n && lc(n.coinid) === lc(id) ? { err: null, data: d } : { err: e || new Error('coinexport of ' + id + ' gave no proof of it'), data: null };
            if (tip === EXP_TIP) EXP[lc(id)] = res;
            cb(res.err, res.data, false);
        });
    }
    function readTip(mds, cb) { mds.cmdR('block', function (e, b) { var t = (!e && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0; cb(t); }); }

    /** Maker, the age rule (lib/maker.js, 0.0.113): which of `coins` (my wallet rows) my node can prove now. A coin with a
     *  proof may back an order at any age: an updated taker asks for its proof. Largest first, at most EXPORTS_PER_CHECK
     *  fresh exports a call; a success is remembered for PROOF_OK_BLOCKS heights. A failure is logged once (the coin is then
     *  kept young by a relock, as before). cb(map: lc coin id → true). */
    var OKAT = {}, PROOF_OK_BLOCKS = 100, EXPORTS_PER_CHECK = 64;
    function exportable(mds, coins, tip, cb) {
        var out = {}, todo = [], i, k;
        if (Object.keys(OKAT).length > 4096) OKAT = {};
        var sorted = (coins || []).slice().sort(function (a, b) { return AX.fill.coinValue(b).cmp(AX.fill.coinValue(a)); });
        for (i = 0; i < sorted.length; i++) {
            k = lc(sorted[i].coinid);
            if (OKAT[k] !== undefined && tip >= OKAT[k] && tip - OKAT[k] < PROOF_OK_BLOCKS) out[k] = true;
            else if (todo.length < EXPORTS_PER_CHECK && isId(sorted[i].coinid)) todo.push(sorted[i].coinid);
        }
        (function next() {
            if (!todo.length) return cb(out);
            var id = todo.shift();
            exportAt(mds, id, tip, function (e, d, cached) {
                if (!e) { OKAT[lc(id)] = tip; out[lc(id)] = true; }
                else if (!cached && g.MDS && typeof g.MDS.log === 'function') g.MDS.log('[dexicon] no coin proof for ' + id + ' (' + (e.message || e) + '): it backs orders only while young, kept so by a relock as before');
                next();
            });
        })();
    }

    /**
     * Maker: answer the proof requests of one inbox poll, [{from, coins}], plus what earlier polls left queued. Only coins
     * that back one of MY live orders are exported (never another coin of my wallet). seal(to, obj) → the raw sealed
     * message (the caller's identity.seal + envelope.msg). cb(replies) with replies = [{to, raw, coins: [ids]}], to be
     * published as they are. Review 23 Nov (M1), the work per poll is bounded whoever asks:
     *   - at most REPLIES_PER_POLL messages / REPLY_CHARS_PER_POLL sealed chars / TIME_BOX_MS, and EXPORTS_PER_POLL fresh
     *     coinexports; the rest stays queued (oldest sender first) for the next poll, which answers its takes first;
     *   - a coin is sent to one sender at most once per ASK_EVERY heights (a taker asks no more often); a repeat asked at
     *     the SAME height is answered with the message already sealed for that sender (no export, no seal);
     *   - a request's coins are de-duplicated before MAX_ASK applies (NIT: 32 copies of one coin no longer hid the rest).
     */
    var QUEUE = [], SENT = {}, SEALED = {}, SEALED_TIP = 0, clock = function () { return Date.now(); };
    function pending() { return QUEUE.length > 0; }
    function enqueue(requests, tip) {
        (requests || []).forEach(function (rq) {
            if (!rq || typeof rq.from !== 'string') return;
            var q = null, i;
            for (i = 0; i < QUEUE.length; i++) if (QUEUE[i].from === rq.from) q = QUEUE[i];
            if (!q) { if (QUEUE.length >= QUEUE_SENDERS) return; q = { from: rq.from, coins: [], at: tip }; QUEUE.push(q); }
            ((rq.coins) || []).forEach(function (c) { if (isId(c) && q.coins.length < MAX_ASK && q.coins.map(lc).indexOf(lc(c)) < 0) q.coins.push(c); });
        });
    }
    function answer(mds, list, requests, cb, seal) {
        var backs = {}, out = [], spent = 0, msgs = 0, chars = 0, t0 = clock();
        (list || []).forEach(function (o) { if (o && o.status === 'live') (o.coins || []).forEach(function (c) { backs[lc(c)] = true; }); });
        readTip(mds, function (tip) {
            var k;
            if (tip !== SEALED_TIP) { SEALED = {}; SEALED_TIP = tip; }
            if (Object.keys(SENT).length > 8192) SENT = {};
            for (k in SENT) if (SENT.hasOwnProperty(k) && tip - SENT[k] >= ASK_EVERY) delete SENT[k];
            enqueue(requests, tip);
            QUEUE = QUEUE.filter(function (q) { return tip - q.at < ASK_EVERY; });   // a request left this long is asked again by now
            function full() { return msgs >= REPLIES_PER_POLL || chars >= REPLY_CHARS_PER_POLL || clock() - t0 >= TIME_BOX_MS; }
            function emit(to, proofs, ids) {
                var raw = seal(to, { k: 'proofs', proofs: proofs });
                msgs++; chars += raw.length;
                ids.forEach(function (c) { SENT[lc(to) + '|' + lc(c)] = tip; });
                var sd = SEALED[lc(to)] || (SEALED[lc(to)] = { coins: {}, raws: [] });
                ids.forEach(function (c) { sd.coins[lc(c)] = true; }); sd.raws.push(raw);
                out.push({ to: to, raw: raw, coins: ids });
            }
            (function nextReq() {
                if (!QUEUE.length || full()) return cb(out);
                var rq = QUEUE[0], from = lc(rq.from), sd = SEALED[from], ids = [], chunk = {}, cids = [], size = 0, ci = 0;
                rq.coins = rq.coins.filter(function (c) { return backs[lc(c)]; });
                if (sd && rq.coins.length && rq.coins.every(function (c) { return sd.coins[lc(c)]; })) {   // asked again at this height
                    QUEUE.shift();
                    sd.raws.forEach(function (raw) { msgs++; chars += raw.length; out.push({ to: rq.from, raw: raw, coins: [], again: true }); });
                    return nextReq();
                }
                rq.coins.forEach(function (c) { if (!(SENT[from + '|' + lc(c)] >= 0)) ids.push(c); });
                (function nextCoin() {
                    if (ci >= ids.length || full()) {
                        if (size) emit(rq.from, chunk, cids);
                        rq.coins = ids.slice(ci);   // what this poll did not reach waits for the next
                        if (!rq.coins.length) QUEUE.shift();
                        return nextReq();
                    }
                    var id = ids[ci];
                    if (spent >= EXPORTS_PER_POLL && !(tip === EXP_TIP && EXP[lc(id)])) { if (size) emit(rq.from, chunk, cids); return cb(out); }
                    exportAt(mds, id, tip, function (e, d, cached) {
                        ci++;
                        if (!cached) spent++;
                        if (e) return nextCoin();
                        var add = d.length + id.length + 6;   // NIT (proofs.js:117): the size check counts what is added
                        if (size && size + add > REPLY_MAX_CHARS) { emit(rq.from, chunk, cids); chunk = {}; cids = []; size = 0; if (full()) { ci--; return nextCoin(); } }
                        chunk[id] = d; cids.push(id); size += add;
                        nextCoin();
                    });
                })();
            })();
        });
    }

    // ---------------- taker ----------------

    /**
     * Taker(opts): opts.cmd(command, cb(err, response)) runs one node command (AX.mds.cmdR), opts.count() is told of each;
     * opts.send(order, coinIds) seals and publishes a request to the order's maker; opts.proven(coinIds) is told the coins
     * this node now sees;
     * opts.log(line). The page calls onBlock(tip) on every block, want(order) when a coin of the order is not visible, and
     * reply(fromPublicId, proofs) for every opened {k:'proofs'} message.
     */
    function Taker(opts) {
        opts = opts || {};
        this.cmd = opts.cmd; this.send = opts.send || noop; this.proven = opts.proven || noop; this.log = opts.log || noop;
        this.count = opts.count || noop;   // told of every node command (the page counts them in the verdict cache's budget)
        this.asked = {};      // lc coin id → {maker: lc publicId, addrs: {lc address: true}, at: height asked}
        this.tip = 0; this.asks = 0; this.imports = 0;
        this.jobs = []; this.busy = false;
    }
    Taker.prototype.onBlock = function (tip) {
        if (!(tip > this.tip)) return;
        this.tip = tip; this.asks = 0; this.imports = 0;
        for (var k in this.asked) if (this.asked.hasOwnProperty(k) && tip - this.asked[k].at > ASK_EVERY * 10) delete this.asked[k];
    };
    /** Ask the order's maker for proofs of its coins not asked of it in the last ASK_EVERY heights. True when sent. */
    Taker.prototype.want = function (order) {
        var self = this, ids = [], addrs = {}, i, a, maker = lc(order && order.pubId);
        if (!/^0x[0-9a-f]{128}$/.test(maker) || this.asks >= ASKS_PER_BLOCK) return false;
        for (i = 0; i < (order.coins || []).length && ids.length < MAX_ASK; i++) {
            a = this.asked[lc(order.coins[i])];
            if (isId(order.coins[i]) && (!a || a.maker !== maker || this.tip - a.at >= ASK_EVERY)) ids.push(order.coins[i]);
        }
        if (!ids.length) return false;
        for (i = 0; i < (order.scripts || []).length; i++) addrs[lc(AX.takeable.scriptAddress(order.scripts[i]))] = true;
        ids.forEach(function (c) { self.asked[lc(c)] = { maker: maker, addrs: addrs, at: self.tip }; });
        this.asks++;
        this.send(order, ids);
        return true;
    };
    /** A {k:'proofs'} reply from `from`. Each proof is checked before anything reaches the node (asked of this maker, names
     *  the asked coin, at one of the order's script addresses); then: already visible → nothing imported; else
     *  `coinimport data:<proof> track:false` and the coin must then be visible under its own id. */
    Taker.prototype.reply = function (from, proofs) {
        var self = this, maker = lc(from), keys = proofs && typeof proofs === 'object' ? Object.keys(proofs).slice(0, MAX_ASK) : [];
        keys.forEach(function (id) {
            var a = self.asked[lc(id)], d = proofs[id], n = named(d);
            if (!a || a.maker !== maker) return;                     // never asked this maker for it: ignored, no log (bounded)
            if (!n || lc(n.coinid) !== lc(id)) return self.log('Coin proof refused: the proof maker ' + from + ' sent for coin ' + id + ' is not a proof of that coin' + (n ? ' (it names ' + n.coinid + ')' : '') + '.');
            if (!a.addrs[lc(n.address)]) return self.log('Coin proof refused: coin ' + id + ' from maker ' + from + ' is at ' + n.address + ', not at the address of any script its order publishes.');
            self.jobs.push({ id: id, d: d, from: from, created: n.created });
        });
        this.run();
    };
    /** 0.0.118: the height below which a coin is outside this node's tree, read once a height (`status`); cb(bound) with
     *  bound = chain.block - chain.length, or 0 when it could not be read. */
    Taker.prototype.bound = function (cb) {
        var self = this, tip = this.tip;
        if (this.boundAt && this.boundAt.tip === tip && tip > 0) return cb(this.boundAt.bound);
        this.count(); this.cmd('status', function (e, st) {
            var c = !e && st && st.chain, b = c ? parseInt(c.block, 10) - parseInt(c.length, 10) : 0;
            b = b > 0 ? b : 0;
            if (b) self.boundAt = { tip: tip, bound: b };
            cb(b);
        });
    };
    /**
     * Import the checked proofs, one at a time. Review 23 Nov (M3, phantom balance): `coinimport` of a coin the node already
     * holds in its tree takes its "already have it" branch and marks the coin RELEVANT whatever track:false says
     * (coinimport.java): the maker's coin then shows in this node's confirmed balance. So a coin is imported only when
     *   - `coins coinid:` answered (an error is not "not there": nothing is imported, the coin is asked again later), and
     *     did not return it; and
     *   - its created block, read from the proof's own bytes, is more than ROOT_MARGIN blocks under this node's tree root.
     *     A coin inside the window is never imported: it is either visible, or spent, or not here yet.
     * After an import a coin that came back relevant anyway (a second page importing it at the same moment) is untracked
     * again (`cointrack enable:false`).
     */
    Taker.prototype.run = function () {
        var self = this, proven = [];
        if (this.busy) return;
        this.busy = true;
        (function next() {
            var j = self.jobs.shift();
            if (!j) { self.busy = false; if (proven.length) self.proven(proven); return; }
            self.count(); self.cmd('coins coinid:' + j.id, function (e0, seen) {
                if (e0) { delete self.asked[lc(j.id)]; return next(); }                         // unknown: never import blind
                if (seen && seen.length) { proven.push(j.id); return next(); }                    // visible already
                if (self.imports >= IMPORTS_PER_BLOCK) { delete self.asked[lc(j.id)]; return next(); }   // asked again next height
                self.bound(function (bound) {
                    if (!bound) { delete self.asked[lc(j.id)]; return next(); }                   // the tree is unknown: asked again later
                    if (!(j.created > 0) || j.created >= bound - ROOT_MARGIN) return next();      // inside the window: never imported
                    self.imports++;
                    self.count(); self.cmd('coinimport data:' + j.d + ' track:false', function (e1) {
                        if (e1) { self.log('Coin proof of ' + j.id + ' from maker ' + j.from + ' refused by this node: ' + String(e1.message || e1).replace(/^cmd failed: coinimport data:\S+ track:false — /, '') + ' — its order is not takeable now.'); return next(); }
                        self.count(); self.cmd('coins coinid:' + j.id, function (e2, rows) {
                            if (!e2 && rows && rows[0] && lc(rows[0].coinid) === lc(j.id)) proven.push(j.id);
                            else self.log('Coin proof of ' + j.id + ' from maker ' + j.from + ' imported, but this node still does not show the coin — its order is not takeable now.');
                            self.count(); self.cmd('coins relevant:true coinid:' + j.id, function (e3, rel) {
                                if (e3 || !rel || !rel.length) return next();
                                self.log('Coin ' + j.id + ' of maker ' + j.from + ' became one of this node\'s own coins on import: untracked again (it is not yours).');
                                self.count(); self.cmd('cointrack enable:false coinid:' + j.id, function () { next(); });
                            });
                        });
                    });
                });
            });
        })();
    };

    AX.proofs = { named: named, answer: answer, exportable: exportable, Taker: Taker, MAX_ASK: MAX_ASK, MAX_PROOF_CHARS: MAX_PROOF_CHARS, REPLY_MAX_CHARS: REPLY_MAX_CHARS, EXPORTS_PER_POLL: EXPORTS_PER_POLL,
                  ASKS_PER_BLOCK: ASKS_PER_BLOCK, IMPORTS_PER_BLOCK: IMPORTS_PER_BLOCK, ASK_EVERY: ASK_EVERY, ROOT_MARGIN: ROOT_MARGIN, REPLIES_PER_POLL: REPLIES_PER_POLL, REPLY_CHARS_PER_POLL: REPLY_CHARS_PER_POLL, TIME_BOX_MS: TIME_BOX_MS, pending: pending,
                  _clock: function (f) { clock = f || function () { return Date.now(); }; },
                  _reset: function () { EXP = {}; EXP_TIP = 0; OKAT = {}; QUEUE = []; SENT = {}; SEALED = {}; SEALED_TIP = 0; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
