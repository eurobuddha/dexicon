/* Review 7 Nov (M-1): the service voids a stale take only while the page is closed, and only by spending MY coin back
 * to me once it is unspent everywhere. Runs the real voidSweep/voidOne from service.js against a stub node. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
const block = src.slice(src.indexOf('var VOID_AFTER_MS'), src.indexOf('/** Auto-cross'));
function run(state) {
    const kv = Object.assign({}, state.kv), relocked = [], logs = [];
    const ctx = { Date, JSON, Object, String, Number, logs, log: (s) => logs.push(s), AX: {
        mds: { kvGet: (k, d, cb) => cb(kv[k] === undefined ? d : kv[k]), kvSet: (k, v, cb) => { kv[k] = v; cb && cb(); },
            cmdR: (c, cb) => {
                if (/^coins relevant:true checkmempool:true coinid:/.test(c)) return cb(null, state.inMempool ? [] : [{ coinid: state.coin }]);
                if (/^coins relevant:true coinid:/.test(c)) return cb(null, state.spentOnChain ? [] : [{ coinid: state.coin }]);
                if (c === 'getaddress') return cb(null, { address: '0xME' });
                cb(null, {});
            } },
        maker: { relock: (m, coins, to, cb) => { relocked.push(coins[0].coinid + '>' + to); cb(null); } } } };
    vm.createContext(ctx); vm.runInContext(block + '\nvoidSweep();', ctx);
    return { kv, relocked, logs };
}
const COIN = '0x' + 'ab'.repeat(32), old = Date.now() - 10 * 60000;
const pending = JSON.stringify({ o1: { sent: old, mine: [COIN], taken: true } });
let r = run({ kv: { ui_alive: String(Date.now()), pending_takes: pending }, coin: COIN });
assert.deepStrictEqual(r.relocked, [], 'the open page owns its takes');
r = run({ kv: { ui_alive: '0', pending_takes: pending }, coin: COIN });
assert.deepStrictEqual(r.relocked, [COIN + '>0xME'], 'page closed: a stale take (even one answered "taken") is voided');
assert.strictEqual(JSON.parse(r.kv.pending_takes).o1, undefined);
assert.strictEqual(JSON.parse(r.kv.void_takes).o1, undefined, 'settled void is removed');
r = run({ kv: { ui_alive: '0', pending_takes: pending }, coin: COIN, inMempool: true });
assert.deepStrictEqual(r.relocked, [], 'a mempool-only spend is looked at again later, never relocked over');
assert(JSON.parse(r.kv.void_takes).o1, 'and stays recorded');
r = run({ kv: { ui_alive: '0', pending_takes: JSON.stringify({ o2: { sent: Date.now(), mine: [COIN] } }) }, coin: COIN });
assert.deepStrictEqual(r.relocked, [], 'a fresh take is left alone');
console.log('VOID SWEEP PASS');
