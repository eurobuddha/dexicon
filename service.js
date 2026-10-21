/**
 * service.js — the Decks background engine (Rhino). It is the MAKER side of every fill:
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
MDS.load('lib/envelope.js');
MDS.load('lib/relay.js');
MDS.load('lib/fill.js');
MDS.load('lib/maker.js');

var ME = null, RELAY = null, READY = false, BOOTING = false, lastBootTryMs = 0, lastBootLog = '';
var BOOT_RETRY_PACE_MS = 55000, HOLD_SECONDS = 8, REFRESH_EVERY_TICKS = 6;
var IDENTITY_CONTEXT = 'decks';
var ticks = 0, myAddresses = {}, coinLocks = {};   // coinid -> unix ms the lock expires (3 min)
var LOCK_MS = 180000;

function log(s) { MDS.log('[decks] ' + s); }
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
                    + ' — grant WRITE trust (mds action:permission uid:<Decks uid> trust:write); retrying');
                return;
            }
            ME = AX.identity.fromSeed(seed, IDENTITY_CONTEXT);
            RELAY = new AX.relay.Client(AX.relay.mdsTransport(AX.mds));
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
    AX.mds.kvGet('relays', '[]', function (val) {
        var list = []; try { list = JSON.parse(val || '[]'); } catch (e) { list = []; }
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
                if (ticks % REFRESH_EVERY_TICKS === 0) {
                    refreshAddresses(function () {
                        AX.maker.refresh(AX.mds, RELAY, ME, function (e, n, relocked) {
                            if (e) log('refresh failed: ' + e.message);
                            else if (n || relocked) log('refresh republished ' + n + ' order(s)' + (relocked ? '; relocked stale backing coins in txpow ' + relocked : ''));
                        });
                    });
                }
            });
        });
    });
}

/** Settlement tracker: a fill is done once its txpow is on chain (txpow onchain:<id> → found + confirmations). */
function settleFills() {
    AX.mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", function (r) {
        var rows = (r && r.rows) || [], i = 0;
        function step() {
            if (i >= rows.length) return;
            var row = rows[i++], f = null;
            try { f = JSON.parse(row.V || row.v); } catch (e) { return step(); }
            if (!f || f.status !== 'settling' || !f.txpowid) return step();
            AX.mds.cmdR('txpow onchain:' + f.txpowid, function (err, res) {
                if (!err && res && res.found === true) {
                    f.status = 'done'; f.block = res.block; f.confirmations = res.confirmations;
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

function reply(toPublicId, obj) {
    var blob = AX.identity.seal(ME, toPublicId, AX.hex.utf8(JSON.stringify(obj)));
    RELAY.publish(AX.envelope.msg(ME, toPublicId, blob, nowS() + 300), function () {});
}

function handleTake(take, next) {
    var taker = take._from;
    if (!taker || typeof take.txn !== 'string' || typeof take.orderId !== 'string') return next();
    AX.maker.load(AX.mds, function (err, list) {
        var o = AX.maker.find(list, take.orderId);
        if (!o || o.status !== 'live') { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'order not live' }); return next(); }
        if (!lockCoins(o.coins)) { reply(taker, { k: 'refused', orderId: take.orderId, reason: 'taken' }); return next(); }
        log('take received for ' + o.orderId + ' from ' + taker + ' (' + take.txn.length / 2 + ' bytes)');
        var spentByMe = [];
        AX.fill.cosign(AX.mds, take.txn, function (txn) {
            var v = AX.fill.verifyAsMaker(txn, { side: o.side, price: o.price, address: o.address }, o.coins, o.remaining, addressList());
            if (v.ok) for (var i = 0; i < txn.inputs.length; i++) if (o.coins.indexOf(txn.inputs[i].coinid) >= 0) spentByMe.push(txn.inputs[i].coinid);
            return v;
        }, function (e, txpowid, verdict) {
            if (e) {
                unlockCoins(o.coins);
                log('take for ' + o.orderId + ' refused: ' + e.message);
                reply(taker, { k: 'refused', orderId: o.orderId, reason: e.message.replace(/^refused: /, '') });
                return next();
            }
            log('FILLED ' + o.orderId + ' ' + verdict.filled + ' MINIMA → txpow ' + txpowid);
            AX.mds.kvSet('fill_' + txpowid, JSON.stringify({ role: 'maker', orderId: o.orderId, side: o.side, price: o.price, filled: verdict.filled, received: verdict.received, paid: verdict.paid, txpowid: txpowid, taker: taker, ts: nowS(), status: 'settling' }), function () {});
            reply(taker, { k: 'taken', orderId: o.orderId, txpowid: txpowid, filled: verdict.filled });
            AX.maker.afterFill(AX.mds, RELAY, ME, o.orderId, verdict.filled, spentByMe, function (e2) {
                unlockCoins(o.coins);
                if (e2) log('afterFill: ' + e2.message);
                notify({ type: 'fill', txpowid: txpowid });
                next();
            });
        });
    });
}

MDS.init(function (msg) {
    if (msg.event === 'inited') { tryBoot(); }
    else if (msg.event === 'MDS_TIMER_10SECONDS') { if (!READY) tryBoot(); else tick(); }
});
