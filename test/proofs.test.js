/* proofs.test.js — the coin proof hand-over (lib/proofs.js): what a maker exports for a taker, and how much. */
(function () {
    var P = AX.proofs, E = AX.envelope, H = AX.hex;
    function id(b) { return '0x' + b.repeat(32); }
    var ADDR = id('AD');
    /** A proof as coinexport returns it: coin id, address, then the rest of the coin and the MMR proof (filler here). */
    function proof(coin, address, chars) {
        var d = '0x00000020' + coin.slice(2) + '00000020' + address.slice(2);
        while (d.length < (chars || 900)) d += '0123456789ABCDEF';
        return d.slice(0, chars || 900);
    }
    // ---- named(): what a proof's bytes say about itself ----
    var n = P.named(proof(id('A1'), ADDR));
    T.eq('named: coin id and address read from the proof bytes', n, { coinid: id('A1'), address: ADDR });
    T.eq('named: not hex', P.named('0x00000020zz' + 'A1'.repeat(80)), null);
    T.eq('named: wrong length prefix', P.named('0x00000021' + proof(id('A1'), ADDR).slice(10)), null);
    T.eq('named: too short', P.named('0x00000020' + 'A1'.repeat(32)), null);
    T.eq('named: over MAX_PROOF_CHARS', P.named(proof(id('A1'), ADDR, P.MAX_PROOF_CHARS + 2)), null);

    // ---- answer(): the maker side ----
    var exports = [], FAIL = {}, LIE = {}, CHARS = 900;
    var mds = { cmdR: function (c, cb) {
        if (c === 'block') return cb(null, { block: '5000' });
        var m = /^coinexport coinid:(0x[0-9A-Fa-f]{64})$/.exec(c);
        if (!m) return cb(new Error('unexpected ' + c));
        exports.push(m[1]);
        if (FAIL[m[1]]) return cb(new Error('cmd failed: coinexport — Coin not found coinid : ' + m[1]));
        cb(null, { coinproof: {}, data: proof(LIE[m[1]] || m[1], ADDR, CHARS) });
    } };
    var list = [{ orderId: 'o1', status: 'live', coins: [id('A1'), id('A2')] }, { orderId: 'o2', status: 'cancelled', coins: [id('C1')] }, { orderId: 'o3', status: 'live', coins: [id('A3')] }];
    var TAKER = '0x' + '77'.repeat(64), got = null;
    P._reset();
    P.answer(mds, list, [{ from: TAKER, coins: [id('A1'), id('C1'), id('99'), 'junk; send amount:1', id('A1'), id('A3')] }], function (r) { got = r; });
    T.eq('answer: only coins backing a LIVE order of mine are exported, once each (a cancelled order\'s coin, a stranger, junk: never)', exports, [id('A1'), id('A3')]);
    T.eq('answer: one reply to the asker with the two proofs', got.length === 1 && got[0].to === TAKER ? Object.keys(got[0].proofs) : got, [id('A1'), id('A3')]);
    T.eq('answer: the proof is the node\'s data, unchanged', got[0].proofs[id('A1')], proof(id('A1'), ADDR, CHARS));

    exports = []; got = null;
    P.answer(mds, list, [{ from: TAKER, coins: [id('A1')] }, { from: '0x' + '88'.repeat(64), coins: [id('A1')] }], function (r) { got = r; });
    T.eq('answer: the same coin at the same height is exported once, whoever asks', exports, []);
    T.eq('answer: both askers answered from it', got.map(function (x) { return x.to; }), [TAKER, '0x' + '88'.repeat(64)]);

    P._reset(); exports = []; got = null; FAIL[id('A2')] = true; LIE[id('A3')] = id('99');
    P.answer(mds, list, [{ from: TAKER, coins: [id('A2'), id('A3')] }], function (r) { got = r; });
    T.eq('answer: a failed export, or one that proves another coin, is left out (and nothing is sent when nothing is left)', got, []);
    delete FAIL[id('A2')]; delete LIE[id('A3')];

    // the export budget: whatever the number of askers, at most EXPORTS_PER_POLL fresh exports per batch
    var many = [], big = { orderId: 'big', status: 'live', coins: [] }, i, reqs = [];
    for (i = 0; i < 96; i++) { var c = '0x' + ('0000' + i.toString(16)).slice(-4).toUpperCase().repeat(16); many.push(c); big.coins.push(c); }
    for (i = 0; i < 3; i++) reqs.push({ from: '0x' + String(i + 1).repeat(128), coins: many.slice(i * 32, i * 32 + 32) });
    P._reset(); exports = []; got = null;
    P.answer(mds, [big], reqs, function (r) { got = r; });
    T.eq('answer: at most EXPORTS_PER_POLL coinexport commands per batch (3 askers × 32 coins)', exports.length, P.EXPORTS_PER_POLL);
    T.ok('answer: a request asks for at most MAX_ASK coins', reqs.every(function (r) { return r.coins.length <= P.MAX_ASK; }));

    // ---- sizes: realistic mainnet proofs (estimated 2.5–3.5K chars; 4000 used) in the sealed reply ----
    var me = AX.identity.fromSeed('0x' + '21'.repeat(32), 'decks'), taker = AX.identity.fromSeed('0x' + '22'.repeat(32), 'decks'), NOW = Math.floor(Date.now() / 1000);
    CHARS = 4000;
    [1, 2, 4, 32].forEach(function (k) {
        P._reset(); got = null;
        P.answer(mds, [big], [{ from: taker.publicId(), coins: many.slice(0, k) }], function (r) { got = r; });
        var sizes = got.map(function (r) {
            var raw = E.msg(me, r.to, AX.identity.seal(me, r.to, H.utf8(JSON.stringify({ k: 'proofs', proofs: r.proofs }))), NOW + 300);
            T.ok('sizes: the sealed reply verifies (under MAX_MSG_BYTES ' + E.MAX_MSG_BYTES + ') with ' + k + ' coin(s)', E.verify(raw, NOW).ok && raw.length <= E.MAX_MSG_BYTES);
            return raw.length;
        });
        T.eq('sizes: every asked coin is answered (' + k + ' coin(s))', got.reduce(function (s, r) { return s + Object.keys(r.proofs).length; }, 0), k);
        T.log('  reply for ' + k + ' coin(s) of 4000-char proofs: ' + sizes.length + ' message(s) of ' + sizes.join(' + ') + ' chars');
    });
})();
