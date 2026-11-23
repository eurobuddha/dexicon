/* held_mirror.js — review 23 Nov (MINOR): service.js mirrorCoinLock mirrors the resting engine's in-memory PandaCoinLock
 * (resting/funding.js, the REAL vendored file) to kv 'coinlock_held', which the page's lib/maker.js holds() reads. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
assert.ok(/mirrorCoinLock\(PandaCoinLock\);/.test(src), 'service.js mirrors PandaCoinLock');
assert.ok(src.indexOf("MDS.load('resting/funding.js')") >= 0 && src.indexOf("MDS.load('resting/funding.js')") < src.indexOf('mirrorCoinLock(PandaCoinLock);'), 'after funding.js is loaded');
const fn = src.slice(src.indexOf('function mirrorCoinLock('), src.indexOf('\nfunction logOnce('));
const kv = {}, ctx = { Date, JSON, String, Object, PandaDEX: {}, PandaSafety: { hex: (x) => /^0x[0-9a-fA-F]+$/.test(x) }, AX: { mds: { kvSet: (k, v, cb) => { kv[k] = v; cb(); } } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../resting/funding.js', 'utf8') + '\n' + fn + '\nmirrorCoinLock(PandaCoinLock);', ctx);
const held = () => Object.keys(JSON.parse(kv.coinlock_held || '{}'));
vm.runInContext("PandaCoinLock.reserve([{ coinid: '0xAA' }, { coinid: '0xBB' }])", ctx);
assert.deepStrictEqual(held(), ['0xaa', '0xbb'], 'a reservation is mirrored');
assert.strictEqual(vm.runInContext("PandaCoinLock.isReserved('0xaa')", ctx), true, 'the vendored lock still works');
vm.runInContext("PandaCoinLock.release([{ coinid: '0xAA' }])", ctx);
assert.deepStrictEqual(held(), ['0xbb'], 'a release is mirrored');
assert.strictEqual(vm.runInContext("PandaCoinLock.claimInputs(['0xCC'])", ctx), true);
assert.deepStrictEqual(held().sort(), ['0xbb', '0xcc'], 'a claimed input is mirrored');
assert.strictEqual(vm.runInContext("PandaCoinLock.claimInputs(['0xCC'])", ctx), false, 'a refused claim');
vm.runInContext("PandaCoinLock.finishInputs(['0xCC'])", ctx);
assert.ok(JSON.parse(kv.coinlock_held)['0xcc'] > Date.now(), 'a finished input stays held for the reservation time');
console.log('HELD MIRROR PASS');
