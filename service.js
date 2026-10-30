/**
 * service.js — the Dexicon background engine (Rhino). It is the MAKER side of every fill:
 *   boot      identity from the node seed (vault action:seed, WRITE-gated → self-healing retry)
 *   tick/10s  ONE bounded inbox long-poll (MDS.net.GET is synchronous here; never loop from its callback),
 *             then for each sealed `take`: verify the taker's transaction against MY order, co-sign, post,
 *             reply `taken` or `refused`, and republish the order with what remains
 *   tick/60s  maker refresh: re-back orders whose coins moved, withdraw ones that cannot be backed, renew expiry
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
MDS.load('lib/ladder.js');   // the FAST market maker (ORDERS › MARKET MAKER), reconciled every tick below
// RESTING layer: the PandaDEX engine, vendored verbatim (scripts/vendor-pandadex.sh). decimal.js is already loaded above.
MDS.load('resting/safety.js'); MDS.load('resting/covenant.js'); MDS.load('resting/funding.js'); MDS.load('resting/signlock.js');
MDS.load('resting/book.js'); MDS.load('resting/pool.js'); MDS.load('resting/composite.js'); MDS.load('resting/txn.js');
MDS.load('resting/tape.js'); MDS.load('resting/maker.js'); MDS.load('resting/price.js'); MDS.load('resting/verifier.js');
MDS.load('resting/pending.js'); MDS.load('resting/stats.js'); MDS.load('resting/split.js'); MDS.load('resting/chain.js');
MDS.load('resting/history.js'); MDS.load('resting/pd_service.js');
MDS.load('lib/autocross.js');   // trades PandaPools back to the ladder's rungs (needs the resting/ engine above)
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
        AX.mds.cmdR('vault action:seed', function (err, r) {
            BOOTING = false;
            var seed = r && r.seed;
            if (err || !seed) {
                logOnce('boot waiting: ' + (err ? err.message : 'no seed (pending/locked?)')
                    + ' — grant WRITE trust (mds action:permission uid:<Dexicon uid> trust:write); retrying');
                return;
            }
            ME = AX.identity.fromSeed(seed, IDENTITY_CONTEXT);
            RELAY = new AX.relay.Client(AX.relay.mdsTransport(AX.mds));
            AX.prng.init(function (pe) { if (pe) log('PRNG init failed: ' + pe.message + ' — sealed replies will fail until it succeeds'); });
            AX.mds.kvSet('publicId', ME.publicId(), function () {});
            loadRelays(function () {
                READY = true;
                log('booted — publicId ' + ME.publicId() + '; relays: ' + RELAY.relays.length);
                refreshAddresses(function () { tick(); });
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
            if (t && t !== devTokenLogged) { AX.fill.setMxUsd(t); devTokenLogged = t; log('DEV: dollar leg token overridden to ' + t); }
            cb();
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
    loadRelays(function () {
        if (!RELAY.relays.length) { logOnce('no relays configured (RELAYS tab in the app)'); return; }
        RELAY.pollInbox(ME.publicId(), HOLD_SECONDS, function (err, msgs, url) {
            if (err) logOnce('inbox poll ' + url + ' failed: ' + err.message);
            var takes = [];
            for (var i = 0; i < msgs.length; i++) {
                var opened = AX.identity.open(ME, msgs[i].env.blob);
                if (!opened || !opened.valid) continue;
                var inner; try { inner = JSON.parse(AX.hex.utf8Decode(opened.plaintext)); } catch (e) { continue; }
                if (inner && inner.k === 'take') { inner._from = opened.fromPublicId || msgs[i].env.from; takes.push(inner); }
            }
            processTakes(takes, function () {
                if (ticks % 3 === 0) settleFills();
                ladderPass(function () { crossPass(function () { afterCross(function () { AX.maker.syncRelays(AX.mds, RELAY, ME, function (rep) {   // then every relay must match this node
                    rep.lines.forEach(function (l) { log(l); });
                    if (ticks % REFRESH_EVERY_TICKS === 0) {
                        refreshAddresses(function () {
                            AX.maker.refresh(AX.mds, RELAY, ME, function (e, n, relocked) {
                                if (e) log('refresh failed: ' + e.message);
                                else if (n || relocked) log('refresh republished ' + n + ' order(s)' + (relocked ? '; relocked stale backing coins in txpow ' + relocked : ''));
                            });
                        });
                    }
                }); }); }); });
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

function reply(toPublicId, obj) {
    var blob = AX.identity.seal(ME, toPublicId, AX.hex.utf8(JSON.stringify(obj)));
    RELAY.publish(AX.envelope.msg(ME, toPublicId, blob, nowS() + 300), function () {});
}

function handleTake(take, next) {
    var taker = take._from;
    // a peer's txn goes into txnview/txnimport: hex only, bounded (security review 30 Oct)
    if (!taker || typeof take.txn !== 'string' || typeof take.orderId !== 'string' || !/^(0x)?[0-9A-Fa-f]{2,200000}$/.test(take.txn)) return next();
    AX.maker.load(AX.mds, function (err, list) {
        var o = AX.maker.find(list, take.orderId);
        if (!o || o.status !== 'live') { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'order not live' }); return next(); }
        if (!lockCoins(o.coins)) { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'taken' }); return next(); }
        log('take received for ' + o.orderId + ' from ' + taker + ' (' + take.txn.length / 2 + ' bytes)');
        var recvMs = Date.now();   // ACTIVITY: "Co-signed for <taker> in X.Xs" (take received → posted)
        var spentByMe = [];
        AX.fill.cosign(AX.mds, take.txn, function (txn) {
            var v = AX.fill.verifyAsMaker(txn, { side: o.side, price: o.price, address: o.address }, o.coins, o.remaining, addressList());
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
                if (e2) log('afterFill: ' + e2.message);
                notify({ type: 'fill', txpowid: txpowid });
                next();
            });
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

/** One MDS.init for all three engines: the FAST maker (this file), the vendored PandaDEX RESTING engine (PDService) and the DOORS (AXService). */
function pdEvent(msg) {
    try {
        if (msg.event === 'inited') PDService.boot();
        else if (msg.event === 'NEWBLOCK') PDService.cmd('block', function (result) { var tip = PandaSafety.tipBlock(result); if (tip > 0) { PDService.block = tip; PDService.refresh(); } });
        else if (msg.event === 'MDSCOMMS' && msg.data && !msg.data.public) {
            var packet = JSON.parse(msg.data.message || '{}');
            if (packet.origin === 'ui') PDService.action(packet);
            else if (packet.origin === 'dexicon' && packet.type === 'CONSOLIDATE') consolidate(packet.data || {});
            // SAVE / STOP on the market maker: reconcile NOW, not on the next 10 s timer after the 8 s inbox hold
            else if (packet.origin === 'dexicon' && packet.type === 'LADDER' && READY) ladderPass(function () { });
        }
    } catch (e) { log('resting engine: ' + (e && e.message ? e.message : e)); }
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
});
