/**
 * ui/doors.js — the DOORS tab: how ERC20 USDT users enter and leave the MINIMA/MxUSD DEX, through the vendored
 * AtomiX TAKER engine (doors/). Three panes over ONE flow — ENTER (USDT → MxUSD into this node's wallet), EXIT
 * (MxUSD → USDT forwarded to an Ethereum address), SWAP (either direction, delivered where the user says) — each
 * a best-price-first sweep of the AtomiX order book exactly as atomix-mds lib/app.js does it (onReview →
 * buildSweepPlan → startLeg per part; SELL parts serialised on their on-chain confirm, BUY parts nonce-serialised),
 * plus a forward queued per part (lib/door.js) that the background service carries out on completion.
 * Settlement never runs here: service.js (AXService) claims, withdraws and refunds. Exposes window.DexiconDoors;
 * ui/app.js's single MDS.init calls inited / onBlock / refresh. Identifiers are shown in FULL, tap to copy.
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var TR = AX.trading, B = AX.book, EN = AX.engine, SP = AX.swapplan, DEC = AX.dec, EO = AX.ethops, DR = AX.door, DB = AX.swapdb, W = AX.wallet;
    var EPS = 1e-9, BOOT_RETRY_MS = 15000, REFRESH_MS = 90000, BUY_SLIPPAGE = 0.02;
    var ctx = null, rpc = null, book = {}, pane = 'enter', dirIn = true, review = null, booting = false, bootTimer = null, timer = null;
    var bals = { eth: '—', usdt: '—', mxusd: '—' }, raw = { ethWei: null, usdtRaw: null }, gasWei = 0n;
    var swaps = [], fwds = {}, events = {};

    function notice(s, kind) { PD.notice(s, kind); if (kind === 'error') PD.appendActivity(s, Date.now()); }
    function esc(s) { return PD.esc(s); }
    function myId() { return ctx ? AX.boot.activeIdentity(ctx).publicId() : null; }
    function trim6(v) { var n = Number(v); return isFinite(n) ? (Math.round(n * 1e6) / 1e6).toString() : '0'; }
    function px(v) { v = Number(v); if (!isFinite(v) || v <= 0) return '0'; var s = v.toPrecision(6); return s.indexOf('.') > -1 ? s.replace(/0+$/, '').replace(/\.$/, '') : s; }
    function feeEth(gasLimit) { return gasWei > 0n ? trim6(DEC.formatUnits(W.gasReserveWei(gasWei, BigInt(gasLimit)), 18)) : '?'; }
    function copy(text) { if (!text || text === '—' || !navigator.clipboard) return; navigator.clipboard.writeText(String(text)); notice('Copied ' + text, 'posted'); }

    // ---------- boot (AtomiX's own sequence: trust preflight, seed identities, node-derived ETH key, covenant) ----------
    function boot() {
        if (booting || ctx) return;
        booting = true; clearTimeout(bootTimer);
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
    function refreshBook() { if (ctx) B.scan(function (err, b) { if (!err) { book = b || {}; quote(); } }); }
    function paintBals() { $('doorBals').textContent = 'ETH ' + bals.eth + ' · USDT ' + bals.usdt + ' · MxUSD ' + bals.mxusd + (gasWei > 0n ? ' · gas ' + trim6(DEC.formatUnits(gasWei, 9)) + ' gwei' : ''); }
    /** ETH + USDT via the ETH RPC (read-only), MxUSD via the node. RAW values are kept — fund checks never trust a rounded string. */
    function refreshBals() {
        if (!ctx) return;
        var addr = ctx.eth.address;
        rpc.getBalance(addr, function (e, wei) { if (e) { bals.eth = '—'; raw.ethWei = null; } else { raw.ethWei = wei; bals.eth = trim6(DEC.formatUnits(wei, 18)); } paintBals(); quote(); });
        EO.make(rpc, ctx.eth.privKey, addr).balanceOf(EO.NET.usdt, function (e, r) { if (e) { bals.usdt = '—'; raw.usdtRaw = null; } else { raw.usdtRaw = r; bals.usdt = DEC.formatUnits(r, 6); } paintBals(); quote(); });
        rpc.gasPrice(function (e, gp) { if (!e && gp > 0n) gasWei = gp; paintBals(); quote(); });
        AX.mds.cmdR('balance tokenid:' + TR.active().tokenId, function (e, r) { bals.mxusd = (!e && r && r[0]) ? trim6(r[0].sendable) : '—'; paintBals(); quote(); });
    }

    // ---------- panes ----------
    function setPane(p) {
        pane = p;
        ['enter', 'exit', 'swap'].forEach(function (k) {
            var cap = k.charAt(0).toUpperCase() + k.slice(1);
            $('door' + cap).hidden = k !== p; $('door' + cap + 'Btn').className = k === p ? 'active' : '';
        });
        quote();
    }
    function setDir(inward) {
        dirIn = !!inward;
        $('doorDirIn').className = dirIn ? 'selected-buy' : ''; $('doorDirOut').className = dirIn ? '' : 'selected-sell';
        $('doorSwapUnit').textContent = dirIn ? 'USDT (ERC20)' : 'MxUSD';
        $('doorSwapToLabel').textContent = dirIn ? 'Minima address — leave empty to keep the MxUSD in this node’s wallet' : 'Ethereum address, 0x + 40 hex';
        $('doorSwapTo').placeholder = dirIn ? 'Mx…' : '0x…';
        quote();
    }
    /** The active pane's inputs as one shape: sell = I give MxUSD (EXIT / SWAP out); else I give USDT. */
    function form() {
        if (pane === 'enter') return { sell: false, amt: $('doorEnterAmt').value.trim(), to: '', box: $('doorEnterQuote'), needTo: false };
        if (pane === 'exit') return { sell: true, amt: $('doorExitAmt').value.trim(), to: $('doorExitTo').value.trim(), box: $('doorExitQuote'), needTo: true };
        return { sell: !dirIn, amt: $('doorSwapAmt').value.trim(), to: $('doorSwapTo').value.trim(), box: $('doorSwapQuote'), needTo: !dirIn };
    }

    /**
     * Plan the active pane's take: SELL → MxUSD amount straight into the sweep planner; BUY → the USDT the user
     * holds is converted at the best ask into an MxUSD target, planned with slippage, and shaved once if the
     * ceil-rounded total would overshoot what they typed. Returns { plan, err, usdtIn } (plan null on no quote).
     */
    function planFor(f) {
        var q = B.bestMakers(book, myId()), amt = Number(f.amt), out = { plan: null, err: null, q: q };
        if (!f.amt) return out;
        if (!(amt > 0)) { out.err = 'Enter a valid amount.'; return out; }
        if (f.sell) {
            if (!q.bidMaker || q.bestBid <= 0) { out.err = 'No AtomiX maker is buying MxUSD right now.'; return out; }
            out.plan = SP.buildSweepPlan(book, true, f.amt, 0, myId());
        } else {
            if (!q.askMaker || q.bestAsk <= 0) { out.err = 'No AtomiX maker is selling MxUSD right now.'; return out; }
            var target = SP.computeMinima(f.amt, q.bestAsk);
            if (!target) { out.err = 'Amount too small.'; return out; }
            out.plan = SP.buildSweepPlan(book, false, target, BUY_SLIPPAGE, myId());
            if (out.plan.legs.length && out.plan.totalUsdt > amt + EPS) {           // ceil-rounding pushed the spend over the input: shave once
                var less = SP.legMinima(Number(target) - (out.plan.totalUsdt - amt) / q.bestAsk - 1e-6);
                out.plan = SP.buildSweepPlan(book, false, less, BUY_SLIPPAGE, myId());
            }
        }
        if (!out.plan.legs.length) out.err = out.plan.stopReason === 'below-min' ? 'That is below the makers’ minimum trade size.' : 'No liquidity available to fill that right now.';
        return out;
    }
    function ceiling(sell, q) {
        var depth = SP.sweepDepthMinima(book, sell, myId(), sell ? 0 : BUY_SLIPPAGE);
        return depth > 0 ? ('Ceiling now: ~' + trim6(depth) + ' MxUSD' + (sell ? '' : ' (≈ ' + trim6(depth * q.bestAsk) + ' USDT)') + ' across ' + Object.keys(book).length + ' maker' + (Object.keys(book).length === 1 ? '' : 's')) : 'Ceiling now: nothing quoted';
    }
    function quote() {
        if (!ctx) return;
        var f = form(), r = planFor(f), L = [], p = r.plan, i;
        if (AX.identitywatch.halted()) { $('doorHalt').hidden = false; $('doorHalt').textContent = 'HALTED — ' + AX.identitywatch.summary() + ' Rescue funds, then reinstall Dexicon.'; }
        if (!f.amt) {
            var q = r.q, best = f.sell ? q.bestBid : q.bestAsk;
            f.box.className = 'door-quote';
            f.box.textContent = best > 0 ? ('Best price ' + px(best) + ' USDT per MxUSD\n' + ceiling(f.sell, q)) : ('No AtomiX maker is ' + (f.sell ? 'buying' : 'selling') + ' MxUSD right now — check back, or trade MINIMA/MxUSD directly on TRADE.');
            return;
        }
        if (r.err) { f.box.className = 'door-quote bad'; f.box.textContent = r.err; return; }
        L.push((f.sell ? 'You give  ' + trim6(p.filledMinima) + ' MxUSD  →  receive ≈ ' + trim6(p.totalUsdt) + ' USDT' : 'You pay  ≈ ' + trim6(p.totalUsdt) + ' USDT  →  receive ' + trim6(p.filledMinima) + ' MxUSD'));
        L.push('Avg ' + px(p.avgPrice) + ' · worst ' + px(p.worstPrice) + ' USDT per MxUSD · ' + p.legs.length + ' part' + (p.legs.length === 1 ? '' : 's') + (f.sell ? '' : ' · within ' + BUY_SLIPPAGE * 100 + '% slippage'));
        if (p.partial) L.push('PARTIAL: fills ' + trim6(p.filledMinima) + ' of ' + trim6(p.target) + ' MxUSD — ' + (p.stopReason === 'slippage' ? 'the rest is priced beyond the slippage cap.' : 'the rest is not in the book right now.'));
        L.push(ceiling(f.sell, r.q));
        for (i = 0; i < p.legs.length; i++) L.push('Part ' + (i + 1) + ': ' + p.legs[i].minima + ' MxUSD @ ' + px(p.legs[i].price) + ' → ' + p.legs[i].usdt + ' USDT · maker ' + p.legs[i].maker.signerPk);
        if (f.sell) L.push('ETH gas from the deposit address: withdraw ≈ ' + feeEth(EO.NET.gas.withdraw) + ' ETH' + (f.to ? ' + forward ≈ ' + feeEth(W.GAS_ERC20) + ' ETH' : '') + ' (you hold ' + bals.eth + ' ETH)');
        else L.push('ETH gas from the deposit address: ≈ ' + feeEth(EO.NET.gas.newContract) + ' ETH per part (you hold ' + bals.eth + ' ETH)');
        if (f.to) L.push((f.sell ? 'USDT' : 'MxUSD') + ' will be forwarded to ' + f.to);
        else if (!f.sell) L.push('MxUSD lands in this node’s wallet.');
        var v = validate(f, p);
        f.box.className = 'door-quote ' + (v ? 'bad' : 'ok');
        f.box.textContent = L.join('\n') + (v ? '\n\n' + v : '');
    }
    /** Fund + address checks; fail CLOSED on an unreadable balance. Returns a message or ''. */
    function validate(f, p) {
        if (AX.identitywatch.halted()) return 'Halted: this node no longer owns the keys AtomiX uses here.';
        if (f.to && (f.sell ? !DR.isEthAddr(f.to) : !DR.isMxAddr(f.to))) return f.sell ? 'Destination must be an Ethereum address (0x + 40 hex).' : 'Destination must be a Minima address (Mx… or 0x + 64 hex).';
        if (f.needTo && !f.to) return 'Enter the destination address.';
        if (raw.ethWei == null) return 'Cannot read the ETH balance of the deposit address right now — try again shortly.';
        if (f.sell) {
            if (bals.mxusd === '—') return 'Cannot read your MxUSD balance right now.';
            if (p.filledMinima > Number(bals.mxusd) + EPS) return 'You hold ' + bals.mxusd + ' MxUSD — reduce the amount.';
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
        var f = form(), r = planFor(f);
        if (!f.amt) return notice('Enter an amount first.', 'error');
        if (r.err) return notice(r.err, 'error');
        var v = validate(f, r.plan); if (v) return notice(v, 'error');
        review = { plan: r.plan, to: f.to, kind: f.sell ? 'usdt' : 'minima', amtEl: pane === 'enter' ? $('doorEnterAmt') : (pane === 'exit' ? $('doorExitAmt') : $('doorSwapAmt')) };
        $('doorDialogTitle').textContent = (pane === 'enter' ? 'ENTER' : pane === 'exit' ? 'EXIT' : 'SWAP') + ' — ' + (f.sell ? 'sell ' + trim6(r.plan.filledMinima) + ' MxUSD for ≈ ' + trim6(r.plan.totalUsdt) + ' USDT' : 'buy ' + trim6(r.plan.filledMinima) + ' MxUSD for ≈ ' + trim6(r.plan.totalUsdt) + ' USDT');
        $('doorDialogBody').textContent = f.box.textContent + '\n\n' + (f.sell ? 'This locks your MxUSD on Minima now (block + 144 refund window).' : 'This locks your USDT on Ethereum now (2 h refund window).') + ' The background service completes the swap; keep this node running.';
        $('doorConfirm').disabled = false;
        $('doorDialog').showModal();
    }
    function confirm() {
        if (!review) return;
        var p = review.plan, to = review.to, kind = review.kind;
        $('doorConfirm').disabled = true; $('doorDialog').close();
        PD.setStage('Starting door swap…'); PD.paintNotice();
        if (p.sell) startSell(p, to, 0, 0); else startBuy(p, to);
        review.amtEl.value = ''; review = null;
    }
    function hooks(maker, sell) {
        return {
            makerLive: function () { return B.makerLive(book[maker.signerPk], sell); },
            me: AX.boot.activeIdentity(ctx), myPublicId: myId(),
            onWithdrawn: refreshBook,
            onNote: function (tag) { if (tag && tag.indexOf('buy-notify-failed') === 0) notice('USDT locked, but telling the maker failed (' + tag + ') — it can still find the lock by hashlock.', 'error'); }
        };
    }
    function queued(hash, kind, to) { if (to) DR.queueForward(AX.mds, hash, kind, to, function (e) { if (e) notice('Forward not queued for ' + hash + ': ' + e.message, 'error'); refresh(); }); else refresh(); }
    /** SELL parts lock unpinned MxUSD coins → each waits for the previous lock to confirm (no double-select). */
    function startSell(p, to, i, ok) {
        if (i >= p.legs.length) { PD.setStage(''); notice('Door: ' + ok + '/' + p.legs.length + ' part' + (p.legs.length === 1 ? '' : 's') + ' locked — the service completes the swap.', 'posted'); return; }
        var leg = p.legs[i];
        PD.setStage('Locking part ' + (i + 1) + '/' + p.legs.length + ' on Minima…'); PD.paintNotice();
        EN.startLeg(leg.maker, 'USDT', true, leg.minima, leg.usdt, hooks(leg.maker, true), function (err, hash) {
            if (err) { PD.setStage(''); notice('Door stopped at part ' + (i + 1) + ': ' + err.message, 'error'); refresh(); return; }
            PD.appendActivity('Door: locked ' + leg.minima + ' MxUSD for ' + leg.usdt + ' USDT — swap ' + hash, Date.now());
            queued(hash, 'usdt', to);
            pollConfirm(hash, true, function (confirmed) {
                if (confirmed) return startSell(p, to, i + 1, ok + 1);
                PD.setStage(''); notice('Part ' + (i + 1) + ' is still confirming; remaining parts not sent — try again shortly.', 'error');
            });
        });
    }
    /** BUY parts are nonce-serialised by the ETH sender → fire back-to-back. */
    function startBuy(p, to) {
        var done = 0, ok = 0;
        p.legs.forEach(function (leg, i) {
            EN.startLeg(leg.maker, 'USDT', false, leg.minima, leg.usdt, hooks(leg.maker, false), function (err, hash) {
                done++;
                if (err) notice('Door part ' + (i + 1) + ' failed: ' + err.message, 'error');
                else { ok++; PD.appendActivity('Door: locked ' + leg.usdt + ' USDT for ' + leg.minima + ' MxUSD — swap ' + hash, Date.now()); queued(hash, 'minima', to); }
                if (done === p.legs.length) { PD.setStage(''); if (ok) notice('Door: ' + ok + '/' + p.legs.length + ' USDT lock' + (ok === 1 ? '' : 's') + ' sent — the service completes the swap.', 'posted'); }
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
                    if (i >= swaps.length) return renderSwaps();
                    var s = swaps[i++];
                    DB.getEvents(s.hash, function (e2, ev) { events[DB.norm(s.hash)] = ev || []; step(); });
                })();
            });
        });
    }
    function idLine(tag, id) { return '<div onclick="DexiconDoors.copy(this.textContent.slice(' + (tag.length + 1) + '))"><b>' + tag + '</b>' + esc(id) + '</div>'; }
    function renderSwaps() {
        var box = $('doorSwaps'), out = [], i, s, f, ids, cls, pill, inward;
        if (!box) return;
        for (i = 0; i < swaps.length; i++) {
            s = swaps[i]; f = fwds[DB.norm(s.hash)] || null; ids = DR.txIds(events[DB.norm(s.hash)] || []);
            inward = s.direction === 'ERC20_TO_MINIMA';
            cls = s.status === 'COMPLETE' ? 'done' : (s.status === 'REFUNDED' || s.status === 'ERROR') ? 'bad' : 'live';
            pill = s.status === 'COMPLETE' ? (f && f.status === 'pending' ? 'FORWARDING' : f && f.status === 'failed' ? 'FORWARD FAILED' : 'DONE') : s.status;
            out.push('<article class="order-card door-card ' + cls + '"><div class="door-head"><div><span class="door-pill ' + cls + '">' + esc(pill) + '</span> <strong>' + (inward ? 'ENTER ' : 'EXIT ') + esc(s.sellAmount) + ' ' + DR.label(s.sellToken) + ' → ' + esc(s.buyAmount) + ' ' + DR.label(s.buyToken) + '</strong></div><span>' + new Date(Number(s.created)).toLocaleString() + '</span></div>'
                + '<div class="door-state">' + esc(DR.statusText(s, f)) + '</div><div class="door-ids">' + idLine('swap', s.hash)
                + (s.contractId ? idLine('eth contract', s.contractId) : '') + idLine('maker', s.counterparty)
                + ids.eth.map(function (h) { return idLine('eth tx', h); }).join('') + ids.minima.map(function (h) { return idLine('minima tx', h); }).join('')
                + (f ? idLine('forward to', f.to) + (f.tx ? idLine('forward tx', f.tx) : '') : '') + '</div>'
                + (f && f.status === 'failed' ? '<div class="door-actions"><button onclick="DexiconDoors.retry(\'' + PD.jsArg(s.hash) + '\')">RETRY FORWARD</button></div>' : '')
                + '</article>');
        }
        box.innerHTML = out.join('') || '<div class="empty-card"><strong>No door swaps yet</strong><span>ENTER brings ERC20 USDT in as MxUSD; EXIT takes MxUSD out as USDT. MINIMA and MxUSD holders need no door.</span></div>';
    }
    function retry(hash) { DR.retryForward(AX.mds, hash, function () { notice('Forward for ' + hash + ' queued again — the service retries on the next block.', 'posted'); refresh(); }); }

    window.DexiconDoors = { inited: boot, onBlock: refresh, refresh: refresh, setPane: setPane, setDir: setDir, quote: quote, review: openReview, confirm: confirm, copy: copy, retry: retry,
        ethAddress: function () { return ctx ? ctx.eth.address : null; } };
})();
