/**
 * headless.js — drive the REAL MiniDapp libs against REAL nodes and a REAL relay without a browser.
 * Talks to each node exactly as the page does: POST https://<mds>/mdscommand_/{cmd|sql}?uid=<session> (the
 * per-MiniDapp session id the node prints in `mds`). TWO nodes: the MAKER node's installed service.js co-signs,
 * this script plays the maker's PAGE (publish) and the TAKER's page (plan, build, sign, sealed take).
 *
 *   node test/headless.js --maker-mds https://127.0.0.1:19303 --maker-session 0x… \
 *                         --taker-mds https://127.0.0.1:19403 --taker-session 0x… \
 *                         --relay http://127.0.0.1:19702 [--token 0x<dev dollar tokenid>] [--price 0.5] [--amount 10] [--take 3]
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), https = require('https'), http = require('http');
const ROOT = path.join(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null).filter(Boolean));
const RELAY = args.relay, TOKEN = args.token || '', PRICE = args.price || '0.5', AMOUNT = args.amount || '10', TAKE = args.take || '3', MAXAGE = args['max-age'] || '';
const MAKER = { mds: args['maker-mds'], session: args['maker-session'] }, TAKER = { mds: args['taker-mds'], session: args['taker-session'] };
if (!RELAY || !MAKER.mds || !MAKER.session || !TAKER.mds || !TAKER.session) { console.error('need --relay --maker-mds --maker-session --taker-mds --taker-session'); process.exit(2); }

function post(u, body, cb) {
    const o = new URL(u), mod = o.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: o.hostname, port: o.port, path: o.pathname + o.search, method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => cb(null, d, res.statusCode)); });
    req.on('error', (e) => cb(e)); req.end(body);
}
function get(u, cb) {
    const o = new URL(u), mod = o.protocol === 'https:' ? https : http;
    mod.get({ hostname: o.hostname, port: o.port, path: o.pathname + o.search, rejectUnauthorized: false }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => cb(null, d)); }).on('error', (e) => cb(e));
}
const nodeCrypto = require('crypto');
const transport = { get: (u, cb) => get(u, (e, t) => cb(e, t)), post: (u, b, cb) => post(u, b, (e, t) => cb(e, t)) };

/** One isolated sandbox per node, with MDS shimmed onto that node's session (same wire format as mds.js). */
function sandboxFor(node, tag) {
    const mdsPost = (kind, command, cb) => post(node.mds + '/mdscommand_/' + kind + '?uid=' + node.session, command, (err, text) => {
        if (err) return cb({ status: false, error: String(err) });
        try { cb(JSON.parse(text)); } catch (e) { cb({ status: false, error: 'bad json: ' + text.slice(0, 120) }); }
    });
    const sb = { Uint8Array, Int8Array, Uint32Array, ArrayBuffer, DataView, Array, Object, Math, Date, JSON, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean, Symbol, Map, Set, Function, RegExp, encodeURIComponent, decodeURIComponent, console };
    sb.globalThis = sb;
    sb.MDS = { cmd: (c, cb) => mdsPost('cmd', c, cb), sql: (q, cb) => mdsPost('sql', q, cb), log: (s) => console.log('[' + tag + ' mds.log]', s),
               net: { GET: (u, cb) => get(u, (e, t) => cb(e ? { status: false, error: String(e) } : { status: true, response: t })), POST: (u, b, cb) => post(u, b, (e, t) => cb(e ? { status: false, error: String(e) } : { status: true, response: t })) } };
    const ctx = vm.createContext(sb);
    for (const f of ['lib/rhino_shim.js', 'vendor/nacl.js', 'vendor/blake.js', 'vendor/sha256.js', 'vendor/sha512.js', 'vendor/decimal.js', 'lib/hex.js', 'lib/flow.js', 'crypto/ax_sodium.js', 'lib/identity.js', 'lib/mdsw.js', 'lib/envelope.js', 'lib/relay.js', 'lib/fill.js', 'lib/maker.js'])
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    vm.runInContext('AX.sodium.setPRNG(__fill)', Object.assign(ctx, { __fill: (x, n) => { const b = nodeCrypto.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; } }));
    return ctx.AX;
}
const nowS = () => Math.floor(Date.now() / 1000);
const step = (s) => console.log('\n== ' + s);
const die = (m) => { console.error('FAIL: ' + m); process.exit(1); };

/** kv setup + identity for one node. cb(AX, me, client) */
function prepare(node, tag, cb) {
    const AX = sandboxFor(node, tag);
    AX.mds.kvInit(() => AX.mds.kvSet('relays', JSON.stringify([RELAY]), (e1) => AX.mds.kvSet('mxusd_tokenid', TOKEN, (e2) => AX.mds.kvSet('coin_max_age', MAXAGE, (e2b) => {
        if (e1 || e2 || e2b) die(tag + ' kv ' + (e1 || e2 || e2b));
        if (TOKEN) AX.fill.setMxUsd(TOKEN);
        AX.mds.cmdR('vault action:seed', (err, r) => {
            if (err || !r || !r.seed) die(tag + ' vault action:seed: ' + (err && err.message));
            const me = AX.identity.fromSeed(r.seed, 'decks');
            const client = new AX.relay.Client(transport);
            client.setRelays([RELAY]);
            console.log(tag, 'publicId', me.publicId());
            cb(AX, me, client);
        });
    }))));
}

step('prepare maker + taker (kv relays/token, identities)');
prepare(MAKER, 'maker', (AXm, maker, cm) => prepare(TAKER, 'taker', (AXt, taker, ct) => {
    if (maker.publicId() === taker.publicId()) die('maker and taker are the SAME identity — point --taker-* at a different node');
    step('maker: cancel live orders from earlier runs (frees their backing coins)');
    AXm.maker.load(AXm.mds, (eL, list) => {
        const live = (list || []).filter((o) => o.status === 'live'); let k = 0;
        (function cancelNext() {
            if (k >= live.length) return createOrder();
            const oid = live[k++].orderId;
            AXm.maker.cancel(AXm.mds, cm, maker, oid, (eC) => { console.log('cancelled', oid, eC ? '(' + eC.message + ')' : ''); cancelNext(); });
        })();
    });
    function createOrder() {
        step('maker: create sell ' + AMOUNT + ' MINIMA @ ' + PRICE);
        AXm.maker.create(AXm.mds, cm, maker, { side: 'sell', price: PRICE, amount: AMOUNT }, (e3, o, results) => {
            if (e3) die('create: ' + e3.message);
            console.log('order', o.orderId, 'coins', o.coins.length, 'relay results', JSON.stringify(results));
            step('taker: relay book shows it');
            ct.pollBook(1, () => {
                const live = ct.orders().filter((x) => x.orderId === o.orderId);
                if (!live.length) die('order not in relay book');
                const order = live[0];
                console.log('book has', ct.orders().length, 'order(s); ours at', order.price, 'x', order.amount);
                step('taker: plan ' + TAKE + ' MINIMA');
                fetchCoins(AXt, order.coins, (e5, makerCoins) => {
                    if (e5) die('maker coins (as seen from taker node): ' + e5.message);
                    AXt.maker.walletCoins(AXt.mds, order.side === 'sell' ? AXt.fill.MXUSD : AXt.fill.MINIMA, (e6, myCoins) => {
                        if (e6) die('taker coins: ' + e6.message);
                        AXt.mds.cmdR('getaddress', (e7, addr) => {
                            let p; try { p = AXt.fill.plan(order, TAKE, makerCoins, myCoins, addr.address); } catch (e) { die('plan: ' + e.message); }
                            console.log('plan: give', p.takerGives, 'receive', p.makerGives, 'inputs', p.inputs.length, 'outputs', p.outputs.length);
                            step('taker: build + sign own inputs + export');
                            AXt.fill.build(AXt.mds, p, (e8, hex) => {
                                if (e8) die('build: ' + e8.message);
                                console.log('txn hex bytes', hex.length / 2);
                                const inner = JSON.stringify({ k: 'take', orderId: order.orderId, txn: hex, taker: taker.publicId() });
                                const blob = AXt.identity.seal(taker, order.pubId, AXt.hex.utf8(inner));
                                const msg = AXt.envelope.msg(taker, order.pubId, blob, nowS() + 300);
                                step('taker: publish sealed take; wait for the maker service');
                                ct.publish(msg, (res) => {
                                    console.log('msg relay results', JSON.stringify(res), 'at', new Date().toISOString());
                                    const t0 = Date.now();
                                    (function waitReply() {
                                        ct.pollInbox(taker.publicId(), 20, (e9, msgs) => {
                                            for (const m of msgs) {
                                                const opened = AXt.identity.open(taker, m.env.blob);
                                                if (!opened || !opened.valid) continue;
                                                let inner2; try { inner2 = JSON.parse(AXt.hex.utf8Decode(opened.plaintext)); } catch (e) { continue; }
                                                if (inner2.k === 'taken' && inner2.orderId === order.orderId) {
                                                    console.log('TAKEN after', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'filled', inner2.filled, 'txpowid', inner2.txpowid);
                                                    return settle(AXt, inner2.txpowid);
                                                }
                                                if (inner2.k === 'refused' && inner2.orderId === order.orderId) die('maker refused after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's: ' + inner2.reason);
                                            }
                                            if (Date.now() - t0 > 180000) die('no reply from maker in 180 s');
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
    }
}));

function fetchCoins(AX, ids, cb) {
    const out = []; let i = 0;
    (function next() {
        if (i >= ids.length) return cb(null, out);
        AX.mds.cmdR('coins coinid:' + ids[i++], (err, rows) => { if (err) return cb(err); const c = Array.isArray(rows) ? rows[0] : rows; if (!c) return cb(new Error('coin missing')); out.push(c); next(); });
    })();
}
function settle(AX, txpowid) {
    step('settlement on the taker node: txpow onchain');
    const t0 = Date.now();
    (function check() {
        AX.mds.cmdR('txpow onchain:' + txpowid, (err, r) => {
            if (!err && r && r.found === true) { console.log('ON CHAIN block', r.block, 'confirmations', r.confirmations); console.log('\nHEADLESS E2E PASS'); process.exit(0); }
            if (Date.now() - t0 > 240000) die('not on chain after 240 s');
            setTimeout(check, 5000);
        });
    })();
}
