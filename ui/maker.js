/**
 * ui/maker.js — ORDERS › MARKET MAKER (window.DexiconMaker), mirror of Dexicon Android 0.1.21 MarketMaker.java: AtomiX's
 * market editor for the FAST book — enable, peg to MEXC (skew, reprice threshold), auto-fill (mid · step % · levels ·
 * ask/bid size), rungs A6..A1 / B1..B6, and a preview of what the ladder commits against what you hold. service.js keeps
 * the ladder live (lib/ladder.js); the page only edits kv 'mm_config' and reads 'mm_status' / 'mm_feed'.
 */
(function () {
    /** Wake the service so the ladder reconciles NOW (owner 2026-10-26: cancel-to-repost was ~18 s of waiting). */
    function wake() { try { MDS.comms.solo(JSON.stringify({ origin: 'dexicon', type: 'LADDER', data: {} }), function () { }); } catch (e) { } }
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var L = AX.ladder, N = L.MAX_LEVELS, feed = { mid: 0, line: 'MEXC: waiting for the service' }, timer = null, filling = false;
    function esc(s) { return PD.esc(s); }

    function render() {
        var box = $('mmCard');
        if (!box) return;
        AX.mds.kvGet('mm_config', '', function (cs) { AX.mds.kvGet('mm_status', '', function (st) { AX.mds.kvGet('mm_feed', '{}', function (fs) {
            var c = L.fromJson(cs), mode = !c.enabled ? 'OFF' : c.peg ? 'PEGGED · MEXC' : 'MANUAL';
            try { feed = JSON.parse(fs || '{}'); } catch (e) { }
            box.innerHTML = '<div class="summary-card mm-card"><div class="mm-top"><label>MARKET MAKER</label><span class="mm-pill' + (c.enabled ? ' on' : '') + '">' + mode + '</span></div>'
                + (c.enabled && c.peg && feed.line ? '<span class="mm-feed">' + esc(feed.line) + '</span>' : '')
                + '<span class="mm-status">' + esc(st || (c.enabled ? 'starting — the service picks it up within seconds' : 'A ladder of FAST asks and bids, pegged to MEXC or set by hand. Your node keeps it live and co-signs every fill.')) + '</span>'
                + '<div class="maker-actions"><button class="cta" onclick="DexiconMaker.open()">' + (c.enabled ? 'EDIT LADDER' : 'SET UP') + ' <span>→</span></button>'
                + (c.enabled ? '<button class="secondary mm-stop" onclick="DexiconMaker.stop()">STOP</button>' : '') + '</div></div>';
        }); }); });
    }

    function buildRows() {
        var a = $('mmAsks'), b = $('mmBids'), i, h = [];
        if (a.childElementCount) return;
        for (i = N; i >= 1; i--) h.push(rowHtml('A', i));   // A6 on top, A1 by the spread
        a.innerHTML = h.join(''); h = [];
        for (i = 1; i <= N; i++) h.push(rowHtml('B', i));
        b.innerHTML = h.join('');
    }
    function rowHtml(s, i) {
        return '<div class="mm-row"><b class="' + (s === 'A' ? 'ask' : 'bid') + '">' + s + i + '</b><input id="mm' + s + i + 'p" inputmode="decimal" placeholder="price" oninput="DexiconMaker.preview()">'
            + '<input id="mm' + s + i + 'a" inputmode="decimal" placeholder="MINIMA" oninput="DexiconMaker.preview()"></div>';
    }
    var FIELDS = { skew: 'mmSkew', reprice: 'mmReprice', mid: 'mmMid', step: 'mmStep', levels: 'mmLevels', askSize: 'mmAsk', bidSize: 'mmBid' };
    function read() {
        var c = L.blankConfig(), k, i;
        c.enabled = $('mmEnabled').checked; c.peg = $('mmPeg').checked;
        for (k in FIELDS) c[k] = $(FIELDS[k]).value.trim();
        for (i = 0; i < N; i++) { c.asks[i] = [$('mmA' + (i + 1) + 'p').value.trim(), $('mmA' + (i + 1) + 'a').value.trim()]; c.bids[i] = [$('mmB' + (i + 1) + 'p').value.trim(), $('mmB' + (i + 1) + 'a').value.trim()]; }
        return c;
    }
    function write(c) {
        var k, i;
        $('mmEnabled').checked = !!c.enabled; $('mmPeg').checked = !!c.peg;
        for (k in FIELDS) $(FIELDS[k]).value = c[k] || '';
        for (i = 0; i < N; i++) { $('mmA' + (i + 1) + 'p').value = c.asks[i][0]; $('mmA' + (i + 1) + 'a').value = c.asks[i][1]; $('mmB' + (i + 1) + 'p').value = c.bids[i][0]; $('mmB' + (i + 1) + 'a').value = c.bids[i][1]; }
    }

    /** AtomiX behaviour: rungs regenerate from mid · step · levels · sizes as you type (manual) or from the live MEXC mid
     *  (pegged); a rung edited by hand stays until those inputs change again. */
    function fill() {
        if (filling) return;
        var c = read(), m, sk, st = L.parse(c.step), a = L.parse(c.askSize), b = L.parse(c.bidSize), rs, i;
        if (c.peg) {
            if (!(feed.mid > 0)) return preview();
            sk = L.parse(c.skew, true) || AX.fill.d(0);
            if (sk.lt(-20)) sk = AX.fill.d(-20); if (sk.gt(20)) sk = AX.fill.d(20);
            m = AX.fill.d(String(feed.mid)).times(AX.fill.d(1).plus(sk.div(100)));
        } else m = L.parse(c.mid);
        if (!m || !st || !a || !b || m.lte(0) || st.lte(0) || (a.lte(0) && b.lte(0))) return preview();
        filling = true;
        if (c.peg) $('mmMid').value = m.toDecimalPlaces(8).toFixed();
        for (i = 1; i <= N; i++) ['A', 'B'].forEach(function (s) { $('mm' + s + i + 'p').value = ''; $('mm' + s + i + 'a').value = ''; });
        rs = L.generate(m, st, L.levelCount(c), a, b);
        rs.forEach(function (r) { $('mm' + r.key + 'p').value = AX.fill.plain(r.price); $('mm' + r.key + 'a').value = AX.fill.plain(r.amount); });
        filling = false;
        preview();
    }
    function preview() {
        if (filling) return;
        var c = read(), err = L.validate(c), on = JSON.parse(JSON.stringify(c)), rs, k, m = PD.bal('minima'), u = PD.bal('usdt'), short, t;
        on.enabled = true;
        rs = c.peg ? L.desired(on, feed.mid, 1) : L.desired(on, 0, 1);
        k = L.commits(rs);
        short = m && u && (k.minima.gt(m.sendable) || k.mxusd.gt(u.sendable));
        t = rs.length + (rs.length === 1 ? ' rung' : ' rungs') + ' · asks commit ' + AX.fill.plain(k.minima) + ' MINIMA · bids commit ' + AX.fill.plain(k.mxusd) + ' MxUSD';
        if (m && u) t += '\nyou hold ' + PD.fmtBal(m.sendable) + ' MINIMA · ' + PD.fmtBal(u.sendable) + ' MxUSD';
        if (short) t += '\n⚠ the ladder commits more than you hold — rungs that cannot be backed stay off';
        if (rs.length > 1) t += '\none coin per rung: if your wallet is one big coin, the maker splits it once (one block)';
        if (err) t += '\n✗ ' + err;
        $('mmPreview').textContent = t;
        $('mmPreview').className = 'door-quote' + (err ? ' bad' : '');
        $('mmFeed').textContent = feed.line || '';
        $('mmMid').disabled = c.peg;
    }
    function open() {
        buildRows();
        AX.mds.kvGet('mm_config', '', function (cs) {
            write(L.fromJson(cs));
            $('mmDialog').showModal();
            pollFeed(); preview();
            timer = setInterval(pollFeed, 2000);
        });
    }
    function pollFeed() {
        AX.mds.kvGet('mm_feed', '{}', function (fs) {
            var was = feed.mid;
            try { feed = JSON.parse(fs || '{}'); } catch (e) { }
            if ($('mmPeg').checked && feed.mid !== was) fill(); else preview();
        });
    }
    function close() { if (timer) clearInterval(timer); timer = null; $('mmDialog').close(); }
    function save() {
        var c = read(), err = L.validate(c);
        if (err) { preview(); return PD.notice(err, 'error'); }
        AX.mds.kvSet('mm_config', JSON.stringify(c), function () { AX.mds.kvSet('mm_dirty', '1', function () { wake();
            close(); render();
            PD.notice(c.enabled ? 'Saved — the maker service puts the ladder live within seconds' : 'Saved — market maker off', 'posted');
        }); });
    }
    function stop() {
        if (!confirm('Stop the market maker? Every ladder order is cancelled on the relays within seconds. Your settings are kept.')) return;
        AX.mds.kvGet('mm_config', '', function (cs) {
            var c = L.fromJson(cs); c.enabled = false;
            AX.mds.kvSet('mm_config', JSON.stringify(c), function () { AX.mds.kvSet('mm_dirty', '1', function () { wake(); render(); PD.notice('Stopping — ladder orders are being cancelled', 'posted'); }); });
        });
    }
    /** Rung label for an order in OPEN (orderId → 'A1'…), read from kv 'mm_ids'. */
    var rungOf = {};
    function loadIds(cb) { AX.mds.kvGet('mm_ids', '{}', function (v) { var ids = {}, k; try { ids = JSON.parse(v || '{}'); } catch (e) { } rungOf = {}; for (k in ids) rungOf[ids[k]] = k; if (cb) cb(); }); }

    window.DexiconMaker = { render: render, open: open, close: close, save: save, stop: stop, fill: fill, preview: preview, loadIds: loadIds, rung: function (id) { return rungOf[id] || ''; } };
})();
