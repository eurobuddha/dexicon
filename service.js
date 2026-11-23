/**
 * service.js — the Dexicon background engine (Rhino). It is the MAKER side of every fill:
 *   boot      identity from seedrandom modifier:dexicon-identity-v1 (WRITE-gated → self-healing retry; never the phrase)
 *   tick/10s  ONE bounded inbox long-poll (MDS.net.GET is synchronous here; never loop from its callback),
 *             then for each sealed `take`: verify the taker's transaction against MY order, co-sign, post,
 *             reply `taken` or `refused`, and republish the order with what remains
 *   tick/60s  maker refresh: re-back orders whose coins moved, withdraw ones that cannot be backed, renew expiry
 *   NEWBLOCK  the same refresh at once while an order waits coinless for its coins (rebackOnBlock)
 */
MDS.load('lib/rhino_shim.js');   // MUST be first — Uint8Array.slice/.fill polyfills Rhino lacks
MDS.load('vendor/nacl.js');
MDS.load('vendor/blake.js');
MDS.load('vendor/sha256.js');
MDS.load('vendor/sha512.js');
MDS.load('vendor/decimal.js');   // exact decimal math (PandaDEX's vendored decimal.js; Rhino-safe)
MDS.load('lib/hex.js');
MDS.load('lib/flow.js');
MDS.load('crypto/ax_sodium.js');
MDS.load('lib/identity.js');
MDS.load('lib/mdsw.js');
MDS.load('lib/prng.js');       // seal() needs entropy; Rhino has no crypto.getRandomValues (AtomiX's node-seeded CSPRNG)
MDS.load('lib/envelope.js');
MDS.load('lib/relay.js');
MDS.load('lib/fill.js');
MDS.load('lib/maker.js');
MDS.load('lib/proofs.js');   // the coin proof hand-over: a taker whose node cannot see one of my backing coins asks for its proof
MDS.load('lib/ladder.js');   // the FAST market maker (ORDERS › MARKET MAKER), reconciled every tick below
// RESTING layer: the PandaDEX engine, vendored verbatim (scripts/vendor-pandadex.sh). decimal.js is already loaded above.
MDS.load('resting/safety.js'); MDS.load('resting/covenant.js'); MDS.load('resting/input-claims.js'); MDS.load('resting/funding.js'); MDS.load('resting/signlock.js');
MDS.load('resting/book.js'); MDS.load('resting/pool.js'); MDS.load('resting/composite.js'); MDS.load('resting/txn.js');
MDS.load('resting/tape.js'); MDS.load('resting/maker.js'); MDS.load('resting/price.js'); MDS.load('resting/verifier.js');
MDS.load('resting/pending.js'); MDS.load('resting/stats.js'); MDS.load('resting/split.js'); MDS.load('resting/chain.js');
MDS.load('resting/history.js'); MDS.load('resting/pd_service.js');
mirrorCoinLock(PandaCoinLock);   // the page's coin choosers see the resting engine's reservations (lib/maker.js holds)
MDS.load('lib/autocross.js');   // trades PandaPools back to the ladder's rungs (needs the resting/ engine above)
MDS.load('lib/ownskip.js');     // an order never fills against my own on-chain order: the planners route past them
AX.ownskip.install(PandaComposite, PandaBook, PDService.isMine, PDService.keysUsable);
AX.ladder.feed(PandaPrice);     // MEXC unreachable → MEXC's own ticker via CoinGecko (lib/ladder.js); never another exchange
// DOORS: the AtomiX TAKER engine, vendored verbatim (scripts/vendor-atomix.sh) — USDT ⇄ MxUSD through HTLCs on both
// chains for ERC20 users. Shared files (hex/flow/identity/mdsw/prng/sodium) are already loaded above.
MDS.load('doors/sha3.js'); MDS.load('doors/elliptic.js'); MDS.load('doors/ax_eth.js'); MDS.load('doors/decimal.js'); MDS.load('doors/abi.js');
MDS.load('doors/ethhtlc.js'); MDS.load('doors/trading.js'); MDS.load('doors/signgate.js'); MDS.load('doors/ethrpc.js'); MDS.load('doors/ethtx.js');
MDS.load('doors/ethops.js'); MDS.load('doors/swapdb.js'); MDS.load('doors/htlc.js'); MDS.load('doors/order.js'); MDS.load('doors/boot.js');
MDS.load('doors/identitywatch.js'); MDS.load('doors/settle.js'); MDS.load('doors/orderbook.js'); MDS.load('doors/take.js'); MDS.load('doors/swapplan.js');
MDS.load('doors/engine.js'); MDS.load('doors/market.js'); MDS.load('doors/wallet.js'); MDS.load('lib/door.js'); MDS.load('doors/ax_service.js');

var ME = null, RELAY = null, READY = false, BOOTING = false, lastBootTryMs = 0, lastBootLog = '';
var BOOT_RETRY_PACE_MS = 55000, HOLD_SECONDS = 8, REFRESH_EVERY_TICKS = 6;
var IDENTITY_CONTEXT = 'decks';   // protocol constant from the working title; renaming it would re-derive every identity (SPEC §2)
var ticks = 0, myAddresses = {}, coinLocks = {};   // coinid -> unix ms the lock expires (3 min)
var LOCK_MS = 180000;

function log(s) { MDS.log('[dexicon] ' + s); }
/** Review 23 Nov (MINOR): PandaCoinLock (resting/funding.js, vendored: never edited) lives in this service's memory; the
 *  page's create/edit (lib/maker.js holds) cannot see it. Every reserve / claim / finish / release is mirrored to kv
 *  'coinlock_held' = {lc coin id: until ms} (a reservation lasts 3 min; a claimed input until it is finished, 10 min). */
function mirrorCoinLock(L) {
    var held = {}, TTL = 180000;
    function lk(x) { return String(x && x.coinid ? x.coinid : x).toLowerCase(); }
    function save() { var now = Date.now(), k; for (k in held) if (held[k] <= now) delete held[k]; AX.mds.kvSet('coinlock_held', JSON.stringify(held), function () { }); }
    function wrap(name, f) { var orig = L[name]; if (typeof orig !== 'function') return; L[name] = function (x) { var r = orig.apply(L, arguments); if (r !== false) { try { (x || []).forEach(f); save(); } catch (e) { } } return r; }; }
    wrap('reserve', function (c) { held[lk(c)] = Date.now() + TTL; });
    wrap('claimInputs', function (id) { held[lk(id)] = Date.now() + 10 * 60000; });
    wrap('finishInputs', function (id) { held[lk(id)] = Date.now() + TTL; });
    wrap('release', function (c) { delete held[lk(c)]; });
}
function logOnce(s) { if (s !== lastBootLog) { lastBootLog = s; log(s); } }
function nowS() { return Math.floor(Date.now() / 1000); }
function notify(obj) { try { MDS.comms.solo(JSON.stringify(obj)); } catch (e) { } }

function tryBoot() {
    if (READY || BOOTING) return;
    var now = Date.now();
    if (lastBootTryMs > 0 && now - lastBootTryMs < BOOT_RETRY_PACE_MS) return;
    lastBootTryMs = now; BOOTING = true;
    AX.mds.kvInit(function (kvErr) {
        if (kvErr) { BOOTING = false; logOnce('kv init failed: ' + kvErr.message); return; }
        writeTrust(function (why) {
          if (why) { BOOTING = false; logOnce('NOT RUNNING: ' + why); return; }
          identitySeed(function (err, seed) {
            BOOTING = false;
            if (err || !seed) {
                logOnce('boot waiting: ' + (err ? err.message : 'no derived seed (pending/locked?)')
                    + ' — grant WRITE trust (mds action:permission uid:<Dexicon uid> trust:write); retrying');
                return;
            }
            ME = AX.identity.fromSeed(seed, IDENTITY_CONTEXT);
            RELAY = new AX.relay.Client(AX.relay.mdsTransport(AX.mds));
            AX.prng.init(function (pe) { if (pe) log('PRNG init failed: ' + pe.message + ' — sealed replies will fail until it succeeds'); });
            loadRelays(function () {
                retireOldIdentity(function () {
                    AX.mds.kvSet('publicId', ME.publicId(), function () {});
                    READY = true;
                    log('booted — publicId ' + ME.publicId() + '; relays: ' + RELAY.relays.length);
                    refreshAddresses(function () { tick(); });
                });
            });
          });
        });
    });
}

/** Owner 30 Oct: Dexicon never runs on READ trust. There every write (take co-sign, cancel, cross) is parked "pending" for
 *  a manual approval later — hours late, on a moved market. `checkmode` (doors/boot.js's own preflight) says WRITE or not
 *  and whether the vault is locked; cb(null) only when Dexicon may run. */
function writeTrust(cb) {
    AX.mds.cmd('checkmode', function (r) {
        var m = r && r.response;
        if (m && m.writemode === false) return cb('Dexicon needs WRITE trust — MiniHub → Dexicon → permissions (or mds action:permission uid:<Dexicon uid> trust:write). Nothing runs without it.');
        if (m && m.dblocked === true) return cb('the node is password-locked — unlock it (vault action:passwordunlock).');
        cb(null);
    });
}

/** Security review 30 Oct (mirror of the APK 0.1.50 SeedSource): the identity input is a one-way node derivation —
 *  the node's phrase and master seed never enter this MiniDapp. cb(err, '0x' + 64 hex). */
function identitySeed(cb) {
    AX.mds.cmdR('seedrandom modifier:dexicon-identity-v1', function (err, r, full) {
        var v = r && String(r.seedrandom || '');
        if (err) return cb(err);
        if (full && full.pending === true) return cb(new Error('the node parked it as pending — Dexicon needs WRITE trust'));
        if (!/^0x[0-9A-Fa-f]{64}$/.test(v)) return cb(new Error('no derived seed (pending/locked?)'));
        cb(null, v);
    });
}

/** One time: orders the old (vault-seed) identity signed are cancelled WITH it, so no taker keeps messaging a key nobody
 *  answers; the ladder then reposts under the new identity. The vault is never read again (publicId is then current). */
function retireOldIdentity(done) {
    AX.mds.kvGet('publicId', '', function (old) {
        if (!old || String(old).toLowerCase() === ME.publicId().toLowerCase()) return done();
        AX.maker.load(AX.mds, function (e0, list) {
            var live = (list || []).filter(function (o) { return o.status === 'live'; });
            if (!live.length) return done();
            log('identity moves off the seed phrase — retiring ' + live.length + ' order(s) signed by ' + old);
            AX.mds.cmdR('vault action:seed', function (err, r) {
                var was = !err && r && r.seed ? AX.identity.fromSeed(r.seed, IDENTITY_CONTEXT) : null;
                if (!was || was.publicId().toLowerCase() !== String(old).toLowerCase()) { log('old orders not cancelled — they expire on their own'); return done(); }
                var i = 0;
                (function next() {
                    if (i >= live.length) return done();
                    AX.maker.cancel(AX.mds, RELAY, was, live[i++].orderId, function () { next(); });
                })();
            });
        });
    });
}

var devTokenLogged = '';
function loadRelays(cb) {
    AX.mds.kvGet('relays', 'unset', function (val) {
        var list = AX.relay.fromKv(val);
        RELAY.setRelays(list);
        // Re-read every tick: the page may set the dev-chain dollar token after the service booted.
        AX.mds.kvGet('mxusd_tokenid', '', function (t) {
            if (!t) return cb();
            AX.fill.overrideOnTestChain(AX.mds, t, function (ok) {   // never on mainnet (security review 30 Oct)
                if (ok && t !== devTokenLogged) { devTokenLogged = t; log('DEV: dollar leg token overridden to ' + t); }
                if (!ok && devTokenLogged !== 'refused') { devTokenLogged = 'refused'; log('dollar-token override IGNORED: not a test chain'); }
                cb();
            });
        });
    });
}

/** Every address that holds one of my coins + the default address: "is this input mine?" for the verifier. */
function refreshAddresses(cb) {
    AX.mds.cmdR('coins relevant:true', function (err, rows) {
        if (!err && Object.prototype.toString.call(rows) === '[object Array]') for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].address) myAddresses[String(rows[i].address).toLowerCase()] = true;
        AX.mds.cmdR('getaddress', function (e2, a) { if (!e2 && a && a.address) myAddresses[String(a.address).toLowerCase()] = true; cb(); });
    });
}
function addressList() { var out = []; for (var k in myAddresses) out.push(k); return out; }

function lockCoins(ids) { var t = Date.now(); for (var i = 0; i < ids.length; i++) if (coinLocks[ids[i]] && coinLocks[ids[i]] > t) return false; for (i = 0; i < ids.length; i++) coinLocks[ids[i]] = t + LOCK_MS; return true; }
function unlockCoins(ids) { for (var i = 0; i < ids.length; i++) delete coinLocks[ids[i]]; }

function tick() {
    if (!READY) return;
    ticks++;
    // review 7 Nov (C-1): about once a minute, free resting input claims whose post provably never happened
    // (two-phase in PoolInputClaims: held >= 10 min, the coin unspent and NOT in the mempool)
    if (ticks % 6 === 0 && typeof PoolInputClaims !== 'undefined' && typeof PDService !== 'undefined') PoolInputClaims.sweepUnposted(PDService.cmd, Date.now());
    if (ticks % 3 === 0) voidSweep();
    loadRelays(function () {
        if (!RELAY.relays.length) { logOnce('no relays configured (RELAYS tab in the app)'); return; }
        RELAY.pollInbox(ME.publicId(), HOLD_SECONDS, function (err, msgs, url) {
            if (err) logOnce('inbox poll ' + url + ' failed: ' + err.message);
            var takes = [], perSender = {}, asks = [], askers = {};   // flood limits (review 30 Oct): 2 takes per sender, 16 per cycle; proof requests: 16 senders per cycle, one sender's requests merged up to 32 coins
            for (var i = 0; i < msgs.length; i++) {
                var opened = AX.identity.open(ME, msgs[i].env.blob);
                if (!opened || !opened.valid) continue;
                var inner; try { inner = JSON.parse(AX.hex.utf8Decode(opened.plaintext)); } catch (e) { continue; }
                if (inner && inner.k === 'take' && opened.fromPublicId && takes.length < 16 && (perSender[opened.fromPublicId] || 0) < 2) {
                    perSender[opened.fromPublicId] = (perSender[opened.fromPublicId] || 0) + 1;
                    inner._from = opened.fromPublicId; takes.push(inner);
                } else if (inner && inner.k === 'proofs?' && opened.fromPublicId && Object.prototype.toString.call(inner.coins) === '[object Array]' && (askers[opened.fromPublicId] || asks.length < 16)) {   // 0.0.128: coins may be [] when only attestations are asked
                    // 0.0.116: a taker asks once per ORDER, so several requests of one sender in one poll are merged (up to 32
                    // coins), never dropped: the 0.0.111 "one per sender" left every order but the first unanswered for 10 blocks
                    var aq = askers[opened.fromPublicId] || (askers[opened.fromPublicId] = asks[asks.push({ from: opened.fromPublicId, coins: [], attest: [], seen: {} }) - 1]);
                    for (var ci = 0; ci < inner.coins.length && aq.coins.length < 32; ci++) { var ck = String(inner.coins[ci]).toLowerCase(); if (!aq.seen[ck]) { aq.seen[ck] = true; aq.coins.push(inner.coins[ci]); } }   // NIT: de-duplicated before the cap
                    // 0.0.128: the addresses whose coin-key attestation the taker wants (up to 32)
                    var at = Object.prototype.toString.call(inner.attest) === '[object Array]' ? inner.attest : [];
                    for (ci = 0; ci < at.length && aq.attest.length < 32; ci++) { var ak = 'a:' + String(at[ci]).toLowerCase(); if (!aq.seen[ak]) { aq.seen[ak] = true; aq.attest.push(at[ci]); } }
                }
            }
            processTakes(takes, function () { answerProofs(asks, function () {
                if (ticks % 3 === 0) settleFills();
                // owner 7 Nov (mirror of APK 0.2.81): the relay check reads every relay's whole book in turn — a repair sweep,
                // so once a minute or straight after a take, not every 10 s tick in front of the next inbox poll
                var sync = takes.length > 0 || ticks % 6 === 0;
                ladderPass(function () { crossPass(function () { afterCross(function () { (sync ? AX.maker.syncRelays : function (a, b, c, cb) { cb({ lines: [] }); })(AX.mds, RELAY, ME, function (rep) {   // then every relay must match this node
                    rep.lines.forEach(function (l) { log(l); });
                    if (ticks % REFRESH_EVERY_TICKS === 0) {
                        refreshAddresses(function () { runRefresh(); });
                    }
                }); }); }); });
            }); });
        });
    });
}

function refreshed(e, n, relocked, relockErrs) {
    if (e) log('refresh failed: ' + e.message);
    else if (n || relocked) log('refresh republished ' + n + ' order(s)' + (relocked ? '; relocked stale backing coins in txpow ' + relocked : ''));
    (relockErrs || []).forEach(function (r) { log('refresh: ' + r + ' — the order stays coinless; the relock is retried after a backoff (2 blocks, doubling to 64)'); });   // 0.0.102: never swallowed
}
/** 0.0.109 (review 22 Nov, MINOR 5): one maker refresh at a time — the minute's tick and NEWBLOCK never overlap. A
 *  refresh that never called back frees the slot after 5 minutes (orders must keep their 60-minute heartbeat). */
var refreshingSince = 0, REFRESH_STUCK_MS = 5 * 60000;
function runRefresh() {
    if (refreshingSince && Date.now() - refreshingSince < REFRESH_STUCK_MS) return;
    var mine = refreshingSince = Date.now();
    AX.maker.refresh(AX.mds, RELAY, ME, function (e, n, relocked, relockErrs) { if (refreshingSince === mine) refreshingSince = 0; refreshed(e, n, relocked, relockErrs); });
}
/** 0.0.102: an order placed or edited on coins that had to be refreshed is published coinless; it is re-backed on the
 *  block that confirms the relock, not up to a minute later at the tick's refresh. Only an order coinless because a
 *  relock of its coins is pending counts (AX.maker.awaitingBacking); nothing to do → nothing runs. */
function rebackOnBlock() {
    AX.maker.load(AX.mds, function (e, list) { if (AX.maker.awaitingBacking(list)) runRefresh(); });
}

/** Review 7 Nov (M-1, mirror of APK MakerService.voidStaleTakes): a signed take has no expiry, so a maker could hold an
 *  unanswered one and post it hours later, only if the price moved its way. The page voids a take unanswered for 5 min
 *  (spends one of MY coins in it back to me) - but only while it is open. With the page closed for 2 min, the service
 *  does the same from the same kv records ('pending_takes', 'void_takes'): only an ON-CHAIN spend settles a take; a
 *  coin unspent everywhere is relocked to me; a mempool-only spend is looked at again later. */
var VOID_AFTER_MS = 5 * 60000, UI_GONE_MS = 2 * 60000, voidingSvc = {};
function voidSweep() {
    AX.mds.kvGet('ui_alive', '0', function (alive) {
        var now = Date.now();
        if (now - (Number(alive) || 0) < UI_GONE_MS) return;   // the open page owns its takes
        AX.mds.kvGet('pending_takes', '{}', function (pv) {
            var pending = {}, voids = {}, moved = false;
            try { pending = JSON.parse(pv || '{}') || {}; } catch (e) { pending = {}; }
            AX.mds.kvGet('void_takes', '{}', function (vv) {
                try { voids = JSON.parse(vv || '{}') || {}; } catch (e) { voids = {}; }
                Object.keys(pending).forEach(function (k) {
                    var pt = pending[k] || {};
                    if (now - (Number(pt.sent) || 0) > VOID_AFTER_MS) { voids[k] = { mine: pt.mine || [], act: pt.act || '' }; delete pending[k]; moved = true; }
                });
                if (moved) { AX.mds.kvSet('pending_takes', JSON.stringify(pending), function () { }); AX.mds.kvSet('void_takes', JSON.stringify(voids), function () { }); }
                Object.keys(voids).forEach(function (k) { voidOne(k, voids[k]); });
            });
        });
    });
}
function voidOne(k, v) {
    var coin = String(((v && v.mine) || [])[0] || '');
    if (voidingSvc[k]) return;
    function done(note) {
        AX.mds.kvGet('void_takes', '{}', function (vv) {
            var all = {}; try { all = JSON.parse(vv || '{}') || {}; } catch (e) { all = {}; }
            delete all[k]; delete voidingSvc[k];
            AX.mds.kvSet('void_takes', JSON.stringify(all), function () { });
            if (note) log('void ' + k + ': ' + note);
        });
    }
    if (!/^0x[0-9A-Fa-f]{64}$/.test(coin)) return done('');
    voidingSvc[k] = true;
    AX.mds.cmdR('coins relevant:true coinid:' + coin, function (e0, onChain) {
        if (e0) { delete voidingSvc[k]; return; }
        if (!(Object.prototype.toString.call(onChain) === '[object Array]' && onChain.length)) return done('settled: coin ' + coin + ' is spent on chain, so the maker can no longer post my signed half');
        AX.mds.cmdR('coins relevant:true checkmempool:true coinid:' + coin, function (e, rows) {
            var c = !e && Object.prototype.toString.call(rows) === '[object Array]' ? rows[0] : null;
            if (e || !c) { delete voidingSvc[k]; return; }   // spent in the mempool only: look again later
            AX.mds.cmdR('getaddress', function (e2, ad) {
                if (e2 || !ad || !ad.address) { delete voidingSvc[k]; return; }
                AX.maker.relock(AX.mds, [c], ad.address, function (e3) {
                    delete voidingSvc[k];
                    // keep the record until the spend is ON CHAIN (a posted relock can still be dropped); the next sweep
                    // then finds the coin spent and closes it
                    if (!e3) log('void ' + k + ': relock of ' + coin + ' posted; settles when it is on chain');
                });
            });
        });
    });
}

/** Auto-cross: after each ladder pass, trade PandaPools back to my rungs when it has moved past them (lib/autocross.js). */
function crossPass(then) {
    try { AX.autocross.run({ mds: AX.mds, price: PandaPrice, svc: PDService, log: log, changed: function () { notify({ type: 'ladder' }); } }, then); }
    catch (e) { log('auto-cross: ' + e); then(); }
}

/** A posted cross spent rung coins: re-back those rungs now, not after the 15 s pass gap (Android MakerService.afterCross). */
function afterCross(next) {
    if (!AX.autocross._state.crossed) return next();
    AX.ladder._state.lastPass = 0; ladderPass(next);
}

/** Settlement tracker: a fill is done once one of its output coins exists on chain (`coins coinid:`). The txpowid
 *  from txnpost is the pre-mining id and never matches the mined block, so it is display-only. */
function settleFills() {
    AX.mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", function (r) {
        var rows = (r && r.rows) || [], i = 0;
        function step() {
            if (i >= rows.length) return;
            var row = rows[i++], f = null;
            try { f = JSON.parse(row.V || row.v); } catch (e) { return step(); }
            if (!f || f.status !== 'settling' || !f.txpowid) return step();
            var probe = (f.coins && f.coins.length) ? f.coins[0] : null;
            if (!probe || !/^0x[0-9A-Fa-f]{64}$/.test(String(probe))) return step();
            AX.mds.cmdR('coins coinid:' + probe, function (err, res) {
                var c = (!err && res) ? (Object.prototype.toString.call(res) === '[object Array]' ? res[0] : res) : null;
                if (c && c.coinid) {
                    f.status = 'done'; f.block = c.created;
                    AX.mds.kvSet('fill_' + f.txpowid, JSON.stringify(f), function () { notify({ type: 'fill', txpowid: f.txpowid, status: 'done' }); step(); });
                } else if (f.ts && nowS() - f.ts > 2 * 3600) {
                    f.status = 'lost';   // two hours without a block: the txn was dropped (double-spent coin, reorg); the UI shows it
                    AX.mds.kvSet('fill_' + f.txpowid, JSON.stringify(f), function () { step(); });
                } else step();
            });
        }
        step();
    });
}

/** 0.0.111, the coin proof hand-over (lib/proofs.js): a taker whose node cannot see a coin backing one of my live orders
 *  (older than its window) asks for the coin's proof; it gets `coinexport` of each such coin, sealed to it. Takes are
 *  answered first; a request never makes this node export a coin that backs no live order of mine. Review 23 Nov (M1):
 *  one poll seals at most 2 messages / 120K chars in at most 3 s (AX.proofs.answer); the rest waits for the next poll,
 *  after its takes. */
function answerProofs(asks, done) {
    if (!asks.length && !AX.proofs.pending()) return done();
    AX.maker.load(AX.mds, function (e, list) {
        AX.proofs.answer(AX.mds, list || [], asks, function (replies) {
            replies.forEach(function (r) {
                RELAY.publish(r.raw, function () {});
                var na = r.coins.filter(function (c) { return c.indexOf('a:') === 0; }).length;
                log('coin proofs sent to ' + r.to + ': ' + (r.again ? 'the reply already sealed at this height, again' : (r.coins.length - na) + ' coin(s), ' + na + ' attestation(s), ' + r.raw.length + ' chars'));   // NIT: no coin list (up to 32 ids a line)
            });
            done();
        }, sealed, '0x' + AX.hex.to(ME.signPk));
    });
}

function processTakes(takes, done) {
    var i = 0;
    function step() {
        if (i >= takes.length) return done();
        handleTake(takes[i++], step);
    }
    step();
}

/** The market maker: one reconcile pass (15 s pacing inside), then the feed line for the page's editor. */
function ladderPass(then) {
    AX.ladder.pass({ mds: AX.mds, relay: RELAY, me: ME, price: PandaPrice, log: log, changed: function () { notify({ type: 'ladder' }); } }, function () {
        AX.mds.kvSet('mm_feed', JSON.stringify({ mid: PandaPrice.mid(), ageMs: PandaPrice.ageMs(), line: AX.ladder.feedLine(PandaPrice), at: Date.now() }), function () { then(); });
    });
}

function sealed(toPublicId, obj) { return AX.envelope.msg(ME, toPublicId, AX.identity.seal(ME, toPublicId, AX.hex.utf8(JSON.stringify(obj))), nowS() + 300); }
function reply(toPublicId, obj) { RELAY.publish(sealed(toPublicId, obj), function () {}); }

function handleTake(take, next) {
    var taker = take._from;
    // a peer's txn goes into txnview/txnimport: hex only, bounded (security review 30 Oct)
    if (!taker || typeof take.txn !== 'string' || typeof take.orderId !== 'string' || !/^(0x)?[0-9A-Fa-f]+$/.test(take.txn) || take.txn.length < 2 || take.txn.length > 200002) return next();   // bounded hex (no {2,200000}: older Rhino rejects that quantifier and the whole service failed to start)
    AX.maker.load(AX.mds, function (err, list) {
        var o = AX.maker.find(list, take.orderId);
        if (!o || o.status !== 'live') { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'order not live' }); return next(); }
        if (!lockCoins(o.coins)) { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'taken' }); return next(); }
        log('take received for ' + o.orderId + ' from ' + taker + ' (' + take.txn.length / 2 + ' bytes)');
        var recvMs = Date.now();   // ACTIVITY: "Co-signed for <taker> in X.Xs" (take received → posted)
        var spentByMe = [];
        AX.fill.cosign(AX.mds, take.txn, AX.fill.signKeys(o.scripts), function (txn, wallet) {
            var v = AX.fill.verifyAsMaker(txn, { side: o.side, price: o.price, address: o.address }, o.coins, o.remaining, addressList().concat(wallet));
            if (v.ok) for (var i = 0; i < txn.inputs.length; i++) if (o.coins.indexOf(txn.inputs[i].coinid) >= 0) spentByMe.push(txn.inputs[i].coinid);
            return v;
        }, function (e, txpowid, verdict, outCoins) {
            if (e) {
                unlockCoins(o.coins);
                log('take for ' + o.orderId + ' refused: ' + e.message);
                reply(taker, { k: 'refused', orderId: o.orderId, reason: e.message.replace(/^refused: /, '') });
                return next();
            }
            log('FILLED ' + o.orderId + ' ' + verdict.filled + ' MINIMA → txpow ' + txpowid);
            AX.mds.kvSet('fill_' + txpowid, JSON.stringify({ role: 'maker', orderId: o.orderId, side: o.side, price: o.price, filled: verdict.filled, received: verdict.received, paid: verdict.paid, txpowid: txpowid, coins: outCoins, taker: taker, ts: nowS(), recvMs: recvMs, cosignMs: Date.now() - recvMs, status: 'settling' }), function () {});
            reply(taker, { k: 'taken', orderId: o.orderId, txpowid: txpowid, filled: verdict.filled, coins: outCoins });
            AX.maker.afterFill(AX.mds, RELAY, ME, o.orderId, verdict.filled, spentByMe, function (e2) {
                unlockCoins(o.coins);
                if (e2) log('afterFill: ' + e2.message);   // 0.0.133: never a silent success; refresh deducts it from fill_ (reconcileFills)
                notify({ type: 'fill', txpowid: txpowid });
                next();
            }, txpowid);
        });
    });
}

/** ASSETS › CONSOLIDATE (mirror of Dexicon Android WalletTools): the node's standard `consolidate tokenid:` — the
 *  PandaPools / UTXO wallet tool — run HERE under PandaSignLock so it never signs alongside a fill, split or post. */
function consolidate(data) {
    var tok = String(data.tokenid || '');
    if (!/^0x[0-9A-Fa-f]{2,64}$/.test(tok)) return PDService.tell('ERROR', { message: 'Invalid token id for consolidate' });
    PandaSignLock.gate('consolidate', function (release) {
        PDService.cmd('consolidate tokenid:' + tok, function (r) {
            release.free();
            if (!r || !r.status) return PDService.tell('ERROR', { message: 'Consolidate failed: ' + ((r && (r.error || r.message)) || 'no reply from the node') });
            var resp = r.response || {}, id = resp.txpowid || (resp.txpow && resp.txpow.txpowid) || '';
            log('consolidate ' + tok + ' → ' + id);
            PDService.tell('POSTED', { message: 'Consolidation submitted' + (id ? ' — txpow ' + id : '') + '. Final after the next block.', tx: id });
            PDService.refresh();
        });
    });
}

/** A LIMIT with nothing but my own orders inside its limit (no third-party order, no pool): say so and send nothing.
 *  Anything it cannot judge (keys unread, a bad amount) is left to PDService.action, which plans past my own orders. */
function onlyOwnOrders(data) {
    var why = '';
    try { if (PDService.ready && PDService.keysUsable()) why = AX.ownskip.onlyOwn(PDService.book, PDService.pools, !!data.buy, data.minima, data.price, PDService.block); } catch (e) { why = ''; }
    if (why) { PDService.setStage(why); PDService.tell('ERROR', { message: why }); }
    return !!why;
}

/** One MDS.init for all three engines: the FAST maker (this file), the vendored PandaDEX RESTING engine (PDService) and the DOORS (AXService). */
function pdEvent(msg) {
    try {
        if (msg.event === 'inited') PDService.boot();
        else if (msg.event === 'NEWBLOCK') PDService.cmd('block', function (result) { var tip = PandaSafety.tipBlock(result); if (tip > 0) { PDService.block = tip; PDService.refresh(); } });
        else if (msg.event === 'MDSCOMMS' && msg.data && !msg.data.public) {
            var packet = JSON.parse(msg.data.message || '{}');
            if (packet.origin === 'ui' && packet.type === 'LIMIT' && onlyOwnOrders(packet.data || {})) return;
            if (packet.origin === 'ui') PDService.action(packet);
            else if (packet.origin === 'dexicon' && packet.type === 'CONSOLIDATE') consolidate(packet.data || {});
            // SAVE / STOP on the market maker: reconcile NOW, not on the next 10 s timer after the 8 s inbox hold
            else if (packet.origin === 'dexicon' && packet.type === 'LADDER' && READY) ladderPass(function () { });
            else if (packet.origin === 'dexicon' && packet.type === 'CROSS_REVIEW' && READY) crossReview(packet.data || {});
        }
    } catch (e) { log('resting engine: ' + (e && e.message ? e.message : e)); }
}
/** REVIEW / RELEASE from ORDERS › MARKET MAKER: the owner's only way out of a cross or PandaDEX fill whose outcome
 *  is unknown. Nothing here runs by itself. The answer goes to kv mm_review_result, tagged with the page's nonce. */
function crossReview(data) {
    var ctx = { mds: AX.mds, price: PandaPrice, svc: PDService, log: log, changed: function () { notify({ type: 'ladder' }); } };
    var nonce = /^[0-9a-z.]{1,40}$/.test(String(data.nonce || '')) ? String(data.nonce) : '';
    function done(o) { o.nonce = nonce; AX.mds.kvSet('mm_review_result', JSON.stringify(o), function () { notify({ type: 'ladder' }); }); }
    try {
        if (data.release === 'cross' || data.release === 'fill') AX.autocross.release(ctx, data.release, function (err) { done({ released: data.release, error: err || '' }); });
        else AX.autocross.review(ctx, function (st) { done({ review: st }); });
    } catch (e) { done({ error: 'review failed: ' + (e && e.message ? e.message : e) }); }
}
/** The DOORS engine (AXService, doors/ax_service.js): AtomiX taker settlement — claims, refunds, forwards. */
function axEvent(msg) {
    try { AXService.event(msg); } catch (e) { log('doors engine: ' + (e && e.message ? e.message : e)); }
}
MDS.init(function (msg) {
    pdEvent(msg);
    axEvent(msg);
    if (msg.event === 'inited') { tryBoot(); }
    else if (msg.event === 'MDS_TIMER_10SECONDS') { if (!READY) tryBoot(); else tick(); }
    else if (msg.event === 'NEWBLOCK' && READY) rebackOnBlock();
});
