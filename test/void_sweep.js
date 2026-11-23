/* Review 7 Nov (M-1): the service voids a stale take only while the page is closed, and only by spending MY coin back
 * to me once it is unspent everywhere. Runs the real voidSweep/voidOne from service.js, with the real void rules of
 * lib/maker.js (0.0.180: voidOf / voidCheck / voidRelocked), against a stand-in node: a spent coin is never returned, an
 * output id is hash(first input, n), a null tip answers `block` with an error and every `coins` with []. */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(ROOT + '/service.js', 'utf8');
const block = src.slice(src.indexOf('/** 0.0.158 (review, MAJOR): a null-prototype map'), src.indexOf('function logOnce(')) + src.slice(src.indexOf('var VOID_AFTER_MS'), src.indexOf('/** Auto-cross'));
// the real lib/maker.js (with lib/fill.js and SHA3 for the output ids) in its own context; relock is the stub's
const lib = vm.createContext({ Uint8Array, Array, Object, Math, Date, JSON, Error, String, Number, parseInt, isNaN, isFinite, RegExp });
lib.globalThis = lib;
['vendor/decimal.js', 'lib/hex.js', 'lib/fill.js', 'lib/maker.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), lib, { filename: f }));
vm.runInContext(fs.readFileSync(path.join(ROOT, 'doors/sha3.js'), 'utf8') + '\n;globalThis.AXSHA3 = AXSHA3;', lib);
const M = lib.AX.maker, F = lib.AX.fill;
function run(state) {
    const kv = Object.assign({}, state.kv), relocked = [], logs = [];
    const mds = { kvGet: (k, d, cb) => cb(kv[k] === undefined ? d : kv[k]), kvSet: (k, v, cb) => { kv[k] = v; cb && cb(); },
        cmdR: (c, cb) => {
            if (c === 'block') return state.tipNull ? cb(new Error('cmd failed: block')) : cb(null, { block: String(state.tip || 2000) });
            let m = /^coins relevant:true (checkmempool:true )?coinid:(0x[0-9A-Fa-f]{64})$/.exec(c);
            if (m) {
                if (state.tipNull) return cb(null, []);
                const row = (state.chain || {})[m[2]] || (m[2] === state.coin && !state.spentOnChain ? { coinid: state.coin, address: '0xME', tokenid: '0x00', amount: '7' } : null);
                return cb(null, !row || (m[1] && state.inMempool && m[2] === state.coin) ? [] : [row]);
            }
            if (c === 'getaddress') return cb(null, { address: '0xME' });
            cb(null, {});
        } };
    const maker = Object.assign({}, M, { relock: (m, coins, to, cb) => { relocked.push(coins.map((x) => x.coinid).join('+') + '>' + to); cb(state.relockErr || null, state.relockErr ? null : '0x' + 'e7'.repeat(32), coins.map((x) => x.coinid)); } });
    const ctx = { Date, JSON, Object, String, Number, logs, log: (s) => logs.push(s), AX: { mds, maker } };
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
assert(JSON.parse(r.kv.void_takes).o1, 'a posted relock keeps the record until the spend is on chain');
assert.deepStrictEqual(r.logs, ['void o1: relock of ' + COIN + ' posted in txpow 0x' + 'e7'.repeat(32) + '; settles when it is on chain'], '0.0.157: the relock\'s txpowid is logged');
const RL = JSON.parse(r.kv.void_takes).o1.rl;
assert.strictEqual(RL.id, F.outputCoinId(COIN, 0), '0.0.180: the relock\'s own output is kept as the void\'s evidence');
r = run({ kv: { ui_alive: '0', pending_takes: pending }, coin: COIN, relockErr: new Error('txnsign: the node is locked') });
assert.deepStrictEqual(r.logs, ['void o1: relock of ' + COIN + ' — txnsign: the node is locked; retried on a later sweep'], '0.0.157: a failed relock is logged, never silent');
// 0.0.180 (review, MAJOR 2): a NULL tip (resync, megammrsync, restore) answers `coins` with [] — it used to close the void as
// "settled", and the maker kept my signed half as a free option
r = run({ kv: { ui_alive: '0', void_takes: JSON.stringify({ o1: { mine: [COIN] } }) }, coin: COIN, tipNull: true });
assert(JSON.parse(r.kv.void_takes).o1, '0.0.180: a null tip never settles a void');
r = run({ kv: { ui_alive: '0', void_takes: JSON.stringify({ o1: { mine: [COIN], block: 2500 } }) }, coin: COIN, spentOnChain: true, tip: 2400 });
assert(JSON.parse(r.kv.void_takes).o1, '0.0.180: a tip below the take\'s block never settles it');
// spent at a known tip, but no evidence: the record waits (spentAt) until it has stayed spent VOID_SPENT_BLOCKS
r = run({ kv: { ui_alive: '0', void_takes: JSON.stringify({ o1: { mine: [COIN] } }) }, coin: COIN, spentOnChain: true, tip: 2000 });
assert.strictEqual(JSON.parse(r.kv.void_takes).o1.spentAt, 2000, '0.0.180: spent without evidence: noted, not settled');
r = run({ kv: { ui_alive: '0', void_takes: JSON.stringify({ o1: { mine: [COIN], spentAt: 2000 } }) }, coin: COIN, spentOnChain: true, tip: 2000 + M.VOID_SPENT_BLOCKS });
assert.strictEqual(JSON.parse(r.kv.void_takes).o1, undefined, '0.0.180: ... settled once it stayed spent ' + M.VOID_SPENT_BLOCKS + ' blocks');
// positive evidence: the relock's own output on chain (mine, same token and amount) settles it at once
const chain = {}; chain[RL.id] = { coinid: RL.id, address: '0xME', tokenid: '0x00', amount: '7' };
r = run({ kv: { ui_alive: '0', void_takes: JSON.stringify({ o1: { mine: [COIN], probe: COIN, relocked: true, rl: RL } }) }, coin: COIN, spentOnChain: true, chain });
assert.strictEqual(JSON.parse(r.kv.void_takes).o1, undefined, '0.0.180: the relock\'s output on chain settles the void');
assert.ok(/was spent back to you \(coin 0x/.test(r.logs[0]), r.logs[0]);
r = run({ kv: { ui_alive: '0', pending_takes: pending }, coin: COIN, inMempool: true });
assert.deepStrictEqual(r.relocked, [], 'a mempool-only spend is looked at again later, never relocked over');
assert(JSON.parse(r.kv.void_takes).o1, 'and stays recorded');
r = run({ kv: { ui_alive: '0', pending_takes: JSON.stringify({ o2: { sent: Date.now(), mine: [COIN] } }) }, coin: COIN });
assert.deepStrictEqual(r.relocked, [], 'a fresh take is left alone');
console.log('VOID SWEEP PASS');
