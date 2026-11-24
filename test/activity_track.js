/* activity_track.js — 0.0.196 (review 8): the ACTIVITY tracker of the page (ui/activity.js), run with the real
 * lib/activity.js, lib/fill.js and lib/maker.js against a stand-in node that models what the real one does: an output
 * coin id is hash(first input, n) for EVERY transaction spending that input; a spent coin is never returned; a node with
 * no chain tip answers `block` with an error and every `coins` with status true and [].
 * A FAST take is "included" only by its OWN payment coin (id, address, token, amount), and an input is "spent" only at a
 * known tip. */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const KV = {}, chain = {}, MINE = '0x' + 'aa'.repeat(32), MAKER = '0x' + 'bb'.repeat(32);
let tip = 5000, tipNull = false;
const ctx = { console, JSON, Math, Object, Array, String, Number, RegExp, Error, Date, parseInt, isNaN, isFinite, Uint8Array, setInterval() { },
    document: { getElementById: () => null }, PD: { state: () => ({ block: 0 }), esc: String },
    MDS: { sql: (q, cb) => cb({ status: true, rows: [] }) } };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
['vendor/decimal.js', 'lib/hex.js', 'doors/sha3.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8') + (f === 'doors/sha3.js' ? '\n;globalThis.AXSHA3 = AXSHA3;' : ''), ctx, { filename: f }));
['lib/fill.js', 'lib/maker.js', 'lib/activity.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
ctx.AX.mds = { kvGet: (k, d, cb) => cb(KV[k] === undefined ? d : KV[k]), kvSet: (k, v, cb) => { KV[k] = v; if (cb) cb(null); },
    cmdR: (c, cb) => {
        if (c === 'block') return tipNull ? cb(new Error('cmd failed: block — no tip')) : cb(null, { block: String(tip) });
        const m = /^coins (relevant:true )?(checkmempool:true )?coinid:(0x[0-9A-Fa-f]{64})$/.exec(c);
        if (!m) return cb(new Error('unexpected ' + c));
        if (tipNull) return cb(null, []);
        const row = chain[m[3]];
        cb(null, row && (!m[1] || row.address === MINE) ? [Object.assign({}, row)] : []);
    } };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui/activity.js'), 'utf8'), ctx, { filename: 'ui/activity.js' });
const A = ctx.DexiconActivity, F = ctx.AX.fill;
A.boot();
let n = 0;
/** a co-signed FAST take: the maker's coin MC first, then my coin MY; output 0 = 25 MINIMA to me */
function take() {
    const MC = '0x' + ('c' + (++n)).repeat(32), MY = '0x' + ('d' + n).repeat(32), id = 'fast_' + n, pay = { id: F.outputCoinId(MC, 0), k: 0, address: MINE, tokenid: '0x00', amount: '25' };
    chain[MC] = { coinid: MC, address: MAKER, tokenid: '0x00', amount: '60', created: '4900' };
    chain[MY] = { coinid: MY, address: MINE, tokenid: F.MXUSD, amount: '0.000001', tokenamount: '3', created: '4900' };
    A.record({ id, route: 'FAST', role: 'taker', side: 'buy', amount: '25', price: '0.1', orderId: '0x' + '01'.repeat(8), ins: [MC, MY], mine: [MY], pay, outs: [pay.id], stage: 'COSIGNED', postBlock: tip, ts: Date.now() });
    return { MC, MY, id, pay };
}
const row = (id) => JSON.parse(KV.activity).filter((r) => r.id === id)[0];

// 1. the maker RELOCKS its coin instead (the take never mines): the relock's output 0 sits at the take's payment id — not mine
let t = take();
delete chain[t.MC]; chain[t.pay.id] = { coinid: t.pay.id, address: MAKER, tokenid: '0x00', amount: '60', created: String(tip + 1) };
tip += 2; A.track();
assert.ok(!Number(row(t.id).block), '0.0.196: another transaction\'s output at the payment id does not "include" the trade (it read: in block ' + row(t.id).block + ')');

// 2. a node with NO chain tip answers every `coins` with []: nothing is "spent", nothing is dropped
t = take(); tipNull = true; A.track(); tipNull = false;
assert.notStrictEqual(row(t.id).stage, 'DROPPED', '0.0.196: an empty answer of a node with no tip is not "an input was spent" (it read DROPPED: ' + row(t.id).reason + ')');

// 3. the take mines: its OWN payment (id, my address, token, amount) → in block
delete chain[t.MC]; delete chain[t.MY]; chain[t.pay.id] = { coinid: t.pay.id, address: MINE, tokenid: '0x00', amount: '25', created: String(tip + 1) };
tip += 2; A.track();
assert.strictEqual(Number(row(t.id).block), tip - 1, '0.0.196: the take\'s own payment coin puts it in its block');

// 4. my coin spent by another transaction at a known tip, no payment → dropped, said
t = take(); delete chain[t.MY]; tip += 1; A.track();
assert.deepStrictEqual([row(t.id).stage, row(t.id).reason], ['DROPPED', 'an input was spent by another transaction'], '0.0.196: my coin spent elsewhere at a known tip drops the row');
console.log('ACTIVITY TRACK PASS');
