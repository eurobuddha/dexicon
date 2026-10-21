/* envelope.test.js — byte-identity with the reference vector + the relay's shape rules. Runs inside test/run.js. */
(function () {
    var E = AX.envelope, H = AX.hex;
    var me = AX.identity.fromSeed('0x' + '11'.repeat(32), 'decks');
    var NOW = 1800000000 - 3600;
    var v = VECTOR.envelope;

    // 1. Canonical + signature reproduce the reference vector exactly (Ed25519 is deterministic).
    var fields = { v: 1, t: 'order', market: v.market, side: v.side, price: v.price, amount: v.amount, coins: v.coins,
                   address: v.address, orderId: v.orderId, seq: v.seq, expiry: v.expiry, pubId: v.pubId, signPk: v.signPk };
    T.eq('signPk matches vector', '0x' + H.to(me.signPk), VECTOR.signPk);
    T.eq('canonical matches vector', E.canonical(fields), VECTOR.canonical);
    var signed = E.order(me, { market: v.market, side: v.side, price: v.price, amount: v.amount, coins: v.coins,
                               address: v.address, orderId: v.orderId, seq: v.seq, expiry: v.expiry });
    T.eq('sig matches vector', JSON.parse(signed).sig, VECTOR.sig);

    // 2. verify accepts the vector and reports the key.
    var ok = E.verify(signed, NOW);
    T.ok('vector verifies', ok.ok && ok.kind === 'order');
    T.eq('key', ok.key, VECTOR.signPk.toLowerCase() + '|' + v.orderId.toLowerCase());

    // 3. Rejections, shape before signature (same messages as Envelope.java).
    function rej(name, raw, now, want) { var r = E.verify(raw, now === undefined ? NOW : now); T.ok(name + ' rejected', !r.ok); if (want) T.eq(name + ' reason', r.error, want); }
    var sigHead = VECTOR.sig.slice(0, 10), flipped = sigHead.slice(0, 9) + (sigHead[9] === 'a' ? 'b' : 'a');
    rej('forged', signed.replace(sigHead, flipped), NOW, 'bad signature');
    rej('pubId not matching signPk', signed.replace(v.pubId, '0x' + '00'.repeat(64)), NOW, 'pubId must end with signPk');
    rej('expired', signed, 1800000000 + 1, 'expired');
    rej('too far ahead', signed, NOW - 2 * 86400, 'expiry too far ahead');
    rej('bad side', signed.replace('"side":"sell"', '"side":"short"'), NOW, 'side must be buy or sell');
    rej('9dp price', signed.replace('"price":"0.01234567"', '"price":"0.123456789"'), NOW, 'bad price');
    rej('extra key', signed.replace('"v":1', '"v":1,"x":1'), NOW, 'keys must be exactly the spec set');
    rej('wrong v', signed.replace('"v":1', '"v":2'), NOW, 'v must be 1');
    rej('neg seq', signed.replace('"seq":1', '"seq":-1'), NOW, 'seq must be a non-negative integer');
    rej('not json', 'nope', NOW, 'bad json');

    // 4. Cancel + msg envelopes round-trip through verify.
    var cancel = E.order(me, { market: v.market, side: 'sell', price: '0.5', amount: '0', coins: [], address: v.address, orderId: v.orderId, seq: 2, expiry: NOW + 60 });
    var c = E.verify(cancel, NOW);
    T.ok('cancel verifies', c.ok && E.isCancelAmount(c.env.amount));
    var other = AX.identity.fromSeed('0x' + '22'.repeat(32), 'decks');
    var blob = AX.identity.seal(me, other.publicId(), H.utf8('{"k":"take"}'));
    var m = E.msg(me, other.publicId(), blob, NOW + 300);
    var mv = E.verify(m, NOW);
    T.ok('msg verifies', mv.ok && mv.kind === 'msg');
    var opened = AX.identity.open(other, mv.env.blob);
    T.ok('recipient opens the sealed blob', !!opened && opened.valid && H.utf8Decode(opened.plaintext) === '{"k":"take"}');
    T.ok('third party cannot open it', !AX.identity.open(AX.identity.fromSeed('0x' + '33'.repeat(32), 'decks'), mv.env.blob));
    rej('msg to wrong length', m.replace(other.publicId(), '0x00'), NOW, 'bad to (publicId = 0x + 64 bytes)');
    rej('msg too far ahead', E.msg(me, other.publicId(), blob, NOW + 601), NOW, 'expiry too far ahead');

    // 5. Canonical refuses the forbidden subset.
    function thr(name, fn) { var t = false; try { fn(); } catch (e) { t = true; } T.ok(name, t); }
    thr('float refused', function () { E.canonical({ a: 1.5 }); });
    thr('nested object refused', function () { E.canonical({ a: { b: 1 } }); });
    thr('quote refused', function () { E.canonical({ a: 'x"y' }); });
    thr('non-ascii refused', function () { E.canonical({ a: 'é' }); });
})();
