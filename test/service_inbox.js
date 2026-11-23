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
          hex: { utf8Decode: (x) => x }, maker: { syncRelays: (a, b, c, cb) => cb({ lines: [] }), reconcilePostings: (a, b, c, cb) => cb([]) } } };
vm.createContext(ctx);
vm.runInContext(part('/** 0.0.158 (review, MAJOR): a null-prototype map', 'function logOnce(') + part('function tick(', 'function refreshed('), ctx);
vm.runInContext('tick()', ctx);
assert.ok(takes, '0.0.158: a message that throws never stops the poll (the takes after it are processed)');
assert.strictEqual(JSON.stringify(takes.map((t) => [t._from, t.orderId])), JSON.stringify([[B, OK], [A, OK]]), '0.0.158: only takes naming an order id are kept');
assert.ok(logs.some((l) => /^inbox: a message could not be handled \(.*\) — skipped$/.test(l)), '0.0.158: the skipped message is logged');
console.log('SERVICE INBOX PASS');
