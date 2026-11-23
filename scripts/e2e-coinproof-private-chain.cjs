#!/usr/bin/env node
/*
 * e2e-coinproof-private-chain.cjs — MANUAL proof of the coin proof hand-over (0.0.111–0.0.114) against a THROWAWAY
 * PRIVATE -test chain. NEVER in npm test, never against a node holding funds, never a public relay.
 *
 *   node scripts/e2e-coinproof-private-chain.cjs --genesis-rpc 29205 --maker-rpc 29215 --taker-rpc 29225 \
 *        --peer-ports 29201,29211,29221,29231 --token 0x<the stand-in dollar the maker minted> --out <empty dir>
 *
 * It drives the REAL engine on two light nodes of your private chain: lib/maker.js create (the age rule: placed on an
 * old proved coin, live at once, nothing relocked), the REAL service.js routing (the tick's inbox classification,
 * answerProofs, processTakes/handleTake: AX.fill.cosign + verifyAsMaker + txnpost, afterFill), the taker's REAL
 * lib/takeable.js verdict cache and lib/proofs.js Taker (asks, checks, `coinimport track:false`), and lib/fill.js plan +
 * build on the taker (the steps ui/app.js tryOrder runs). Stand-ins only for what is not the node: the relay (an
 * in-process store that verifies every envelope with lib/envelope.js, as the Java relay does — nothing leaves this
 * machine) and the kv store (memory: the node's MDS SQL is not reachable over RPC).
 *
 * It REFUSES to run unless every port is 29000 or above; every node's `status` says a -TEST version; `network` says p2p
 * disabled and every connection is 127.0.0.1 at one of --peer-ports; all three nodes have the same block 1, and it is
 * less than a day old (a fresh private genesis).
 *
 * Setup (all on ports >= 29000, -data under a scratch folder):
 *   java -jar minima.jar -data <d>/g -port 29201 -rpcenable -test -nop2p -genesis
 *   java -jar minima.jar -data <d>/m -port 29211 -rpcenable -test -nop2p -connect 127.0.0.1:29201     (maker, light)
 *   java -jar minima.jar -data <d>/t -port 29221 -rpcenable -test -nop2p -connect 127.0.0.1:29201     (taker, light)
 *   fund maker and taker from the genesis node (send ... split:5); on the maker: tokencreate name:TUSD amount:1000000
 *   decimals:8, then send 1000 of it to itself split:10; wait until those coins are older than the taker's tree
 *   (`coins coinid:<one of them>` on the taker returns []: ~40 blocks on -test).
 *
 * Runs: POSITIVE — maker places BUY 100 MINIMA @ 0.5 (50 TUSD) on an old coin; the taker's node cannot see it; the
 * taker asks, imports, sees it, takes 100; the maker co-signs and posts; MINED; balances move by exactly 100 MINIMA and
 * 50 TUSD. NEGATIVE (each on its own order and old coin, forged replies signed with the maker's identity): a stale
 * proof, a tampered proof, the proof of a different coin — each: nothing imported or refused by the node, the order
 * never shown, nothing built, nothing sent, the maker's coin unspent.
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http'), nodeCrypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
function refuse(why) { console.error('REFUSED: ' + why + '. Nothing was sent.'); process.exit(2); }
const GP = Number(arg('genesis-rpc')), MP = Number(arg('maker-rpc')), TP = Number(arg('taker-rpc')), TOKEN = String(arg('token') || ''), OUT = arg('out');
const PEERS = String(arg('peer-ports') || '').split(',').filter(Boolean).map(Number);
for (const [n, p] of [['genesis-rpc', GP], ['maker-rpc', MP], ['taker-rpc', TP]]) if (!Number.isInteger(p) || p < 29000 || p > 65535) refuse('--' + n + ' must be given and be 29000 or above');
if (!PEERS.length || PEERS.some((p) => !(Number.isInteger(p) && p >= 29000))) refuse('--peer-ports must list the p2p ports of your own private nodes, each 29000 or above');
if (!/^0x[0-9A-Fa-f]{64}$/.test(TOKEN)) refuse('--token must be the stand-in dollar token id the maker minted');
if (!OUT) refuse('--out must name an output folder');
fs.mkdirSync(OUT, { recursive: true });
if (fs.readdirSync(OUT).length) refuse('--out must be empty');

const t0 = Date.now(), cmdLog = fs.createWriteStream(path.join(OUT, 'commands.log')), transcript = [];
function say(step, detail) { const line = Object.assign({ t: Date.now() - t0, step }, detail || {}); transcript.push(line); console.log(JSON.stringify(line)); fs.writeFileSync(path.join(OUT, 'transcript.json'), JSON.stringify(transcript, null, 1)); }
function fail(why) { say('FAIL', { why }); console.error('FAIL: ' + why); process.exit(1); }
const NAMES = { [GP]: 'GENESIS', [MP]: 'MAKER', [TP]: 'TAKER' };
function rpc(port, cmd) {
    if (!(port >= 29000)) return Promise.reject(new Error('REFUSED port ' + port));
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/' + encodeURIComponent(cmd), timeout: 120000, insecureHTTPParser: true, agent: false }, (r) => {   // the node's RPC: a bare-LF status line, one request per connection
            let b = ''; r.on('data', (d) => b += d);
            r.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { status: false, error: 'bad json: ' + b.slice(0, 200) }; } cmdLog.write((Date.now() - t0) + 'ms ' + NAMES[port] + ' ' + cmd + ' -> ' + j.status + (j.status ? '' : ' ' + (j.error || j.message)) + '\n'); resolve(j); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => { cmdLog.write((Date.now() - t0) + 'ms ' + NAMES[port] + ' ' + cmd + ' -> ERROR ' + e.message + '\n'); resolve({ status: false, error: e.message }); });
    });
}
const ok = (r, what) => { if (!r || r.status !== true) throw new Error(what + ': ' + (r && (r.error || r.message))); return r.response; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, ms = 600000, every = 3000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) fail('timed out waiting for ' + label); await sleep(every); } }
async function tip(port) { return Number(ok(await rpc(port, 'block'), 'block').block); }
async function seen(port, coin) { return ok(await rpc(port, 'coins coinid:' + coin), 'coins coinid'); }
async function balances(port) { const out = {}; ok(await rpc(port, 'balance'), 'balance').forEach((b) => { out[String(b.tokenid).toUpperCase()] = b.confirmed; }); return out; }

async function guard(port) {
    const st = ok(await rpc(port, 'status'), 'status'), net = ok(await rpc(port, 'network'), 'network'), b1 = ok(await rpc(port, 'txpow block:1'), 'txpow block:1');
    const born = Number(b1.header && b1.header.timemilli), conns = (net.connections || []).map((c) => ({ host: c.host, minimaport: Number(c.minimaport) }));
    const why = !/-TEST/.test(String(st.version)) ? 'not a -test chain (' + st.version + ')'
        : (net.details && net.details.p2p) !== 'disabled' ? 'p2p is not disabled'
        : conns.some((c) => c.host !== '127.0.0.1' || PEERS.indexOf(c.minimaport) < 0) ? 'connected to a node that is not one of --peer-ports: ' + JSON.stringify(conns)
        : !(born > 0 && Date.now() - born < 86400000) ? 'block 1 is not less than a day old (' + new Date(born).toISOString() + ')' : '';
    if (why) refuse(NAMES[port] + ' at ' + port + ': ' + why);
    return { node: NAMES[port], port, version: st.version, block: st.chain.block, block1: b1.txpowid, block1Time: new Date(born).toISOString(), megammr: st.megammr, connections: conns };
}

// ---- the real libs, one sandbox per node; MDS.cmd = that node's RPC ----
const FILES = ['lib/rhino_shim.js', 'vendor/nacl.js', 'vendor/blake.js', 'vendor/sha256.js', 'vendor/sha512.js', 'vendor/decimal.js', 'lib/hex.js', 'lib/flow.js', 'crypto/ax_sodium.js',
    'lib/identity.js', 'lib/mdsw.js', 'doors/signgate.js', 'lib/envelope.js', 'lib/relay.js', 'lib/fill.js', 'doors/sha3.js', 'lib/takeable.js', 'lib/maker.js', 'lib/proofs.js'];
function sandbox(port, tag) {
    const sb = { Uint8Array, Int8Array, Uint32Array, ArrayBuffer, DataView, Array, Object, Math, Date, JSON, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean,
        Symbol, Map, Set, Function, RegExp, encodeURIComponent, decodeURIComponent, console, setTimeout, clearTimeout };
    sb.globalThis = sb;
    sb.MDS = { cmd: (c, cb) => { rpc(port, c).then(cb); }, log: (s) => say(tag + ' MDS.log', { line: String(s) }) };
    const ctx = vm.createContext(sb);
    for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8') + (f === 'doors/sha3.js' ? '\n;globalThis.AXSHA3 = AXSHA3;' : ''), ctx, { filename: f });
    vm.runInContext('AX.sodium.setPRNG(__fill)', Object.assign(ctx, { __fill: (x, n) => { const b = nodeCrypto.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; } }));
    const kv = {};   // stand-in for the kv table (MDS SQL)
    Object.assign(ctx.AX.mds, { kvInit: (cb) => cb && cb(null), kvGet: (k, d, cb) => cb(Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : d), kvSet: (k, v, cb) => { kv[k] = String(v); if (cb) cb(null); }, kvDel: (k, cb) => { delete kv[k]; if (cb) cb(null); } });
    return { ctx, AX: ctx.AX, kv };
}
const call = (fn, ...args) => new Promise((res) => fn(...args, (...r) => res(r)));

// ---- the relay stand-in: an in-process store, every envelope verified like the Java relay ----
const RELAY_URL = 'http://127.0.0.1:1';   // okUrl accepts it; never connected to: the transport below answers in-process
function relayStore(verify) {
    const st = { orders: {}, log: [], cursor: 0, inbox: {}, msgCursor: 0, msgs: [] };
    const now = () => Math.floor(Date.now() / 1000);
    const transport = {
        post(url, body, cb) {
            const p = url.slice(RELAY_URL.length), v = verify(body, now());
            if (!v.ok) return setImmediate(() => cb(null, JSON.stringify({ ok: false, error: v.error })));
            if (p === '/dex/publish' && v.kind === 'order') {
                const have = st.orders[v.key];
                if (have && have.seq >= v.env.seq) return setImmediate(() => cb(null, '{"ok":false,"error":"stale seq"}'));
                st.orders[v.key] = { seq: v.env.seq, raw: body }; st.log.push({ c: ++st.cursor, raw: body });
                return setImmediate(() => cb(null, JSON.stringify({ ok: true, seq: v.env.seq, cursor: st.cursor })));
            }
            if (p === '/dex/msg' && v.kind === 'msg') {
                const to = v.env.to.toLowerCase(); (st.inbox[to] = st.inbox[to] || []).push({ c: ++st.msgCursor, raw: body }); st.msgs.push({ to, from: v.env.from.toLowerCase(), chars: body.length });
                return setImmediate(() => cb(null, '{"ok":true}'));
            }
            setImmediate(() => cb(null, '{"ok":false,"error":"bad path"}'));
        },
        get(url, cb) {
            const u = new URL(url), since = Number(u.searchParams.get('since') || 0);
            if (u.pathname.endsWith('/dex/book')) return setImmediate(() => cb(null, JSON.stringify({ cursor: st.cursor, reset: since === 0, orders: st.log.filter((l) => l.c > since).map((l) => l.raw) })));
            if (u.pathname.endsWith('/dex/inbox')) { const q = st.inbox[String(u.searchParams.get('pk')).toLowerCase()] || []; return setImmediate(() => cb(null, JSON.stringify({ cursor: st.msgCursor, messages: q.filter((m) => m.c > since).map((m) => m.raw) }))); }
            setImmediate(() => cb(new Error('bad path')));
        }
    };
    return { st, transport };
}

/** The source of one top-level function of service.js (braces counted; the functions taken hold no brace in a string). */
function fnSrc(src, name) {
    const i = src.indexOf('\nfunction ' + name + '(');
    if (i < 0) throw new Error('service.js has no function ' + name);
    for (let k = src.indexOf('{', i), depth = 0; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i + 1, k + 1); }
    throw new Error('unbalanced ' + name);
}

(async function main() {
    // ---- 1. refusals ----
    const g = [await guard(GP), await guard(MP), await guard(TP)];
    if (new Set(g.map((x) => x.block1)).size !== 1) refuse('the three nodes do not share block 1: ' + JSON.stringify(g.map((x) => [x.node, x.block1])));
    if (g[1].megammr || g[2].megammr) refuse('maker and taker must be light nodes (no -megammr) for this proof');
    say('chain', { nodes: g });

    // ---- 2. the two sides ----
    const maker = sandbox(MP, 'MAKER'), taker = sandbox(TP, 'TAKER');
    const relay = relayStore((raw, now) => maker.AX.envelope.verify(raw, now));
    for (const s of [maker, taker]) {
        s.kv.relays = JSON.stringify([RELAY_URL]); s.kv.mxusd_tokenid = TOKEN;
        const [applied] = await call(s.AX.fill.overrideOnTestChain, s.AX.mds, TOKEN);
        if (!applied) fail('the dollar-token override was refused (not a test chain?)');
    }
    maker.kv.coin_max_age = '10';   // a -test tree is ~32 blocks: COIN_MAX_AGE lowered so the backing coin counts as stale
    async function identity(s) { const [e, r] = await call(s.AX.mds.cmdR, 'seedrandom modifier:dexicon-identity-v1'); if (e) fail('seedrandom: ' + e.message); return s.AX.identity.fromSeed(r.seedrandom, 'decks'); }
    const mMe = await identity(maker), tMe = await identity(taker);
    const mClient = new maker.AX.relay.Client(relay.transport), tClient = new taker.AX.relay.Client(relay.transport);
    mClient.setRelays([RELAY_URL]); tClient.setRelays([RELAY_URL]);
    say('identities', { maker: mMe.publicId(), taker: tMe.publicId() });

    // the maker's service.js, its real functions (the tick's inbox routing, the proof answer, the take handling)
    const svc = fs.readFileSync(path.join(ROOT, 'service.js'), 'utf8');
    const tickSrc = fnSrc(svc, 'tick'), a = tickSrc.indexOf('var takes = [], perSender = {}'), b = tickSrc.indexOf('processTakes(takes,');
    if (a < 0 || b < 0) fail('service.js tick() no longer has the inbox routing this harness runs');
    const svcLog = [];
    vm.runInContext('var ME = __me, RELAY = __relay, myAddresses = {}, coinLocks = {}, LOCK_MS = 180000;\nfunction log(s) { __log(s); }\nfunction nowS() { return Math.floor(Date.now() / 1000); }\nfunction notify() { }\n'
        + ['refreshAddresses', 'addressList', 'lockCoins', 'unlockCoins', 'sealed', 'reply', 'answerProofs', 'processTakes', 'handleTake'].map((n) => fnSrc(svc, n)).join('\n')
        + '\nfunction classify(msgs) { ' + tickSrc.slice(a, b) + ' return { takes: takes, asks: asks }; }', Object.assign(maker.ctx, { __me: mMe, __relay: mClient, __log: (s) => { svcLog.push(s); say('MAKER service log', { line: s }); } }));
    async function makerTick(honest) {
        const [err, msgs] = await call((cb) => mClient.pollInbox(mMe.publicId(), 0, cb));
        if (err) fail('maker inbox: ' + err.message);
        const r = maker.ctx.classify(msgs);
        if (!honest) return r;   // an attacker's turn: the requests are read, not answered
        await new Promise((res) => maker.ctx.processTakes(r.takes, () => maker.ctx.answerProofs(r.asks, res)));
        return r;
    }

    // the taker's page: the verdict cache + the proof taker exactly as ui/app.js wires them
    const T = taker.AX.takeable, tLog = [], tSign = '0x' + taker.AX.hex.to(tMe.signPk).toLowerCase();
    let PF = null;
    const VC = new T.Cache((c, cb) => taker.AX.mds.cmdR(c, cb), { log: (s) => tLog.push(s), onMissing: (o) => PF.want(o), afterPass: () => PF.flush() });
    PF = new taker.AX.proofs.Taker({ cmd: (c, cb) => taker.AX.mds.cmdR(c, cb),
        send: (o, ids) => tClient.publish(taker.AX.envelope.msg(tMe, o.pubId, taker.AX.identity.seal(tMe, o.pubId, taker.AX.hex.utf8(JSON.stringify({ k: 'proofs?', coins: ids }))), Math.floor(Date.now() / 1000) + 120), () => { }),
        proven: (ids) => { tLog.push('proven ' + ids.join(', ')); VC.proven(ids); }, log: (s) => { tLog.push(s); say('TAKER log', { line: s }); } });
    const replies = [];
    async function takerInbox() {
        const [err, msgs] = await call((cb) => tClient.pollInbox(tMe.publicId(), 0, cb));
        if (err) fail('taker inbox: ' + err.message);
        for (const m of msgs) {
            const opened = taker.AX.identity.open(tMe, m.env.blob); if (!opened || !opened.valid) continue;
            const inner = JSON.parse(taker.AX.hex.utf8Decode(opened.plaintext));
            if (inner.k === 'proofs') PF.reply(opened.fromPublicId, inner.proofs); else replies.push(inner);
        }
        await waitFor('the taker\'s imports', async () => !PF.busy && !PF.jobs.length, 120000, 500);
    }
    async function takerWarm() {
        const [e] = await call((cb) => tClient.pollBook(0, cb)); if (e) fail('book: ' + e.message);
        const h = await tip(TP); VC.onBlock(h); PF.onBlock(h);
        await new Promise((res) => VC.warm(tClient.orders(), tSign, res));
        return tClient.orders();
    }
    const verdict = (o) => T.check(o, VC.verdicts(), tSign);

    // stale proof material: every old maker token coin exported NOW (the negative "stale proof" uses one much later)
    const mCoins = ok(await rpc(MP, 'coins relevant:true tokenid:' + TOKEN), 'coins').filter((c) => !c.spent);
    const earlyTip = await tip(MP), early = {};
    // only coins already older than the taker's tree count as old (a fill's change coin from an earlier run is young)
    for (const c of mCoins) if (!(await seen(TP, c.coinid)).length) early[c.coinid.toUpperCase()] = ok(await rpc(MP, 'coinexport coinid:' + c.coinid), 'coinexport').data;
    if (Object.keys(early).length < 4) fail('fewer than 4 maker token coins are older than the taker\'s tree: wait, or split more');
    say('early exports (for the stale-proof run)', { atMakerTip: earlyTip, coins: Object.keys(early) });

    async function place(label) {
        // every maker token coin that is not one of the old ones exported above (a fill's change coin is young) is held, so the
        // order is backed by an OLD coin (AX.maker.holds: a coin listed in kv pending_takes `mine` is never picked)
        const young = ok(await rpc(MP, 'coins relevant:true tokenid:' + TOKEN), 'coins').map((c) => c.coinid).filter((id) => !early[id.toUpperCase()]);
        maker.kv.pending_takes = JSON.stringify({ harness: { mine: young } });
        const before = relay.st.log.length, cmdsAt = fs.statSync(path.join(OUT, 'commands.log')).size;
        const [err, o, results, notice] = await call(maker.AX.maker.create, maker.AX.mds, mClient, mMe, { side: 'buy', price: '0.5', amount: '100' });
        if (err) fail(label + ': create failed: ' + err.message);
        await sleep(300);
        const issued = fs.readFileSync(path.join(OUT, 'commands.log'), 'utf8').slice(cmdsAt).split('\n').filter((l) => / MAKER /.test(l)).map((l) => l.replace(/^\d+ms MAKER /, ''));
        const h = await tip(MP), rows = [];
        for (const c of o.coins) rows.push(ok(await rpc(MP, 'coins coinid:' + c), 'coins')[0]);
        const relocks = issued.filter((l) => /^txncreate id:rl/.test(l) || /^txnpost id:rl/.test(l));
        say(label + ': maker placed', { orderId: o.orderId, coins: o.coins, coinCreated: rows.map((r) => r && r.created), makerTip: h, ages: rows.map((r) => h - Number(r.created)), relocking: o.relocking || [], notice, published: relay.st.log.length - before,
            relays: results.map((r) => r.ok), relockCommands: relocks, coinexports: issued.filter((l) => /^coinexport/.test(l)) });
        if (notice !== '' || (o.relocking || []).length || relocks.length) fail(label + ': the order was not live at once without a relock');
        for (const c of o.coins) if ((await seen(TP, c)).length) fail(label + ': the taker already sees ' + c + ' — wait until the maker\'s coins are older than the taker\'s tree');
        say(label + ': taker cannot see the coin', { coins: o.coins, takerTip: await tip(TP), takerCoinsCoinid: [] });
        return o;
    }

    // ================= POSITIVE =================
    await new Promise((res) => maker.ctx.refreshAddresses(res));   // as the service does at boot
    const balBefore = { maker: await balances(MP), taker: await balances(TP) };
    const o1 = await place('POSITIVE');
    let orders = await takerWarm();
    let env = orders.find((x) => x.orderId === o1.orderId);
    if (!env) fail('the taker does not have the order from the relay');
    say('POSITIVE: taker verdict before any proof', { verdict: verdict(env), requestsToMaker: relay.st.msgs.filter((m) => m.to === mMe.publicId().toLowerCase()).length });
    if (verdict(env).state === 'ok') fail('shown before a proof');
    const r1 = await makerTick(true);
    say('POSITIVE: maker service answered', { requests: r1.asks, log: svcLog.slice(-1) });
    await takerInbox();
    orders = await takerWarm(); env = orders.find((x) => x.orderId === o1.orderId);
    const c1 = o1.coins[0], after = await seen(TP, c1), relevant = ok(await rpc(TP, 'coins relevant:true coinid:' + c1), 'coins');
    say('POSITIVE: after the import', { verdict: verdict(env), takerCoinsCoinid: after.map((x) => ({ coinid: x.coinid, created: x.created, address: x.address, tokenid: x.tokenid, tokenamount: x.tokenamount })), relevantOnTaker: relevant.length, takerLog: tLog.slice() });
    if (verdict(env).state !== 'ok') fail('not takeable after the proof: ' + verdict(env).reason);
    if (relevant.length) fail('the imported coin became relevant on the taker');
    // the take, as ui/app.js tryOrder: this height's rows, the check, plan, build, sealed take
    const F = taker.AX.fill, mc = [];
    for (const id of env.coins) { let row = VC.coin(id); if (!row) { const [e2, r2] = await call((cb) => VC.ask(id, cb)); if (e2 || !r2) fail('maker coin lookup: ' + (e2 ? e2.message : 'missing')); row = r2; } mc.push(row); }
    if (VC.refresh(env, tSign).state !== 'ok') fail('the take check refused it');
    const [ew, myCoins] = await call(taker.AX.maker.walletCoins, taker.AX.mds, F.MINIMA);
    if (ew) fail('taker coins: ' + ew.message);
    const tAddr = ok(await rpc(TP, 'getaddress'), 'getaddress').address;
    const plan = F.plan(env, '100', mc, myCoins, tAddr);
    say('POSITIVE: taker plan', { inputs: plan.inputs, outputs: plan.outputs, takerGives: plan.takerGives, makerGives: plan.makerGives });
    const [eb, hex] = await call(F.build, taker.AX.mds, plan);
    if (eb) fail('taker build: ' + eb.message);
    await call((cb) => tClient.publish(taker.AX.envelope.msg(tMe, env.pubId, taker.AX.identity.seal(tMe, env.pubId, taker.AX.hex.utf8(JSON.stringify({ k: 'take', orderId: env.orderId, txn: hex, taker: tMe.publicId() }))), Math.floor(Date.now() / 1000) + 300), cb));
    say('POSITIVE: take sent', { txnChars: hex.length });
    await makerTick(true);
    await takerInbox();
    const taken = replies.find((x) => x.orderId === o1.orderId);
    say('POSITIVE: maker answered the take', { reply: taken, makerLog: svcLog.slice(-3) });
    if (!taken || taken.k !== 'taken') fail('the maker did not co-sign: ' + JSON.stringify(taken));
    const fill = JSON.parse(maker.kv['fill_' + taken.txpowid]);
    const outCoin = fill.coins[0];
    await waitFor('the fill mined', async () => (await seen(MP, c1)).length === 0 && (await seen(MP, outCoin)).length > 0);
    const created = Number((await seen(MP, outCoin))[0].created), blk = ok(await rpc(MP, 'txpow block:' + created), 'txpow block');
    let mined = null;
    for (const id of (blk.istransaction ? [blk.txpowid] : []).concat(blk.body.txnlist || [])) {
        const t = id === blk.txpowid ? blk : ok(await rpc(MP, 'txpow txpowid:' + id), 'txpow');
        if ((t.body.txn.inputs || []).some((x) => x.coinid.toUpperCase() === c1.toUpperCase())) { mined = t; break; }
    }
    if (!mined) fail('no transaction in block ' + created + ' spends ' + c1);
    await waitFor('balances settle', async () => { const t = await balances(TP), m = await balances(MP); return t[TOKEN.toUpperCase()] !== balBefore.taker[TOKEN.toUpperCase()] && m['0X00'] !== balBefore.maker['0X00']; }, 300000);
    await sleep(8000);
    const balAfter = { maker: await balances(MP), taker: await balances(TP) };
    const D = taker.ctx.Decimal, delta = (side, tok) => new D(balAfter[side][tok] || 0).minus(new D(balBefore[side][tok] || 0)).toFixed();
    const moved = { makerMINIMA: delta('maker', '0X00'), makerTUSD: delta('maker', TOKEN.toUpperCase()), takerMINIMA: delta('taker', '0X00'), takerTUSD: delta('taker', TOKEN.toUpperCase()) };
    say('POSITIVE: MINED', { postedTxpowid: taken.txpowid, minedTxpowid: mined.txpowid, inBlock: created, transactionid: mined.body.txn.transactionid,
        inputs: mined.body.txn.inputs.map((x) => x.coinid), outputs: mined.body.txn.outputs.map((x) => ({ coinid: x.coinid, address: x.address, tokenid: x.tokenid, amount: x.tokenid === '0x00' ? x.amount : x.tokenamount })),
        balancesBefore: balBefore, balancesAfter: balAfter, moved, order: JSON.parse(maker.kv.myorders).find((x) => x.orderId === o1.orderId) });
    if (JSON.stringify(moved) !== JSON.stringify({ makerMINIMA: '100', makerTUSD: '-50', takerMINIMA: '-100', takerTUSD: '50' })) fail('balances did not move by exactly 100 MINIMA and 50 TUSD: ' + JSON.stringify(moved));

    // ================= NEGATIVES =================
    // each negative keeps its order live (cancelled at the end), so each runs on its own old coin the taker never asked for
    const negOrders = [];
    async function negative(label, forge) {
        const o = await place(label), c = o.coins[0]; negOrders.push(o.orderId);
        let os = await takerWarm(), e = os.find((x) => x.orderId === o.orderId);
        const r = await makerTick(false);   // the maker's inbox is read; an attacker answers instead of the honest service
        if (!r.asks.some((q) => q.coins.indexOf(c) >= 0)) fail(label + ': the taker did not ask for ' + c);
        const forged = {}; forged[c] = await forge(c);
        const sentBefore = relay.st.msgs.length, cmdsAt = fs.statSync(path.join(OUT, 'commands.log')).size;
        await call((cb) => mClient.publish(maker.AX.envelope.msg(mMe, tMe.publicId(), maker.AX.identity.seal(mMe, tMe.publicId(), maker.AX.hex.utf8(JSON.stringify({ k: 'proofs', proofs: forged }))), Math.floor(Date.now() / 1000) + 300), cb));
        const logAt = tLog.length;
        await takerInbox();
        os = await takerWarm(); e = os.find((x) => x.orderId === o.orderId);
        await sleep(300);
        const issued = fs.readFileSync(path.join(OUT, 'commands.log'), 'utf8').slice(cmdsAt).split('\n').filter((l) => / TAKER /.test(l)).map((l) => l.replace(/^\d+ms TAKER /, ''));
        const shown = T.visible(tClient.orders(), VC.verdicts(), tSign)[T.okey(e)] === true;
        const takeMsgs = relay.st.msgs.slice(sentBefore + 1).filter((m) => m.from === tMe.publicId().toLowerCase());
        const builds = issued.filter((l) => /^(txncreate|newscript|txninput|txnsign)/.test(l));
        say(label + ': result', { coin: c, takerLog: tLog.slice(logAt), coinimportCommands: issued.filter((l) => /^coinimport/.test(l)).map((l) => l.replace(/data:\S+/, 'data:<' + (l.match(/data:(\S+)/) || [0, ''])[1].length + ' chars>')),
            verdict: verdict(e), shownAsMarket: shown, takerSentAfterward: takeMsgs.length, takerBuildCommands: builds, takerSeesCoin: (await seen(TP, c)).length, makerCoinUnspent: (await seen(MP, c)).length === 1 });
        if (shown || takeMsgs.length || builds.length || (await seen(MP, c)).length !== 1) fail(label + ': the order was shown, or something was built or sent');
    }
    await negative('NEGATIVE tampered proof', async (c) => { const d = ok(await rpc(MP, 'coinexport coinid:' + c), 'coinexport').data; const last = d.slice(-1); return d.slice(0, -1) + (last === '0' ? '1' : '0'); });
    await negative('NEGATIVE proof of a different coin', async (c) => { const other = mCoins.find((x) => x.coinid.toUpperCase() !== c.toUpperCase() && !JSON.parse(maker.kv.myorders).some((o) => (o.coins || []).indexOf(x.coinid) >= 0)); return ok(await rpc(MP, 'coinexport coinid:' + other.coinid), 'coinexport').data; });
    // the stale proof: exported at the start, its proof block (the maker's tip - 8 on -test) now below the taker's tree
    await waitFor('the early proofs to go stale', async () => { const c = ok(await rpc(TP, 'status'), 'status').chain; return c.block - c.length > earlyTip; }, 3600000, 5000);
    await negative('NEGATIVE stale proof', async (c) => { if (!early[c.toUpperCase()]) fail('no early export of ' + c); return early[c.toUpperCase()]; });
    for (const id of negOrders) await call(maker.AX.maker.cancel, maker.AX.mds, mClient, mMe, id);
    say('ALL RUNS PASSED', { relayMessages: relay.st.msgs.length, maxMsgChars: Math.max.apply(null, relay.st.msgs.map((m) => m.chars)) });
    cmdLog.end();
})().catch((e) => fail(e.stack || String(e)));
