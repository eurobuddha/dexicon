/**
 * ui/doors.js — the DOORS tab: how ERC20 USDT users enter and leave Dexicon, through the vendored AtomiX TAKER engine
 * (doors/). Three panes over ONE flow — ENTER (USDT in), EXIT (out to USDT, forwarded to an Ethereum address), SWAP
 * (either direction, delivered where the user says) — each a best-price-first sweep of an AtomiX order book exactly as
 * atomix-mds lib/app.js does it (onReview → buildSweepPlan → startLeg per part; SELL parts serialised on their on-chain
 * confirm, BUY parts nonce-serialised), plus a forward queued per part (lib/door.js) that the service carries out.
 *
 * BOTH AtomiX markets (owner 2026-10-22): every pane quotes the MxUSD market (USDT ⇄ MxUSD) and the MINIMA market
 * (USDT ⇄ MINIMA) side by side — amount out, average price, ceiling, live makers — and the user picks the route. The
 * market is selected through the engine's own AX.trading selection (AX.door.withMarket / selectMarket); doors/*.js is
 * never edited. One take at a time: a take holds the selection until every part's callback has fired.
 *
 * Settlement never runs here: service.js (AXService) claims, withdraws and refunds. Exposes window.DexiconDoors;
 * ui/app.js's single MDS.init calls inited / onBlock / refresh. Identifiers are shown in FULL, tap to copy.
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var TR = AX.trading, B = AX.book, EN = AX.engine, DEC = AX.dec, EO = AX.ethops, DR = AX.door, DB = AX.swapdb, W = AX.wallet;
    var EPS = 1e-9, BOOT_RETRY_MS = 15000, REFRESH_MS = 90000;
    var ctx = null, rpc = null, books = { mxusdt: {}, minima: {} }, pane = 'enter', dirIn = true, route = 'mxusdt', review = null, busy = false;
    var booting = false, bootTimer = null, timer = null;
    var bals = { eth: '—', usdt: '—', mxusdt: '—', minima: '—' }, raw = { ethWei: null, usdtRaw: null }, gasWei = 0n;
    var swaps = [], fwds = {}, events = {};

    function notice(s, kind) { PD.notice(s, kind); if (kind === 'error') PD.appendActivity(s, Date.now()); }
    function esc(s) { return PD.esc(s); }
    function ids() { return ctx ? { mxusdt: ctx.identities.mxusdt.publicId(), minima: ctx.identities.minima.publicId() } : {}; }
    function trim6(v) { var n = Number(v); return isFinite(n) ? (Math.round(n * 1e6) / 1e6).toString() : '0'; }
    function px(v) { v = Number(v); if (!isFinite(v) || v <= 0) return '0'; var s = v.toPrecision(6); return s.indexOf('.') > -1 ? s.replace(/0+$/, '').replace(/\.$/, '') : s; }
    function feeEth(gasLimit) { return gasWei > 0n ? trim6(DEC.formatUnits(W.gasReserveWei(gasWei, BigInt(gasLimit)), 18)) : '?'; }
    function copy(text) { if (!text || text === '—' || !navigator.clipboard) return; navigator.clipboard.writeText(String(text)); notice('Copied ' + text, 'posted'); }
    function coin() { return DR.coinOf(route); }

    // ---------- boot (AtomiX's own sequence: trust preflight, seed identities, node-derived ETH key, covenant) ----------
    function boot() {
        if (booting || ctx) return;
        booting = true; clearTimeout(bootTimer);
        // Test chains only: Dexicon's DEV dollar token (RELAYS › settings) stands in for MxUSD in the doors engine too.
        AX.mds.kvGet('mxusd_tokenid', '', function (t) { if (/^0x[0-9A-Fa-f]{64}$/.test(t || '')) TR.MXUSDT.tokenId = t; });
        AX.boot.init(function (err, c) {
            booting = false;
            if (err) {
                $('doorEth').textContent = err.permission ? 'needs WRITE trust' : (err.locked ? 'node is locked' : 'not ready');
                $('doorBals').textContent = err.message;
                bootTimer = setTimeout(boot, BOOT_RETRY_MS);
                return;
            }
            ctx = c;
            rpc = new AX.ethrpc.Rpc(EO.NET.rpcs[0]);
            EN.configure({ rpc: rpc, ethPriv: ctx.eth.privKey, ethAddr: ctx.eth.address, myMinimaPk: ctx.htlc.publickey, onSwapsChanged: refresh });
            $('doorEth').textContent = ctx.eth.address;
            refreshBals(); refreshBook(); refresh();
            clearInterval(timer); timer = setInterval(function () { refreshBals(); refreshBook(); }, REFRESH_MS);
        });
    }

    // ---------- reads ----------
    /** Both AtomiX books, scanned one after the other (each under its own market selection). */
    function refreshBook() { if (ctx) DR.scanBoth(function (b) { if (b.mxusdt) books.mxusdt = b.mxusdt; if (b.minima) books.minima = b.minima; quote(); }); }
    function paintBals() {
        $('doorBals').textContent = 'ETH ' + bals.eth + ' · USDT ' + bals.usdt + ' · MxUSD ' + bals.mxusdt + ' · MINIMA ' + bals.minima
            + (gasWei > 0n ? ' · gas ' + trim6(DEC.formatUnits(gasWei, 9)) + ' gwei' : '');
    }
    /** ETH + USDT via the ETH RPC (read-only), MxUSD + MINIMA via the node. RAW values are kept — fund checks never trust a rounded string. */
    function refreshBals() {
        if (!ctx) return;
        var addr = ctx.eth.address;
        rpc.getBalance(addr, function (e, wei) { if (e) { bals.eth = '—'; raw.ethWei = null; } else { raw.ethWei = wei; bals.eth = trim6(DEC.formatUnits(wei, 18)); } paintBals(); quote(); });
        EO.make(rpc, ctx.eth.privKey, addr).balanceOf(EO.NET.usdt, function (e, r) { if (e) { bals.usdt = '—'; raw.usdtRaw = null; } else { raw.usdtRaw = r; bals.usdt = DEC.formatUnits(r, 6); } paintBals(); quote(); });
        rpc.gasPrice(function (e, gp) { if (!e && gp > 0n) gasWei = gp; paintBals(); quote(); });
        DR.ROUTES.forEach(function (k) {
            AX.mds.cmdR('balance tokenid:' + TR.byKey(k).tokenId, function (e, r) { bals[k] = (!e && r && r[0]) ? trim6(r[0].sendable) : (!e && r && !r.length ? '0' : '—'); paintBals(); quote(); });
        });
    }

    // ---------- panes ----------
    function setPane(p) {
        pane = p;
        ['enter', 'exit', 'swap'].forEach(function (k) {
            var cap = k.charAt(0).toUpperCase() + k.slice(1);
            $('door' + cap).hidden = k !== p; $('door' + cap + 'Btn').className = k === p ? 'active' : '';
        });
        labels(); quote();
    }
    function setDir(inward) {
        dirIn = !!inward;
        $('doorDirIn').className = dirIn ? 'selected-buy' : ''; $('doorDirOut').className = dirIn ? '' : 'selected-sell';
        labels(); quote();
    }
    /** The user picked a route card. */
    function pick(key) { if (DR.ROUTES.indexOf(key) < 0) return; route = key; labels(); quote(); }
    /** Field labels that name the picked route's coin. */
    function labels() {
        var c = coin();
        $('doorExitUnit').textContent = c;
        $('doorDirIn').textContent = 'USDT → ' + c; $('doorDirOut').textContent = c + ' → USDT';
        $('doorSwapUnit').textContent = dirIn ? 'USDT (ERC20)' : c;
        $('doorSwapToLabel').textContent = dirIn ? 'Minima address — leave empty to keep the ' + c + ' in this node’s wallet' : 'Ethereum address, 0x + 40 hex';
        $('doorSwapTo').placeholder = dirIn ? 'Mx…' : '0x…';
    }
    /** The active pane's inputs as one shape: sell = I give the route coin (EXIT / SWAP out); else I give USDT. */
    function form() {
        if (pane === 'enter') return { sell: false, amt: $('doorEnterAmt').value.trim(), to: '', box: $('doorEnterQuote'), needTo: false };
        if (pane === 'exit') return { sell: true, amt: $('doorExitAmt').value.trim(), to: $('doorExitTo').value.trim(), box: $('doorExitQuote'), needTo: true };
        return { sell: !dirIn, amt: $('doorSwapAmt').value.trim(), to: $('doorSwapTo').value.trim(), box: $('doorSwapQuote'), needTo: !dirIn };
    }

    /** One route card: what this market gives for the typed amount (or its best price when nothing is typed). */
    function routeCard(r, f) {
        var c = r.coin, p = r.plan, L = [], picked = r.key === route;
        var title = f.sell ? c + ' → USDT' : 'USDT → ' + c;
        if (p) {
            L.push('<strong>' + (f.sell ? '≈ ' + esc(trim6(p.totalUsdt)) + ' USDT' : esc(trim6(p.filledMinima)) + ' ' + c) + '</strong>');
            L.push('<span>' + (f.sell ? 'for ' + esc(trim6(p.filledMinima)) + ' ' + c : 'for ≈ ' + esc(trim6(p.totalUsdt)) + ' USDT') + '</span>');
            L.push('<span>avg ' + px(p.avgPrice) + ' USDT/' + c + ' · ' + p.legs.length + ' part' + (p.legs.length === 1 ? '' : 's') + (p.partial ? ' · PARTIAL' : '') + '</span>');
        } else if (r.err) L.push('<span class="bad">' + esc(r.err) + '</span>');
        else L.push('<strong>' + (r.best > 0 ? px(r.best) + ' USDT/' + c : 'no quote') + '</strong><span>' + (r.best > 0 ? 'best ' + (f.sell ? 'bid' : 'ask') : 'no maker ' + (f.sell ? 'buying' : 'selling')) + '</span>');
        L.push('<span>ceiling ~' + esc(trim6(r.depth)) + ' ' + c + ' · ' + r.makers + ' maker' + (r.makers === 1 ? '' : 's') + '</span>');
        if (f.sell) L.push('<span>you hold ' + esc(bals[r.key]) + ' ' + c + '</span>');
        return '<button type="button" class="door-route' + (picked ? ' picked' : '') + '" onclick="DexiconDoors.pick(\'' + r.key + '\')"><label>' + (picked ? '● ' : '○ ') + title + '</label>' + L.join('') + '</button>';
    }

    function quote() {
        if (!ctx) return;
        var f = form(), both = DR.quoteBoth(books, f.sell, f.amt, ids()), r = both[DR.ROUTES.indexOf(route)], p = r.plan, c = coin(), L = [], i;
        if (AX.identitywatch.halted()) { $('doorHalt').hidden = false; $('doorHalt').textContent = 'HALTED — ' + AX.identitywatch.summary() + ' Rescue funds, then reinstall Dexicon.'; }
        var cards = '<div class="door-routes">' + both.map(function (x) { return routeCard(x, f); }).join('') + '</div>';
        if (!f.amt || !p) { f.box.className = 'door-quote'; f.box.innerHTML = cards + (f.amt && r.err ? '<div class="bad">' + esc(c + ' route: ' + r.err) + '</div>' : ''); return; }
        L.push((f.sell ? 'You give  ' + trim6(p.filledMinima) + ' ' + c + '  →  receive ≈ ' + trim6(p.totalUsdt) + ' USDT' : 'You pay  ≈ ' + trim6(p.totalUsdt) + ' USDT  →  receive ' + trim6(p.filledMinima) + ' ' + c) + '   (' + c + ' market)');
        L.push('Avg ' + px(p.avgPrice) + ' · worst ' + px(p.worstPrice) + ' USDT per ' + c + ' · ' + p.legs.length + ' part' + (p.legs.length === 1 ? '' : 's') + (f.sell ? '' : ' · within ' + DR.BUY_SLIPPAGE * 100 + '% slippage'));
        if (p.partial) L.push('PARTIAL: fills ' + trim6(p.filledMinima) + ' of ' + trim6(p.target) + ' ' + c + ' — ' + (p.stopReason === 'slippage' ? 'the rest is priced beyond the slippage cap.' : 'the rest is not in the book right now.'));
        for (i = 0; i < p.legs.length; i++) L.push('Part ' + (i + 1) + ': ' + p.legs[i].minima + ' ' + c + ' @ ' + px(p.legs[i].price) + ' → ' + p.legs[i].usdt + ' USDT · maker ' + p.legs[i].maker.signerPk);
        if (f.sell) L.push('ETH gas from the deposit address: withdraw ≈ ' + feeEth(EO.NET.gas.withdraw) + ' ETH' + (f.to ? ' + forward ≈ ' + feeEth(W.GAS_ERC20) + ' ETH' : '') + ' (you hold ' + bals.eth + ' ETH)');
        else L.push('ETH gas from the deposit address: ≈ ' + feeEth(EO.NET.gas.newContract) + ' ETH per part (you hold ' + bals.eth + ' ETH)');
        if (f.to) L.push((f.sell ? 'USDT' : c) + ' will be forwarded to ' + f.to);
        else if (!f.sell) L.push(c + ' lands in this node’s wallet.');
        var v = validate(f, p);
        f.box.className = 'door-quote ' + (v ? 'bad' : 'ok');
        f.box.innerHTML = cards + '<div>' + esc(L.join('\n') + (v ? '\n\n' + v : '')) + '</div>';
    }
    /** Fund + address checks for the PICKED route; fail CLOSED on an unreadable balance. Returns a message or ''. */
    function validate(f, p) {
        var c = coin();
        if (AX.identitywatch.halted()) return 'Halted: this node no longer owns the keys AtomiX uses here.';
        if (busy) return 'A door swap is still starting — wait for it to finish.';
        if (f.to && (f.sell ? !DR.isEthAddr(f.to) : !DR.isMxAddr(f.to))) return f.sell ? 'Destination must be an Ethereum address (0x + 40 hex).' : 'Destination must be a Minima address (Mx… or 0x + 64 hex).';
        if (f.needTo && !f.to) return 'Enter the destination address.';
        if (raw.ethWei == null) return 'Cannot read the ETH balance of the deposit address right now — try again shortly.';
        if (f.sell) {
            if (bals[route] === '—') return 'Cannot read your ' + c + ' balance right now.';
            if (p.filledMinima > Number(bals[route]) + EPS) return 'You hold ' + bals[route] + ' ' + c + ' — reduce the amount.';
            if (gasWei > 0n && W.gasReserveWei(gasWei, BigInt(EO.NET.gas.withdraw) + (f.to ? W.GAS_ERC20 : 0n)) > raw.ethWei) return 'Not enough ETH at the deposit address for the withdraw' + (f.to ? ' + forward' : '') + ' gas — send a little ETH there first.';
        } else {
            if (raw.usdtRaw == null) return 'Cannot read your USDT balance right now.';
            if (DEC.parseUnits(trim6(p.totalUsdt), 6) > raw.usdtRaw) return 'You hold ' + bals.usdt + ' USDT at the deposit address — reduce the amount or top it up.';
            if (gasWei > 0n && W.gasReserveWei(gasWei, BigInt(EO.NET.gas.newContract) * BigInt(p.legs.length)) > raw.ethWei) return 'Not enough ETH at the deposit address for ' + p.legs.length + ' lock transaction' + (p.legs.length === 1 ? '' : 's') + ' — send a little ETH there first.';
        }
        return '';
    }

    // ---------- review → start ----------
    function openReview(kind) {
        if (!ctx) return notice('Doors not ready — grant WRITE trust in MiniHub and reload.', 'error');
        setPane(kind === 'swap' ? 'swap' : kind);
        var f = form(), c = coin(), r = DR.planRoute(books[route], route, f.sell, f.amt, ids()[route]);
        if (!f.amt) return notice('Enter an amount first.', 'error');
        if (!r.plan) return notice(c + ' route: ' + r.err, 'error');
        var v = validate(f, r.plan); if (v) return notice(v, 'error');
        review = { plan: r.plan, key: route, to: f.to, amtEl: pane === 'enter' ? $('doorEnterAmt') : (pane === 'exit' ? $('doorExitAmt') : $('doorSwapAmt')) };
        $('doorDialogTitle').textContent = (pane === 'enter' ? 'ENTER' : pane === 'exit' ? 'EXIT' : 'SWAP') + ' — ' + (f.sell ? 'sell ' + trim6(r.plan.filledMinima) + ' ' + c + ' for ≈ ' + trim6(r.plan.totalUsdt) + ' USDT' : 'buy ' + trim6(r.plan.filledMinima) + ' ' + c + ' for ≈ ' + trim6(r.plan.totalUsdt) + ' USDT');
        var body = f.box.lastChild;
        $('doorDialogBody').textContent = (body ? body.textContent : '') + '\n\n' + (f.sell ? 'This locks your ' + c + ' on Minima now (block + 144 refund window).' : 'This locks your USDT on Ethereum now (2 h refund window).') + ' The background service completes the swap; keep this node running.';
        $('doorConfirm').disabled = false;
        $('doorDialog').showModal();
    }
    function confirm() {
        if (!review || busy) return;
        var p = review.plan, to = review.to, key = review.key;
        $('doorConfirm').disabled = true; $('doorDialog').close();
        // The engine takes in whichever market AX.trading has selected; hold this route until every part has called back.
        DR.selectMarket(key); busy = true;
        PD.setStage('Starting door swap (' + DR.coinOf(key) + ' market)…'); PD.paintNotice();
        if (p.sell) startSell(p, key, to, 0, 0); else startBuy(p, key, to);
        review.amtEl.value = ''; review = null;
    }
    function finish() { busy = false; PD.setStage(''); quote(); }
    function hooks(maker, key, sell) {
        return {
            makerLive: function () { return B.makerLive(books[key][maker.signerPk], sell); },
            me: ctx.identities[key], myPublicId: ctx.identities[key].publicId(),
            onWithdrawn: refreshBook,
            onNote: function (tag) { if (tag && tag.indexOf('buy-notify-failed') === 0) notice('USDT locked, but telling the maker failed (' + tag + ') — it can still find the lock by hashlock.', 'error'); }
        };
    }
    function queued(hash, kind, to) { if (to) DR.queueForward(AX.mds, hash, kind, to, function (e) { if (e) notice('Forward not queued for ' + hash + ': ' + e.message, 'error'); refresh(); }); else refresh(); }
    /** SELL parts lock unpinned coins → each waits for the previous lock to confirm (no double-select). */
    function startSell(p, key, to, i, ok) {
        var c = DR.coinOf(key);
        if (i >= p.legs.length) { finish(); notice('Door: ' + ok + '/' + p.legs.length + ' part' + (p.legs.length === 1 ? '' : 's') + ' locked — the service completes the swap.', 'posted'); return; }
        var leg = p.legs[i];
        DR.selectMarket(key);   // nothing else changes it mid-take; re-asserted per part as belt and braces
        PD.setStage('Locking part ' + (i + 1) + '/' + p.legs.length + ' (' + c + ') on Minima…'); PD.paintNotice();
        EN.startLeg(leg.maker, 'USDT', true, leg.minima, leg.usdt, hooks(leg.maker, key, true), function (err, hash) {
            if (err) { finish(); notice('Door stopped at part ' + (i + 1) + ': ' + err.message, 'error'); refresh(); return; }
            PD.appendActivity('Door: locked ' + leg.minima + ' ' + c + ' for ' + leg.usdt + ' USDT — swap ' + hash, Date.now());
            queued(hash, 'usdt', to);
            pollConfirm(hash, true, function (confirmed) {
                if (confirmed) return startSell(p, key, to, i + 1, ok + 1);
                finish(); notice('Part ' + (i + 1) + ' is still confirming; remaining parts not sent — try again shortly.', 'error');
            });
        });
    }
    /** BUY parts are nonce-serialised by the ETH sender → fire back-to-back. */
    function startBuy(p, key, to) {
        var done = 0, ok = 0, c = DR.coinOf(key);
        p.legs.forEach(function (leg, i) {
            EN.startLeg(leg.maker, 'USDT', false, leg.minima, leg.usdt, hooks(leg.maker, key, false), function (err, hash) {
                done++;
                if (err) notice('Door part ' + (i + 1) + ' failed: ' + err.message, 'error');
                else { ok++; PD.appendActivity('Door: locked ' + leg.usdt + ' USDT for ' + leg.minima + ' ' + c + ' — swap ' + hash, Date.now()); queued(hash, 'minima', to); }
                if (done === p.legs.length) { finish(); if (ok) notice('Door: ' + ok + '/' + p.legs.length + ' USDT lock' + (ok === 1 ? '' : 's') + ' sent — the service completes the swap.', 'posted'); }
            });
        });
    }
    function pollConfirm(hash, sell, cb) {
        var tries = 0;
        (function loop() { EN.confirmMyLock(hash, sell, function (found) { if (found) return cb(true); if (++tries > 24) return cb(false); setTimeout(loop, 5000); }); })();
    }

    // ---------- door swaps (durable: swapdb + forward records) ----------
    function refresh() {
        if (!ctx) return;
        DB.allSwaps(function (e, all) {
            swaps = (all || []).filter(function (s) { return s.role === 'INITIATOR'; });
            DR.listForwards(AX.mds, function (list) {
                fwds = DR.byHash(list);
                var i = 0;
                (function step() {
                    if (i >= swaps.length) { renderSwaps(); if (window.DexiconActivity) DexiconActivity.render(); return; }
                    var s = swaps[i++];
                    DB.getEvents(s.hash, function (e2, ev) { events[DB.norm(s.hash)] = ev || []; step(); });
                })();
            });
        });
    }
    function idLine(tag, id) { return '<div onclick="DexiconDoors.copy(this.getAttribute(\'data-v\'))" data-v="' + esc(id) + '"><b>' + tag + '</b>' + esc(id) + '</div>'; }
    /** One door swap card — the DOORS list and the ACTIVITY tab share it. Stage pill: STARTED (lock sent) → LOCKED
     *  (maker locked) → CLAIMING → DONE / FORWARDING, or REFUNDED / ERROR. */
    function swapCard(s) {
        var f = fwds[DB.norm(s.hash)] || null, tx = DR.txIds(events[DB.norm(s.hash)] || []), inward = s.direction === 'ERC20_TO_MINIMA';
        var cls = s.status === 'COMPLETE' ? 'done' : (s.status === 'REFUNDED' || s.status === 'ERROR') ? 'bad' : 'live';
        var pill = s.status === 'COMPLETE' ? (f && f.status === 'pending' ? 'FORWARDING' : f && f.status === 'failed' ? 'FORWARD FAILED' : 'DONE') : s.status;
        return '<article class="order-card door-card ' + cls + '"><div class="door-head"><div><span class="door-pill ' + cls + '">' + esc(pill) + '</span> <strong>' + (inward ? 'DOOR IN ' : 'DOOR OUT ') + esc(s.sellAmount) + ' ' + DR.label(s.sellToken) + ' → ' + esc(s.buyAmount) + ' ' + DR.label(s.buyToken) + '</strong></div><span>' + new Date(Number(s.created)).toLocaleString() + '</span></div>'
            + '<div class="door-state">' + esc(DR.statusText(s, f)) + '</div><div class="door-ids">' + idLine('swap', s.hash)
            + (s.contractId ? idLine('eth contract', s.contractId) : '') + idLine('maker', s.counterparty)
            + tx.eth.map(function (h) { return idLine('eth tx', h); }).join('') + tx.minima.map(function (h) { return idLine('minima tx', h); }).join('')
            + (f ? idLine('forward to', f.to) + (f.tx ? idLine('forward tx', f.tx) : '') : '') + '</div>'
            + (f && f.status === 'failed' ? '<div class="door-actions"><button onclick="DexiconDoors.retry(\'' + PD.jsArg(s.hash) + '\')">RETRY FORWARD</button></div>' : '')
            + '</article>';
    }
    function renderSwaps() {
        var box = $('doorSwaps');
        if (!box) return;
        box.innerHTML = swaps.map(swapCard).join('') || '<div class="empty-card"><strong>No door swaps yet</strong><span>ENTER brings ERC20 USDT in as MxUSD or MINIMA; EXIT takes either out as USDT. MINIMA and MxUSD holders need no door.</span></div>';
    }
    function retry(hash) { DR.retryForward(AX.mds, hash, function () { notice('Forward for ' + hash + ' queued again — the service retries on the next block.', 'posted'); refresh(); }); }

    window.DexiconDoors = { inited: boot, onBlock: refresh, refresh: refresh, setPane: setPane, setDir: setDir, pick: pick, quote: quote, review: openReview, confirm: confirm, copy: copy, retry: retry,
        ethAddress: function () { return ctx ? ctx.eth.address : null; },
        /** Door swaps for the ACTIVITY tab: [{ ts, html }]. */
        activityCards: function () { return swaps.map(function (s) { return { ts: Number(s.created) || 0, html: swapCard(s) }; }); } };
})();
