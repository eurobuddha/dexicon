/* 0.0.102: an order placed or edited on coins being refreshed is published coinless; the service re-backs it on the next
 * block (NEWBLOCK), not at the minute's refresh, and a relock failure the refresh returns is logged, never swallowed.
 * Runs the real refreshed/rebackOnBlock from service.js against stubs. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
const block = src.slice(src.indexOf('function refreshed('), src.indexOf('/** Review 7 Nov (M-1'));
assert.ok(/msg\.event === 'NEWBLOCK' && READY\) rebackOnBlock\(\)/.test(src), 'NEWBLOCK is wired to rebackOnBlock');
assert.ok(/AX\.maker\.refresh\(AX\.mds, RELAY, ME, refreshed\)/.test(src.slice(src.indexOf('function tick('))), 'the tick refresh logs through refreshed()');
function run(list, relockErrs) {
    const logs = [], calls = [];
    const ctx = { RELAY: {}, ME: {}, log: (s) => logs.push(s), AX: { mds: {}, maker: {
        load: (m, cb) => cb(null, list),
        awaitingBacking: (l) => l.some((o) => o.status === 'live' && !(o.coins || []).length),
        refresh: (m, r, me, cb) => { calls.push('refresh'); cb(null, 1, null, relockErrs || []); } } } };
    vm.createContext(ctx); vm.runInContext(block + '\nrebackOnBlock();', ctx);
    return { logs, calls };
}
let r = run([{ status: 'live', coins: ['0x01'] }, { status: 'cancelled', coins: [] }]);
assert.deepStrictEqual(r.calls, [], 'every live order backed: a block runs nothing');
r = run([{ status: 'live', coins: ['0x01'] }, { status: 'live', coins: [], relocking: ['0x02'] }]);
assert.deepStrictEqual(r.calls, ['refresh'], 'a coinless live order: the block re-backs it at once');
r = run([{ status: 'live', coins: [] }], ['relock of 0x02 failed: txnsign: the node is locked']);
assert.ok(r.logs.some((l) => l === 'refresh: relock of 0x02 failed: txnsign: the node is locked — the order stays coinless; the relock is retried after a backoff (2 blocks, doubling to 64)'), r.logs.join('\n'));
console.log('REBACK BLOCK PASS');
