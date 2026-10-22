/**
 * door — Dexicon's glue around the vendored AtomiX taker engine (doors/): naming (the Minima dollar token is
 * MxUSD everywhere Dexicon speaks, whatever label the engine persisted), the transaction ids of a swap's two legs,
 * and the FORWARD queue — "when this swap completes, move what arrived on by one send": MxUSD to a Minima address
 * the user named (SWAP lane) or USDT to an Ethereum address (EXIT / SWAP lane). Forward records live in ax_kv
 * (`door_fwd_<hash>`) so they survive a reload and the service.js tick carries them out even with the page closed.
 * Rhino-safe (both hosts load it). Requires AX.swapdb, AX.trading, AX.dec, AX.wallet, AX.htlc at call time.
 * Attaches to AX.door.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    var MXUSD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
    var MAX_ATTEMPTS = 20;   // forward retries (one per service poll ≈ one per block) before the row is marked failed

    /** Display label for an engine token label or token id. The engine persists the legacy spelling; we never show it. */
    function label(t) {
        var s = String(t == null ? '' : t).trim(), l = s.toLowerCase();
        if (l === 'mxusdt' || l === 'mxusd' || l === MXUSD.toLowerCase()) return 'MxUSD';
        if (l === 'minima' || l === '0x00') return 'MINIMA';
        if (l === 'usdt' || l.indexOf('eth:') === 0) return 'USDT';
        return s;
    }
    function isEthAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(String(a == null ? '' : a).trim()); }
    /** A Minima address as the node prints it (Mx…) or its 0x hex form. Interpolated into `send` — nothing else passes. */
    function isMxAddr(a) { return /^(Mx[0-9A-Z]{20,80}|0x[0-9a-fA-F]{64})$/.test(String(a == null ? '' : a).trim()); }
    function norm(h) { return AX.swapdb ? AX.swapdb.norm(h) : String(h || '').toLowerCase().replace(/^0x/, ''); }
    function fwdKey(hash) { return 'door_fwd_' + norm(hash); }

    /** The transaction ids a swap's event log recorded, per chain. Minima-leg events carry token 'minima' or a
     *  Minima token id (the claim/refund rows); ETH-leg events carry 'ETH:<token>' or 'ETH'. Full ids, deduped. */
    function txIds(events) {
        var out = { eth: [], minima: [] }, i, e, tok, id, bucket;
        for (i = 0; i < (events || []).length; i++) {
            e = events[i] || {}; id = String(e.note == null ? '' : e.note); tok = String(e.token == null ? '' : e.token);
            if (!/^0x[0-9a-fA-F]{64}$/.test(id)) continue;
            bucket = tok.slice(0, 3).toUpperCase() === 'ETH' ? out.eth : out.minima;
            if (bucket.indexOf(id) < 0) bucket.push(id);
        }
        return out;
    }

    /** Plain-language state of a door swap for the progress card (taker role only — Dexicon never makes). */
    function statusText(s, fwd) {
        var sell = s.sellToken, buy = s.buyToken, st = s.status;
        if (st === 'STARTED') return 'Locked your ' + s.sellAmount + ' ' + label(sell) + ' — waiting for the AtomiX maker to lock ' + label(buy) + '.';
        if (st === 'LOCKED' || st === 'CLAIMING') return 'Maker locked ' + label(buy) + ' — claiming your ' + s.buyAmount + ' ' + label(buy) + ' now.';
        if (st === 'COMPLETE') {
            if (!fwd) return 'Done — ' + s.buyAmount + ' ' + label(buy) + ' received in this node’s wallet' + (label(buy) !== 'USDT' ? ' (less the 0.0001 ' + label(buy) + ' notify output).' : '.');
            if (fwd.status === 'sent') return 'Done — forwarded ' + fwd.amount + ' ' + label(buy) + ' to ' + fwd.to + '.';
            if (fwd.status === 'failed') return 'Swap done, forward FAILED: ' + (fwd.err || 'unknown') + ' — tap RETRY.';
            return 'Done — forwarding ' + label(buy) + ' to ' + fwd.to + (fwd.err ? ' (retrying: ' + fwd.err + ')' : '…');
        }
        if (st === 'REFUNDED') return 'Timed out — your ' + s.sellAmount + ' ' + label(sell) + ' was refunded to this node' + (label(sell) === 'USDT' ? '’s ETH wallet.' : '’s wallet.');
        if (st === 'ERROR') return 'Failed — see the recorded transactions; the counterparty took the leg you paid or refunded theirs.';
        return st || '';
    }

    function parse(v) { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }

    /** Queue a forward for a swap just started. kind 'minima' (MxUSD → Mx address) or 'usdt' (USDT → ETH address). cb(err). */
    function queueForward(mds, hash, kind, to, cb) {
        to = String(to || '').trim();
        if (kind === 'minima' ? !isMxAddr(to) : !isEthAddr(to)) return cb(new Error('bad forward address'));
        mds.kvSet(fwdKey(hash), JSON.stringify({ hash: norm(hash), kind: kind, to: to, status: 'pending', attempts: 0, ts: Date.now() }), cb);
    }
    /** All forward records (any status), newest first. cb(list). */
    function listForwards(mds, cb) {
        mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'door_fwd_%'", function (r) {
            var rows = (r && r.rows) || [], out = [], i, f;
            for (i = 0; i < rows.length; i++) { f = parse(rows[i].V || rows[i].v); if (f) out.push(f); }
            out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            cb(out);
        });
    }
    function byHash(list) { var m = {}, i; for (i = 0; i < list.length; i++) m[list[i].hash] = list[i]; return m; }
    function save(mds, f, cb) { mds.kvSet(fwdKey(f.hash), JSON.stringify(f), function () { cb(); }); }
    /** A failed forward back to pending so the next service poll retries it. */
    function retryForward(mds, hash, cb) {
        mds.kvGet(fwdKey(hash), '', function (v) { var f = parse(v); if (!f) return cb(); f.status = 'pending'; f.attempts = 0; f.err = ''; save(mds, f, cb); });
    }

    /**
     * Service side, once per poll: every pending forward whose swap is COMPLETE is carried out — ONE send,
     * recorded as 'sent' with its transaction id; a refunded/failed swap voids its forward. deps = { mds, rpc,
     * ctx (boot ctx), log }. cb() always.
     */
    function processForwards(deps, cb) {
        var mds = deps.mds, DB = AX.swapdb, TR = AX.trading, D = AX.dec;
        listForwards(mds, function (list) {
            AX.flow.each(list, function (f, i, next) {
                if (f.status !== 'pending') return next();
                DB.getSwap(f.hash, function (e, s) {
                    if (e || !s) return next();
                    if (s.status === 'REFUNDED' || s.status === 'ERROR') { f.status = 'void'; return save(mds, f, next); }
                    if (s.status !== 'COMPLETE') return next();
                    f.attempts = (f.attempts || 0) + 1;
                    var done = function (err, tx) {
                        if (err) { f.err = String(err.message || err); if (f.attempts >= MAX_ATTEMPTS) f.status = 'failed'; }
                        else { f.status = 'sent'; f.tx = tx || ''; f.err = ''; }
                        if (deps.log) deps.log('forward ' + f.hash + ' ' + f.kind + ' → ' + f.to + ': ' + (err ? 'failed (' + f.err + ')' : 'sent ' + f.tx));
                        save(mds, f, next);
                    };
                    if (f.kind === 'minima') {
                        if (!isMxAddr(f.to)) return done(new Error('bad address'));
                        var c = TR.forCoinLabel(s.buyToken), tokenId = c ? c.tokenId : MXUSD;
                        f.amount = D.sub(s.buyAmount, AX.htlc.NOTIFY_AMOUNT);   // the claim paid the 0.0001 notify output from the coin
                        if (!AX.htlc.isDecimal(f.amount) || !D.gt0(f.amount)) return done(new Error('nothing to forward'));
                        mds.cmdR('send amount:' + f.amount + ' address:' + f.to + ' tokenid:' + tokenId, function (err, resp) { done(err, resp && resp.txpowid); });
                    } else {
                        if (!isEthAddr(f.to) || !deps.rpc || !deps.ctx) return done(new Error('ETH side not ready'));
                        f.amount = s.buyAmount;
                        AX.wallet.sendUsdt(deps.rpc, deps.ctx.eth.privKey, deps.ctx.eth.address, f.to, f.amount, done);
                    }
                });
            }, function () { cb(); });
        });
    }


    // ---------- BOTH AtomiX markets (owner 2026-10-22: "offer both, show both quotes") ----------
    // AtomiX runs two independent books: the MxUSD market (sentinel USDTSWAP, AX.trading.MXUSDT) and the MINIMA
    // market (MINIMASWAP, AX.trading.MINIMA). The vendored engine reads its market from ONE selection —
    // AX.trading.active() — so Dexicon never edits doors/*.js: it flips that selection through the engine's own API
    // (AX.trading.setActive). Book scans read the sentinel synchronously on entry (orderbook.scan), so withMarket()
    // restores the selection before any callback runs. A take reads label/token/take-sentinel synchronously at
    // startLeg and at the post-lock take.send, so the page selects the route (selectMarket) and holds it — no other
    // take may start — until every part's callback has fired. Settlement (service.js) never consults the selection:
    // settle.js attributes each swap by its own recorded label (AX.trading.forCoinLabel).
    var ROUTES = ['mxusdt', 'minima'];
    var BUY_SLIPPAGE = 0.02, EPS = 1e-9, SYM = 'USDT';

    /** Display coin of a route key. */
    function coinOf(key) { return key === 'minima' ? 'MINIMA' : 'MxUSD'; }
    /** Run fn with the engine's market selection set to `key`, restoring the previous selection on return. */
    function withMarket(key, fn) {
        var TR = AX.trading, prev = TR.active();
        TR.setActive(TR.byKey(key));
        try { return fn(); } finally { TR.setActive(prev); }
    }
    /** Select the route for a take (left selected — see above). */
    function selectMarket(key) { return AX.trading.setActive(AX.trading.byKey(key)); }
    /** Scan both books, one after the other. cb({ mxusdt: book|null, minima: book|null }). */
    function scanBoth(cb) {
        var out = {}, i = 0;
        (function next() {
            if (i >= ROUTES.length) return cb(out);
            var k = ROUTES[i++];
            withMarket(k, function () { AX.book.scan(function (err, b) { out[k] = err ? null : (b || {}); next(); }); });
        })();
    }
    /** Makers (not me) with a fillable level on the side a taker needs: sell → their bids, buy → their asks. */
    function liveMakers(book, sell, myId) {
        var n = 0, pk, o, lv, i, B = AX.book, O = AX.order;
        for (pk in (book || {})) {
            o = book[pk];
            if (B.isMine(o, myId)) continue;
            lv = sell ? O.effectiveBids(o, SYM) : O.effectiveAsks(o, SYM);
            for (i = 0; i < lv.length; i++) if (B.levelCap(o, lv[i], sell) > 0) { n++; break; }
        }
        return n;
    }
    /**
     * Quote ONE route for a typed amount — atomix-mds lib/app.js onReview math, unchanged: SELL → `amt` of the route
     * coin straight into the sweep planner; BUY → the USDT typed is converted at the best ask into a coin target,
     * planned within BUY_SLIPPAGE and shaved once if ceil-rounding would overshoot what was typed.
     * Returns { key, coin, sell, plan|null, err|null, best, depth, makers }.
     */
    function planRoute(book, key, sell, amt, myId) {
        var SP = AX.swapplan, B = AX.book, coin = coinOf(key);
        book = book || {};
        var q = B.bestMakers(book, myId), r = { key: key, coin: coin, sell: !!sell, plan: null, err: null,
            best: sell ? q.bestBid : q.bestAsk, depth: SP.sweepDepthMinima(book, sell, myId, sell ? 0 : BUY_SLIPPAGE),
            makers: liveMakers(book, sell, myId) };
        if (amt === '' || amt == null) return r;
        var n = Number(amt);
        if (!(n > 0)) { r.err = 'Enter a valid amount.'; return r; }
        if (!(r.best > 0)) { r.err = 'No AtomiX maker is ' + (sell ? 'buying ' : 'selling ') + coin + ' right now.'; return r; }
        if (sell) r.plan = SP.buildSweepPlan(book, true, String(amt), 0, myId);
        else {
            var target = SP.computeMinima(String(amt), q.bestAsk);
            if (!target) { r.err = 'Amount too small.'; return r; }
            r.plan = SP.buildSweepPlan(book, false, target, BUY_SLIPPAGE, myId);
            if (r.plan.legs.length && r.plan.totalUsdt > n + EPS) {
                var less = SP.legMinima(Number(target) - (r.plan.totalUsdt - n) / q.bestAsk - 1e-6);
                r.plan = SP.buildSweepPlan(book, false, less, BUY_SLIPPAGE, myId);
            }
        }
        if (!r.plan.legs.length) { r.err = r.plan.stopReason === 'below-min' ? 'Below the makers’ minimum trade size.' : 'No liquidity to fill that right now.'; r.plan = null; }
        return r;
    }
    /** Both routes for one form: [mxusdt quote, minima quote]. ids = { mxusdt: myPublicId, minima: myPublicId }. */
    function quoteBoth(books, sell, amt, ids) {
        return ROUTES.map(function (k) { return planRoute((books || {})[k], k, sell, amt, (ids || {})[k]); });
    }

    AX.door = { ROUTES: ROUTES, BUY_SLIPPAGE: BUY_SLIPPAGE, coinOf: coinOf, withMarket: withMarket, selectMarket: selectMarket, scanBoth: scanBoth,
        liveMakers: liveMakers, planRoute: planRoute, quoteBoth: quoteBoth,
        MXUSD: MXUSD, MAX_ATTEMPTS: MAX_ATTEMPTS, label: label, isEthAddr: isEthAddr, isMxAddr: isMxAddr, fwdKey: fwdKey, txIds: txIds, statusText: statusText,
        queueForward: queueForward, listForwards: listForwards, byHash: byHash, retryForward: retryForward, processForwards: processForwards };
})(typeof globalThis !== 'undefined' ? globalThis : this);
