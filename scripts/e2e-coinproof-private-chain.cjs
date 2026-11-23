#!/usr/bin/env node
/*
 * e2e-coinproof-private-chain.cjs — MANUAL proof of the coin proof hand-over (0.0.111–0.0.127) and the coin-key
 * attestation (0.0.128–0.0.130) against a THROWAWAY PRIVATE -test chain. NEVER in npm test, never against a node holding
 * funds, never a public relay.
 *
 *   node scripts/e2e-coinproof-private-chain.cjs --genesis-rpc 29305 --maker-rpc 29315 --taker-rpc 29325 \
 *        --peer-ports 29301,29311,29321 --token 0x<the stand-in dollar the maker minted> --out <empty dir>
 *
 * It drives the REAL engine on two light nodes of your private chain: lib/maker.js create, the REAL service.js routing
 * (the tick's inbox classification, answerProofs → lib/proofs.js answer with its per-poll caps and the coin-key
 * attestation `sign`, processTakes/handleTake: AX.fill.cosign + verifyAsMaker + txnpost, afterFill), the taker's REAL
 * lib/takeable.js verdict cache and lib/proofs.js Taker (asks, checks, `coinimport track:false`, `verify`), wired as
 * ui/app.js wires them, and lib/fill.js plan + build on the taker. Stand-ins only for what is not the node: the relay (an
 * in-process store that verifies every envelope with lib/envelope.js and enforces the Java relay's message limits —
 * 262,144 chars a message, 200 per inbox, 20,000 in all; nothing leaves this machine) and the kv store (memory: the
 * node's MDS SQL is not reachable over RPC).
 *
 * It REFUSES to run unless every port is 29000 or above; every node's `status` says a -TEST version; `network` says p2p
 * disabled and every connection is 127.0.0.1 at one of --peer-ports; all three nodes have the same block 1, and it is
 * less than a day old (a fresh private genesis).
 *
 * Setup (all on ports >= 29000, -data under a scratch folder):
 *   java -jar minima.jar -data <d>/g -port 29301 -rpcenable -test -nop2p -genesis
 *   java -jar minima.jar -data <d>/m -port 29311 -rpcenable -test -nop2p -connect 127.0.0.1:29301 [-blockaskeyuses]  (maker)
 *   java -jar minima.jar -data <d>/t -port 29321 -rpcenable -test -nop2p -connect 127.0.0.1:29301                    (taker)
 *   fund maker and taker from the genesis node (send ... split:5); on the maker: tokencreate name:TUSD amount:1000000
 *   decimals:8; then, each to its own `newaddress` of the maker: 1000 TUSD split:10 (group A), 50 TUSD split:10 thrice
 *   (group B: 30 coins of 5; `send` splits at most 10, so 50 TUSD split:10 three times), 500 TUSD split:5 (group C) — a
 *   later send may spend a few group-A coins (6 are enough); wait until those coins are older than the taker's tree
 *   (`coins coinid:<one of them>` on the taker returns []: ~40 blocks on -test).
 *
 * Runs (the taker requires attestation — kv require_attest ON — except where said):
 *   POSITIVE     BUY 100 MINIMA @ 0.5 on an old group-A coin: placed live with no relock; the taker asks proof +
 *                attestation in one request, verifies, imports, sees it attested, takes 100; co-signed, MINED; balances
 *                move by exactly 100 MINIMA and 50 TUSD; the maker's coin never relevant on the taker.
 *   MULTI-COIN   BUY 180 @ 0.5 on 18 old group-B coins: the proofs come in several messages (chunked), all imported.
 *   IN-WINDOW    an order on a YOUNG coin, its proof pushed at the taker with the visibility lookup failing, then
 *                lying ([]): nothing imported either time; the taker's `balance` and `coins relevant:true` never hold it.
 *   COPYCAT      another identity lists a group-A coin of a live maker order with the maker's script at a better price
 *                and answers with the coin's proof and the maker's attestation, relayed: the copycat is hidden (its
 *                signature check fails), the real order is shown.
 *   NO ATTEST    an order on a group-C coin answered by a maker that does not attest (an older version): shown with
 *                require_attest OFF, hidden with it ON.
 *   NEGATIVES    (forged replies signed with the maker's identity) a tampered MMR tail, a tampered COIN BODY (amount), the
 *                proof of a different coin, a stale proof — each: refused, not shown, nothing built.
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
const issuedAll = [];   // every node command, in order: [node, command]
function rpc(port, cmd) {
    if (!(port >= 29000)) return Promise.reject(new Error('REFUSED port ' + port));
    issuedAll.push([NAMES[port], cmd]);
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
const U = (s) => String(s).toUpperCase();

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
    sb.MDS = { cmd: (c, cb) => { rpc(port, c).then(cb); }, log: (s) => say(tag + ' MDS.log', { line: String(s) }),
        sql: (q, cb) => cb({ status: false, error: 'no MDS SQL over RPC' }) };   // the claims table (lib/maker.js pageHolds): none here
    const ctx = vm.createContext(sb);
    for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8') + (f === 'doors/sha3.js' ? '\n;globalThis.AXSHA3 = AXSHA3;' : ''), ctx, { filename: f });
    vm.runInContext('AX.sodium.setPRNG(__fill)', Object.assign(ctx, { __fill: (x, n) => { const b = nodeCrypto.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; } }));
    const kv = {};   // stand-in for the kv table (MDS SQL)
    Object.assign(ctx.AX.mds, { kvInit: (cb) => cb && cb(null), kvGet: (k, d, cb) => cb(Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : d), kvSet: (k, v, cb) => { kv[k] = String(v); if (cb) cb(null); }, kvDel: (k, cb) => { delete kv[k]; if (cb) cb(null); } });
    return { ctx, AX: ctx.AX, kv };
}
const call = (fn, ...args) => new Promise((res) => fn(...args, (...r) => res(r)));

// ---- the relay stand-in: an in-process store, every envelope verified like the Java relay, with its message limits ----
const RELAY_URL = 'http://127.0.0.1:1';   // okUrl accepts it; never connected to: the transport below answers in-process
const MAX_MSG_CHARS = 262144, MAX_INBOX_PER_PK = 200, MAX_MSGS = 20000;   // maxima dexrelay Envelope.MAX_MSG_BYTES, Store.MAX_INBOX_PER_PK, Store.MAX_MSGS
function relayStore(verify) {
    const st = { orders: {}, log: [], cursor: 0, inbox: {}, msgCursor: 0, msgs: [], refused: [] };
    const now = () => Math.floor(Date.now() / 1000);
    function sweep() { const t = now(); for (const k of Object.keys(st.inbox)) st.inbox[k] = st.inbox[k].filter((m) => m.expiry > t); }   // the Java relay sweeps expired messages
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
                sweep();
                const to = v.env.to.toLowerCase(), q = st.inbox[to] = st.inbox[to] || [], total = Object.keys(st.inbox).reduce((n, k) => n + st.inbox[k].length, 0);
                const why = body.length > MAX_MSG_CHARS ? 'too big' : (total >= MAX_MSGS || q.length >= MAX_INBOX_PER_PK) ? 'inbox full' : '';
                if (why) { st.refused.push({ to, chars: body.length, why }); return setImmediate(() => cb(null, JSON.stringify({ ok: false, error: why }))); }
                q.push({ c: ++st.msgCursor, raw: body, expiry: v.env.expiry }); st.msgs.push({ to, from: v.env.from.toLowerCase(), chars: body.length, c: st.msgCursor });
                return setImmediate(() => cb(null, '{"ok":true}'));
            }
            setImmediate(() => cb(null, '{"ok":false,"error":"bad path"}'));
        },
        get(url, cb) {
            const u = new URL(url), since = Number(u.searchParams.get('since') || 0);
            if (u.pathname.endsWith('/dex/book')) return setImmediate(() => cb(null, JSON.stringify({ cursor: st.cursor, reset: since === 0, orders: st.log.filter((l) => l.c > since).map((l) => l.raw) })));
            if (u.pathname.endsWith('/dex/inbox')) { sweep(); const q = st.inbox[String(u.searchParams.get('pk')).toLowerCase()] || []; return setImmediate(() => cb(null, JSON.stringify({ cursor: st.msgCursor, messages: q.filter((m) => m.c > since).map((m) => m.raw) }))); }
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
    const mKeys = ok(await rpc(MP, 'keys'), 'keys'), mKey0 = (mKeys.keys || [])[0] || {};
    say('maker key mode', { size: mKey0.size, depth: mKey0.depth, maxuses: mKey0.maxuses, blockAsKeyUses: Number(mKey0.maxuses) > 262144 });

    // ---- 2. the two sides ----
    const maker = sandbox(MP, 'MAKER'), taker = sandbox(TP, 'TAKER');
    const relay = relayStore((raw, now) => maker.AX.envelope.verify(raw, now));
    for (const s of [maker, taker]) {
        s.kv.relays = JSON.stringify([RELAY_URL]); s.kv.mxusd_tokenid = TOKEN;
        const [applied] = await call(s.AX.fill.overrideOnTestChain, s.AX.mds, TOKEN);
        if (!applied) fail('the dollar-token override was refused (not a test chain?)');
    }
    maker.kv.legacy_fresh = '0';    // 0.0.122: ON by default (Android takers); the hand-over runs with it OFF
    maker.kv.coin_max_age = '10';   // a -test tree is ~32 blocks: COIN_MAX_AGE lowered so the backing coins count as stale
    async function identity(s) { const [e, r] = await call(s.AX.mds.cmdR, 'seedrandom modifier:dexicon-identity-v1'); if (e) fail('seedrandom: ' + e.message); return s.AX.identity.fromSeed(r.seedrandom, 'decks'); }
    const mMe = await identity(maker), tMe = await identity(taker);
    const cMe = taker.AX.identity.fromSeed('0x' + nodeCrypto.randomBytes(32).toString('hex'), 'decks');   // the copycat: an identity, no node
    const mClient = new maker.AX.relay.Client(relay.transport), tClient = new taker.AX.relay.Client(relay.transport), cClient = new taker.AX.relay.Client(relay.transport);
    mClient.setRelays([RELAY_URL]); tClient.setRelays([RELAY_URL]); cClient.setRelays([RELAY_URL]);
    const mSign = '0x' + maker.AX.hex.to(mMe.signPk);
    say('identities', { maker: mMe.publicId(), taker: tMe.publicId(), copycat: cMe.publicId() });

    // the maker's service.js, its real functions (the tick's inbox routing, the proof answer, the take handling)
    const svc = fs.readFileSync(path.join(ROOT, 'service.js'), 'utf8');
    const tickSrc = fnSrc(svc, 'tick'), a = tickSrc.indexOf('var takes = [], perSender = {}'), b = tickSrc.indexOf('processTakes(takes,');
    if (a < 0 || b < 0) fail('service.js tick() no longer has the inbox routing this harness runs');
    const svcLog = [];
    vm.runInContext('var ME = __me, RELAY = __relay, myAddresses = {}, coinLocks = {}, LOCK_MS = 180000;\nfunction log(s) { __log(s); }\nfunction nowS() { return Math.floor(Date.now() / 1000); }\nfunction notify() { }\n'
        + ['refreshAddresses', 'addressList', 'lockCoins', 'unlockCoins', 'sealed', 'reply', 'answerProofs', 'processTakes', 'handleTake'].map((n) => fnSrc(svc, n)).join('\n')
        + '\nfunction classify(msgs) { ' + tickSrc.slice(a, b) + ' return { takes: takes, asks: asks }; }'
        // an older maker (before 0.0.128): answers proofs, never attests (no signPk)
        + '\nfunction answerOld(asks, done) { AX.maker.load(AX.mds, function (e, list) { AX.proofs.answer(AX.mds, list || [], asks, function (r) { r.forEach(function (x) { RELAY.publish(x.raw, function () { }); }); done(r); }, sealed); }); }',
        Object.assign(maker.ctx, { __me: mMe, __relay: mClient, __log: (s) => { svcLog.push(s); say('MAKER service log', { line: s }); } }));
    /** mode: 'honest' (the service), 'old' (answers proofs, never attests), 'read' (an attacker's turn: read, not answered) */
    async function makerTick(mode) {
        const [err, msgs] = await call((cb) => mClient.pollInbox(mMe.publicId(), 0, cb));
        if (err) fail('maker inbox: ' + err.message);
        const r = maker.ctx.classify(msgs);
        if (mode === 'read') return r;
        await new Promise((res) => maker.ctx.processTakes(r.takes, () => (mode === 'old' ? maker.ctx.answerOld : maker.ctx.answerProofs)(r.asks, res)));
        return r;
    }

    // the taker's page: the verdict cache + the proof taker exactly as ui/app.js wires them (inject: a node answer replaced, IN-WINDOW only)
    const T = taker.AX.takeable, tLog = [], tSign = '0x' + taker.AX.hex.to(tMe.signPk).toLowerCase();
    let PF = null, inject = null;
    const tcmd = (c, cb) => { const r = inject && inject(c); if (r) { issuedAll.push(['TAKER-INJECTED', c]); cmdLog.write((Date.now() - t0) + 'ms TAKER-INJECTED ' + c + ' -> ' + r.say + '\n'); return setImmediate(() => cb(r.err || null, r.res)); } taker.AX.mds.cmdR(c, cb); };
    const VC = new T.Cache(tcmd, { log: (s) => tLog.push(s), onMissing: (o) => PF.want(o), afterPass: () => PF.flush(), onAttest: (o) => PF.wantAttest(o) });
    PF = new taker.AX.proofs.Taker({ cmd: tcmd, count: () => { VC.spent++; },
        send: (o, ids, att) => tClient.publish(taker.AX.envelope.msg(tMe, o.pubId, taker.AX.identity.seal(tMe, o.pubId, taker.AX.hex.utf8(JSON.stringify({ k: 'proofs?', coins: ids, attest: att || [] }))), Math.floor(Date.now() / 1000) + 120), () => { }),
        proven: (ids, by) => { tLog.push('proven ' + ids.join(', ')); VC.proven(ids, by); },
        attested: (ad, pk, good) => { say('TAKER attestation verdict', { address: ad, signPk: pk, valid: good }); VC.attest(ad, pk, good); },
        log: (s) => { tLog.push(s); say('TAKER log', { line: s }); } });
    VC.requireAttest = true;   // kv require_attest ON: an order is shown only when its maker attested its addresses
    const replies = [], got = [];
    async function takerInbox() {
        const [err, msgs] = await call((cb) => tClient.pollInbox(tMe.publicId(), 0, cb));
        if (err) fail('taker inbox: ' + err.message);
        for (const m of msgs) {
            const opened = taker.AX.identity.open(tMe, m.env.blob); if (!opened || !opened.valid) continue;
            const inner = JSON.parse(taker.AX.hex.utf8Decode(opened.plaintext));
            if (inner.k === 'proofs') { got.push({ from: String(opened.fromPublicId).toLowerCase(), proofs: inner.proofs || {}, attest: inner.attest || {} }); PF.reply(opened.fromPublicId, inner.proofs, inner.attest); }
            else replies.push(inner);
        }
        await waitFor('the taker\'s imports and checks', async () => !PF.busy && !PF.vbusy && !PF.vjobs.length && (!PF.jobs.length || PF.imports >= taker.AX.proofs.IMPORTS_PER_BLOCK), 120000, 500);
    }
    async function takerWarm() {
        const [e] = await call((cb) => tClient.pollBook(0, cb)); if (e) fail('book: ' + e.message);
        const h = await tip(TP); VC.onBlock(h); PF.onBlock(h);
        await new Promise((res) => VC.warm(tClient.orders(), tSign, res));
        await waitFor('the taker\'s imports', async () => !PF.busy, 120000, 300);
        return tClient.orders();
    }
    const verdict = (o) => T.check(o, VC.verdicts(), tSign);
    const shownNow = (o) => !!o && T.visible(tClient.orders(), VC.verdicts(), tSign)[T.okey(o)] === true;
    const why = (o) => { if (!o) return null; const l = T.layout(tClient.orders(), VC.verdicts(), tSign); for (const s of ['buy', 'sell']) for (const x of l.sides[s]) if (x.key === T.okey(o)) return { state: x.check && x.check.state, reason: x.check && x.check.reason, attested: !!(x.check && x.check.attested), shown: !!x.shown }; return null; };
    async function relevantOnTaker(coin) { return ok(await rpc(TP, 'coins relevant:true coinid:' + coin), 'coins').length; }

    // the maker's token coins, by address (the setup puts groups A, B, C at three addresses of its own)
    const mCoins = ok(await rpc(MP, 'coins relevant:true tokenid:' + TOKEN), 'coins').filter((c) => !c.spent);
    const byAddr = {}; for (const c of mCoins) (byAddr[U(c.address)] = byAddr[U(c.address)] || []).push(c);
    const groups = Object.keys(byAddr).map((ad) => ({ address: ad, coins: byAddr[ad], each: [...new Set(byAddr[ad].map((c) => c.tokenamount))] }));
    say('maker token coins by address', { groups: groups.map((x) => ({ address: x.address, coins: x.coins.length, amounts: x.each })) });
    // a later send of the setup may spend some group-A coins (the wallet picks its inputs): A is the bigger 100-TUSD group
    // (a fill's change also comes back to its coin's address: only the 100-TUSD coins of an address count)
    const only = (x, amt) => ({ address: x.address, coins: x.coins.filter((c) => c.tokenamount === amt) });
    const hundreds = groups.map((x) => only(x, '100')).filter((x) => x.coins.length).sort((p, q) => q.coins.length - p.coins.length);
    const gA = hundreds[0], gC = hundreds[1], gB = groups.map((x) => only(x, '5')).find((x) => x.coins.length >= 18);
    if (!gA || !gB || !gC || gA.coins.length < 6 || gC.coins.length < 2) fail('the setup groups (A: ≥ 6 × 100 TUSD, B: ≥ 18 × 5 TUSD, C: ≥ 2 × 100 TUSD, each at its own address) are not all there');
    // stale proof material: every old group-A coin exported NOW (the negative "stale proof" uses one much later)
    const earlyTip = await tip(MP), early = {};
    for (const c of gA.coins) if (!(await seen(TP, c.coinid)).length) early[U(c.coinid)] = ok(await rpc(MP, 'coinexport coinid:' + c.coinid), 'coinexport').data;
    if (Object.keys(early).length < 6) fail('fewer than 6 group-A coins are older than the taker\'s tree: wait');
    say('early exports (for the stale-proof run)', { atMakerTip: earlyTip, coins: Object.keys(early) });
    const used = new Set();   // coins already backing an order of this harness
    const free = (grp, n) => grp.coins.map((c) => c.coinid).filter((id) => !used.has(U(id)) && (grp !== gA || early[U(id)] !== undefined)).slice(0, n);

    /** Place a maker order backed ONLY by coins of `allowed` (every other maker token coin is held: AX.maker.holds reads kv
     *  pending_takes `mine`). */
    async function place(label, allowed, params, wantOld = true) {
        const all = ok(await rpc(MP, 'coins relevant:true tokenid:' + TOKEN), 'coins').map((c) => c.coinid);
        const allow = new Set(allowed.map(U));
        maker.kv.pending_takes = JSON.stringify({ harness: { mine: all.filter((id) => !allow.has(U(id))) } });
        const before = relay.st.log.length, at = issuedAll.length;
        const [err, o, results, notice] = await call(maker.AX.maker.create, maker.AX.mds, mClient, mMe, params || { side: 'buy', price: '0.5', amount: '100' });
        if (err) fail(label + ': create failed: ' + err.message);
        await sleep(300);
        const issued = issuedAll.slice(at).filter((x) => x[0] === 'MAKER').map((x) => x[1]);
        const h = await tip(MP), rows = [];
        for (const c of o.coins) { rows.push(ok(await rpc(MP, 'coins coinid:' + c), 'coins')[0]); used.add(U(c)); }
        const relocks = issued.filter((l) => /^txncreate id:rl/.test(l) || /^txnpost id:rl/.test(l));
        say(label + ': maker placed', { orderId: o.orderId, coins: o.coins, scripts: o.scripts, coinCreated: rows.map((r) => r && r.created), makerTip: h, ages: rows.map((r) => h - Number(r.created)), relocking: o.relocking || [], notice, published: relay.st.log.length - before,
            relays: results.map((r) => r.ok), relockCommands: relocks, coinexports: issued.filter((l) => /^coinexport/.test(l)).length });
        if (notice !== '' || (o.relocking || []).length || relocks.length) fail(label + ': the order was not live at once without a relock');
        if (wantOld) for (const c of o.coins) if ((await seen(TP, c)).length) fail(label + ': the taker already sees ' + c + ' — wait until the maker\'s coins are older than the taker\'s tree');
        return o;
    }
    async function cancel(id) { await call(maker.AX.maker.cancel, maker.AX.mds, mClient, mMe, id); }

    // ================= POSITIVE (require_attest ON) =================
    await new Promise((res) => maker.ctx.refreshAddresses(res));   // as the service does at boot
    const balBefore = { maker: await balances(MP), taker: await balances(TP) };
    const o1 = await place('POSITIVE', free(gA, 1));
    let orders = await takerWarm();
    let env = orders.find((x) => x.orderId === o1.orderId);
    if (!env) fail('the taker does not have the order from the relay');
    say('POSITIVE: taker verdict before any proof', { verdict: verdict(env), layout: why(env), requestsToMaker: relay.st.msgs.filter((m) => m.to === mMe.publicId().toLowerCase()).length });
    if (shownNow(env)) fail('shown before a proof');
    // the service's ticks (one poll each; a poll's work is capped at 2 messages / 120K chars / 3 s, so a first `sign` of an
    // address — ~4 s for a 128×4 block-mode key — leaves the proof to the next poll)
    let rounds1 = 0;
    for (; rounds1 < 8; rounds1++) {
        const r1 = await makerTick('honest');
        say('POSITIVE: maker service poll ' + (rounds1 + 1), { requests: r1.asks.map((q) => ({ from: q.from, coins: q.coins, attest: q.attest })), log: svcLog.slice(-1) });
        await takerInbox();
        orders = await takerWarm(); env = orders.find((x) => x.orderId === o1.orderId);
        if (shownNow(env)) break;
        await sleep(3000);
    }
    const c1 = o1.coins[0], after = await seen(TP, c1);
    say('POSITIVE: after the import and the attestation', { makerPolls: rounds1 + 1, verdict: verdict(env), layout: why(env), takerCoinsCoinid: after.map((x) => ({ coinid: x.coinid, created: x.created, address: x.address, tokenid: x.tokenid, tokenamount: x.tokenamount })), relevantOnTaker: await relevantOnTaker(c1),
        takerBalanceTUSD: (await balances(TP))[U(TOKEN)] || '0', takerLog: tLog.slice() });
    if (!shownNow(env) || !why(env).attested) fail('not shown as attested after the proof: ' + JSON.stringify(why(env)));
    if (await relevantOnTaker(c1)) fail('the imported coin became relevant on the taker');
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
    await makerTick('honest');
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
        if ((t.body.txn.inputs || []).some((x) => U(x.coinid) === U(c1))) { mined = t; break; }
    }
    if (!mined) fail('no transaction in block ' + created + ' spends ' + c1);
    await waitFor('balances settle', async () => { const t = await balances(TP), m = await balances(MP); return t[U(TOKEN)] !== balBefore.taker[U(TOKEN)] && m['0X00'] !== balBefore.maker['0X00']; }, 300000);
    await sleep(8000);
    const balAfter = { maker: await balances(MP), taker: await balances(TP) };
    const D = taker.ctx.Decimal, delta = (side, tok) => new D(balAfter[side][tok] || 0).minus(new D(balBefore[side][tok] || 0)).toFixed();
    const moved = { makerMINIMA: delta('maker', '0X00'), makerTUSD: delta('maker', U(TOKEN)), takerMINIMA: delta('taker', '0X00'), takerTUSD: delta('taker', U(TOKEN)) };
    say('POSITIVE: MINED', { postedTxpowid: taken.txpowid, minedTxpowid: mined.txpowid, inBlock: created, transactionid: mined.body.txn.transactionid,
        inputs: mined.body.txn.inputs.map((x) => x.coinid), outputs: mined.body.txn.outputs.map((x) => ({ coinid: x.coinid, address: x.address, tokenid: x.tokenid, amount: x.tokenid === '0x00' ? x.amount : x.tokenamount })),
        balancesBefore: balBefore, balancesAfter: balAfter, moved, order: JSON.parse(maker.kv.myorders).find((x) => x.orderId === o1.orderId) });
    if (JSON.stringify(moved) !== JSON.stringify({ makerMINIMA: '100', makerTUSD: '-50', takerMINIMA: '-100', takerTUSD: '50' })) fail('balances did not move by exactly 100 MINIMA and 50 TUSD: ' + JSON.stringify(moved));

    // ================= MULTI-COIN: 18 old coins, the reply chunked over several messages =================
    {
        const o = await place('MULTI-COIN', free(gB, 18), { side: 'buy', price: '0.5', amount: '180' });
        if (o.coins.length !== 18) fail('MULTI-COIN: backed by ' + o.coins.length + ' coins, not 18');
        const msgsBefore = relay.st.msgs.length, gotBefore = got.length;
        let e = null, rounds = 0;
        for (; rounds < 12; rounds++) {
            const os = await takerWarm(); e = os.find((x) => x.orderId === o.orderId);
            if (e && shownNow(e)) break;
            await makerTick('honest'); await takerInbox();
            await sleep(3000);
        }
        const fromMaker = relay.st.msgs.slice(msgsBefore).filter((m) => m.from === mMe.publicId().toLowerCase() && m.to === tMe.publicId().toLowerCase());
        const proofMsgs = got.slice(gotBefore).filter((x) => x.from === mMe.publicId().toLowerCase()).map((x) => ({ proofs: Object.keys(x.proofs).length, attest: Object.keys(x.attest).length }));
        say('MULTI-COIN: result', { orderId: o.orderId, coins: o.coins.length, rounds, makerToTakerMessageChars: fromMaker.map((m) => m.chars), messages: proofMsgs, layout: why(e),
            imported: o.coins.filter((c) => tLog.some((l) => l.indexOf('proven') === 0 && l.indexOf(c) >= 0)).length });
        if (!e || !shownNow(e)) fail('MULTI-COIN: not shown after ' + rounds + ' rounds');
        if (proofMsgs.filter((x) => x.proofs).length < 2) fail('MULTI-COIN: the proofs did not come chunked over several messages');
        if (fromMaker.some((m) => m.chars > MAX_MSG_CHARS)) fail('MULTI-COIN: a message over the relay limit');
        await cancel(o.orderId);
    }

    // ================= IN-WINDOW: a young coin's proof is never imported, whatever the lookup says =================
    {
        const young = ok(await rpc(MP, 'getaddress'), 'getaddress').address;
        const had = new Set(ok(await rpc(MP, 'coins relevant:true tokenid:' + TOKEN), 'coins').map((c) => U(c.coinid)));   // only the coin this send makes
        const sendYoung = ok(await rpc(MP, 'send tokenid:' + TOKEN + ' amount:20 address:' + young), 'send');
        say('IN-WINDOW: a young coin for the maker', { sendTxpowid: sendYoung.txpowid });
        const yc = await waitFor('the young coin', async () => ok(await rpc(MP, 'coins relevant:true tokenid:' + TOKEN), 'coins').find((c) => c.tokenamount === '20' && U(c.address) === U(young) && !had.has(U(c.coinid))));
        await waitFor('the taker sees the young coin', async () => (await seen(TP, yc.coinid)).length > 0, 300000);
        const o = await place('IN-WINDOW', [yc.coinid], { side: 'buy', price: '0.5', amount: '40' }, false);
        const os = await takerWarm(), e = os.find((x) => x.orderId === o.orderId);
        const balB = (await balances(TP))[U(TOKEN)] || '0';
        // push its proof at the taker: the taker asks as if it did not see the coin (sentAt cleared: this height's request
        // to the maker may already be out), the honest maker answers
        PF.sentAt = {}; PF.want(e); PF.flush();
        const at1 = issuedAll.length;
        inject = (c) => c === 'coins coinid:' + yc.coinid ? { err: new Error('cmd failed: coins coinid: — timeout (injected)'), say: 'ERROR (injected)' } : null;
        let proof = null;
        for (let i = 0; i < 4 && !proof; i++) {   // a first `sign` of this address may take the poll: the proof then comes next poll
            await makerTick('honest'); await takerInbox();
            proof = (got.slice().reverse().find((x) => x.proofs[yc.coinid]) || {}).proofs;
        }
        if (!proof) fail('IN-WINDOW: the maker sent no proof of the young coin');
        const imports1 = issuedAll.slice(at1).filter((x) => /^coinimport/.test(x[1])).length;
        // the lookup LIES: [] for a coin inside the tree (the race): the created-block gate refuses it
        PF.sentAt = {}; PF.want(e);
        const at2 = issuedAll.length;
        inject = (c) => c === 'coins coinid:' + yc.coinid ? { res: [], say: '[] (injected)' } : null;
        PF.reply(mMe.publicId(), proof);
        await waitFor('the taker\'s checks', async () => !PF.busy, 60000, 300);
        inject = null;
        const issued2 = issuedAll.slice(at2).map((x) => x[1]), imports2 = issued2.filter((c) => /^coinimport/.test(c)).length;
        const st = ok(await rpc(TP, 'status'), 'status').chain, balA = (await balances(TP))[U(TOKEN)] || '0', rel = await relevantOnTaker(yc.coinid);
        say('IN-WINDOW: result', { coin: yc.coinid, coinCreated: yc.created, proofCreated: taker.AX.proofs.named(proof[yc.coinid]).created, takerTreeBound: Number(st.block) - Number(st.length), lookupErrorImports: imports1, lookupLiesCommands: issued2, lookupLiesImports: imports2,
            takerRelevantRows: rel, takerBalanceTUSDBefore: balB, takerBalanceTUSDAfter: balA });
        if (imports1 || imports2 || rel || balA !== balB) fail('IN-WINDOW: a young coin was imported, or became the taker\'s');
        await cancel(o.orderId);
    }

    // ================= COPYCAT: another identity, the same coin, the maker's attestation relayed =================
    {
        const real = await place('COPYCAT real', free(gA, 1));
        const X = real.coins[0], addr = taker.AX.takeable.scriptAddress(real.scripts[0]).toLowerCase();
        const relayedSig = maker.kv['attest_' + mSign.toLowerCase() + '_' + addr];
        if (!relayedSig) fail('COPYCAT: the maker has no attestation of ' + addr + ' to relay (the POSITIVE run signs it)');
        const nowS = Math.floor(Date.now() / 1000), copyId = '0x' + nodeCrypto.randomBytes(8).toString('hex');
        const copyRaw = taker.AX.envelope.order(cMe, { market: 'MINIMA/MxUSD', side: 'buy', price: '0.6', amount: '100', coins: [X], scripts: real.scripts.slice(), address: tAddr, orderId: copyId, seq: nowS, expiry: nowS + 3600 });
        await call((cb) => cClient.publish(copyRaw, cb));
        say('COPYCAT: copycat order published', { orderId: copyId, signPk: '0x' + taker.AX.hex.to(cMe.signPk), coin: X, price: '0.6 (better than the real 0.5)', script: real.scripts[0] });
        await takerWarm();
        // the copycat answers FIRST: the coin's proof (any node that sees the coin can export it) and the maker's attestation
        const [ce, cmsgs] = await call((cb) => cClient.pollInbox(cMe.publicId(), 0, cb)); if (ce) fail('copycat inbox: ' + ce.message);
        const asked = cmsgs.map((m) => { const op = taker.AX.identity.open(cMe, m.env.blob); return op && op.valid ? JSON.parse(taker.AX.hex.utf8Decode(op.plaintext)) : null; }).filter(Boolean);
        if (!asked.some((q) => q.k === 'proofs?' && (q.attest || []).indexOf(addr) >= 0)) fail('COPYCAT: the taker did not ask the copycat to attest ' + addr);
        const cp = {}; cp[X] = ok(await rpc(MP, 'coinexport coinid:' + X), 'coinexport').data;
        const ca = {}; ca[addr] = relayedSig;
        await call((cb) => cClient.publish(taker.AX.envelope.msg(cMe, tMe.publicId(), taker.AX.identity.seal(cMe, tMe.publicId(), taker.AX.hex.utf8(JSON.stringify({ k: 'proofs', proofs: cp, attest: ca }))), Math.floor(Date.now() / 1000) + 300), cb));
        await takerInbox();
        await makerTick('honest'); await takerInbox();
        let eReal = null, eCopy = null;
        for (let i = 0; i < 4; i++) { const os = await takerWarm(); eReal = os.find((x) => x.orderId === real.orderId); eCopy = os.find((x) => x.orderId === copyId); if (shownNow(eReal)) break; await makerTick('honest'); await takerInbox(); await sleep(3000); }
        say('COPYCAT: result', { copycatWasAsked: asked, real: why(eReal), copycat: why(eCopy), proverRecorded: VC.owners[X.toLowerCase()] || null, takerLog: tLog.filter((l) => /attestation refused/.test(l)) });
        if (!eCopy || shownNow(eCopy) || !eReal || !shownNow(eReal)) fail('COPYCAT: the copycat was shown, or the real order was not');
        await cancel(real.orderId);
    }

    // ================= NO ATTEST: a maker that does not attest (before 0.0.128) =================
    {
        const o = await place('NO ATTEST', free(gC, 1));
        let e = null, on = null;
        // until the proof is in (one request per maker per height: a maker already asked at this height waits for the next)
        for (let i = 0; i < 20; i++) { await makerTick('old'); await takerInbox(); const os = await takerWarm(); e = os.find((x) => x.orderId === o.orderId); on = why(e); if (on && /its maker has not proved/.test(on.reason || '')) break; await sleep(5000); }
        VC.requireAttest = false;
        const off = why(e);
        say('NO ATTEST: result', { coin: o.coins[0], requireAttestOn: on, requireAttestOff: off });
        if (!off || !off.shown || on.shown || !/its maker has not proved it controls this coin/.test(on.reason)) fail('NO ATTEST: not shown with require_attest off, or shown with it on');
        VC.requireAttest = true;
        await cancel(o.orderId);
    }

    // ================= NEGATIVES =================
    const negOrders = [];
    async function negative(label, coin, forge) {
        const o = await place(label, [coin]), c = o.coins[0]; negOrders.push(o.orderId);
        let os = null, e = null, asked = false;
        // the maker's inbox is read; an attacker answers instead of the honest service (one request per maker per height:
        // a maker already asked at this height is asked at the next)
        for (let i = 0; i < 20 && !asked; i++) {
            os = await takerWarm(); e = os.find((x) => x.orderId === o.orderId);
            asked = (await makerTick('read')).asks.some((q) => q.coins.indexOf(c) >= 0);
            if (!asked) await sleep(5000);
        }
        if (!asked) fail(label + ': the taker did not ask for ' + c);
        const forged = {}; forged[c] = await forge(c);
        const sentBefore = relay.st.msgs.length, at = issuedAll.length;
        await call((cb) => mClient.publish(maker.AX.envelope.msg(mMe, tMe.publicId(), maker.AX.identity.seal(mMe, tMe.publicId(), maker.AX.hex.utf8(JSON.stringify({ k: 'proofs', proofs: forged }))), Math.floor(Date.now() / 1000) + 300), cb));
        const logAt = tLog.length;
        await takerInbox();
        os = await takerWarm(); e = os.find((x) => x.orderId === o.orderId);
        await sleep(300);
        const issued = issuedAll.slice(at).filter((x) => x[0] === 'TAKER').map((x) => x[1]);
        const takeMsgs = relay.st.msgs.slice(sentBefore + 1).filter((m) => m.from === tMe.publicId().toLowerCase() && m.to === mMe.publicId().toLowerCase());
        const builds = issued.filter((l) => /^(txncreate|newscript|txninput|txnsign)/.test(l));
        say(label + ': result', { coin: c, takerLog: tLog.slice(logAt), coinimportCommands: issued.filter((l) => /^coinimport/.test(l)).map((l) => l.replace(/data:\S+/, 'data:<' + (l.match(/data:(\S+)/) || [0, ''])[1].length + ' chars>')),
            verdict: verdict(e), shownAsMarket: shownNow(e), takerMessagesToMakerAfterward: takeMsgs.length, takerBuildCommands: builds, takerSeesCoin: (await seen(TP, c)).length, makerCoinUnspent: (await seen(MP, c)).length === 1 });
        if (shownNow(e) || builds.length || (await seen(MP, c)).length !== 1) fail(label + ': the order was shown, or something was built');
    }
    const negCoins = free(gA, 4);
    if (negCoins.length < 4) fail('not enough old group-A coins for the negatives');
    await negative('NEGATIVE tampered proof (MMR tail)', negCoins[0], async (c) => { const d = ok(await rpc(MP, 'coinexport coinid:' + c), 'coinexport').data; const last = d.slice(-1); return d.slice(0, -1) + (last === '0' ? '1' : '0'); });
    await negative('NEGATIVE tampered proof (coin body: amount)', negCoins[1], async (c) => {
        const d = ok(await rpc(MP, 'coinexport coinid:' + c), 'coinexport').data, len = parseInt(d.substr(148, 2), 16), at = 150 + 2 * len - 2;   // amount MiniNumber at 146: scale, length, value bytes
        const nb = ((parseInt(d.substr(at, 2), 16) + 1) & 0x7f).toString(16).padStart(2, '0').toUpperCase();
        return d.slice(0, at) + nb + d.slice(at + 2);
    });
    await negative('NEGATIVE proof of a different coin', negCoins[2], async (c) => { const other = gC.coins.find((x) => !used.has(U(x.coinid))) || gC.coins[0]; return ok(await rpc(MP, 'coinexport coinid:' + other.coinid), 'coinexport').data; });
    // the stale proof: exported at the start, its proof block (the maker's tip - 8 on -test) now below the taker's tree
    await waitFor('the early proofs to go stale', async () => { const c = ok(await rpc(TP, 'status'), 'status').chain; return Number(c.block) - Number(c.length) > earlyTip; }, 3600000, 5000);
    await negative('NEGATIVE stale proof', negCoins[3], async (c) => { if (!early[U(c)]) fail('no early export of ' + c); return early[U(c)]; });
    for (const id of negOrders) await cancel(id);

    const signs = issuedAll.filter((x) => x[0] === 'MAKER' && /^sign /.test(x[1])).map((x) => x[1].split(' ')[1]);
    const mKeysAfter = ok(await rpc(MP, 'keys'), 'keys');
    say('ALL RUNS PASSED', { relayMessages: relay.st.msgs.length, maxMsgChars: Math.max.apply(null, relay.st.msgs.map((m) => m.chars)), relayRefused: relay.st.refused,
        makerSignCommands: signs, distinctKeysSigned: [...new Set(signs)].length, attestationsKept: Object.keys(maker.kv).filter((k) => /^attest_/.test(k)),
        attestationSignatureChars: Object.keys(maker.kv).filter((k) => /^attest_/.test(k)).map((k) => maker.kv[k].length),
        makerKeyUsesAfter: (mKeysAfter.keys || []).filter((k) => signs.indexOf(k.publickey) >= 0).map((k) => ({ publickey: k.publickey, uses: k.uses })) });
    cmdLog.end();
})().catch((e) => fail(e.stack || String(e)));
