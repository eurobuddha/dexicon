// P0-c Node runner: load the vendored crypto stack in service.js order into ONE shared global, then sign.
// Usage: node spikes/ed25519/run_node.js > spikes/ed25519/vector.json
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const here = __dirname, V = p => path.join(here, 'vendor', p);
const ctx = vm.createContext({ console, print: undefined, Uint8Array, Int32Array, Float64Array, ArrayBuffer, DataView, Math, JSON, Object, Array, Error, TypeError, RangeError, Number, String, Boolean, parseInt, encodeURIComponent, decodeURIComponent, globalThis: undefined });
ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
const order = ['rhino_shim.js', 'nacl.js', 'blake.js', 'sha256.js', 'sha512.js', 'hex.js', 'ax_sodium.js', 'identity.js'];
for (const f of order) vm.runInContext(fs.readFileSync(V(f), 'utf8'), ctx, { filename: f });
vm.runInContext(fs.readFileSync(path.join(here, 'sign_envelope.js'), 'utf8'), ctx, { filename: 'sign_envelope.js' });
