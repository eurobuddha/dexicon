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
 * Rhino-safe (ES5). Needs AX.mds-style cmdR only. Attaches to AX.proofs.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    /** At most this many coins in one request (an order backs with at most 32). */
    var MAX_ASK = 32;
    /** A proof's data (0x + hex). MEASURED 580–888 chars on a -test chain; ~2.5–3.5K estimated on mainnet (unmeasured). */
    var MAX_PROOF_CHARS = 16000;
    /** Proof data per reply message. Sealing quadruples it (lib/identity.js seal: the plaintext travels hex-encoded inside the
     *  sealed payload, and the blob is hex again): 60000 chars → a ~241K-char msg, under the 256K-char MAX_MSG_BYTES. */
    var REPLY_MAX_CHARS = 60000;
    /** Maker: coinexport commands per request batch (one inbox poll), whatever the number of senders. */
    var EXPORTS_PER_POLL = 64;

    function lc(s) { return String(s || '').toLowerCase(); }
    function isId(s) { return typeof s === 'string' && /^0x[0-9A-Fa-f]{64}$/.test(s); }

    /** The coin id and address a proof's bytes name, or null. CoinProof = Coin.writeDataStream then the MMR proof; a Coin
     *  starts with its coin id then its address, each MiniData.writeHashToStream = 4-byte length (0x20) + 32 bytes. */
    function named(d) {
        if (typeof d !== 'string' || d.length < 146 || d.length > MAX_PROOF_CHARS || !/^0x[0-9A-Fa-f]+$/.test(d)) return null;
        if (d.substr(2, 8) !== '00000020' || d.substr(74, 8) !== '00000020') return null;
        return { coinid: '0x' + d.substr(10, 64).toUpperCase(), address: '0x' + d.substr(82, 64).toUpperCase() };
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

    /**
     * Maker: answer a batch of requests [{from, coins}] from one inbox poll. Only coins that back one of MY live orders are
     * exported (never another coin of my wallet), at most EXPORTS_PER_POLL fresh exports for the whole batch. cb(replies)
     * with replies = [{to, proofs:{coinid: data}}] (a request whose proofs do not fit one message gets more).
     */
    function answer(mds, list, requests, cb) {
        var backs = {}, out = [], spent = 0;
        (list || []).forEach(function (o) { if (o && o.status === 'live') (o.coins || []).forEach(function (c) { backs[lc(c)] = true; }); });
        readTip(mds, function (tip) {
            var ri = 0;
            (function nextReq() {
                if (ri >= requests.length) return cb(out);
                var rq = requests[ri++], seen = {}, ids = [], chunk = {}, size = 0, ci = 0;
                ((rq && rq.coins) || []).slice(0, MAX_ASK).forEach(function (c) { if (isId(c) && backs[lc(c)] && !seen[lc(c)]) { seen[lc(c)] = true; ids.push(c); } });
                (function nextCoin() {
                    if (ci >= ids.length) { if (size) out.push({ to: rq.from, proofs: chunk }); return nextReq(); }
                    var id = ids[ci++];
                    if (spent >= EXPORTS_PER_POLL && !(tip === EXP_TIP && EXP[lc(id)])) return nextCoin();
                    exportAt(mds, id, tip, function (e, d, cached) {
                        if (!cached) spent++;
                        if (e) return nextCoin();
                        if (size && size + d.length > REPLY_MAX_CHARS) { out.push({ to: rq.from, proofs: chunk }); chunk = {}; size = 0; }
                        chunk[id] = d; size += d.length + id.length + 6;
                        nextCoin();
                    });
                })();
            })();
        });
    }

    AX.proofs = { named: named, answer: answer, MAX_ASK: MAX_ASK, MAX_PROOF_CHARS: MAX_PROOF_CHARS, REPLY_MAX_CHARS: REPLY_MAX_CHARS, EXPORTS_PER_POLL: EXPORTS_PER_POLL,
                  _reset: function () { EXP = {}; EXP_TIP = 0; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
