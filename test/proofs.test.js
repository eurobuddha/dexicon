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
    T.eq('want: asks for every coin of the order', [tk.want(order([id('B1'), id('B2')])), sent[0]], [true, [id('B1'), id('B2')]]);
    T.eq('want: not again within ASK_EVERY heights', tk.want(order([id('B1'), id('B2')])), false);
    for (i = 0; i < 20; i++) tk.want(order([id('C' + (i % 10))].concat(i >= 10 ? [id('D' + (i - 10))] : [])));
    T.eq('want: at most ASKS_PER_BLOCK requests a height', sent.length, P.ASKS_PER_BLOCK);
    tk.onBlock(100 + P.ASK_EVERY);
    T.eq('want: asked again ASK_EVERY heights later', tk.want(order([id('B1')])), true);
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
    T.eq('reply: a good proof: looked up, imported untracked (the tree read once a height), looked up again, checked not relevant, proven', [ran, provenIds], [['coins coinid:' + id('B1'), 'coinimport ' + id('B1'), 'coins coinid:' + id('B1'), 'coins relevant:true coinid:' + id('B1')], [id('B1')]]);
    T.eq('count: every node command the Taker runs is counted (the page puts them in the verdict cache\'s budget)', counted, 3 + 4);
    ran = [];
    tk.reply(MAKER, (function () { var m = {}; m[id('B1')] = good(id('B1')); return m; })());
    T.eq('reply: a coin the node already sees is not imported (it would become relevant)', ran, ['coins coinid:' + id('B1')]);
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
    T.eq('M3: one block further under the root is imported (the tree read once a height)', ran, ['coins coinid:' + id('F3'), 'coinimport ' + id('F3'), 'coins coinid:' + id('F3'), 'coins relevant:true coinid:' + id('F3')]);
    tk.onBlock(151); STATUS = null; ran = [];
    tk.want(order([id('F4')])); tk.reply(MAKER, one(id('F4')));
    T.eq('M3: the tree cannot be read: nothing imported', ran, ['coins coinid:' + id('F4'), 'status']);
    STATUS = { chain: { block: '1000', length: '500' } }; ran = [];
    var NOBLK = {}; NOBLK[id('F5')] = good(id('F5')).slice(0, 160);
    tk.want(order([id('F5')])); tk.reply(MAKER, NOBLK);
    T.eq('M3: a proof whose created block cannot be read is never imported', ran.filter(function (r) { return r.indexOf('coinimport') === 0; }), []);
    ran = []; lines = []; RELEVANT[id('F6')] = true;
    tk.want(order([id('F6')])); tk.reply(MAKER, one(id('F6')));
    T.eq('M3: a coin that came back relevant anyway (another page imported it at the same moment) is untracked again', [ran.slice(-2), RELEVANT[id('F6')], lines], [['coins relevant:true coinid:' + id('F6'), 'cointrack enable:false coinid:' + id('F6')], undefined,
        ['Coin ' + id('F6') + ' of maker ' + MAKER + ' became one of this node\'s own coins on import: untracked again (it is not yours).']]);
    // the import budget: at most IMPORTS_PER_BLOCK a height, the rest asked again later
    tk.onBlock(200); ran = []; var many2 = {}, o2 = [];
    for (i = 0; i < 20; i++) { var cc = '0x' + ('00' + i.toString(16)).slice(-2).toUpperCase().repeat(32); o2.push(cc); }
    tk.want(order(o2)); o2.forEach(function (c) { many2[c] = good(c); });
    tk.reply(MAKER, many2);
    T.eq('reply: at most IMPORTS_PER_BLOCK imports a height', ran.filter(function (r) { return r.indexOf('coinimport') === 0; }).length, P.IMPORTS_PER_BLOCK);
})();
