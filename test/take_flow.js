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
const cmds = [], published = [], timers = [];
let inboxCb = null, clock = 1000;
const MAKER_A = { orderId: 'ordA', side: 'sell', price: '0.003675', amount: '100', coins: ['0xC0A'], pubId: 'pkA', address: 'MxMAKERA', signPk: '0xaa' };
const MAKER_B = { orderId: 'ordB', side: 'sell', price: '0.0037', amount: '100', coins: ['0xC0B'], pubId: 'pkB', address: 'MxMAKERB', signPk: '0xbb' };
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
    maker: { load: (m, cb) => cb(null, []), walletCoins: (m, tok, cb) => { cmds.push('walletCoins ' + tok); cb(null, [{ coinid: '0xMINE', amount: '10' }]); }, create() { throw new Error('should not rest'); } },
    fill: { MINIMA: '0x00', MXUSD: '0xUSD', setMxUsd() { },
        plan: (o, amt, mc, my, addr) => { assert.ok(mc.length && my.length && addr); return { filled: amt, takerGives: '0.3675', makerGives: amt, inputs: ['0xMINE'], outputs: [1] }; },
        build: (m, p, cb) => cb(null, '0xHEX') },
    envelope: { msg: (me, to, blob) => ({ to, blob }) },
    identity: { fromSeed: () => ({ publicId: () => 'pkME', signPk: [1] }), seal: (me, to, b) => b, open: (me, blob) => ({ valid: true, plaintext: blob }) },
    hex: { to: () => '01', utf8: (s) => s, utf8Decode: (s) => s },
    prng: { init() { } }, activity: { BUILDING: 'BUILDING', SENT: 'SENT', COSIGNED: 'COSIGNED', FAILED: 'FAILED', REFUSED: 'REFUSED' },
    relay: { fromKv: () => ['https://r1'], Client: function () { this.relays = ['https://r1']; this.status = {}; this.cursors = {};
        this.setRelays = () => { }; this.orders = () => [MAKER_A, MAKER_B]; this.polled = 0; this.pollBook = (s, cb) => { if (!this.polled++) cb(null, true, 'r1'); };
        this.pollInbox = (pk, s, cb) => { inboxCb = cb; }; this.publish = (m, cb) => { published.push(m); cb([{ ok: true }, { ok: true }]); }; }, xhrTransport: () => ({}) },
    mds: { kvInit: (cb) => cb(), kvGet: (k, d, cb) => cb(d), kvSet: (k, v, cb) => cb && cb(), sql: (q, cb) => cb({ rows: [] }),
        cmd: (c, cb) => cb && cb(), cmdR: (c, cb) => { cmds.push(c); if (c.startsWith('vault')) return cb(null, { seed: 'x' }); if (c === 'getaddress') return cb(null, { address: 'MxME' });
            if (c.startsWith('coins coinid:')) return cb(null, [{ coinid: c.slice(13), amount: '100', tokenid: '0x00' }]); cb(null, {}); } },
};
let initCb; ctx.MDS = { init: (cb) => { initCb = cb; } };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8'), ctx);
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

inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'refused', orderId: 'ordA', reason: 'order already taken' }) } }]);
assert.strictEqual(published.length, 2, 'refusal moved to the next order by itself');
assert.strictEqual(published[1].to, 'pkB');
assert.strictEqual(els.cta.disabled, true, 'still locked while retrying');

const TX = '0x0E426494D798898EE301C6A969E016F39D9E6A0B87BFFD9DAB5A435DBD0058BC';
clock += 9000;
inboxCb(null, [{ env: { blob: JSON.stringify({ k: 'taken', orderId: 'ordB', txpowid: TX, filled: '100', coins: [] }) } }]);
const text = els.tradeLog.children.map((c) => c.textContent).join('\n');
assert.strictEqual(els.cta.disabled, false, 'unlocked after co-sign');
assert.ok(text.includes('TRADE DONE') && text.includes(TX), 'full txpowid in the log');
assert.ok(text.includes('maker refused: order already taken — next order'));
console.log(text);
console.log('TAKE FLOW PASS');
