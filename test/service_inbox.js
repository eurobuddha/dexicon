/* service_inbox.js — service.js tick()'s inbox pass, run against stubs (0.0.158, review MAJOR): one sealed message that
 * throws is skipped, never the rest of the poll; a take naming an order id a plain object inherits ('constructor',
 * '__proto__') or any non order id is dropped; the per-sender limits still count. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
const part = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const OK = '0x' + '0a'.repeat(8), A = '0x' + '11'.repeat(64), B = '0x' + '22'.repeat(64);
const take = (from, orderId) => ({ env: { blob: JSON.stringify({ f: from, p: { k: 'take', orderId, txn: '0xAB' } }) } });
const msgs = [null, { env: { blob: 'THROW' } }, take(A, 'constructor'), take(A, '__proto__'), take(A, 'toString'), take(A, 42),
    { env: { blob: JSON.stringify({ f: A, p: null }) } }, take(B, OK), take(A, OK)];
let takes = null, logs = [];
const ctx = { JSON, Object, String, Math, Error, Date,
    READY: true, ticks: 0, HOLD_SECONDS: 8, REFRESH_EVERY_TICKS: 6, ME: { publicId: () => 'me' },
    RELAY: { relays: ['r'], pollInbox: (pk, hold, cb) => cb(null, msgs) },
    log: (s) => logs.push(s), logOnce: () => {}, loadRelays: (cb) => cb(), voidSweep: () => {}, settleFills: () => {},
    processTakes: (t, done) => { takes = t; done(); }, answerProofs: (a, done) => done(), ladderPass: (f) => f(), crossPass: (f) => f(), afterCross: (f) => f(),
    runRefresh: () => {},
    AX: { identity: { open: (me, blob) => { if (blob === 'THROW') throw new Error('boom'); const j = JSON.parse(blob); return { valid: true, fromPublicId: j.f, plaintext: JSON.stringify(j.p) }; } },
          fill: { MAX_TAKE_TXN_BYTES: 32000 }, proofs: { MAX_PROOF_CHARS: 16000 }, hex: { utf8Decode: (x) => x }, maker: { syncRelays: (a, b, c, cb) => cb({ lines: [] }), reconcilePostings: (a, b, c, cb) => cb([]) } } };
vm.createContext(ctx);
vm.runInContext(part('/** 0.0.158 (review, MAJOR): a null-prototype map', 'function logOnce(') + (src.indexOf('/** 0.0.165 (review, MINOR): takes past') >= 0 ? part('/** 0.0.165 (review, MINOR): takes past', 'function processTakes(') : '') + part('function tick(', 'function refreshed('), ctx);
vm.runInContext('tick()', ctx);
assert.ok(takes, '0.0.158: a message that throws never stops the poll (the takes after it are processed)');
assert.strictEqual(JSON.stringify(takes.map((t) => [t._from, t.orderId])), JSON.stringify([[B, OK], [A, OK]]), '0.0.158: only takes naming an order id are kept');
assert.ok(logs.some((l) => /^inbox: a message could not be handled \(.*\) — skipped$/.test(l)), '0.0.158: the skipped message is logged');
// 0.0.165 (review, MINOR): takes past 16 a poll / 2 a sender used to be DROPPED (the inbox cursor had moved past them):
// they wait in a queue (4 a sender, 64 in all) and the next polls take them, oldest first
const hex = (n) => '0x' + n.toString(16).padStart(128, '0');
msgs.length = 0;
for (let k = 0; k < 20; k++) msgs.push(take(A, OK));                 // one sender floods 20
for (let k = 1; k <= 20; k++) msgs.push(take(hex(k), OK));           // 20 senders, one each
logs = []; vm.runInContext('tick()', ctx);
const per = (l) => l.reduce((m, t) => (m[t._from] = (m[t._from] || 0) + 1, m), {});
assert.strictEqual(takes.length, 16, '0.0.165: 16 takes a poll');
assert.strictEqual(per(takes)[A], 2, '0.0.165: 2 a sender a poll');
assert.ok(logs.some((l) => /^inbox: 16 take\(s\) not queued — the take queue is full \(64, 4 a sender\)/.test(l)), '0.0.165: a flood beyond 4 a sender is dropped, logged: ' + logs);
msgs.length = 0; vm.runInContext('tick()', ctx);
assert.strictEqual(takes.length, 8, '0.0.165: the next poll takes the queued rest (2 of the flooder, 6 others)');
assert.strictEqual(per(takes)[A], 2);
vm.runInContext('tick()', ctx);
assert.strictEqual(takes.length, 0, '0.0.165: then the queue is empty');
// 0.0.183 (review, MAJOR 4 (d)): a take may carry proofs of the taker's coins — a bounded map of coin id → hex, else junk
const C = '0x' + 'c1'.repeat(32), P1 = '0x00000020' + 'ab'.repeat(200);
const withProofs = (pr) => ({ env: { blob: JSON.stringify({ f: hex(99), p: { k: 'take', orderId: OK, txn: '0xAB', proofs: pr } }) } });
const many = {}; for (let k = 0; k < 21; k++) many['0x' + k.toString(16).padStart(64, '0')] = P1;
msgs.length = 0;
[{ [C]: P1 }, [P1], { notacoin: P1 }, { [C]: 'nothex' }, { [C]: '0x' + 'ab'.repeat(8001) }, many, null].forEach((pr) => msgs.push(withProofs(pr)));
vm.runInContext('tick()', ctx);
assert.strictEqual(takes.length, 1, '0.0.183: only the take whose proofs are a bounded coin id → hex map is queued');
assert.strictEqual(JSON.stringify(takes[0].proofs), JSON.stringify({ [C]: P1 }));
console.log('SERVICE INBOX PASS');
