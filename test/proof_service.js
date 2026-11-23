/* 0.0.111: the maker's service answers a taker's coin proof request ({k:'proofs?'}) with a sealed {k:'proofs'} reply of
 * `coinexport` data for the asked coins that back its live orders. Runs the real answerProofs from service.js and the real
 * lib/proofs.js against stubs, and checks the tick routes requests there (one per sender, after the takes). */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
assert.ok(/MDS\.load\('lib\/proofs\.js'\)/.test(src), 'service.js loads lib/proofs.js');
const tick = src.slice(src.indexOf('function tick('), src.indexOf('function refreshed('));
assert.ok(/inner\.k === 'proofs\?' && opened\.fromPublicId/.test(tick), 'the tick collects proof requests');
// 0.0.116: the tick's routing, run: one sender's requests (one per order) are merged up to 32 coins, never dropped; 16 senders a poll
{
    const a = tick.indexOf('var takes = [], perSender = {}'), b = tick.indexOf('processTakes(takes,');
    const rctx = { Object, JSON, String, ME: {}, AX: { identity: { open: (me, blob) => ({ valid: true, fromPublicId: blob.f, plaintext: blob.p }) }, hex: { utf8Decode: (p) => p } } };
    vm.createContext(rctx);
    vm.runInContext('function classify(msgs) { ' + tick.slice(a, b) + ' return asks; }', rctx);
    const req = (f, coins) => ({ env: { blob: { f, p: JSON.stringify({ k: 'proofs?', coins }) } } });
    const c = (i) => '0x' + ('00' + i.toString(16)).slice(-2).repeat(32);
    let got = rctx.classify([req('A', [c(1)]), req('A', [c(2), c(3)]), req('B', [c(4)])]);
    assert.strictEqual(JSON.stringify(got.map((q) => ({ from: q.from, coins: q.coins }))), JSON.stringify([{ from: 'A', coins: [c(1), c(2), c(3)] }, { from: 'B', coins: [c(4)] }]), 'one sender\'s requests merged, none dropped');
    // 0.0.128: a request may ask attestations of addresses (coins [] when it asks nothing else): merged, de-duplicated, ≤ 32
    const att = (f, coins, attest) => ({ env: { blob: { f, p: JSON.stringify({ k: 'proofs?', coins, attest }) } } });
    got = rctx.classify([att('A', [], [c(7), c(7)]), att('A', [c(1)], [c(8)])]);
    assert.strictEqual(JSON.stringify([got[0].coins, got[0].attest]), JSON.stringify([[c(1)], [c(7), c(8)]]), 'attestation requests merged and de-duplicated');
    got = rctx.classify([req('A', [c(1), c(1), c(1)]), req('A', [c(1), c(2)])]);
    assert.strictEqual(JSON.stringify(got[0].coins), JSON.stringify([c(1), c(2)]), 'NIT: one sender\'s coins de-duplicated before the 32-coin cap');
    const many = []; for (let i = 0; i < 40; i++) many.push(req('A', [c(i)]));
    got = rctx.classify(many);
    assert.strictEqual(got.length === 1 && got[0].coins.length, 32, 'at most 32 coins per sender a poll');
    const senders = []; for (let i = 0; i < 70; i++) senders.push(req('S' + i, [c(i % 200)]));
    assert.strictEqual(rctx.classify(senders).length, 64, 'at most 64 senders a poll (0.0.138: queued round robin by lib/proofs.js)');
}
assert.ok(/processTakes\(takes, function \(\) \{ answerProofs\(asks, function \(\) \{/.test(tick), 'takes are answered first, then proof requests');
const block = src.slice(src.indexOf('function answerProofs('), src.indexOf('function processTakes('));
const id = (b) => '0x' + b.repeat(32), ADDR = id('AD'), TAKER = '0x' + '77'.repeat(64);
const proof = (c) => ('0x00000020' + c.slice(2) + '00000020' + ADDR.slice(2) + '0123456789ABCDEF'.repeat(60)).slice(0, 900);
const pubs = [], logs = [], cmds = [];
const ctx = { log: (s) => logs.push(s), RELAY: { publish: (raw, cb) => { pubs.push(raw); cb([]); } }, sealed: (to, obj) => JSON.stringify({ to, obj }), Object, JSON, String, parseInt, Error, Date };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../lib/proofs.js', 'utf8'), ctx);
ctx.AX.mds = { cmdR: (c, cb) => { cmds.push(c); if (c === 'block') return cb(null, { block: '77' }); const m = /^coinexport coinid:(0x[0-9A-F]{64})$/.exec(c); return m ? cb(null, { data: proof(m[1]) }) : cb(new Error('unexpected ' + c)); } };
ctx.ME = { signPk: new Uint8Array(32).fill(0x5b) }; ctx.AX.hex = { to: (u) => Array.from(u, (b) => ('0' + b.toString(16)).slice(-2)).join('') };
ctx.AX.maker = { load: (m, cb) => cb(null, [{ orderId: 'o1', status: 'live', coins: [id('A1')] }, { orderId: 'o2', status: 'filled', coins: [id('B1')] }]) };
vm.runInContext(block, ctx);
let done = 0;
vm.runInContext('answerProofs([], function () { DONE(); })', Object.assign(ctx, { DONE: () => done++ }));
assert.strictEqual(done, 1); assert.deepStrictEqual(cmds, [], 'no request: no node command');
ctx.ASKS = [{ from: TAKER, coins: [id('A1'), id('B1')] }];
vm.runInContext('answerProofs(ASKS, function () { DONE(); })', ctx);
assert.strictEqual(done, 2);
assert.deepStrictEqual(cmds, ['block', 'coinexport coinid:' + id('A1')], 'only the live order\'s coin is exported');
assert.strictEqual(JSON.stringify(pubs), JSON.stringify([JSON.stringify({ to: TAKER, obj: { k: 'proofs', proofs: { [id('A1')]: proof(id('A1')) } } })]), 'one sealed reply to the asker, published as sealed');
// NIT (review 23 Nov): the log line names the taker in full and counts the coins (no list of up to 32 ids)
assert.ok(logs[0] === 'coin proofs sent to ' + TAKER + ': 1 coin(s), 0 attestation(s), ' + pubs[0].length + ' chars', logs.join('\n'));
// M1: what a poll did not reach is answered by the next poll, even one with no new request (after its takes)
assert.ok(/if \(!asks\.length && !AX\.proofs\.pending\(\)\) return done\(\);/.test(block), 'a poll with no request still answers the queue');
console.log('PROOF SERVICE PASS');
