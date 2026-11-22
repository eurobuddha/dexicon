/* 0.0.111: the maker's service answers a taker's coin proof request ({k:'proofs?'}) with a sealed {k:'proofs'} reply of
 * `coinexport` data for the asked coins that back its live orders. Runs the real answerProofs from service.js and the real
 * lib/proofs.js against stubs, and checks the tick routes requests there (one per sender, after the takes). */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
assert.ok(/MDS\.load\('lib\/proofs\.js'\)/.test(src), 'service.js loads lib/proofs.js');
const tick = src.slice(src.indexOf('function tick('), src.indexOf('function refreshed('));
assert.ok(/inner\.k === 'proofs\?' && opened\.fromPublicId && asks\.length < 16 && !askers\[opened\.fromPublicId\]/.test(tick), 'the tick collects proof requests: one per sender, 16 per poll');
assert.ok(/processTakes\(takes, function \(\) \{ answerProofs\(asks, function \(\) \{/.test(tick), 'takes are answered first, then proof requests');
const block = src.slice(src.indexOf('function answerProofs('), src.indexOf('function processTakes('));
const id = (b) => '0x' + b.repeat(32), ADDR = id('AD'), TAKER = '0x' + '77'.repeat(64);
const proof = (c) => ('0x00000020' + c.slice(2) + '00000020' + ADDR.slice(2) + '0123456789ABCDEF'.repeat(60)).slice(0, 900);
const replies = [], logs = [], cmds = [];
const ctx = { log: (s) => logs.push(s), reply: (to, obj) => replies.push({ to, obj }), Object, JSON, String, parseInt, Error };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../lib/proofs.js', 'utf8'), ctx);
ctx.AX.mds = { cmdR: (c, cb) => { cmds.push(c); if (c === 'block') return cb(null, { block: '77' }); const m = /^coinexport coinid:(0x[0-9A-F]{64})$/.exec(c); return m ? cb(null, { data: proof(m[1]) }) : cb(new Error('unexpected ' + c)); } };
ctx.AX.maker = { load: (m, cb) => cb(null, [{ orderId: 'o1', status: 'live', coins: [id('A1')] }, { orderId: 'o2', status: 'filled', coins: [id('B1')] }]) };
vm.runInContext(block, ctx);
let done = 0;
vm.runInContext('answerProofs([], function () { DONE(); })', Object.assign(ctx, { DONE: () => done++ }));
assert.strictEqual(done, 1); assert.deepStrictEqual(cmds, [], 'no request: no node command');
ctx.ASKS = [{ from: TAKER, coins: [id('A1'), id('B1')] }];
vm.runInContext('answerProofs(ASKS, function () { DONE(); })', ctx);
assert.strictEqual(done, 2);
assert.deepStrictEqual(cmds, ['block', 'coinexport coinid:' + id('A1')], 'only the live order\'s coin is exported');
assert.strictEqual(JSON.stringify(replies), JSON.stringify([{ to: TAKER, obj: { k: 'proofs', proofs: { [id('A1')]: proof(id('A1')) } } }]), 'one sealed reply to the asker');
assert.ok(logs[0] === 'coin proofs sent to ' + TAKER + ': ' + id('A1'), logs.join('\n'));
console.log('PROOF SERVICE PASS');
