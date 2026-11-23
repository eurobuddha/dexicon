/* proofs.test.js — the coin proof hand-over (lib/proofs.js): what a maker exports for a taker, and how much. */
(function () {
    var P = AX.proofs, E = AX.envelope, H = AX.hex;
    function id(b) { return '0x' + b.repeat(32); }
    var ADDR = id('AD');
    /** MiniNumber.writeDataStream of a whole number: scale 0, length, minimal two's-complement big-endian bytes. */
    function mn(v) { var h = v.toString(16); if (h.length % 2) h = '0' + h; if (parseInt(h.slice(0, 2), 16) & 0x80) h = '00' + h; return '00' + ('0' + (h.length / 2).toString(16)).slice(-2) + h; }
    /** A proof as coinexport returns it (Coin.writeDataStream): coin id, address, amount 1003, tokenid 0x00, storestate,
     *  MMR entry 5, unspent, created block (`created`, default 100), no state, no token; then the MMR proof (filler here). */
    function proof(coin, address, chars, created) {
        var d = '0x00000020' + coin.slice(2) + '00000020' + address.slice(2) + '000203EB' + '0000000100' + '01' + '000100' + '0000000105' + '00' + mn(created === undefined ? 100 : created) + '000100' + '00';
        while (d.length < (chars || 900)) d += '0123456789ABCDEF';
        return d.slice(0, chars || 900);
    }
    // ---- named(): what a proof's bytes say about itself ----
    var n = P.named(proof(id('A1'), ADDR));
    T.eq('named: coin id, address and created block read from the proof bytes', n, { coinid: id('A1'), address: ADDR, created: 100 });
    T.eq('named: a created block of 3 bytes (top bit set: a leading zero byte)', P.named(proof(id('A1'), ADDR, 900, 2433919)).created, 2433919);
    T.eq('named: bytes that stop before the created block: -1', P.named(proof(id('A1'), ADDR).slice(0, 160)).created, -1);
    // the real coinexport of a -test chain coin (scratch run, 22 Nov): created 8, as its JSON said
    T.eq('named: a real coinexport', P.named('0x00000020DA2484B996F8A21A991CF2080488EE7ABE8701B7F97D196ECF8A73DC03E3C07B0000002065DCC7CE31C102DABE24BF76D625907156A88B61996A8E9C68154D68929826C3000203EB0000000100010001000000000105000001080001000000011B'),
        { coinid: '0xDA2484B996F8A21A991CF2080488EE7ABE8701B7F97D196ECF8A73DC03E3C07B', address: '0x65DCC7CE31C102DABE24BF76D625907156A88B61996A8E9C68154D68929826C3', created: 8 });
    T.eq('named: not hex', P.named('0x00000020zz' + 'A1'.repeat(80)), null);
    T.eq('named: wrong length prefix', P.named('0x00000021' + proof(id('A1'), ADDR).slice(10)), null);
    T.eq('named: too short', P.named('0x00000020' + 'A1'.repeat(32)), null);
    T.eq('named: over MAX_PROOF_CHARS', P.named(proof(id('A1'), ADDR, P.MAX_PROOF_CHARS + 2)), null);

    // ---- answer(): the maker side ----
    var exports = [], FAIL = {}, LIE = {}, CHARS = 900, TIP = '5000', seals = 0;
    var mds = { cmdR: function (c, cb) {
        if (c === 'block') return cb(null, { block: TIP });
        var m = /^coinexport coinid:(0x[0-9A-Fa-f]{64})$/.exec(c);
        if (!m) return cb(new Error('unexpected ' + c));
        exports.push(m[1]);
        if (FAIL[m[1]]) return cb(new Error('cmd failed: coinexport — Coin not found coinid : ' + m[1]));
        cb(null, { coinproof: {}, data: proof(LIE[m[1]] || m[1], ADDR, CHARS) });
    } };
    /** The seal stand-in: the reply's JSON (the real one is ~4x bigger: identity.seal hex-encodes twice; sizes below). */
    function seal(to, obj) { seals++; return JSON.stringify({ to: to, obj: obj }); }
    function proofsOf(rs) { var m = {}; rs.forEach(function (r) { var p = JSON.parse(r.raw).obj.proofs; Object.keys(p).forEach(function (k) { m[k] = p[k]; }); }); return m; }
    var list = [{ orderId: 'o1', status: 'live', coins: [id('A1'), id('A2')] }, { orderId: 'o2', status: 'cancelled', coins: [id('C1')] }, { orderId: 'o3', status: 'live', coins: [id('A3')] }];
    var TAKER = '0x' + '77'.repeat(64), got = null;
    P._reset();
    P.answer(mds, list, [{ from: TAKER, coins: [id('A1'), id('C1'), id('99'), 'junk; send amount:1', id('A1'), id('A3')] }], function (r) { got = r; }, seal);
    T.eq('answer: only coins backing a LIVE order of mine are exported, once each (a cancelled order\'s coin, a stranger, junk: never)', exports, [id('A1'), id('A3')]);
    T.eq('answer: one reply to the asker with the two proofs', got.length === 1 && got[0].to === TAKER ? Object.keys(proofsOf(got)) : got, [id('A1'), id('A3')]);
    T.eq('answer: the proof is the node\'s data, unchanged', proofsOf(got)[id('A1')], proof(id('A1'), ADDR, CHARS));

    exports = []; got = null;
    P.answer(mds, list, [{ from: TAKER, coins: [id('A1')] }, { from: '0x' + '88'.repeat(64), coins: [id('A1')] }], function (r) { got = r; }, seal);
    T.eq('answer: the same coin at the same height is exported once, whoever asks', exports, []);
    T.eq('answer: the repeat of the same asker at the same height gets the message already sealed; the other asker its own', [got.map(function (x) { return x.to; }), got[0].again], [[TAKER, '0x' + '88'.repeat(64)], true]);

    P._reset(); exports = []; got = null; FAIL[id('A2')] = true; LIE[id('A3')] = id('99');
    P.answer(mds, list, [{ from: TAKER, coins: [id('A2'), id('A3')] }], function (r) { got = r; }, seal);
    T.eq('answer: a failed export, or one that proves another coin, is left out (and nothing is sent when nothing is left)', got, []);
    delete FAIL[id('A2')]; delete LIE[id('A3')];

    // the export budget: whatever the number of askers, at most EXPORTS_PER_POLL fresh exports per batch
    var many = [], big = { orderId: 'big', status: 'live', coins: [] }, i, reqs = [];
    for (i = 0; i < 96; i++) { var c = '0x' + ('0000' + i.toString(16)).slice(-4).toUpperCase().repeat(16); many.push(c); big.coins.push(c); }
    for (i = 0; i < 3; i++) reqs.push({ from: '0x' + String(i + 1).repeat(128), coins: many.slice(i * 32, i * 32 + 32) });
    P._reset(); exports = []; got = null; CHARS = 300;
    P.answer(mds, [big], reqs, function (r) { got = r; }, seal);
    T.ok('answer: at most EXPORTS_PER_POLL coinexport commands per batch (3 askers × 32 coins)', exports.length <= P.EXPORTS_PER_POLL);
    T.ok('answer: a request asks for at most MAX_ASK coins', reqs.every(function (r) { return r.coins.length <= P.MAX_ASK; }));

    // ---- 0.0.128, the coin-key attestation: the maker signs ONCE per (identity, backing address), ever ----
    T.eq('attest: the statement = SHA3-256("dexicon-backing-v1" · signPk · address) (pinned with node:crypto sha3-256)', P.statement('0x' + '5B'.repeat(32), '0x' + 'AD'.repeat(32)), '0x786AA52E713678C149E951ECFBCD63BC2B4260A6FF135B8B0293CA9115B6AF58');
    T.ok('attest: another identity or another address, another statement', P.statement('0x' + '5C'.repeat(32), '0x' + 'AD'.repeat(32)) !== P.statement('0x' + '5B'.repeat(32), '0x' + 'AD'.repeat(32)) && P.statement('0x' + '5B'.repeat(32), '0x' + 'AE'.repeat(32)) !== P.statement('0x' + '5B'.repeat(32), '0x' + 'AD'.repeat(32)));
    T.eq('attest: scriptPk reads RETURN SIGNEDBY(pk), nothing else', [P.scriptPk('RETURN SIGNEDBY(0x' + '5B'.repeat(32) + ')'), P.scriptPk('RETURN TRUE'), P.scriptPk('RETURN SIGNEDBY(0x5B)')], ['0x' + '5B'.repeat(32), null, null]);
    (function () {
        var MYPK = '0x' + 'A7'.repeat(32), signs = [], akv = {};
        function sk(i) { return '0x' + ('0' + (0x30 + i).toString(16)).slice(-2).toUpperCase().repeat(32); }
        var scripts = [0, 1, 2, 3, 4, 5].map(function (i) { return 'RETURN SIGNEDBY(' + sk(i) + ')'; }), ad = scripts.map(function (x) { return AX.takeable.scriptAddress(x); });
        var amds = { kvGet: function (k, d, cb) { cb(akv[k] === undefined ? d : akv[k]); }, kvSet: function (k, v, cb) { akv[k] = v; cb(null); },
            cmdR: function (c, cb) {
                if (c === 'block') return cb(null, { block: TIP });
                var m = /^sign publickey:(0x[0-9A-F]{64}) data:(0x[0-9A-F]{64})$/.exec(c);
                if (m) { signs.push(m[1]); return cb(null, '0x' + m[1].slice(2) + m[2].slice(2)); }   // a stand-in signature naming key and data
                mds.cmdR(c, cb);
            } };
        var lst = [{ orderId: 'a1', status: 'live', coins: [id('A1')], scripts: scripts.slice(0, 6) }];
        P._reset(); TIP = '7000'; got = null;
        P.answer(amds, lst, [{ from: TAKER, coins: [], attest: [ad[0], '0x' + 'EE'.repeat(32), ad[0]] }], function (r) { got = r; }, seal, MYPK);
        var att = got.length ? JSON.parse(got[0].raw).obj.attest : null;
        T.eq('attest: only an address of my live orders\' scripts is signed, by its own key, once', [signs, att && Object.keys(att)], [[sk(0)], [ad[0]]]);
        T.eq('attest: the signature is over the statement for MY identity and that address', att[ad[0]], '0x' + sk(0).slice(2) + P.statement(MYPK, ad[0]).slice(2));
        T.eq('attest: kept in kv attest_<signPk>_<address>', akv['attest_' + MYPK.toLowerCase() + '_' + ad[0].toLowerCase()], att[ad[0]]);
        P._reset(); TIP = '7100'; signs = []; got = null;   // memory lost (a restart): the kv copy answers
        P.answer(amds, lst, [{ from: '0x' + '99'.repeat(64), coins: [], attest: [ad[0]] }], function (r) { got = r; }, seal, MYPK);
        T.eq('attest: never signed twice for the same address and identity (restart: from kv)', [signs, JSON.parse(got[0].raw).obj.attest[ad[0]]], [[], att[ad[0]]]);
        P._reset(); TIP = '7200'; signs = []; got = null; CHARS = 900;
        P.answer(amds, lst, [{ from: TAKER, coins: [], attest: ad }], function (r) { got = r; }, seal, MYPK);
        T.eq('attest: at most SIGNS_PER_POLL fresh signs a poll, the rest queued', [P.SIGNS_PER_POLL, signs.length, P.pending()], [4, 4, true]);
        P.answer(amds, lst, [], function (r) { got = r; }, seal, MYPK);
        T.eq('attest: ... and signed at the next poll', signs.length, 5);
        // 0.0.152: kv attest_sign off — nothing is signed or sent, coin proofs still answered; unset/anything else = on
        P._reset(); TIP = '7300'; signs = []; got = null; akv.attest_sign = ' OFF ';
        P.answer(amds, lst, [{ from: '0x' + '98'.repeat(64), coins: [id('A1')], attest: [ad[5]] }], function (r) { got = r; }, seal, MYPK);
        T.eq('0.0.152: attest_sign off: no sign, no attestation in the reply, the coin proof sent', [signs, got.length, JSON.parse(got[0].raw).obj.attest === undefined, Object.keys(JSON.parse(got[0].raw).obj.proofs)], [[], 1, true, [id('A1')]]);
        T.eq('0.0.152: attest_sign on = unset, \'\', 1, on, junk; off = 0, false, off, no (any case, spaces)', [undefined, '', '1', 'on', 'x', '0', 'false', ' off ', 'NO'].map(P.attestOn), [true, true, true, true, true, false, false, false, false]);
        delete akv.attest_sign; P._reset(); TIP = '7400'; signs = []; got = null;
        P.answer(amds, lst, [{ from: '0x' + '98'.repeat(64), coins: [], attest: [ad[5]] }], function (r) { got = r; }, seal, MYPK);
        T.eq('0.0.152: ... unset again: the attestation is sent (signed once ever, kept in kv)', got.length && Object.keys(JSON.parse(got[0].raw).obj.attest), [ad[5]]);
        P._reset(); TIP = '5000';
    })();

    // ---- review 23 Nov (MINOR): "provable" is remembered PROOF_OK_BLOCKS (10) heights and dropped at once when an export fails ----
    function exportable(t) { var r = null; TIP = String(t); P.exportable(mds, [{ coinid: id('A1'), amount: '5', tokenid: '0x00' }], t, function (x) { r = x; }); return !!r[id('A1').toLowerCase()]; }
    P._reset(); CHARS = 900;
    T.eq('MINOR: a coin that exports is provable', exportable(6000), true);
    FAIL[id('A1')] = true;
    T.eq('MINOR: exports failing: still remembered within PROOF_OK_BLOCKS heights', exportable(6000 + P.PROOF_OK_BLOCKS - 1), true);
    T.eq('MINOR: ... and not after PROOF_OK_BLOCKS (10) heights', [P.PROOF_OK_BLOCKS, exportable(6000 + P.PROOF_OK_BLOCKS)], [10, false]);
    delete FAIL[id('A1')]; P._reset();
    T.eq('MINOR: provable again', exportable(6100), true);
    FAIL[id('A1')] = true; got = null; TIP = '6101';
    P.answer(mds, list, [{ from: TAKER, coins: [id('A1')] }], function (r) { got = r; }, seal);
    T.eq('MINOR: an export failing for a taker ends "provable" at once (the next refresh relocks it)', exportable(6101), false);
    delete FAIL[id('A1')]; TIP = '5000'; P._reset();

    // ---- review 23 Nov (M1): anyone can make the maker seal; the work of one poll is bounded, the rest waits ----
    var attackers = [];
    for (i = 0; i < 16; i++) attackers.push({ from: '0x' + ('0' + i.toString(16)).slice(-2).repeat(64), coins: many.slice(0, 32) });
    P._reset(); exports = []; got = null; seals = 0; CHARS = 4000;
    P.answer(mds, [big], attackers, function (r) { got = r; }, seal);
    var sizes = got.map(function (r) { return r.raw.length; }), total = sizes.reduce(function (a, b) { return a + b; }, 0);
    T.ok('M1: 16 askers × 32 coins: one poll seals at most REPLIES_PER_POLL messages (' + seals + ')', seals <= P.REPLIES_PER_POLL && got.length <= P.REPLIES_PER_POLL);
    T.ok('M1: ... and at most REPLY_CHARS_PER_POLL chars plus one message (' + total + ')', total <= P.REPLY_CHARS_PER_POLL + P.REPLY_MAX_CHARS + 1000);
    T.ok('M1: the rest is queued for the next poll', P.pending());
    var polls = 1, answered = {};
    got.forEach(function (r) { answered[r.to] = (answered[r.to] || 0) + r.coins.length; });
    while (P.pending() && polls < 200) { P.answer(mds, [big], [], function (r) { r.forEach(function (x) { answered[x.to] = (answered[x.to] || 0) + x.coins.length; }); }, seal); polls++; }
    T.ok('M1: every asker is answered in later polls, each coin once (' + polls + ' polls)', !P.pending() && attackers.every(function (a) { return answered[a.from] === 32; }));
    // a coin is sent to one asker at most once per ASK_EVERY heights
    seals = 0; exports = []; TIP = '5003';
    P.answer(mds, [big], [{ from: attackers[0].from, coins: many.slice(0, 32) }], function (r) { got = r; }, seal);
    T.eq('M1: the same asker re-asking within ASK_EVERY heights: nothing exported or sealed', [got.length, seals, exports.length], [0, 0, 0]);
    TIP = String(5000 + P.ASK_EVERY);
    P.answer(mds, [big], [{ from: attackers[0].from, coins: many.slice(0, 2) }], function (r) { got = r; }, seal);
    T.eq('M1: ... and answered again ASK_EVERY heights later', got.length === 1 && got[0].coins, many.slice(0, 2));
    // review 23 Nov (MINOR-5): 16 throwaway identities ask 32 coins each, then an honest taker asks 1: round robin, one
    // message a sender a turn — the honest one is answered within ceil(17 / REPLIES_PER_POLL) polls, never dropped
    P._reset(); CHARS = 4000; TIP = '5000';
    var HONEST = '0x' + 'ED'.repeat(64), flood = [], served = -1, polls5 = 0;
    for (i = 0; i < 16; i++) flood.push({ from: '0x' + ('0' + (0xA0 + i).toString(16)).slice(-2).repeat(64), coins: many.slice(0, 32) });
    P.answer(mds, [big], flood, function () { }, seal); polls5++;
    P.answer(mds, [big], [{ from: HONEST, coins: [many[40]] }], function (r) { if (r.some(function (x) { return x.to === HONEST; })) served = polls5; }, seal); polls5++;
    while (served < 0 && polls5 < 60) { P.answer(mds, [big], [], function (r) { if (r.some(function (x) { return x.to === HONEST; })) served = polls5; }, seal); polls5++; }
    T.ok('MINOR-5: the honest taker behind 16 flooding identities is answered within 9 polls (poll ' + served + ')', served >= 0 && served <= 9);
    // review 23 Nov (0.0.150): 256 throwaway identities fill the queue; an honest NEW asker is not turned away: it takes
    // the slot of the sender served longest ago and is answered before any throwaway gets a second message
    P._reset(); CHARS = 4000; TIP = '5000';
    var flood256 = [], served6 = -1, polls6 = 0, seconds = 0, turnsOf = {};
    for (i = 0; i < 256; i++) flood256.push({ from: '0x' + ('000' + i.toString(16)).slice(-4).repeat(32), coins: many.slice(0, 32) });
    function count6(r) { r.forEach(function (x) { turnsOf[x.to] = (turnsOf[x.to] || 0) + 1; if (x.to === HONEST && served6 < 0) served6 = polls6; if (x.to !== HONEST && turnsOf[x.to] === 2 && served6 < 0) seconds++; }); }
    P.answer(mds, [big], flood256, count6, seal); polls6++;
    P.answer(mds, [big], [{ from: HONEST, coins: [many[40]] }], count6, seal); polls6++;
    while (served6 < 0 && polls6 < 400) { P.answer(mds, [big], [], count6, seal); polls6++; }
    T.ok('0.0.150: an honest asker arriving after 256 throwaway identities is admitted and answered (poll ' + served6 + ')', served6 >= 0 && served6 <= 2 + Math.ceil(256 / P.REPLIES_PER_POLL));
    T.eq('0.0.150: ... before any throwaway gets a second message', seconds, 0);
    P._reset(); CHARS = 300;
    // the time box: a slow node stops the poll after TIME_BOX_MS
    P._reset(); var T0 = 0; P._clock(function () { return T0; }); seals = 0; CHARS = 300;
    var slowMds = { cmdR: function (c, cb) { if (c !== 'block') T0 += 400; mds.cmdR(c, cb); } };
    P.answer(slowMds, [big], [{ from: TAKER, coins: many.slice(0, 32) }], function (r) { got = r; }, seal);
    T.ok('M1: a slow node: the poll stops after TIME_BOX_MS (' + T0 + ' ms of exports), the rest queued', T0 <= P.TIME_BOX_MS + 400 && P.pending() && got.length === 1);
    P._clock(null); TIP = '5000';
    // NIT: coins are de-duplicated BEFORE the 32-coin cap
    P._reset(); got = null; CHARS = 900;
    var dup = []; for (i = 0; i < 32; i++) dup.push(many[0]); dup = dup.concat(many.slice(1, 9));
    P.answer(mds, [big], [{ from: TAKER, coins: dup }], function (r) { got = r; }, seal);
    T.eq('NIT: 32 copies of one coin then 8 others: all 9 answered', got.reduce(function (n, r) { return n + r.coins.length; }, 0), 9);

    // ---- sizes: realistic mainnet proofs (estimated 2.5–3.5K chars; 4000 used) in the sealed reply ----
    var me = AX.identity.fromSeed('0x' + '21'.repeat(32), 'decks'), taker = AX.identity.fromSeed('0x' + '22'.repeat(32), 'decks'), NOW = Math.floor(Date.now() / 1000);
    function realSeal(to, obj) { return E.msg(me, to, AX.identity.seal(me, to, H.utf8(JSON.stringify(obj))), NOW + 300); }
    CHARS = 4000;
    [1, 2, 4, 32].forEach(function (k) {
        P._reset(); var all = [];
        var first = true, perPoll = [];
        while (true) { got = null; P.answer(mds, [big], first ? [{ from: taker.publicId(), coins: many.slice(0, k) }] : [], function (r) { got = r; }, realSeal); first = false; all = all.concat(got); perPoll.push(got.reduce(function (n, r) { return n + r.raw.length; }, 0)); if (!P.pending()) break; }
        T.ok('M1: real sealed replies — every poll seals at most REPLY_CHARS_PER_POLL chars (' + perPoll.join(', ') + ')', perPoll.every(function (n) { return n <= P.REPLY_CHARS_PER_POLL; }));
        var sz = all.map(function (r) {
            T.ok('sizes: the sealed reply verifies (under MAX_MSG_BYTES ' + E.MAX_MSG_BYTES + ') with ' + k + ' coin(s)', E.verify(r.raw, NOW).ok && r.raw.length <= E.MAX_MSG_BYTES);
            return r.raw.length;
        });
        T.eq('sizes: every asked coin is answered (' + k + ' coin(s))', all.reduce(function (s, r) { return s + r.coins.length; }, 0), k);
        T.log('  reply for ' + k + ' coin(s) of 4000-char proofs: ' + sz.length + ' message(s) of ' + sz.join(' + ') + ' chars, over ' + perPoll.length + ' poll(s)');
    });

    // ---- Taker: the taker side (0.0.112) ----
    var MAKER = '0x' + '5A'.repeat(64), SCRIPT = 'RETURN SIGNEDBY(0x' + '5B'.repeat(32) + ')', SADDR = AX.takeable.scriptAddress(SCRIPT);
    var sent = [], ran = [], provenIds = [], lines = [], SEEN = {}, IMPORT_ERR = null, LOOKUP_ERR = null, STATUS = { chain: { block: '1000', length: '500' } }, RELEVANT = {};
    var counted = 0;
    var tk = new P.Taker({ count: function () { counted++; },
        cmd: function (c, cb) {
            ran.push(c.indexOf('coinimport') === 0 ? 'coinimport ' + P.named(c.split(' ')[1].slice(5)).coinid : c);
            if (c === 'status') return STATUS ? cb(null, STATUS) : cb(new Error('cmd failed: status'));
            if (c.indexOf('coins relevant:true coinid:') === 0) { var r = c.slice(27); return cb(null, RELEVANT[r] ? [{ coinid: r }] : []); }
            if (c.indexOf('cointrack enable:false coinid:') === 0) { delete RELEVANT[c.slice(30)]; return cb(null, 'Coin removed from track list'); }
            if (c.indexOf('coins coinid:') === 0) { var q = c.slice(13); if (LOOKUP_ERR) return cb(new Error(LOOKUP_ERR)); return cb(null, SEEN[q] ? [{ coinid: q }] : []); }
            if (c.indexOf('coinimport data:') === 0) { if (IMPORT_ERR) return cb(new Error('cmd failed: ' + c + ' — ' + IMPORT_ERR)); SEEN[P.named(c.split(' ')[1].slice(5)).coinid] = true; return cb(null, {}); }
            cb(new Error('unexpected ' + c));
        },
        send: function (o, ids) { sent.push(ids); }, proven: function (ids) { provenIds = provenIds.concat(ids); }, log: function (l) { lines.push(l); } });
    function order(coins, pub) { return { orderId: 'x', pubId: pub || MAKER, coins: coins, scripts: [SCRIPT] }; }
    tk.onBlock(100);
    T.eq('want: a maker that is not a publicId is never asked', tk.want(order([id('B1')], 'pkJUNK')), false);
    T.eq('want: queues every coin of the order; flush sends them', [tk.want(order([id('B1'), id('B2')])), sent.length, (tk.flush(), sent[0])], [true, 0, [id('B1'), id('B2')]]);
    T.eq('want: not again within ASK_EVERY heights', tk.want(order([id('B1'), id('B2')])), false);
    T.eq('M2: a maker already asked at this height waits for the next one (\'later\')', tk.want(order([id('B3')])), 'later');
    // M2: several orders of ONE maker in a height → ONE request with all their coins
    tk.onBlock(101); sent = [];
    T.eq('M2: three orders of one maker queue', [tk.want(order([id('C1')])), tk.want(order([id('C2'), id('C3')])), tk.want(order([id('C4')]))], [true, true, true]);
    tk.flush();
    T.eq('M2: ... and go out as one request', sent, [[id('C1'), id('C2'), id('C3'), id('C4')]]);
    // M2: at most ASKS_PER_BLOCK makers a height; the rest are 'later' (re-checked at the next height, not 'no' for 10)
    tk.onBlock(102); sent = []; var verdicts = [];
    for (i = 0; i < 10; i++) verdicts.push(tk.want(order([id('D' + i)], '0x' + ('0' + (0x70 + i).toString(16)).slice(-2).repeat(64))));
    tk.flush();
    T.eq('M2: at most ASKS_PER_BLOCK makers a height, the rest later', [sent.length, verdicts.filter(function (v) { return v === 'later'; }).length], [P.ASKS_PER_BLOCK, 10 - P.ASKS_PER_BLOCK]);
    // M2: a maker's request holds at most MAX_ASK coins; an order that does not fit is 'later'
    tk.onBlock(103); var c32 = [], c2 = [];
    for (i = 0; i < 31; i++) c32.push('0x' + ('00' + (0x80 + i).toString(16)).slice(-2).toUpperCase().repeat(32));
    T.eq('M2: an order that does not fit this height\'s request to its maker is later', [tk.want(order(c32)), tk.want(order([id('E1'), id('E2')]))], [true, 'later']);
    tk.flush(); sent = [];
    tk.onBlock(100 + P.ASK_EVERY);
    T.eq('want: asked again ASK_EVERY heights later', tk.want(order([id('B1')])), true);
    tk.flush();
    var good = function (c) { return proof(c, SADDR); };
    ran = []; lines = [];
    tk.reply('0x' + '66'.repeat(64), (function () { var m = {}; m[id('B1')] = good(id('B1')); return m; })());
    T.eq('reply: a proof from another maker touches nothing, says nothing', [ran, lines], [[], []]);
    var unasked = {}; unasked[id('E9')] = good(id('E9'));
    tk.reply(MAKER, unasked);
    T.eq('reply: a proof never asked for touches nothing', ran, []);
    var m1 = {}; m1[id('B2')] = proof(id('B9'), SADDR); m1[id('B1')] = proof(id('B1'), ADDR);
    tk.reply(MAKER, m1);
    T.eq('reply: another coin\'s proof, or one at an address no script of the order has, never reaches the node', ran, []);
    T.eq('reply: both refusals are told, whole ids', lines, ['Coin proof refused: the proof maker ' + MAKER + ' sent for coin ' + id('B2') + ' is not a proof of that coin (it names ' + id('B9') + ').',
        'Coin proof refused: coin ' + id('B1') + ' from maker ' + MAKER + ' is at ' + ADDR + ', not at the address of any script its order publishes.']);
    IMPORT_ERR = 'Invalid MMR Proof'; lines = [];
    tk.reply(MAKER, (function () { var m = {}; m[id('B1')] = good(id('B1')); return m; })());
    T.eq('reply: the node refuses a stale proof: nothing proven, told', [ran, provenIds, lines], [['coins ' + 'coinid:' + id('B1'), 'status', 'coinimport ' + id('B1')], [], ['Coin proof of ' + id('B1') + ' from maker ' + MAKER + ' refused by this node: Invalid MMR Proof — its order is not takeable now.']]);
    IMPORT_ERR = null; ran = [];
    tk.reply(MAKER, (function () { var m = {}; m[id('B1')] = good(id('B1')); return m; })());
    T.eq('reply: a good proof: looked up, imported untracked (the tree read once a height), looked up again, proven', [ran, provenIds], [['coins coinid:' + id('B1'), 'coinimport ' + id('B1'), 'coins coinid:' + id('B1')], [id('B1')]]);
    T.eq('count: every node command the Taker runs is counted (the page puts them in the verdict cache\'s budget)', counted, 3 + 3);
    ran = [];
    tk.reply(MAKER, (function () { var m = {}; m[id('B1')] = good(id('B1')); return m; })());
    T.eq('reply: a coin the node already sees is not imported (it would become relevant)', ran, ['coins coinid:' + id('B1')]);
    // review 23 Nov (MINOR-1): a block landing between a pass's want() and its flush() must not lose the request
    tk.onBlock(130); sent = [];
    tk.want(order([id('7A')]));
    tk.onBlock(131);                       // NEWBLOCK mid-pass
    tk.flush();
    T.eq('MINOR-1: the request queued before the block is still sent at the flush', sent, [[id('7A')]]);
    T.eq('MINOR-1: ... stamped as asked when sent (not asked again within ASK_EVERY)', tk.want(order([id('7A')])), false);
    // ---- review 23 Nov (M3, phantom balance): coinimport of a coin inside the node's tree marks it RELEVANT whatever
    // track:false says (coinimport.java "already have it"), so it is imported only when that is impossible ----
    function one(c) { var m = {}; m[c] = good(c); return m; }
    tk.onBlock(150); ran = []; provenIds = []; lines = [];
    tk.want(order([id('F1')])); LOOKUP_ERR = 'cmd failed: coins coinid: — timeout';
    tk.reply(MAKER, one(id('F1')));
    T.eq('M3: the visibility lookup errs: nothing imported (unknown is not "not there")', ran, ['coins coinid:' + id('F1')]);
    T.eq('M3: ... and the coin is asked again later', tk.want(order([id('F1')])), true);
    LOOKUP_ERR = null; ran = [];
    var IN = {}; IN[id('F2')] = proof(id('F2'), SADDR, 900, 500 - P.ROOT_MARGIN);
    tk.want(order([id('F2')])); tk.reply(MAKER, IN);
    T.eq('M3: a coin created inside the tree (or within ROOT_MARGIN under its root) is never imported', ran, ['coins coinid:' + id('F2'), 'status']);
    ran = []; var EDGE = {}; EDGE[id('F3')] = proof(id('F3'), SADDR, 900, 500 - P.ROOT_MARGIN - 1);
    tk.want(order([id('F3')])); tk.reply(MAKER, EDGE);
    T.eq('M3: one block further under the root is imported (the tree read once a height)', ran, ['coins coinid:' + id('F3'), 'coinimport ' + id('F3'), 'coins coinid:' + id('F3')]);
    tk.onBlock(151); STATUS = null; ran = [];
    tk.want(order([id('F4')])); tk.reply(MAKER, one(id('F4')));
    T.eq('M3: the tree cannot be read: nothing imported', ran, ['coins coinid:' + id('F4'), 'status']);
    STATUS = { chain: { block: '1000', length: '500' } }; ran = [];
    var NOBLK = {}; NOBLK[id('F5')] = good(id('F5')).slice(0, 160);
    tk.want(order([id('F5')])); tk.reply(MAKER, NOBLK);
    T.eq('M3: a proof whose created block cannot be read is never imported', ran.filter(function (r) { return r.indexOf('coinimport') === 0; }), []);
    // review 23 Nov (MINOR-4): two pages of one node get the same proof at the same moment: imports run one at a time
    // (opts.lock, the page's SQL lease lock), so the second finds the coin already visible and never imports it (a second
    // import would mark it relevant); `cointrack` is never run
    (function () {
        var q = [], NODE = {}, imports = 0, cmds = [], held = false, waiting = [];
        function later(f) { q.push(f); }
        function node(c, cb) { cmds.push(c.split(' ')[0]); later(function () {
            if (c === 'status') return cb(null, STATUS);
            if (c.indexOf('coinimport data:') === 0) { imports++; NODE[P.named(c.split(' ')[1].slice(5)).coinid] = true; return cb(null, {}); }
            if (c.indexOf('coins coinid:') === 0) return cb(null, NODE[c.slice(13)] ? [{ coinid: c.slice(13) }] : []);
            cb(new Error('unexpected ' + c));
        }); }
        // a simple FIFO mutex standing in for the page's SQL lease lock: the next waiter runs once the holder releases
        var lock = function (body) {
            function release(k) { held = false; var nb = waiting.shift(); if (nb) { held = true; later(function () { nb(release); }); } k(); }
            later(function () { if (held) waiting.push(body); else { held = true; body(release); } });
        };
        var pa = new P.Taker({ cmd: node, lock: lock }), pb = new P.Taker({ cmd: node, lock: lock });
        [pa, pb].forEach(function (t) { t.onBlock(150); t.want(order([id('F6')])); });
        pa.reply(MAKER, one(id('F6'))); pb.reply(MAKER, one(id('F6')));
        var n = 0; while (q.length && n++ < 10000) q.shift()();
        T.eq('MINOR-4: two pages, one proof, the same moment: one coinimport; no cointrack, no relevant check', [imports, cmds.filter(function (c) { return c === 'cointrack'; }).length], [1, 0]);
        // without the lock (an unwired host) both would import: the case the lock exists for
        q = []; NODE = {}; imports = 0;
        var ua = new P.Taker({ cmd: node }), ub = new P.Taker({ cmd: node });
        [ua, ub].forEach(function (t) { t.onBlock(150); t.want(order([id('F7')])); });
        ua.reply(MAKER, one(id('F7'))); ub.reply(MAKER, one(id('F7')));
        n = 0; while (q.length && n++ < 10000) q.shift()();
        T.eq('MINOR-4: (without opts.lock both pages import: why the page wires it)', imports, 2);
    })();
    // review 23 Nov (MINOR): a node whose tree is shorter than the makers' proof depth can never import — said ONCE, then
    // nothing is asked for 10 heights, doubling; the orders' reason says why
    tk.onBlock(160); ran = []; lines = []; sent = []; IMPORT_ERR = 'TreeNode at Blocktime not found (proof too old): 33';
    tk.want(order([id('91')])); tk.flush(); tk.reply(MAKER, one(id('91')));
    T.eq('MINOR: a too-short tree is said once, plainly', lines, ['This node cannot import the coin proofs of maker ' + MAKER + ': its chain tree is shorter than the depth they are proved at (TreeNode at Blocktime not found (proof too old): 33). That maker\'s FAST orders on coins older than this node\'s window stay hidden; tried again from block 170, backing off to every 640 blocks.']);
    T.eq('MINOR: meanwhile nothing is asked and the order says why', [tk.want(order([id('92')])), (tk.flush(), sent.length)], ['this node\'s chain tree is too short to import its maker\'s coin proof (retried from block 170)', 1]);
    T.eq('NIT-1: another maker is still asked (the back-off is that maker\'s only)', tk.want(order([id('94')], '0x' + '5E'.repeat(64))), true);
    tk.onBlock(170); lines = [];
    T.eq('MINOR: asked again when the backoff ends', tk.want(order([id('92')])), true);
    tk.flush(); tk.reply(MAKER, one(id('92')));
    T.eq('MINOR: a second failure is not logged again; the wait doubles', [lines, tk.want(order([id('93')]))], [[], 'this node\'s chain tree is too short to import its maker\'s coin proof (retried from block 190)']);
    IMPORT_ERR = null; tk.short = {};
    // ---- 0.0.129, the coin-key attestation (taker half): asked with the request, checked with `verify` on this node ----
    (function () {
        var vran = [], verdicts = [], vsent = [], vlines = [], KEYPK = '0x' + '5B'.repeat(32);
        var A = '0x' + 'A1'.repeat(64), C = '0x' + 'C1'.repeat(64);   // the real maker and a copycat identity
        function sigOf(pk, data) { return '0x' + pk.slice(2) + data.slice(2); }   // the stand-in node's signature
        var vt = new P.Taker({ cmd: function (c, cb) {
                vran.push(c.split(' ')[0]);
                var m = /^verify publickey:(0x[0-9A-Fa-f]{64}) data:(0x[0-9A-Fa-f]{64}) signature:(0x[0-9A-Fa-f]+)$/.exec(c);
                if (!m) return cb(new Error('unexpected ' + c));
                if (m[3].slice(2, 66) !== m[1].slice(2)) return cb(new Error('cmd failed: ' + c + ' — Signature publickey is different : 0x' + m[3].slice(2, 66)));
                return m[3] === sigOf(m[1], m[2]) ? cb(null, 'Signature valid') : cb(new Error('cmd failed: ' + c + ' — Signature NOT valid'));
            }, send: function (o, ids, at) { vsent.push({ to: o.pubId, coins: ids, attest: at }); }, attested: function (a, pk, ok) { verdicts.push([a, pk, ok]); }, log: function (l) { vlines.push(l); },
            known: ['0x' + 'b1'.repeat(32) + '|' + SADDR.toLowerCase()] });
        vt.onBlock(500);
        var real = order([id('A1')], A), copy = order([id('A1')], C), addr = SADDR.toLowerCase();
        T.eq('attest: a takeable order\'s maker is asked to attest its address (queued, one request per maker)', [vt.wantAttest(real), vt.wantAttest(copy), (vt.flush(), vsent)],
            [true, true, [{ to: A, coins: [], attest: [addr] }, { to: C, coins: [], attest: [addr] }]]);
        T.eq('attest: not asked again within ASK_EVERY heights', vt.wantAttest(real), false);
        T.eq('attest: a pair verified before (kv attested) is never asked', vt.wantAttest(order([id('A2')], '0x' + '00'.repeat(32) + 'b1'.repeat(32))), false);
        var good = sigOf(KEYPK, P.statement('0x' + A.slice(-64), SADDR)), m1 = {}; m1[addr] = good;
        vt.reply(A, {}, m1);
        T.eq('attest: the real maker\'s signature verifies on this node: attested', [vran, verdicts], [['verify'], [[addr, '0x' + A.slice(-64).toLowerCase(), true]]]);
        // the copycat relays the real maker's attestation as its own: the statement is rebuilt for ITS signPk → refused
        vran = []; verdicts = [];
        var m2 = {}; m2[addr] = good; vt.reply(C, {}, m2);
        T.eq('attest: a relayed attestation fails for another identity (its statement names the real maker)', [vran, verdicts], [['verify'], [[addr, '0x' + C.slice(-64).toLowerCase(), false]]]);
        T.ok('attest: ... told plainly', /^Coin-key attestation refused: maker 0x(c1){64} sent a signature for address /i.test(vlines[0]));
        vran = []; var m3 = {}; m3['0x' + 'EE'.repeat(32)] = good; vt.reply(A, {}, m3);
        T.eq('attest: an address never asked of that maker touches nothing', vran, []);
    })();
    // the import budget: at most IMPORTS_PER_BLOCK a height, the rest asked again later
    tk.onBlock(200); ran = []; var many2 = {}, o2 = [];
    for (i = 0; i < 20; i++) { var cc = '0x' + ('00' + i.toString(16)).slice(-2).toUpperCase().repeat(32); o2.push(cc); }
    tk.want(order(o2)); o2.forEach(function (c) { many2[c] = good(c); });
    tk.reply(MAKER, many2);
    T.eq('reply: at most IMPORTS_PER_BLOCK imports a height', ran.filter(function (r) { return r.indexOf('coinimport') === 0; }).length, P.IMPORTS_PER_BLOCK);
    tk.flush(); sent = []; ran = [];
    tk.onBlock(201);
    T.eq('M2: the proofs over the cap are imported at the next height, not asked again', [ran.filter(function (r) { return r.indexOf('coinimport') === 0; }).length, sent.length], [20 - P.IMPORTS_PER_BLOCK, 0]);
})();
