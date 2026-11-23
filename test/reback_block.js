/* 0.0.102: an order placed or edited on coins being refreshed is published coinless; the service re-backs it on the next
 * block (NEWBLOCK), not at the minute's refresh, and a relock failure the refresh returns is logged, never swallowed.
 * Runs the real refreshed/rebackOnBlock from service.js against stubs. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
const block = src.slice(src.indexOf('function refreshed('), src.indexOf('/** Review 7 Nov (M-1'));
assert.ok(/msg\.event === 'NEWBLOCK' && READY\) rebackOnBlock\(\)/.test(src), 'NEWBLOCK is wired to rebackOnBlock');
assert.ok(/ticks % REFRESH_EVERY_TICKS === 0\) runRefresh\(\);/.test(src.slice(src.indexOf('function tick('))), 'the tick refreshes through runRefresh() (one at a time, logged by refreshed())');
function run(list, relockErrs, blocks, hold) {
    const logs = [], calls = [], held = [];
    const ctx = { RELAY: {}, ME: {}, Date, log: (s) => logs.push(s), AX: { mds: {}, maker: {
        load: (m, cb) => cb(null, list),
        awaitingBacking: (l) => l.some((o) => o.status === 'live' && !(o.coins || []).length && (o.relocking || []).length > 0),   // lib/maker.js, tested in maker.test.js
        refresh: (m, r, me, cb) => { calls.push('refresh'); const done = () => cb(null, 1, null, relockErrs || []); if (hold) held.push(done); else done(); } } } };
    vm.createContext(ctx); vm.runInContext(block + '\nfor (var b = 0; b < ' + (blocks || 1) + '; b++) rebackOnBlock();', ctx);
    return { logs, calls, held, ctx };
}
let r = run([{ status: 'live', coins: ['0x01'] }, { status: 'cancelled', coins: [] }]);
assert.deepStrictEqual(r.calls, [], 'every live order backed: a block runs nothing');
r = run([{ status: 'live', coins: ['0x01'] }, { status: 'live', coins: [], relocking: ['0x02'] }]);
assert.deepStrictEqual(r.calls, ['refresh'], 'a coinless live order: the block re-backs it at once');
r = run([{ status: 'live', coins: [], relocking: ['0x02'] }], ['relock of 0x02 failed: txnsign: the node is locked']);
assert.ok(r.logs.some((l) => l === 'refresh: relock of 0x02 failed: txnsign: the node is locked — the order stays coinless; the relock is retried after a backoff (2 blocks, doubling to 64)'), r.logs.join('\n'));
// 0.0.109 (review 22 Nov, MINOR 5): a block never starts a refresh while one is running
r = run([{ status: 'live', coins: [], relocking: ['0x02'] }], [], 3, true);
assert.deepStrictEqual(r.calls, ['refresh'], 'three blocks during one running refresh start no second one');
r.held[0](); vm.runInContext('rebackOnBlock();', r.ctx);
assert.deepStrictEqual(r.calls, ['refresh', 'refresh'], 'once it called back, the next block refreshes again');
console.log('REBACK BLOCK PASS');
