/* takesize.test.js — 0.0.164 (review, MINOR): a take is ONE sealed message of at most 256 KiB. The transaction limit is
   proven against the real seal, the taker refuses a take that would not fit BEFORE signing (measured unsigned + a bound
   per signature), and an order is backed by at most 8 coins so a take of all of it fits. */
(function () {
    var F = AX.fill, E = AX.envelope, M = AX.maker;
    var me = AX.identity.fromSeed('0x' + '22'.repeat(32), 'decks'), to = AX.identity.fromSeed('0x' + '33'.repeat(32), 'decks').publicId();
    function sealedLen(bytes) {
        var inner = JSON.stringify({ k: 'take', orderId: '0x' + '01'.repeat(8), txn: '0x' + 'ab'.repeat(bytes), taker: me.publicId() });
        var raw = E.msg(me, to, AX.identity.seal(me, to, AX.hex.utf8(inner)), Math.floor(Date.now() / 1000) + 300);
        return { len: raw.length, ok: E.verify(raw, Math.floor(Date.now() / 1000)).ok };
    }
    var at = sealedLen(F.MAX_TAKE_TXN_BYTES), over = sealedLen(F.MAX_TAKE_TXN_BYTES + 1000);
    T.ok('0.0.164: a take of MAX_TAKE_TXN_BYTES seals under the relays\' limit (' + at.len + ' chars)', at.ok && at.len <= E.MAX_MSG_BYTES);
    T.ok('0.0.164: ... and the limit is tight (' + over.len + ' chars for 1000 bytes more)', !over.ok);

    // the taker's build: measured before any txnsign
    var MYPK = '0x' + 'd1'.repeat(32), TADDR = '0x' + 'ee'.repeat(32), unsigned = 0, sent = [];
    var mds = { cmd: function (c, cb) { sent.push(c); cb({ status: true }); }, cmdR: function (c, cb) {
        sent.push(c);
        if (c === 'scripts') return cb(null, [{ address: TADDR, script: 'RETURN SIGNEDBY(' + MYPK + ')', simple: true, publickey: MYPK }]);
        if (/^txnexport/.test(c)) return cb(null, { data: '0x' + 'ab'.repeat(sent.some(function (x) { return /^txnsign/.test(x); }) ? unsigned + F.SIG_BYTES : unsigned) });
        cb(null, {});
    } };
    var p = { inputs: ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32)], outputs: [], scripts: [], makerAddrs: ['0x' + 'cc'.repeat(32)], takerAddrs: [TADDR] }, err = null, hex = null;
    unsigned = F.MAX_TAKE_TXN_BYTES - F.SIG_BYTES + 1;
    F.build(mds, p, function (e, h) { err = e; hex = h; });
    T.ok('0.0.164: a take that would not fit is refused BEFORE signing (' + (err && err.message) + ')', !!err && /your 1 coins make this take too large to send — consolidate/.test(err.message) && !sent.some(function (x) { return /^txnsign/.test(x); }) && sent.some(function (x) { return /^txndelete/.test(x); }));
    sent.length = 0; unsigned = 2000;
    F.build(mds, p, function (e, h) { err = e; hex = h; });
    T.ok('0.0.164: one that fits is signed and exported', !err && /^0x(ab)+$/.test(hex) && sent.some(function (x) { return /^txnsign/.test(x); }));

    // 0.0.183 (review, MAJOR 4 (d)): my coins older than half my own tree carry their coinexport proofs INSIDE the take, and
    // count against the take's size before anything is signed
    var OLDC = '0x' + '03'.repeat(32), YOUNG = '0x' + '04'.repeat(32), PROOF = '0x00000020' + OLDC.slice(2) + '00000020' + TADDR.slice(2) + '000203EB0000000100010001000000000105000001640001000000' + 'AB'.repeat(800), proofs = null;
    var mdsP = { cmd: mds.cmd, cmdR: function (c, cb) {
        if (c === 'status') { sent.push(c); return cb(null, { chain: { block: '5000', length: '1000' } }); }   // proofs for coins older than 500
        if (c.indexOf('coinexport coinid:') === 0) { sent.push(c); return cb(null, c.split('coinid:')[1] === OLDC ? { data: PROOF } : { data: '0x00' }); }
        mds.cmdR(c, cb);
    } };
    var pP = Object.assign({}, p, { takerIns: [{ coinid: OLDC, created: '4000' }, { coinid: YOUNG, created: '4800' }] });
    sent.length = 0; unsigned = 2000;
    F.build(mdsP, pP, function (e, h, pr) { err = e; hex = h; proofs = pr; });
    T.eq('0.0.183: the take carries the proof of my old coin, never of a young one', [!!err, Object.keys(proofs || {}), sent.filter(function (x) { return /^coinexport/.test(x); })], [false, [OLDC], ['coinexport coinid:' + OLDC]]);
    sent.length = 0; unsigned = F.MAX_TAKE_TXN_BYTES - F.SIG_BYTES - 500;   // fits alone, not with its ~0.9 KB proof
    F.build(mdsP, pP, function (e, h, pr) { err = e; hex = h; proofs = pr; });
    T.ok('0.0.183: the proofs count against the take\'s size, refused BEFORE signing (' + (err && err.message) + ')', !!err && /of them the proofs of your older coins/.test(err.message) && !sent.some(function (x) { return /^txnsign/.test(x); }));

    // 0.0.192 (review 4): a take near the byte limit with MANY proofs. Each proof also costs its JSON wrapping in the sealed
    // message (~296 sealed chars), which was not counted: 32000 bytes with 20 proofs of 708 bytes was signed and then sealed
    // to 263864 chars — over the relays' 262144, never sent. Nothing is signed that cannot be sent: built here by the real
    // F.build, then sealed by the real seal and envelope code
    var P20 = {}, ins20 = [], PB = 708;
    for (i = 0; i < 20; i++) {
        var cid = '0x' + ('b' + (i % 16).toString(16)).repeat(31) + (i < 16 ? '00' : '01'), head = '0x00000020' + cid.slice(2) + '00000020' + TADDR.slice(2) + '000203EB0000000100010001000000000105000001640001000000';
        P20[cid] = head + 'AB'.repeat(PB - (head.length - 2) / 2); ins20.push({ coinid: cid, created: '4000' });
    }
    var mds20 = { cmd: mds.cmd, cmdR: function (c, cb) {
        if (c === 'status') { sent.push(c); return cb(null, { chain: { block: '5000', length: '1000' } }); }
        if (c.indexOf('coinexport coinid:') === 0) { sent.push(c); return cb(null, { data: P20[c.split('coinid:')[1]] }); }
        mds.cmdR(c, cb);
    } };
    function take20(unsignedBytes) {
        var r = { err: null, signed: false, len: 0, fits: false, n: 0 };
        sent.length = 0; unsigned = unsignedBytes;
        F.build(mds20, Object.assign({}, p, { takerIns: ins20 }), function (e, h, pr) {
            r.err = e; r.signed = sent.some(function (x) { return /^txnsign/.test(x); }); r.n = Object.keys(pr || {}).length;
            if (e) return;
            var raw = E.msg(me, to, AX.identity.seal(me, to, AX.hex.utf8(JSON.stringify({ k: 'take', orderId: '0x' + '01'.repeat(8), txn: h, taker: me.publicId(), proofs: pr }))), Math.floor(Date.now() / 1000) + 300);
            r.len = raw.length; r.fits = raw.length <= E.MAX_MSG_BYTES && E.verify(raw, Math.floor(Date.now() / 1000)).ok;
        });
        return r;
    }
    // the review's shape: transaction + signature + proof BYTES = MAX_TAKE_TXN_BYTES exactly
    var t20 = take20(F.MAX_TAKE_TXN_BYTES - F.SIG_BYTES - 20 * PB);
    T.ok('0.0.192: 32000 bytes of take with 20 proofs of 708 bytes: nothing is signed that cannot be sent (signed ' + t20.signed + ', sealed ' + t20.len + ' chars, ' + (t20.err && t20.err.message) + ')',
        t20.err ? !t20.signed && /of them the proofs of your older coins/.test(t20.err.message) : t20.fits);
    // the largest take with 20 proofs that IS signed: sealed for real, it fits
    var room = F.MAX_TAKE_TXN_BYTES - F.SIG_BYTES - 20 * (PB + F.PROOF_JSON_BYTES) - F.PROOFS_JSON_BYTES;
    t20 = take20(room);
    T.ok('0.0.192: a limit-size take with 20 proofs is signed and its sealed message fits the relays\' limit (' + t20.len + ' of ' + E.MAX_MSG_BYTES + ' chars)', !t20.err && t20.signed && t20.n === 20 && t20.fits);
    t20 = take20(room + 1);
    T.ok('0.0.192: ... one byte more is refused before signing', !!t20.err && !t20.signed);

    // maker: at most 8 backing coins an order
    var coins = []; for (var i = 0; i < 10; i++) coins.push({ coinid: '0x' + ('0' + i).repeat(32), address: '0xaa', tokenid: '0x00', amount: '10', created: '1000', state: [] });
    T.eq('0.0.164: 8 coins back an order of 80', M.backing('sell', '0.1', '80', coins, [], 1100, 900).length, 8);
    var why = ''; try { M.placement('sell', '0.1', '90', coins, [], 1100, 900); } catch (e) { why = e.message; }
    T.ok('0.0.164: an order that needs 9 coins is refused: consolidate first (' + why + ')', /in 8 coins: .* consolidate first/.test(why));
    // 0.0.188 (review, MINOR 3): backing() says it plainly — the coins are there, spread over more than 8 (it read "not enough")
    why = ''; try { M.backing('sell', '0.1', '90', coins, [], 1100, 900); } catch (e) { why = e.message; }
    T.ok('0.0.188: an order needing 9 coins: "needs more than 8 coins: consolidate" (' + why + ')', /^needs more than 8 coins: consolidate/.test(why));
    // ... and an order placed before 0.0.164 on 12 coins keeps them at the refresh while they are all there and cover it
    var SC = '0x' + 'cd'.repeat(32), PK = '0x' + 'dd'.repeat(32), kv = {}, pubd = [];
    var w = []; for (i = 0; i < 12; i++) w.push({ coinid: '0x' + ('a' + i.toString(16)).repeat(32), address: SC, tokenid: '0x00', amount: '10', created: '1000', state: [] });
    var mdsR = { kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); }, kvSet: function (k, v, cb) { kv[k] = v; cb && cb(null); }, cmd: function (c, cb) { cb({ status: true }); }, cmdR: function (c, cb) {
        if (c === 'scripts') return cb(null, [{ address: SC, script: 'RETURN SIGNEDBY(' + PK + ')', simple: true, publickey: PK }]);
        if (c === 'keys') return cb(null, { keys: [{ publickey: PK }] });
        if (c === 'block') return cb(null, { block: '1100' });
        if (c === 'getaddress') return cb(null, { address: SC });
        if (/^coins relevant:true checkmempool:true tokenid:/.test(c)) return cb(null, /tokenid:0x00$/.test(c) ? w : []);
        cb(new Error('unexpected ' + c));
    } };
    var OLD = { orderId: '0x' + '0d'.repeat(8), side: 'sell', price: '0.1', amount: '120', remaining: '120', coins: w.map(function (c) { return c.coinid; }), scripts: ['RETURN SIGNEDBY(' + PK + ')'], address: SC, seq: 1, expiry: Math.floor(Date.now() / 1000) + 3000, status: 'live', fillsFrom: 1 };
    kv.myorders = JSON.stringify([OLD]); kv.legacy_fresh = '0';
    M.refresh(mdsR, { relays: ['r'], publish: function (raw, cb) { pubd.push(raw); cb([{ url: 'r', ok: true }]); } }, me, function () { });
    T.eq('0.0.188: an order backed by 12 coins (placed before the 8-coin limit) keeps them at the refresh', JSON.parse(kv.myorders)[0].coins.length, 12);
})();
