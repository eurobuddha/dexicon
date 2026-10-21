/**
 * headless.js — drive the REAL MiniDapp libs against a REAL node and a REAL relay without a browser.
 * It speaks to the node exactly as the page does: POST https://<mds>/mdscommand_/{cmd|sql}?uid=<session>
 * (the per-MiniDapp session id the node prints in `mds`), so every node command, kv write and signature goes
 * through the same MDS layer and permissions the page uses. The service.js on the node plays the MAKER.
 *
 *   node test/headless.js --mds https://127.0.0.1:19303 --session 0x... --relay http://127.0.0.1:19702 \
 *        [--token 0x<dev dollar tokenid>] [--price 0.5] [--amount 10] [--take 3]
 *
 * Scenario: set kv (relays, dev token) → maker.create sell → relay book shows it → taker plans+builds+signs →
 * sealed take → waits for taken/refused from the service → prints the txpowid and its on-chain status.
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), https = require('https'), http = require('http'), url = require('url');
const ROOT = path.join(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null).filter(Boolean));
const MDS = args.mds, SESSION = args.session, RELAY = args.relay, TOKEN = args.token || '', PRICE = args.price || '0.5', AMOUNT = args.amount || '10', TAKE = args.take || '3';
if (!MDS || !SESSION || !RELAY) { console.error('need --mds --session --relay'); process.exit(2); }

function post(u, body, cb) {
    const o = url.parse(u), mod = o.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: o.hostname, port: o.port, path: o.path, method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => cb(null, d, res.statusCode)); });
    req.on('error', (e) => cb(e)); req.end(body);
}
function get(u, cb) {
    const o = url.parse(u), mod = o.protocol === 'https:' ? https : http;
    mod.get({ hostname: o.hostname, port: o.port, path: o.path, rejectUnauthorized: false }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => cb(null, d)); }).on('error', (e) => cb(e));
}
/** The node's MDS endpoint, same wire format as mds.js (plain-text body, ?uid=<session>). */
function mdsPost(kind, command, cb) {
    post(MDS + '/mdscommand_/' + kind + '?uid=' + SESSION, command, (err, text) => {
        if (err) return cb({ status: false, error: String(err) });
        try { cb(JSON.parse(text)); } catch (e) { cb({ status: false, error: 'bad json: ' + text.slice(0, 120) }); }
    });
}

// Sandbox with the production libs; MDS is a shim with cmd/sql/net.
const sandbox = { Uint8Array, Int8Array, Uint32Array, ArrayBuffer, DataView, Array, Object, Math, Date, JSON, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean, Symbol, Map, Set, Function, RegExp, encodeURIComponent, decodeURIComponent, console };
sandbox.globalThis = sandbox;
sandbox.MDS = { cmd: (c, cb) => mdsPost('cmd', c, cb), sql: (q, cb) => mdsPost('sql', q, cb), net: { GET: (u, cb) => get(u, (e, t) => cb(e ? { status: false, error: String(e) } : { status: true, response: t })), POST: (u, b, cb) => post(u, b, (e, t) => cb(e ? { status: false, error: String(e) } : { status: true, response: t })) }, log: (s) => console.log('[mds.log]', s) };
const ctx = vm.createContext(sandbox);
for (const f of ['lib/rhino_shim.js', 'vendor/nacl.js', 'vendor/blake.js', 'vendor/sha256.js', 'vendor/sha512.js', 'vendor/decimal.js', 'lib/hex.js', 'lib/flow.js', 'crypto/ax_sodium.js', 'lib/identity.js', 'lib/mdsw.js', 'lib/envelope.js', 'lib/relay.js', 'lib/fill.js', 'lib/maker.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
const nodeCrypto = require('crypto');
vm.runInContext('AX.sodium.setPRNG(__fill)', Object.assign(ctx, { __fill: (x, n) => { const b = nodeCrypto.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; } }));
const AX = ctx.AX;
const nowS = () => Math.floor(Date.now() / 1000);
const step = (s) => console.log('\n== ' + s);
const die = (m) => { console.error('FAIL: ' + m); process.exit(1); };

step('kv: relays + dev token');
AX.mds.kvInit(() => AX.mds.kvSet('relays', JSON.stringify([RELAY]), (e1) => AX.mds.kvSet('mxusd_tokenid', TOKEN, (e2) => {
    if (e1 || e2) die('kv ' + (e1 || e2));
    if (TOKEN) AX.fill.setMxUsd(TOKEN);
    step('identity from vault seed');
    AX.mds.cmdR('vault action:seed', (err, r) => {
        if (err || !r || !r.seed) die('vault action:seed: ' + (err && err.message));
        const me = AX.identity.fromSeed(r.seed, 'decks');
        console.log('publicId', me.publicId());
        const transport = { get: (u, cb) => get(u, (e, t) => cb(e, t)), post: (u, b, cb) => post(u, b, (e, t) => cb(e, t)) };
        const client = new AX.relay.Client(transport);
        client.setRelays([RELAY]);
        step('maker: create sell ' + AMOUNT + ' MINIMA @ ' + PRICE);
        AX.maker.create(AX.mds, client, me, { side: 'sell', price: PRICE, amount: AMOUNT }, (e3, o, results) => {
            if (e3) die('create: ' + e3.message);
            console.log('order', o.orderId, 'coins', o.coins.length, 'relay results', JSON.stringify(results));
            step('relay book shows it');
            client.pollBook(1, (e4, changed) => {
                const live = client.orders().filter((x) => x.orderId === o.orderId);
                if (!live.length) die('order not in relay book');
                const order = live[0];
                console.log('book has', client.orders().length, 'order(s); ours at', order.price, 'x', order.amount);
                step('taker: plan ' + TAKE + ' MINIMA');
                fetchCoins(order.coins, (e5, makerCoins) => {
                    if (e5) die('maker coins: ' + e5.message);
                    AX.maker.walletCoins(AX.mds, order.side === 'sell' ? AX.fill.MXUSD : AX.fill.MINIMA, (e6, myCoins) => {
                        if (e6) die('my coins: ' + e6.message);
                        AX.mds.cmdR('getaddress', (e7, addr) => {
                            let p; try { p = AX.fill.plan(order, TAKE, makerCoins, myCoins, addr.address); } catch (e) { die('plan: ' + e.message); }
                            console.log('plan: give', p.takerGives, 'receive', p.makerGives, 'inputs', p.inputs.length, 'outputs', p.outputs.length);
                            step('taker: build + sign + export');
                            AX.fill.build(AX.mds, p, (e8, hex) => {
                                if (e8) die('build: ' + e8.message);
                                console.log('txn hex bytes', hex.length / 2);
                                const inner = JSON.stringify({ k: 'take', orderId: order.orderId, txn: hex, taker: me.publicId() });
                                const blob = AX.identity.seal(me, order.pubId, AX.hex.utf8(inner));
                                const msg = AX.envelope.msg(me, order.pubId, blob, nowS() + 300);
                                step('taker: publish sealed take; wait for the maker service');
                                client.publish(msg, (res) => {
                                    console.log('msg relay results', JSON.stringify(res));
                                    const t0 = Date.now();
                                    (function waitReply() {
                                        client.pollInbox(me.publicId(), 20, (e9, msgs) => {
                                            for (const m of msgs) {
                                                const opened = AX.identity.open(me, m.env.blob);
                                                if (!opened || !opened.valid) continue;
                                                let inner2; try { inner2 = JSON.parse(AX.hex.utf8Decode(opened.plaintext)); } catch (e) { continue; }
                                                if (inner2.k === 'taken' && inner2.orderId === order.orderId) {
                                                    console.log('TAKEN after', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'filled', inner2.filled, 'txpowid', inner2.txpowid);
                                                    return settle(inner2.txpowid);
                                                }
                                                if (inner2.k === 'refused' && inner2.orderId === order.orderId) die('maker refused: ' + inner2.reason);
                                            }
                                            if (Date.now() - t0 > 120000) die('no reply from maker in 120 s');
                                            waitReply();
                                        });
                                    })();
                                });
                            });
                        });
                    });
                });
            });
        });
    });
})));

function fetchCoins(ids, cb) {
    const out = []; let i = 0;
    (function next() {
        if (i >= ids.length) return cb(null, out);
        AX.mds.cmdR('coins coinid:' + ids[i++], (err, rows) => { if (err) return cb(err); const c = Array.isArray(rows) ? rows[0] : rows; if (!c) return cb(new Error('coin missing')); out.push(c); next(); });
    })();
}
function settle(txpowid) {
    step('settlement: txpow onchain');
    const t0 = Date.now();
    (function check() {
        AX.mds.cmdR('txpow onchain:' + txpowid, (err, r) => {
            if (!err && r && r.found === true) { console.log('ON CHAIN block', r.block, 'confirmations', r.confirmations); console.log('\nHEADLESS E2E PASS'); process.exit(0); }
            if (Date.now() - t0 > 180000) die('not on chain after 180 s');
            setTimeout(check, 5000);
        });
    })();
}
