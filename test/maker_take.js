/* maker_take.js — service.js handleTake, run against stubs: what a co-signed take leaves for the bookkeeping.
 * 0.0.145: the fill_ record carries `verified` (the remaining the take was checked against; reconcileFills uses it). */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
const part = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const TX = '0x' + 'D4'.repeat(32), kv = {}, fills = [];
const ctx = { JSON, Date, Math, String, Object, Error,
  RELAY: {}, ME: {}, log: () => {}, notify: () => {}, reply: () => {}, nowS: () => 1800000000,
  AX: { mds: { kvSet: (k, v, cb) => { kv[k] = v; cb(null); }, cmdR: (c, cb) => c === 'block' ? cb(null, { block: '2400123' }) : cb(new Error('unexpected ' + c)) },
        maker: { load: (m, cb) => cb(null, [{ orderId: '0x0101010101010101', side: 'sell', price: '0.1', address: '0xAD', coins: ['0xC1'], scripts: [], remaining: '100', status: 'live' }]),
                 find: (l, id) => l.find((o) => o.orderId === id) || null,
                 afterFill: function () { fills.push(Array.prototype.slice.call(arguments, 3)); arguments[6](null); } },
        fill: { signKeys: () => [], verifyAsMaker: () => ({ ok: true }),
                cosign: (m, txn, keys, verify, done) => { verify({ inputs: [{ coinid: '0xC1' }] }, []); done(null, TX, { filled: '40', received: '4', paid: '40' }, ['0xOUT']); } } } };
vm.createContext(ctx);
vm.runInContext('var coinLocks = {}, LOCK_MS = 180000;\n' + part('/** 0.0.158 (review, MAJOR): a null-prototype map', 'function logOnce(') + part('function lockCoins(', 'function tick(') + part('function handleTake(', '\n/** ASSETS'), ctx);
let next = 0;
vm.runInContext("handleTake({ _from: '0x" + '77'.repeat(64) + "', txn: '0xAB', orderId: '0x0101010101010101' }, NEXT)", Object.assign(ctx, { NEXT: () => next++ }));
const rec = JSON.parse(kv['fill_' + TX]);
assert.strictEqual(next, 1, 'the take is done once');
assert.strictEqual(rec.verified, '100', '0.0.145: the fill record keeps the remaining the take was checked against');
assert.deepStrictEqual([rec.role, rec.orderId, rec.filled, rec.txpowid], ['maker', '0x0101010101010101', '40', TX], 'the fill record');
assert.strictEqual(JSON.stringify([fills[0][0], fills[0][1], fills[0][2], fills[0][4], fills[0][5]]), JSON.stringify(['0x0101010101010101', '40', ['0xC1'], TX, '100']), 'afterFill gets the order, filled, spent coins, the txpowid and the checked remaining');
// 0.0.161 (review, MAJOR — phantom fills): the fill is PROVISIONAL: its record carries my spent coins and the post height,
// and afterFill is told so (it keeps a provisional entry on the order until settleFills sees it mined or never mined)
assert.strictEqual(JSON.stringify([rec.prov, rec.ins, rec.postBlock, rec.status]), JSON.stringify([true, ['0xC1'], 2400123, 'settling']), '0.0.161: a provisional record');
assert.strictEqual(JSON.stringify(fills[0][6]), JSON.stringify({ b: 2400123 }), '0.0.161: afterFill gets the provisional mark');
console.log('MAKER TAKE PASS');
