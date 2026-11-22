/**
 * take_flow.js — the one-click FAST take in ui/app.js, driven in a stubbed page (no browser, no node).
 * Proves: crossing BUY executes at once (no dialog), the button locks, the log prints each step, a refusal moves to the
 * next order by itself, a co-sign prints the full txpowid and unlocks, and the maker's coins were fetched BEFORE the click.
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
function elem(id) {
    const e = { id, style: {}, value: '', textContent: '', innerHTML: '', hidden: true, disabled: false, className: '', children: [], scrollTop: 0, scrollHeight: 0,
        classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); } },
        appendChild(c) { this.children.push(c); }, addEventListener() { }, querySelector() { return els.cta; } };
    Object.defineProperty(e, 'innerHTML', { get() { return this._h || ''; }, set(v) { this._h = v; if (v === '') this.children = []; } });
    return e;
}
const els = {}; const $ = (id) => els[id] || (els[id] = elem(id)); els.cta = elem('cta');
const cmds = [], published = [], timers = [], GONE = new Set();   // GONE: coin ids this node's `coins coinid:` does not return
let inboxCb = null, clock = 1000;
const MAKER_A = { orderId: 'ordA', side: 'sell', price: '0.003675', amount: '100', coins: ['0xC0A'], pubId: 'pkA', address: 'MxMAKERA', signPk: '0xaa' };
const MAKER_B = { orderId: 'ordB', side: 'sell', price: '0.0037', amount: '100', coins: ['0xC0B'], pubId: 'pkB', address: 'MxMAKERB', signPk: '0xbb' };
let BOOK = [MAKER_A, MAKER_B];
const ctx = {
    console, JSON, Math, Object, Array, String, Number, RegExp, Error, Date: { now: () => clock },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() { }, setInterval() { },
    localStorage: { getItem: () => null, setItem() { } }, fetch: () => ({ then: () => ({ then: () => ({ catch() { } }) }) }), navigator: {},
    document: { getElementById: $, createElement: () => ({ textContent: '' }) },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'vendor/decimal.js'), 'utf8'), ctx);
vm.runInContext(`
PandaDEX = { d: function (v) { return new Decimal(v); } };
PD = { BAL: { minima: '1000', usdt: '0.2' }, bal: function (w) { return { sendable: new Decimal(this.BAL[w]), at: 1 }; }, fmtBal: function (v) { return new Decimal(v).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(); }, num: function (v) { try { return v === '' || v == null ? null : new Decimal(v); } catch (e) { return null; } }, isBuy: function () { return true; },
       notice: function () {}, appendActivity: function () {}, esc: String, fmt: String, fmtPrice: String, jsArg: String, setStage: function () {}, paintNotice: function () {},
       preview: function () {}, render: function () {}, renderBookOnly: function () {}, renderOrdersPage: function () {}, balances: function () {}, inited: function () {}, servicePacket: function () {} };
DexiconActivity = { rows: {}, record: function (r) { this.rows[r.id] = r; }, update: function (id, f) { f(this.rows[id]); }, statusOf: function () { return null; }, boot: function () {}, setFills: function () {}, onBlock: function () {}, render: function () {} };
DexiconDoors = { inited: function () {}, onBlock: function () {}, refresh: function () {} };
DexiconMaker = { render: function () {}, loadIds: function (cb) { if (cb) cb(); }, rung: function () { return ''; } };
`, ctx);
ctx.AX = {
    maker: { dust: (rem, amt) => Number(rem) > 0 && Number(rem) < 1 && Number(rem) < Number(amt), load: (m, cb) => cb(null, []), walletCoins: (m, tok, cb) => { cmds.push('walletCoins ' + tok); cb(null, ['0xMINE1', '0xMINE2', '0xMINE3', '0xMINE4', '0xMINE5', '0xMINE6'].map((id) => ({ coinid: id, amount: '10' }))); }, create() { throw new Error('should not rest'); } },
    fill: { MIN_REM: '1', floorTake: (w, a) => { const W = new ctx.Decimal(w), A = new ctx.Decimal(a); if (W.gte(A)) return A; if (A.minus(W).gte(1)) return W; const t = A.minus(1); return t.gt(0) ? t : new ctx.Decimal(0); }, MINIMA: '0x00', MXUSD: '0xUSD', setMxUsd() { }, up8: (x) => x.toDecimalPlaces(8, ctx.Decimal.ROUND_UP),
        plan: (o, amt, mc, my, addr) => { assert.ok(mc.length && my.length && addr); ctx.lastPlanAmt = amt; (ctx.planCoins = ctx.planCoins || []).push(my[0].coinid); return { filled: amt, takerGives: '0.3675', makerGives: amt, inputs: [my[0].coinid], outputs: [1] }; },
        build: (m, p, cb) => cb(null, '0xHEX') },
    envelope: { msg: (me, to, blob) => ({ to, blob }) },
    identity: { fromSeed: () => ({ publicId: () => 'pkME', signPk: [1] }), seal: (me, to, b) => b, open: (me, blob) => ({ valid: true, fromPublicId: JSON.parse(blob)._f, plaintext: blob }) },
    hex: { to: () => '01', utf8: (s) => s, utf8Decode: (s) => s },
    prng: { init() { } }, activity: { BUILDING: 'BUILDING', SENT: 'SENT', COSIGNED: 'COSIGNED', FAILED: 'FAILED', REFUSED: 'REFUSED' },
    relay: { fromKv: () => ['https://r1'], Client: function () { this.relays = ['https://r1']; this.status = {}; this.cursors = {};
        this.setRelays = () => { }; this.orders = () => BOOK; this.polled = 0; this.pollBook = (s, cb) => { if (!this.polled++) cb(null, true, 'r1'); };
        this.pollInbox = (pk, s, cb) => { inboxCb = cb; }; this.publish = (m, cb) => { published.push(m); cb([{ ok: true }, { ok: true }]); }; }, xhrTransport: () => ({}) },
    mds: { kvInit: (cb) => cb(), kvGet: (k, d, cb) => cb(d), kvSet: (k, v, cb) => cb && cb(), sql: (q, cb) => cb({ rows: [] }),
        cmd: (c, cb) => cb && cb(), cmdR: (c, cb) => { cmds.push(c); if (c.startsWith('vault')) throw new Error('the page must never read the vault seed'); if (c.startsWith('seedrandom')) return cb(null, { seedrandom: '0x' + 'ab'.repeat(32) }); if (c === 'getaddress') return cb(null, { address: 'MxME' });
            if (c.startsWith('coins coinid:')) return cb(null, GONE.has(c.slice(13)) ? [] : [{ coinid: c.slice(13), amount: '100', tokenid: '0x00' }]); cb(null, {}); } },
};
let initCb; ctx.MDS = { init: (cb) => { initCb = cb; } };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib/takeable.js'), 'utf8'), ctx);   // the real verdict rule
vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8'), ctx);
let tip = 2433552;
const newBlock = () => initCb({ event: 'NEWBLOCK', data: { txpow: { header: { block: String(++tip) } } } });   // re-checks every shown order's coins
initCb({ event: 'inited' });
while (timers.length) timers.shift()();          // let the book poll + prefetch run

const before = cmds.slice();
assert.ok(before.includes('coins coinid:0xC0A') && before.includes('coins coinid:0xC0B'), 'maker coins prefetched before the click');
assert.ok(before.includes('getaddress'), 'address prefetched before the click');

// funds: 0.2 MxUSD free cannot buy 100 @ 0.0037 (0.37) → red line, button disabled, balances cut to 6 dp
$('price').value = '0.0037'; $('amount').value = '100';
ctx.DexiconFast.paintFunds();
assert.ok(els.fundsWarn.textContent.startsWith('Exceeds your free MxUSD by 0.17'), els.fundsWarn.textContent);
assert.strictEqual(els.cta.disabled, true, 'shortfall disables the button');
vm.runInContext("PD.BAL.usdt = '12.123456789'", ctx);
ctx.DexiconFast.paintFunds();
assert.strictEqual(els.fundsWarn.textContent, '');
assert.strictEqual(els.cta.disabled, false);
assert.ok(els.availLine.textContent.startsWith('Available: 12.123456 MxUSD'), els.availLine.textContent);
cmds.length = 0;
ctx.DexiconFast.place(true);                       // THE click
assert.ok(!cmds.some((c) => c.startsWith('coins coinid:')), 'no coin lookup after the click');
assert.strictEqual(els.cta.disabled, true, 'button locked');
assert.strictEqual(published.length, 1, 'take sent on the first click');
assert.strictEqual(published[0].to, 'pkA', 'best price first');
ctx.DexiconFast.place(true);                       // a second click while trading does nothing
assert.strictEqual(published.length, 1, 'second click ignored');

inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'refused', orderId: 'ordA', reason: 'spoofed', _f: 'pkSOMEONE' }) } }]);   // security review 30 Oct: not the maker → ignored
inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'refused', orderId: 'ordA', reason: 'order already taken', _f: 'pkA' }) } }]);
// review 7 Nov (H1): a refusal is the maker's word — the take may still be posted, so its 100 stays counted until voided
// and is NOT re-bought from B: the 100-MINIMA run is covered and ends
assert.strictEqual(published.length, 1, 'a refused take is never re-bought elsewhere');
assert.strictEqual(els.cta.disabled, false, 'run over');
let refusedLog = els.tradeLog.children.map((c) => c.textContent).join('\n');
assert.ok(refusedLog.includes('maker refused: order already taken — counted as possibly filled until voided'), refusedLog);
assert.ok(refusedLog.includes('100 MINIMA still waiting on makers'), refusedLog);
assert.strictEqual($('amount').value, '', 'nothing surely untraded is left in the field');
BOOK = [MAKER_B];
$('price').value = '0.0037'; $('amount').value = '100';
ctx.DexiconFast.place(true);
assert.strictEqual(published.length, 2);
assert.strictEqual(published[1].to, 'pkB');
assert.strictEqual(els.cta.disabled, true, 'locked while waiting on B');

const TX = '0x0E426494D798898EE301C6A969E016F39D9E6A0B87BFFD9DAB5A435DBD0058BC';
clock += 9000;
inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'taken', orderId: 'ordB', txpowid: TX, filled: '100', coins: [], _f: 'pkB' }) } }]);
const text = els.tradeLog.children.map((c) => c.textContent).join('\n');
assert.strictEqual(els.cta.disabled, false, 'unlocked after co-sign');
assert.ok(text.includes('TRADE DONE') && text.includes(TX), 'full txpowid in the log');

console.log(text);

// 100 % is of the EXACT offer at the price: both asks cross 0.0037 → 200 MINIMA, no rounding
BOOK = [MAKER_A, MAKER_B];
assert.strictEqual(ctx.DexiconFast.offered(true, '0.0037').toFixed(), '200');
assert.strictEqual(ctx.DexiconFast.offered(true, '0.003675').toFixed(), '100');
// Owner 7 Nov, the sweep: ONE click takes 60 from C, then 90 from D (best-first), and is done at 150
const MAKER_C = { orderId: 'ordC', side: 'sell', price: '0.0036', amount: '60', coins: ['0xC0C'], pubId: 'pkC', address: 'MxMAKERC', signPk: '0xcc' };
const MAKER_D = { orderId: 'ordD', side: 'sell', price: '0.0037', amount: '100', coins: ['0xC0D'], pubId: 'pkD', address: 'MxMAKERD', signPk: '0xdd' };
BOOK = [MAKER_C, MAKER_D];
newBlock();                                      // new orders: shown (and takeable) once this node has seen their coins
els.tradeLog.innerHTML = '';
$('price').value = '0.0037'; $('amount').value = '150';
ctx.DexiconFast.place(true);
assert.strictEqual(published[published.length - 1].to, 'pkC', 'sweep starts at the best ask');
inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'taken', orderId: 'ordC', txpowid: TX, filled: '60', coins: [], _f: 'pkC' }) } }]);
assert.strictEqual(published[published.length - 1].to, 'pkD', 'a co-sign moves the sweep to the next order');
assert.strictEqual(ctx.lastPlanAmt, '90', 'the next take is only what is still wanted');
assert.notStrictEqual(ctx.planCoins[ctx.planCoins.length - 1], ctx.planCoins[ctx.planCoins.length - 2], 'a coin inside a take still waiting on its maker is never signed again');
assert.strictEqual(els.cta.disabled, true, 'still locked mid-sweep');
inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'taken', orderId: 'ordD', txpowid: TX, filled: '90', coins: [], _f: 'pkD' }) } }]);
let sweepLog = els.tradeLog.children.map((c) => c.textContent).join('\n');
assert.ok(sweepLog.includes('TRADE DONE: 150 of 150 MINIMA'), sweepLog);
assert.strictEqual(els.cta.disabled, false, 'unlocked when the amount is covered');

// An unanswered take counts as possibly filled: asking 99.5 of E (100, floor → 99) and E never answers → the sweep
// moves on, nothing else crosses, 0.5 is NOT traded and nothing rests (AX.maker.create throws if anything rests)
const MAKER_E = { orderId: 'ordE', side: 'sell', price: '0.003675', amount: '100', coins: ['0xC0E'], pubId: 'pkE', address: 'MxMAKERE', signPk: '0xee' };
BOOK = [MAKER_E];
newBlock();
els.tradeLog.innerHTML = '';
$('price').value = '0.003675'; $('amount').value = '99.5';
ctx.DexiconFast.place(true);
assert.strictEqual(ctx.lastPlanAmt, '99', 'shrunk so 1 MINIMA stays on the order');
while (timers.length) timers.shift()();          // 30 s, no answer
sweepLog = els.tradeLog.children.map((c) => c.textContent).join('\n');
assert.ok(sweepLog.includes('no answer in 30s — counted as possibly filled'), sweepLog);
assert.ok(sweepLog.includes('99 MINIMA still waiting on makers') && sweepLog.includes('0.5 MINIMA not traded; nothing was placed as an order'), sweepLog);
assert.strictEqual(els.cta.disabled, false);

// Owner 22 Nov 2026: "If an order is not tradable, it shouldn't be displayed anywhere as a real market." The real ghost:
// order 0x77da4748491f267c, its coin created ~1826 blocks before this node's tip — `coins coinid:` returns nothing here.
const GHOST_COIN = '0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8', GHOST_MAKER = '0x5243C4B815456066ABCD619F4D5474FBBE224449F38DB4D1F7528CC8F3916296';
const GHOST = { orderId: '0x77da4748491f267c', side: 'buy', price: '0.0042', amount: '1000', coins: [GHOST_COIN], pubId: 'pkG', address: 'MxGHOST', signPk: GHOST_MAKER };
const BID = { orderId: 'ordF', side: 'buy', price: '0.004', amount: '50', coins: ['0xC0F'], pubId: 'pkF', address: 'MxMAKERF', signPk: '0xff' };
const MINE = { orderId: 'ordM', side: 'buy', price: '0.005', amount: '7', coins: ['0xC0M'], pubId: 'pkME', address: 'MxME', signPk: '0x01' };   // mySignPk() = 0x01
const prices = (lv) => lv.map((l) => l.exact.toFixed()).sort().reverse();   // best bid first, as the ladder sorts
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);   // arrays from the page's context
GONE.add(GHOST_COIN);
BOOK = [GHOST, BID, MINE];
// before this node has looked: neither third-party order is market (D2), my own is (D4), the line says "checking"
let bids = ctx.DexiconFast.levels(false, null);
same(prices(bids), ['0.005'], 'unchecked orders are not shown; my own is');
assert.ok(bids[0].mine, 'my own order is marked');
ctx.DexiconFast.paintHidden();
assert.strictEqual(els.fastHidden.hidden, false);
assert.ok(els.fastHidden.textContent.startsWith('checking 2 FAST orders…'), els.fastHidden.textContent);
cmds.length = 0;
newBlock();
assert.ok(cmds.includes('coins coinid:' + GHOST_COIN) && cmds.includes('coins coinid:0xC0F') && !cmds.includes('coins coinid:0xC0M'), 'every shown order looked up, never my own');
bids = ctx.DexiconFast.levels(false, null);
same(prices(bids), ['0.005', '0.004'], 'the ghost is gone; the best third-party bid is 0.004, not 0.0042');
vm.runInContext('PD.isBuy = function () { return false; }', ctx);
same(ctx.DexiconFast.crossing(false, '0.004').map((o) => o.orderId), ['ordF'], 'a sell never crosses the ghost (nor my own)');
assert.strictEqual(ctx.DexiconFast.offered(false, '0.004').toFixed(), '50', 'the percent buttons offer only what is takeable');
ctx.DexiconFast.paintHidden();
assert.strictEqual(els.fastHidden.textContent, "1 FAST order hidden: not takeable from this node (a backing coin is spent or older than this node's chain window)  ▾");
assert.strictEqual(els.fastHiddenList.hidden, true);
ctx.DexiconFast.toggleHidden();                  // the tap: each hidden order with its WHOLE ids and the reason
assert.strictEqual(els.fastHiddenList.hidden, false);
const listed = els.fastHiddenList.innerHTML;
assert.ok(listed.includes('order 0x77da4748491f267c') && listed.includes('maker ' + GHOST_MAKER) && listed.includes('coin ' + GHOST_COIN + ' — spent or not seen by this node (checked at block ' + tip + ')'), listed);
assert.ok(listed.includes("not takeable: a backing coin is spent or older than this node's chain window"), listed);
// a SELL with the ghost's price as its limit: only the takeable bid is swept, the ghost never receives a take
$('price').value = '0.004'; $('amount').value = '1000';
ctx.DexiconFast.refreshPreview();
assert.ok(els.cta.innerHTML.startsWith('SELL 50 MINIMA NOW'), els.cta.innerHTML);
const n = published.length;
ctx.DexiconFast.place(false);
assert.strictEqual(published[n].to, 'pkF', 'the take goes to the takeable bid');
assert.ok(!published.slice(n).some((m) => m.to === 'pkG'), 'never to the ghost');
inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'taken', orderId: 'ordF', txpowid: TX, filled: '50', coins: [], _f: 'pkF' }) } }]);
assert.ok(els.tradeLog.children.map((c) => c.textContent).join('\n').includes('No other FAST order crosses 0.004'), 'the run ends without the ghost');
// the node catches up (or the maker re-backs with a fresh coin and the old one becomes visible): the next block shows it
GONE.delete(GHOST_COIN); newBlock();
same(prices(ctx.DexiconFast.levels(false, null)), ['0.005', '0.0042', '0.004'], 'a re-check that sees the coin shows the order again');
console.log('TAKE FLOW PASS');
