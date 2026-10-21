/**
 * Dexicon test harness — loads the vendored globals + app libs into ONE isolated VM context that mimics Rhino
 * (no require/module/process/Buffer/TextEncoder), then runs every test/*.test.js against it.  Run: node test/run.js
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sandbox = {
    Uint8Array, Int8Array, Uint32Array, ArrayBuffer, DataView, Array, Object, Math, Date, JSON, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean, Symbol, Map, Set, BigInt, Function, RegExp, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const FILES = ['lib/rhino_shim.js', 'vendor/nacl.js', 'vendor/blake.js', 'vendor/sha256.js', 'vendor/sha512.js',
               'vendor/decimal.js', 'lib/hex.js', 'lib/flow.js', 'crypto/ax_sodium.js', 'lib/identity.js', 'lib/envelope.js', 'lib/relay.js', 'lib/fill.js', 'lib/maker.js',
               // DOORS: the AtomiX taker engine (doors/, vendored) in service.js load order, then Dexicon's door glue
               'doors/sha3.js', 'doors/elliptic.js', 'doors/ax_eth.js', 'doors/decimal.js', 'doors/abi.js', 'doors/ethhtlc.js', 'doors/trading.js', 'doors/signgate.js',
               'lib/mdsw.js', 'doors/ethrpc.js', 'doors/ethtx.js', 'doors/ethops.js', 'doors/swapdb.js', 'doors/htlc.js', 'doors/order.js', 'doors/boot.js', 'doors/identitywatch.js',
               'doors/settle.js', 'doors/orderbook.js', 'doors/take.js', 'doors/swapplan.js', 'doors/engine.js', 'doors/market.js', 'doors/wallet.js'];
for (const f of FILES) {
    try { vm.runInContext(read(f), ctx, { filename: f }); }
    catch (e) { console.error('LOAD FAILED (Rhino-incompatible?):', f, '\n', e); process.exit(1); }
}
const nodeCrypto = require('crypto');
vm.runInContext('AX.sodium.setPRNG(__fill)', Object.assign(ctx, { __fill: (x, n) => { const b = nodeCrypto.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; } }));
let pass = 0, fail = 0; const fails = [];
sandbox.T = {
    eq: (name, got, want) => { const c = JSON.stringify(got) === JSON.stringify(want); c ? pass++ : (fail++, fails.push(name + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want))); },
    ok: (name, cond) => { cond ? pass++ : (fail++, fails.push(name)); },
    log: (s) => console.log(s)
};
sandbox.VECTOR = JSON.parse(read('spec/vectors/order-v1-vector.json'));
for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.test.js')).sort()) {
    console.log('\n### ' + f);
    try { vm.runInContext(read('test/' + f), ctx, { filename: 'test/' + f }); }
    catch (e) { fail++; fails.push('test file threw: ' + f + ' — ' + e); console.error(e); }
}
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ` — ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n' + fails.join('\n')); process.exit(1); }
