/**
 * P0-c — canonicalise and Ed25519-sign a Decks order envelope (SPEC §3) with the AtomiX sodium stack.
 * Runs under Node AND under Rhino 1.7.14 (the node's service.js engine). Prints one JSON line:
 * {signPk, canonical, canonicalHex, sig, envelope} — consumed by Verify.java.
 *
 * Node:  node spikes/ed25519/run_node.js
 * Rhino: java -jar rhino-1.7.14.jar -version 200 -opt -1 <concat of vendor files + this file>
 */
(function (g) {
    'use strict';
    var AX = g.AX, S = AX.sodium, H = AX.hex;

    /** Canonical JSON: sorted keys, no whitespace, "sig" excluded. Amounts are already strings. */
    function canonical(env) {
        var keys = Object.keys(env).filter(function (k) { return k !== 'sig'; }).sort();
        var parts = [];
        for (var i = 0; i < keys.length; i++) {
            parts.push(JSON.stringify(keys[i]) + ':' + JSON.stringify(env[keys[i]]));
        }
        return '{' + parts.join(',') + '}';
    }

    // Deterministic identity for the vector: fixed seed, context "decks" (SPEC §2).
    var me = AX.identity.fromSeed('0x' + '11'.repeat(32), 'decks');

    var env = {
        v: 1, t: 'order', market: 'MINIMA/MxUSD', side: 'sell',
        price: '0.01234567', amount: '100.5',
        coins: ['0xF19FE115E66277A5785D69CA53BDA431B0D7CDB5B7DB1C4AE8C3CA01558C045F'],
        address: '0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A',
        orderId: '0x0102030405060708', seq: 1, expiry: 1800000000,
        pubId: me.publicId(),                      // boxPk||signPk — takers seal fills to it
        signPk: '0x' + H.to(me.signPk)
    };
    var canon = canonical(env);
    var msg = H.utf8(canon);
    var sig = S.signDetached(msg, me.signSk);
    env.sig = '0x' + H.to(sig);
    if (!S.signVerify(sig, msg, me.signPk)) throw new Error('self-verify failed');

    var out = { signPk: env.signPk, canonical: canon, canonicalHex: H.to(msg), sig: env.sig, envelope: env };
    g.DECKS_VECTOR = JSON.stringify(out);
    if (typeof print === 'function') print(g.DECKS_VECTOR);           // Rhino shell
    else if (typeof console !== 'undefined') console.log(g.DECKS_VECTOR); // Node
})(typeof globalThis !== 'undefined' ? globalThis : this);
