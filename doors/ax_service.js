/**
 * ax_service.js — the DOORS background engine: the TAKER-ONLY reduction of mds/atomix-mds service.js (0.1.38),
 * owned by Dexicon (not vendored — see doors/VENDORED.md). What is kept is verbatim in spirit: the self-healing
 * boot (retries until WRITE trust), the engine configuration, the poll with its wedge watchdog, and the pass order
 * identitywatch → settle (claims/refunds of MY in-flight swaps, terminal status only from chain state) → market.
 * What is dropped is everything that MAKES a market: maker/responder/OTC configuration, keep-alive, peg refresh,
 * balances for publishing, the currency switch — Dexicon only ever takes an AtomiX maker's quote, in one market
 * (MxUSD). Namespaced as AXService (like resting/pd_service.js's PDService) because atomix service.js's top-level
 * READY/BOOTING/tryBoot/log would otherwise overwrite Dexicon service.js's own. Added: AX.door.processForwards
 * (carry out the user's "forward what arrives" instruction) and a `door` comms packet so the page refreshes.
 */
var AXService = (function () {
    var READY = false, BOOTING = false, lastBootTryMs = 0, lastBootLog = '', BOOT_RETRY_PACE_MS = 55000;
    var CTX = null, RPC = null, POLLING = false, POLL_START = 0, POLL_STUCK_MS = 5 * 60 * 1000;

    function log(s) { MDS.log('[dexicon doors] ' + s); }
    function logOnce(s) { if (s !== lastBootLog) { lastBootLog = s; log(s); } }
    function changed() { try { MDS.comms.solo(JSON.stringify({ type: 'door' })); } catch (e) { } }
    /** Engine notification → node notification + node log + a page refresh. */
    function notifyLog(title, body) { try { MDS.notify(title + ': ' + body); } catch (e) { } log(title + ' — ' + body); changed(); }

    function configureEngines() {
        AX.settle.configure({ rpc: RPC, ethPriv: CTX.eth.privKey, ethAddr: CTX.eth.address, myMinimaPk: CTX.htlc.publickey,
            myMinimaAddr: CTX.htlc.miniaddress, notify: notifyLog, onSwapsChanged: changed });
        AX.engine.configure({ rpc: RPC, ethPriv: CTX.eth.privKey, ethAddr: CTX.eth.address, myMinimaPk: CTX.htlc.publickey, onSwapsChanged: changed });
    }

    function tryBoot() {
        if (READY || BOOTING) return;
        var now = Date.now();
        if (lastBootTryMs > 0 && now - lastBootTryMs < BOOT_RETRY_PACE_MS) return;
        lastBootTryMs = now; BOOTING = true;
        AX.boot.init(function (err, ctx) {
            BOOTING = false;
            if (err) { logOnce('boot waiting: ' + err.message + (err.permission ? ' — grant WRITE trust; retrying' : ' — retrying')); return; }
            CTX = ctx;
            RPC = new AX.ethrpc.Rpc(AX.ethops.NET.rpcs[0]);
            configureEngines();
            READY = true;
            log('booted — taker settlement live; ETH ' + ctx.eth.address + '; Minima key ' + ctx.htlc.publickey);
            poll();
        });
    }

    /** One pass. Overlap guard + WATCHDOG: an uncaught throw inside an async callback chain would otherwise leave
     *  POLLING true forever and silently stop every claim/refund — a fund-safety hazard. */
    function poll() {
        if (!READY) return;
        if (POLLING) { if (Date.now() - POLL_START > POLL_STUCK_MS) { log('WATCHDOG: poll wedged — resetting'); POLLING = false; } else return; }
        POLLING = true; POLL_START = Date.now();
        AX.identitywatch.check(CTX, function () {
            AX.settle.poll(function () {
                AX.door.processForwards({ mds: AX.mds, rpc: RPC, ctx: CTX, log: log }, function () {
                    AX.htlc.currentBlock(function (eB, tip) {           // market feed LAST (display data, never delays settlement)
                        if (eB) { POLLING = false; return; }
                        AX.market.poll(tip, function () { POLLING = false; });
                    });
                });
            });
        });
    }

    function event(msg) {
        if (msg.event === 'inited') tryBoot();
        else if (msg.event === 'NEWBLOCK' || msg.event === 'MDS_TIMER_60SECONDS') { if (!READY) tryBoot(); else poll(); }
    }

    return { event: event, tryBoot: tryBoot, poll: poll, ready: function () { return READY; }, ctx: function () { return CTX; } };
})();
