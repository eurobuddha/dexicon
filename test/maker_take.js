/* maker_take.js — service.js handleTake, run against stubs: what a co-signed take leaves for the bookkeeping.
 * 0.0.145: the fill_ record carries `verified` (the remaining the take was checked against; reconcileFills uses it).
 * 0.0.161: the record is provisional (prov, ins, postBlock) and afterFill is told so.
 * 0.0.162: a durable posting_<orderId> record is written BEFORE txnpost (nothing posts if it fails), deleted once afterFill
 * applied the fill; after a failed afterFill it stays and the order takes no take until it is reconciled. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../service.js', 'utf8');
const part = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const TX = '0x' + 'D4'.repeat(32), OID = '0x0101010101010101', kv = {}, fills = [], replies = [], order = [];
let AFTER_ERR = null, KVSET_FAILS = null, POSTED = 0;
const PAY = { id: '0x' + 'E1'.repeat(32), k: 2, address: '0xAD', tokenid: '0x01', amount: '4' };
const ctx = { JSON, Date, Math, String, Object, Error,
  RELAY: {}, ME: {}, log: () => {}, notify: () => {}, reply: (to, m) => replies.push(m), nowS: () => 1800000000,
  AX: { mds: { kvSet: (k, v, cb) => { order.push('kvSet ' + k); if (KVSET_FAILS && k.indexOf(KVSET_FAILS) === 0) return cb(new Error('sql failed: Database is closed')); kv[k] = v; cb(null); },
               kvGet: (k, d, cb) => cb(kv[k] === undefined ? d : kv[k]), kvDel: (k, cb) => { order.push('kvDel ' + k); delete kv[k]; cb(null); },
               cmdR: (c, cb) => c === 'block' ? cb(null, { block: '2400123' }) : cb(new Error('unexpected ' + c)) },
        maker: { load: (m, cb) => cb(null, [{ orderId: OID, side: 'sell', price: '0.1', address: '0xAD', coins: ['0xC1'], scripts: [], remaining: '100', status: 'live' }]),
                 find: (l, id) => l.find((o) => o.orderId === id) || null,
                 afterFill: function () { fills.push(Array.prototype.slice.call(arguments, 3)); arguments[6](AFTER_ERR); } },
        fill: { MAX_TAKE_TXN_BYTES: 32000, signKeys: () => [], verifyAsMaker: () => ({ ok: true }),
                cosign: (m, txn, keys, verify, done, prePost) => {
                    verify({ inputs: [{ coinid: '0xC1' }] }, []);
                    if (!prePost) { order.push('txnpost'); POSTED++; return done(null, TX, { filled: '40', received: '4', paid: '40' }, ['0xOUT']); }   // a caller with no hook
                    prePost({ mine: ['0xC1'], outs: ['0xOUT'], verdict: { filled: '40', received: '4', paid: '40' }, pay: PAY, first: '0xC1' }, (e) => {
                        if (e) return done(e, null, { ok: true });
                        order.push('txnpost'); POSTED++; done(null, TX, { filled: '40', received: '4', paid: '40' }, ['0xOUT']);
                    });
                } } } };
vm.createContext(ctx);
const LIB = fs.readFileSync(__dirname + '/../lib/maker.js', 'utf8'), FR = /\/\*\* 0\.0\.162: the maker fill_ record of a posting record/;
if (FR.test(LIB)) {   // the two helpers handleTake uses, from the real lib/maker.js
    vm.runInContext(LIB.replace(/^[\s\S]*?(    \/\*\* 0\.0\.162: the maker fill_ record of a posting record[\s\S]*?\n    \}\n    \/\*\* 0\.0\.162: kv `posting_<orderId>`[\s\S]*?\n    \}\n)[\s\S]*$/, 'var FR = (function () { function now() { return 1800000000; }\n$1 return { fillRecord: fillRecord, postingOf: postingOf }; })();'), ctx);
    ctx.AX.maker.fillRecord = ctx.FR.fillRecord; ctx.AX.maker.postingOf = ctx.FR.postingOf;
}
vm.runInContext('var coinLocks = {}, LOCK_MS = 180000;\n' + part('/** 0.0.158 (review, MAJOR): a null-prototype map', 'function logOnce(') + part('function lockCoins(', 'function tick(') + (src.indexOf('/** 0.0.165 (review, MINOR): takes past') >= 0 ? part('/** 0.0.165 (review, MINOR): takes past', 'function processTakes(') : '') + part('function handleTake(', '\n/** ASSETS'), ctx);
let next = 0;
const take = () => vm.runInContext("handleTake({ _from: '0x" + '77'.repeat(64) + "', txn: '0xAB', orderId: '" + OID + "' }, NEXT)", Object.assign(ctx, { NEXT: () => next++ }));
take();
const rec = JSON.parse(kv['fill_' + TX]);
assert.strictEqual(next, 1, 'the take is done once');
assert.strictEqual(rec.verified, '100', '0.0.145: the fill record keeps the remaining the take was checked against');
assert.deepStrictEqual([rec.role, rec.orderId, rec.filled, rec.txpowid], ['maker', OID, '40', TX], 'the fill record');
assert.strictEqual(JSON.stringify([fills[0][0], fills[0][1], fills[0][2], fills[0][4], fills[0][5]]), JSON.stringify([OID, '40', ['0xC1'], TX, '100']), 'afterFill gets the order, filled, spent coins, the txpowid and the checked remaining');
// 0.0.161 (review, MAJOR — phantom fills): the fill is PROVISIONAL: its record carries my spent coins and the post height,
// and afterFill is told so (it keeps a provisional entry on the order until settleFills sees it mined or never mined)
assert.strictEqual(JSON.stringify([rec.prov, rec.ins, rec.postBlock, rec.status]), JSON.stringify([true, ['0xC1'], 2400123, 'settling']), '0.0.161: a provisional record');
assert.strictEqual(JSON.stringify(fills[0][6]), JSON.stringify({ b: 2400123, p: PAY.id }), '0.0.161/0.0.179: afterFill gets the provisional mark and the payment coin to hold');
// 0.0.179 (review, MAJOR 1): the take's own payment coin (computed id, address, token, amount) and its first input travel on
// the posting and fill records: settleFills proves the fill mined by THAT, never by "my first input is spent"
assert.strictEqual(JSON.stringify([rec.pay, rec.first]), JSON.stringify([PAY, '0xC1']), '0.0.179: the fill record carries the payment');
// 0.0.162 (review, MINOR): the posting record is written BEFORE txnpost and removed once afterFill applied the fill
assert.strictEqual(order.slice(0, 2).join(','), 'kvSet posting_' + OID + ',txnpost', '0.0.162: the durable posting record lands before the post');
assert.ok(order.indexOf('kvDel posting_' + OID) > order.indexOf('kvSet fill_' + TX), '0.0.162: removed after the fill was applied');
assert.strictEqual(kv['posting_' + OID], undefined);
// a posting record that cannot be written: nothing is posted, the taker is told
order.length = 0; KVSET_FAILS = 'posting_'; take();
assert.strictEqual(POSTED, 1, '0.0.162: no posting record → no post');
assert.ok(/could not be recorded before posting/.test(replies[replies.length - 1].reason), replies[replies.length - 1].reason);
// afterFill fails: the posting record stays and the next take of that order is refused until it is reconciled
KVSET_FAILS = null; AFTER_ERR = new Error('the myorders store is held by another writer'); take();
assert.strictEqual(POSTED, 2);
assert.ok(kv['posting_' + OID] && JSON.parse(kv['posting_' + OID]).txpowid === TX, '0.0.162: a fill not applied keeps its posting record (with its txpowid)');
AFTER_ERR = null; take();
assert.strictEqual(POSTED, 2, '0.0.162: ... and the order takes no take meanwhile');
assert.strictEqual(replies[replies.length - 1].reason, 'its last fill is still being applied — try again in a minute');
// 0.0.165: a take of an order this node never had gets no reply (junk would make every relay carry one)
const nr = replies.length, nx = next;
vm.runInContext("handleTake({ _from: '0x" + '77'.repeat(64) + "', txn: '0xAB', orderId: '0x0909090909090909' }, NEXT)", ctx);
assert.strictEqual(replies.length, nr, '0.0.165: no reply for an unknown order');
assert.strictEqual(next, nx + 1);
console.log('MAKER TAKE PASS');
