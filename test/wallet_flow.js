/**
 * wallet_flow.js — ui/wallet.js in a stubbed page: a BOOK/POOL LIMIT that fails on funding is recovered by itself
 * (consolidate, or wait for confirmations) and re-sent ONCE; other errors and a second failure are left alone.
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const solo = [], sends = [], notices = [], timers = [];
let bal = { sendable: '8', unconfirmed: '0', coins: 6 };
const ctx = { console, JSON, Math, Date, String, Number, RegExp, Error, Object, Array,
    setTimeout: (f) => timers.push(f), confirm: () => true };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'vendor/decimal.js'), 'utf8'), ctx);
vm.runInContext("PandaDEX = { USDT: '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90', d: function (v) { return new Decimal(v); } };", ctx);
ctx.MDS = { comms: { solo: (m) => solo.push(JSON.parse(m)) },
    cmd: (c, cb) => cb({ status: true, response: [{ tokenid: '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90', sendable: bal.sendable, unconfirmed: bal.unconfirmed, coins: bal.coins }] }) };
ctx.PD = { notice: (m, k) => notices.push(m), send: (t, d) => { sends.push([t, d]); ctx.DexiconWallet.sent(t, d); }, state: () => ({ block: 100 }), bal: () => null };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui/wallet.js'), 'utf8'), ctx);
const W = ctx.DexiconWallet;
const ERR = 'Wallet has 6 coins of this token. Could not select 5.02923798 from at most 8 available, stateless coins. Wait for pending transactions, or consolidate this token in MinimaCore and retry. Nothing was posted by this request.';

assert.strictEqual(W.failed(ERR), false, 'no LIMIT sent yet → not ours');
W.sent('LIMIT', { buy: true, minima: '1372.8', price: '0.003664', gtc: true, minRem: '1' });
assert.strictEqual(W.failed('A transaction is already in flight'), false, 'non-funding error is shown as is');
assert.strictEqual(W.failed(ERR), true, 'funding failure → recovery takes over');
assert.deepStrictEqual(solo.map((p) => p.type), ['CONSOLIDATE'], 'spendable covers it but scattered → consolidate via the service');
assert.strictEqual(solo[0].origin, 'dexicon');
bal = { sendable: '8', unconfirmed: '3', coins: 2 };   // consolidation still confirming
timers.shift()();
assert.strictEqual(sends.length, 0, 'waits while the consolidation confirms');
bal = { sendable: '8', unconfirmed: '0', coins: 1 };
timers.shift()();
assert.strictEqual(sends.length, 1, 'retried once');
assert.strictEqual(sends[0][0], 'LIMIT'); assert.strictEqual(sends[0][1].minima, '1372.8'); assert.strictEqual(sends[0][1]._retry, true);
assert.strictEqual(W.failed(ERR), false, 'the retry failing is NOT retried again');
assert.ok(W.here(ERR).includes('ASSETS › CONSOLIDATE') && !W.here(ERR).includes('MinimaCore'), 'the pointer names ASSETS');

// coins still confirming → wait, no consolidation
solo.length = 0; sends.length = 0; timers.length = 0;
W.sent('LIMIT', { buy: false, minima: '100', price: '0.0037', gtc: true, minRem: '1' });
bal = { sendable: '20', unconfirmed: '90', coins: 3 };
ctx.MDS.cmd = (c, cb) => cb({ status: true, response: [{ tokenid: '0x00', sendable: bal.sendable, unconfirmed: bal.unconfirmed, coins: bal.coins }] });
assert.strictEqual(W.failed(ERR), true);
assert.strictEqual(solo.length, 0, 'MINIMA still confirming → no consolidation');
assert.ok(notices[notices.length - 1].startsWith('Waiting for your MINIMA to confirm'));
bal = { sendable: '110', unconfirmed: '0', coins: 3 };
timers.shift()();
assert.strictEqual(sends.length, 1, 'retried when spendable');
console.log('WALLET FLOW PASS');
