/**
 * service.js — the Decks background engine (Rhino). v0.0.2 scope (P2-1/P2-2): boot the identity from the node
 * seed, keep the relay list in kv, and long-poll my inbox from the configured relays — ONE bounded GET per
 * MDS_TIMER_10SECONDS tick (MDS.net.GET is synchronous in this engine; never loop from its callback).
 * The maker auto-sign (P2-5) will consume the messages this loop surfaces.
 */
MDS.load('lib/rhino_shim.js');   // MUST be first — Uint8Array.slice/.fill polyfills Rhino lacks
MDS.load('vendor/nacl.js');
MDS.load('vendor/blake.js');
MDS.load('vendor/sha256.js');
MDS.load('vendor/sha512.js');
MDS.load('lib/hex.js');
MDS.load('lib/flow.js');
MDS.load('crypto/ax_sodium.js');
MDS.load('lib/identity.js');
MDS.load('lib/mdsw.js');
MDS.load('lib/envelope.js');
MDS.load('lib/relay.js');

var ME = null, RELAY = null, READY = false, BOOTING = false, lastBootTryMs = 0, lastBootLog = '';
var BOOT_RETRY_PACE_MS = 55000, HOLD_SECONDS = 8;
var IDENTITY_CONTEXT = 'decks';

function log(s) { MDS.log('[decks] ' + s); }
function logOnce(s) { if (s !== lastBootLog) { lastBootLog = s; log(s); } }

/** Identity = AtomiX-style HKDF from the node seed (vault action:seed is WRITE-gated → self-healing retry). */
function tryBoot() {
    if (READY || BOOTING) return;
    var now = Date.now();
    if (lastBootTryMs > 0 && now - lastBootTryMs < BOOT_RETRY_PACE_MS) return;
    lastBootTryMs = now; BOOTING = true;
    AX.mds.kvInit(function (kvErr) {
        if (kvErr) { BOOTING = false; logOnce('kv init failed: ' + kvErr.message); return; }
        AX.mds.cmdR('vault action:seed', function (err, r, full) {
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
                tick();
            });
        });
    });
}

function loadRelays(cb) {
    AX.mds.kvGet('relays', '[]', function (err, val) {
        var list = [];
        try { list = JSON.parse(val || '[]'); } catch (e) { list = []; }
        RELAY.setRelays(list);
        cb();
    });
}

var inboxSeen = 0;
function tick() {
    if (!READY) return;
    loadRelays(function () {
        if (!RELAY.relays.length) { logOnce('no relays configured (kv relays = JSON array of http(s) URLs)'); return; }
        RELAY.pollInbox(ME.publicId(), HOLD_SECONDS, function (err, msgs, url) {
            if (err) { logOnce('inbox poll ' + url + ' failed: ' + err.message); return; }
            for (var i = 0; i < msgs.length; i++) {
                inboxSeen++;
                // P2-5 wires the maker auto-sign here. For now: surface it to the UI and the node log.
                log('inbox #' + inboxSeen + ' from ' + msgs[i].env.from + ' blob ' + msgs[i].env.blob.length / 2 + ' bytes');
                AX.mds.kvSet('inbox_' + msgs[i].env.sig, msgs[i].raw, function () {});
            }
            if (msgs.length) MDS.comms.solo(JSON.stringify({ type: 'inbox', count: msgs.length }));
        });
    });
}

MDS.init(function (msg) {
    if (msg.event === 'inited') { tryBoot(); }
    else if (msg.event === 'MDS_TIMER_10SECONDS') { if (!READY) tryBoot(); else tick(); }
});
