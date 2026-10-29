/**
 * autocross — mirror of Dexicon Android 0.1.43 maker/AutoCross.java (owner 2026-10-29): when PandaPools moves past my
 * own FAST ladder — its selling price above my best ask, or its buying price below my best bid — this node trades the
 * pool back to that rung, sized to the rungs it moved past. One pool-only composite transaction (PandaComposite +
 * PandaTxn.fillComposite, the BOOK/POOL route minus the book): it pins the new reserves, so a pool that moved first
 * rejects it whole. Recorded like any POOL trade (PDService.fillMeta → ACTIVITY, TRADES). Only while the MEXC price is
 * fresh, only when it beats the rung after the 0.5 % fee, at most crossPerHour (default 3) an hour.
 * Rhino-safe (ES5). Requires AX.maker and the vendored resting/ engine (PandaDEX, PandaPool, PandaComposite).
 *
 * kv 'mm_cross' = JSON array of cross times (ms) · 'mm_pool' = the market-maker card's pool line
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var HOUR_MS = 3600000, FAIL_GAP_MS = 60000;
    var state = { inFlight: false, failedMs: 0 };

    /** Pure. The cross my live rungs call for against these pools, or null when the pool is in line (or it would not pay). */
    function decide(pools, rungs, mexcMid) {
        var P = g.PandaDEX, PP = g.PandaPool, hi = null, lo = null, i, p, s;
        if (!(mexcMid > 0) || !pools || !rungs) return null;
        for (i = 0; i < pools.length; i++) {
            p = pools[i];
            if (!PP.funded(p) || String(p.tok).toLowerCase() !== P.USDT.toLowerCase()) continue;
            s = PP.spotPrice(p);
            if (hi === null || s.gt(hi)) hi = s;
            if (lo === null || s.lt(lo)) lo = s;
        }
        if (hi === null) return null;
        var sellAt = hi.mul('0.995'), buyAt = lo.div('0.995');   // what the pool pays / charges after its 0.5 % fee
        var bestAsk = null, bestBid = null, askWant = P.d(0), bidWant = P.d(0), asks = [], bids = [], o, px, rem;
        for (i = 0; i < rungs.length; i++) {
            o = rungs[i];
            if (!o || o.status !== 'live' || !(o.coins || []).length) continue;   // an unbacked rung is not on offer: never cross what the ladder does not hold
            px = P.d(o.price); rem = P.d(o.remaining);
            if (o.side === 'sell' && px.lt(sellAt)) { askWant = askWant.add(rem); asks.push(o); if (bestAsk === null || px.lt(bestAsk)) bestAsk = px; }
            if (o.side === 'buy' && px.gt(buyAt)) { bidWant = bidWant.add(rem); bids.push(o); if (bestBid === null || px.gt(bestBid)) bestBid = px; }
        }
        var sellGap = bestAsk === null ? null : sellAt.div(bestAsk).sub(1), buyGap = bestBid === null ? null : bestBid.div(buyAt).sub(1);
        if (sellGap === null && buyGap === null) return null;
        var sell = buyGap === null || (sellGap !== null && sellGap.gte(buyGap));   // the side further out of line
        var limit = sell ? bestAsk : bestBid, want = sell ? askWant : bidWant;
        var plan = g.PandaComposite.plan([], pools, !sell, want, limit, 0);
        if (g.PandaComposite.isEmpty(plan) || plan.poolMinima.lt(1)) return null;
        var eff = plan.effectivePrice, mexc = P.d(String(mexcMid));
        if (sell ? (eff.lt(limit) || eff.lte(mexc)) : (eff.gt(limit) || eff.gte(mexc))) return null;
        // the crossed rungs' backing coins, best price first — the cross spends these (they are what fills), nothing else
        var crossed = (sell ? asks : bids).slice().sort(function (a, b) { return sell ? P.d(a.price).cmp(P.d(b.price)) : P.d(b.price).cmp(P.d(a.price)); }), coins = [];
        crossed.forEach(function (r) { r.coins.forEach(function (id) { if (coins.indexOf(id) < 0) coins.push(id); }); });
        return { sell: sell, limit: limit, want: want, gapPct: (sell ? sellGap : buyGap).mul(100), plan: plan, coins: coins };
    }

    function line(d) {
        var P = g.PandaDEX;
        return 'pool ' + d.gapPct.toFixed(2) + '% ' + (d.sell ? 'above your best ask' : 'below your best bid') + ' — ' + (d.sell ? 'sell ' : 'buy ')
            + P.plain(d.plan.totalMinima) + ' MINIMA @ avg ' + P.plain(d.plan.effectivePrice);
    }

    /** One look at the pool after a ladder pass; crosses when switched on and every guard passes. ctx = { mds, price,
     *  svc (PDService), log, changed }. cb() always. */
    function run(ctx, cb) {
        var mds = ctx.mds, svc = ctx.svc;
        mds.kvGet('mm_config', '', function (cs) {
            var c = AX.ladder.fromJson(cs);
            if (!c.enabled) return mds.kvSet('mm_pool', '', function () { cb(); });
            if (!svc || !svc.poolHaveLive || !svc.identity) return cb();
            mds.kvGet('mm_ids', '{}', function (is) {
                var ids = {}; try { ids = JSON.parse(is || '{}') || {}; } catch (e) { }
                AX.maker.load(mds, function (e0, list) {
                    var rungs = [], k, o, now = Date.now();
                    for (k in ids) { o = AX.maker.find(list || [], ids[k]); if (o) rungs.push(o); }
                    var mid = ctx.price.mid(), d = decide(svc.pools, rungs, mid);
                    mds.kvGet('mm_cross', '[]', function (rs) {
                        var recent = [], cap = parseInt(String(c.crossPerHour === undefined ? '3' : c.crossPerHour), 10), a, i;
                        try { a = JSON.parse(rs || '[]') || []; for (i = 0; i < a.length; i++) if (now - a[i] < HOUR_MS) recent.push(a[i]); } catch (e) { }
                        if (!(cap >= 0)) cap = 3;
                        var why = !c.autoCross ? ' (auto-cross off)' : !ctx.price.fresh() ? ' (waiting: MEXC price not fresh)'
                            : recent.length >= cap ? ' (waiting: ' + cap + ' crosses this hour)' : now - state.failedMs < FAIL_GAP_MS ? ' (retrying shortly)' : '';
                        var st = !(mid > 0) ? 'waiting for the MEXC price' : !d ? 'pool in line with your ladder' : line(d) + why;
                        mds.kvSet('mm_pool', st, function () {
                            if (!d || why || state.inFlight || svc.busy || svc.fillMeta) return cb();   // one PandaDEX trade at a time
                            execute(ctx, d, recent, cb);
                        });
                    });
                });
            });
        });
    }

    function execute(ctx, d, recent, cb) {
        var svc = ctx.svc, plan = d.plan, P = g.PandaDEX, i;
        state.inFlight = true;
        svc.filling = {};
        for (i = 0; i < plan.sourceCoinIds.length; i++) svc.filling[plan.sourceCoinIds[i]] = true;
        svc.setBusy(true); svc.setStage('Auto-cross: ' + line(d));
        ctx.log('auto-cross: ' + line(d));
        fill(svc.cmd, svc.identity, d, function (error, tx) {
            svc.setBusy(false);
            state.inFlight = false;
            if (error) {
                svc.filling = {}; state.failedMs = Date.now();
                svc.setStage('Auto-cross failed — ' + error); ctx.log('auto-cross failed: ' + error);
                if (ctx.changed) ctx.changed();
                return cb();
            }
            svc.setStage('Auto-cross posted — ' + (d.sell ? 'sold ' : 'bought ') + P.plain(plan.totalMinima) + ' MINIMA into PandaPools');
            svc.fillCoins = plan.sourceCoinIds.slice(); svc.fillBlock = svc.block;
            svc.fillMeta = { spentcoin: plan.sourceCoinIds[0], price: P.plain(plan.effectivePrice), size: P.plain(plan.totalMinima), buy: !d.sell, txpowid: tx || '',
                proceeds: P.plain(d.sell ? plan.totalUsdt : plan.totalMinima), postBlock: svc.block, sourceKind: 'POOL', autoCross: true,
                sourceCoinids: plan.sourceCoinIds.slice() };
            svc.saveFill();
            recent.push(Date.now());
            ctx.mds.kvSet('mm_cross', JSON.stringify(recent), function () { if (ctx.changed) ctx.changed(); svc.refresh(); cb(); });
        });
    }

    /** PandaTxn.fillComposite funded ONLY by my crossed rungs' own coins (29 Oct: the wallet scan could not reach the
     *  ladder's split coins, and a fallback to the wider wallet oversold the ladder by 9000 MINIMA). */
    function fill(cmd, identity, d, done) {
        var T = g.PandaTxn, prep = T.prepareComposite(d.plan, !d.sell);
        ownCoins(cmd, prep.payTok, prep.needed, d.coins, function (err, coins, sum) {
            if (err) return done(err);
            T.ensurePools(cmd, prep.route && prep.route.ok ? prep.route.allocs : [], 0, function (perr) {
                if (perr) return done(perr);
                T.buildComposite(cmd, identity, d.plan, prep, !d.sell, coins, sum, done);
            });
        });
    }

    /** My unspent, stateless coins of `token` named by `ids` (at most 8), reserved, if they cover `need`. */
    function ownCoins(cmd, token, need, ids, cb) {
        var F = g.PandaFunding, L = g.PandaCoinLock, P = g.PandaDEX, got = [], sum = P.d(0), i = 0;
        (function next() {
            if (sum.gte(need) || i >= ids.length || got.length >= 8) {
                if (sum.lt(need)) return cb("the crossed rungs' own coins no longer cover it. Nothing was posted.");
                L.reserve(got); return cb(null, got, sum);
            }
            var id = ids[i++];
            if (L.isReserved(id)) return next();
            cmd('coins relevant:true sendable:true coinid:' + id, function (r) {
                var rows = F.rows(r), c = rows && rows.length === 1 ? rows[0] : null, v = c ? F.value(c) : null;
                if (c && P.eqTok(c.tokenid, token) && String(c.coinid).toLowerCase() === String(id).toLowerCase() && !c.spent
                    && !(c.state && Object.keys(c.state).length) && v && v.gt(0)) { got.push(c); sum = sum.add(v); }
                next();
            });
        })();
    }

    /** The switch-on warning (owner 29 Oct): what auto-cross does, what would cross right now, what the owner agrees to.
     *  Same text as the APK's MarketMaker.crossWarning. */
    function warning(poolLine, perHour) {
        var now = String(poolLine || '').replace(/ \([^)]*\)$/, ''), cap = String(perHour || '').trim() || '3';
        var right = !now || /^waiting/.test(now) ? 'Not known yet — the pool position shows once the ladder is running.'
            : /^pool in line/.test(now) ? 'Nothing. The pool is in line with your ladder, so nothing would cross.'
            : 'YES — ' + now + '.\nThis trade is made as soon as you SAVE (if the MEXC price is fresh).';
        return 'Auto-cross trades your own funds against PandaPools, automatically, with no further confirmation.\n\n'
            + 'WHAT IT DOES\nWhen the pool\'s price rises past your best ask, your node SELLS MINIMA into the pool until it is back at that ask. '
            + 'When it falls past your best bid, your node BUYS. Each trade is the size of your rungs the pool moved past — the coins behind those '
            + 'rungs are spent, exactly as if a taker had filled them.\n\n'
            + 'WHAT WOULD CROSS RIGHT NOW (your live ladder)\n' + right + '\n\n'
            + 'WHAT YOU ARE AGREEING TO\n'
            + '• Up to ' + cap + ' trades an hour. If someone keeps pushing the pool back, it crosses again each time and your inventory moves '
            + 'one way: selling turns MINIMA into MxUSD, buying the reverse. A side of your ladder can empty until you top it up.\n'
            + '• Trades are on-chain and final. Each one beats your rung price after the pool\'s 0.5 % fee and the MEXC price at that moment, '
            + 'but MEXC can move afterwards.\n'
            + '• It never trades more than your backed rungs hold, never while the MEXC price is stale, and the whole trade is rejected if the pool '
            + 'moves first.\n\n'
            + 'Every cross appears in ACTIVITY and TRADES. Untick it here and SAVE to stop.';
    }

    AX.autocross = { decide: decide, line: line, run: run, warning: warning, _state: state };
})(typeof globalThis !== 'undefined' ? globalThis : this);
