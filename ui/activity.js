/**
 * ui/activity.js — the ACTIVITY tab (window.DexiconActivity): every trade, newest first, live stage, full ids.
 * Mirrors the Android ActivityTab (apks/dexicon 0.1.9); the stage machine is lib/activity.js (AX.activity).
 * Rows live in ax_kv 'activity' (this page is their only writer). Sources:
 *   FAST taker   ui/app.js sendTake / inboxLoop call record()/update()
 *   FAST maker   the service's fill_<txpowid> rows (merged in, AX.activity.merge)
 *   BOOK/POOL    the vendored PDService's own in-flight fill_state (txpowid, size, proceeds, source coins) and busy/stage
 * Tracking runs while this page is open (NEWBLOCK + every 10 s): inputs first, then the output — FAST rows by
 * `coins coinid:<output>`, BOOK/POOL rows by the exact proceeds coin PDService itself verifies. Never by time.
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var A = AX.activity, rows = [], fills = [], loaded = false, tracking = false, liveId = null, tip = 0;
    var USD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';

    function esc(s) { return PD.esc(s); }
    function save() { AX.mds.kvSet('activity', JSON.stringify(rows), function () { }); }
    function load(cb) {
        AX.mds.kvGet('activity', '[]', function (v) { try { rows = JSON.parse(v || '[]'); } catch (e) { rows = []; } loaded = true; if (cb) cb(); });
    }
    function chainTip() { return Math.max(tip, Number((PD.state() || {}).block || 0)); }

    /** New row (FAST taker from app.js); it becomes the one the TRADE status line follows. */
    function record(row) { row.ts = row.ts || Date.now(); rows = A.upsert(rows, row); liveId = row.id; save(); render(); }
    function update(id, fn) { var r = A.find(rows, function (x) { return x.id === id; }); if (!r) return; fn(r); save(); render(); }
    function setFills(list) { fills = list || []; render(); }

    /** Adopt PDService's in-flight BOOK/POOL fill (fill_state) as a slow row, once per txpowid. */
    function adoptSlow(cb) {
        MDS.sql("SELECT `json` FROM `fill_state` WHERE `id`=1", function (res) {
            var raw = null, r = (res && res.rows) || [];
            try { if (r.length) raw = JSON.parse(r[0].json || r[0].JSON || 'null'); } catch (e) { raw = null; }
            var m = raw && raw.meta;
            if (m && m.txpowid && !A.find(rows, function (x) { return x.txpowid === m.txpowid; })) {
                var row = A.fromSlow(m, Date.now()); row.payTok = m.buy ? '0x00' : USD;
                rows = A.upsert(rows, row); liveId = row.id; save();
            }
            if (cb) cb();
        });
    }

    function cmd(c, cb) { AX.mds.cmdR(c, function (err, r) { cb(err ? null : r); }); }
    function first(r) { return Object.prototype.toString.call(r) === '[object Array]' ? r[0] : r; }
    function inputsGone(ins, i, cb) {
        if (!ins || i >= ins.length) return cb(false);
        cmd('coins coinid:' + ins[i], function (r) {
            if (r === null) return inputsGone(ins, i + 1, cb);            // unreadable is not "gone"
            var c = first(r);
            if (!c || !c.coinid || c.spent === true) return cb(true);
            inputsGone(ins, i + 1, cb);
        });
    }
    /** The output evidence: FAST → the first output coin's created block; BOOK/POOL → the exact proceeds coin. */
    function outCreated(a, cb) {
        if (a.outs && a.outs.length) return cmd('coins coinid:' + a.outs[0], function (r) { var c = r && first(r); cb(c && c.coinid ? Number(c.created || 0) : 0); });
        var st = PD.state() || {}, addr = st.identity && st.identity.address;
        if (!a.proceeds || !addr) return cb(0);
        cmd('coins simplestate:true address:' + addr + ' tokenid:' + (a.payTok || '0x00') + ' coinage:0 depth:' + Math.max(12, chainTip() - Number(a.postBlock || 0) + 6), function (r) {
            var c = A.proceedsCoin(r, a.payTok || '0x00', a.proceeds, a.postBlock);
            if (c) a.outs = [c.coinid];
            cb(c ? Number(c.created || 0) : 0);
        });
    }
    function track() {
        if (tracking || !loaded) return;
        adoptSlow(function () {
            var now = Date.now(), todo = rows.filter(function (a) { return A.watch(a, chainTip(), now); });
            if (!todo.length) return render();
            tracking = true;
            cmd('block', function (b) {
                tip = Math.max(tip, Number((b && b.block) || 0));
                var i = 0, changed = false;
                (function step() {
                    if (i >= todo.length) { tracking = false; if (changed) save(); return render(); }
                    var a = todo[i++], probe = !Number(a.block) && (a.stage === A.POSTED || a.stage === A.COSIGNED || a.stage === A.DROPPED);
                    if (!probe) { changed = A.observe(a, tip, false, 0, Date.now()) || changed; return step(); }
                    inputsGone(a.ins, 0, function (gone) {
                        outCreated(a, function (created) { changed = A.observe(a, tip, gone, created, Date.now()) || changed; step(); });
                    });
                })();
            });
        });
    }

    function all() { return A.merge(rows, fills); }
    function idLine(label, v) { return v ? '<div class="trade-evidence act-id" onclick="DexiconFast.copy(this.getAttribute(\'data-v\'))" data-v="' + esc(v) + '">' + esc(label) + ' ' + esc(v) + '</div>' : ''; }
    function card(a, cb, now) {
        var buy = a.side === 'buy', tone = A.failedTerminal(a) ? 'bad' : A.confirmed(a, cb) ? 'ok' : 'live', d = A.depth(a, cb), out = [], i;
        out.push('<article class="order-card act-card ' + (buy ? 'buy-order' : 'sell-order') + '"><div class="order-top"><div><span class="side">' + (buy ? 'BUY' : 'SELL')
            + '</span><strong>' + PD.fmt(a.amount) + ' MINIMA <b>@</b> ' + PD.fmtPrice(a.price) + '</strong></div><span class="act-chip ' + tone + '">' + esc(A.chip(a, cb)) + '</span></div>');
        out.push('<div class="order-meta"><span>' + esc(a.route) + ' · ' + (a.role === 'maker' ? 'MAKER' : 'TAKER') + (a.mxusd ? ' · ' + esc(a.mxusd) + ' MxUSD' : '') + ' · '
            + esc(new Date(Number(a.ts || 0)).toLocaleString()) + '</span><span>' + Math.max(0, Math.floor((now - Number(a.ts || now)) / 1000)) + 's</span></div>');
        out.push('<p class="act-status">' + esc(A.status(a, cb, now)) + '</p>');
        if (a.postBlock || a.block) out.push('<div class="order-meta"><span>' + (a.postBlock ? 'posted at block ' + a.postBlock : '') + (a.block ? (a.postBlock ? ' · ' : '') + 'in block ' + a.block + ' · ' + A.confirmationText(d) : '') + '</span></div>');
        out.push(idLine('txpow', a.txpowid));
        for (i = 0; a.outs && i < a.outs.length; i++) out.push(idLine('coin', a.outs[i]));
        out.push(idLine('order', a.orderId));
        if (a.route === 'FAST') out.push(idLine(a.role === 'maker' ? 'taker' : 'maker', a.counterparty));
        out.push('</article>');
        return out.join('');
    }
    function render() {
        var box = $('activityPage'), live = $('activityLive'), st = PD.state() || {}, cb = chainTip(), now = Date.now(), list = all(), html = [], i, followed;
        if (st.busy && st.stage) html.push('<article class="order-card act-card is-pending"><div class="order-top"><div><span class="side">BOOK/POOL</span><strong>in progress</strong></div><span class="act-chip live">BUILDING</span></div><p class="act-status">' + esc(st.stage) + '</p></article>');
        // Door swaps (AtomiX, both markets) join the timeline with their own stages and full tx ids (ui/doors.js swapCard).
        var items = list.map(function (a) { return { ts: Number(a.ts || 0), html: card(a, cb, now) }; });
        if (window.DexiconDoors && DexiconDoors.activityCards) items = items.concat(DexiconDoors.activityCards());
        items.sort(function (x, y) { return y.ts - x.ts; });
        for (i = 0; i < items.length; i++) html.push(items[i].html);
        if (box) box.innerHTML = '<div class="summary-card"><label>ACTIVITY · NEWEST FIRST</label><span>Confirmed / done after ' + A.CONFIRM_BLOCKS
            + ' blocks. The txpowid is the pre-mining id; inclusion is proven by an output coin. Tap any id to copy it in full.</span></div>'
            + (html.join('') || '<div class="empty-card"><strong>No trades yet</strong><span>Every BUY/SELL you make, every fill your node co-signs and every AtomiX swap shows its live progress here.</span></div>');
        if (!live) return;
        followed = liveId && A.find(rows, function (x) { return x.id === liveId; });
        if (followed && A.settled(followed, cb)) { followed.settledMs = followed.settledMs || now; if (now - followed.settledMs > 120000) { liveId = null; followed = null; } }
        if (st.busy && st.stage && !followed) { live.hidden = false; live.textContent = 'BOOK/POOL · ' + st.stage + '   ▸ ACTIVITY'; return; }
        live.hidden = !followed;
        if (followed) live.textContent = (followed.side === 'buy' ? 'BUY ' : 'SELL ') + followed.amount + ' MINIMA · ' + followed.route + ' · ' + A.status(followed, cb, now) + '   ▸ ACTIVITY';
    }
    function onBlock() { track(); }
    function boot() { load(function () { track(); }); }
    setInterval(function () { if (loaded) { track(); } }, 10000);
    setInterval(function () { var v = $('activityView'); if (liveId || (v && v.className.indexOf('active') >= 0)) render(); }, 1000);

    function statusOf(id) { var r = A.find(rows, function (x) { return x.id === id; }); return r ? A.status(r, chainTip(), Date.now()) : null; }
    window.DexiconActivity = { statusOf: statusOf, boot: boot, record: record, update: update, setFills: setFills, onBlock: onBlock, render: render, track: track };
})();
