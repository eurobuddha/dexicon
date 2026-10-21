/**
 * ui/app.js — Dexicon page: the FAST layer (signed relay orders, node-co-signed fills) and the relay panel, riding
 * on the vendored PandaDEX page (ui/pd_app.js = RESTING layer: V5 covenant book + PandaPools, chart, tape, assets,
 * on-chain maker). PandaDEX's script exposes window.PD; this file exposes window.DexiconFast, which pd_app.js calls
 * from its ladder, order form, orders list and render(). ui/doors.js exposes window.DexiconDoors (the AtomiX doors).
 * One MDS.init lives here.
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var M = AX.maker, F = AX.fill, E = AX.envelope;
    var me = null, client = null, relays = [], discovered = [], polling = false, inboxPolling = false;
    var myOrders = [], fastFills = [], pendingTakes = {}, takeCtx = null, fastMode = true, version = 'dev';
    var D = function (v) { return PandaDEX.d(v); };

    try { fastMode = localStorage.getItem('dexicon_layer') !== 'chain'; } catch (e) { }

    function notice(s, kind) { PD.notice(s, kind); if (kind === 'error') PD.appendActivity(s, Date.now()); }
    function esc(s) { return PD.esc(s); }
    function nowS() { return Math.floor(Date.now() / 1000); }
    function mySignPk() { return me ? ('0x' + AX.hex.to(me.signPk)).toLowerCase() : ''; }

    // ---------- layer mode ----------
    function setMode(fast) {
        fastMode = !!fast;
        try { localStorage.setItem('dexicon_layer', fastMode ? 'fast' : 'chain'); } catch (e) { }
        $('layerFast').className = fastMode ? 'selected-fast' : '';
        $('layerChain').className = fastMode ? '' : 'selected-chain';
        $('layerBadge').textContent = fastMode ? 'FAST' : 'V5';
        $('layerHint').textContent = fastMode
            ? 'FAST: instant to place, edit and cancel; your coins stay in your wallet and your node co-signs each fill.'
            : 'ON-CHAIN: your funds move into the V5 covenant until filled or cancelled; survives your node going offline.';
        $('gtc').style.display = fastMode ? 'none' : '';
        $('advanced').style.display = fastMode ? 'none' : '';
        fastPreview();
    }

    // ---------- the fast book ----------
    function liveOrders() { return client ? client.orders() : []; }
    /** Levels for the ladder: [{price, minima, exact, mine}] on one side, quantised to the grouping tick like PandaDEX. */
    function levels(sell, tick) {
        var out = {}, keys = [], orders = liveOrders(), i, o, price, amount, level, key, t = tick ? D(tick) : null;
        for (i = 0; i < orders.length; i++) {
            o = orders[i];
            if ((o.side === 'sell') !== !!sell) continue;
            price = PD.num(o.price); amount = PD.num(o.amount);
            if (!price || !amount || !amount.gt(0)) continue;
            level = t ? (sell ? price.div(t).ceil() : price.div(t).floor()).mul(t) : price.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
            key = level.toFixed();
            if (!out[key]) { out[key] = { price: level, minima: D(0), exact: price, mine: false }; keys.push(key); }
            out[key].minima = out[key].minima.add(amount);
            if (sell ? price.lt(out[key].exact) : price.gt(out[key].exact)) out[key].exact = price;
            if (o.signPk.toLowerCase() === mySignPk()) out[key].mine = true;
        }
        return keys.map(function (k) { return out[k]; });
    }
    /** Best fast orders on the OPPOSITE side that a limit at `price` crosses, best price first (never my own). */
    function crossing(isBuy, price) {
        var p = PD.num(price), out = [], orders = liveOrders(), i, o, op;
        if (!p) return out;
        for (i = 0; i < orders.length; i++) {
            o = orders[i]; op = PD.num(o.price);
            if (!op || o.signPk.toLowerCase() === mySignPk() || !(o.coins || []).length) continue;
            if (isBuy && o.side === 'sell' && op.lte(p)) out.push(o);
            if (!isBuy && o.side === 'buy' && op.gte(p)) out.push(o);
        }
        out.sort(function (a, b) { return isBuy ? D(a.price).cmp(D(b.price)) : D(b.price).cmp(D(a.price)); });
        return out;
    }
    function fastPreview() {
        var box = $('fastPreview'), isBuy = PD.isBuy(), price = $('price').value, amount = PD.num($('amount').value), hits, lines = [], left, take, now;
        if (!box) return;
        if (!fastMode || !amount || !amount.gt(0)) { box.textContent = ''; box.className = 'fast-preview'; return; }
        hits = crossing(isBuy, price);
        if (!hits.length) { box.textContent = 'Rests as a FAST ' + (isBuy ? 'bid' : 'ask') + ' on ' + relays.length + ' relay' + (relays.length === 1 ? '' : 's') + ' — instant, cancel any time.'; box.className = 'fast-preview'; return; }
        take = hits[0]; now = Decimal.min(amount, D(take.amount)); left = amount.sub(now);
        lines.push('CROSSES a FAST ' + (isBuy ? 'ask' : 'bid') + ' @ ' + take.price + ' (' + take.amount + ' MINIMA): takes ' + now.toFixed() + ' now, final in one block.');
        if (left.gt(0)) lines.push('Remaining ' + left.toFixed() + ' MINIMA then rests as a FAST order @ ' + price + '.');
        box.textContent = lines.join('\n'); box.className = 'fast-preview cross';
    }

    // ---------- placing ----------
    function place(isBuy) {
        var price = $('price').value.trim(), amount = $('amount').value.trim(), p = PD.num(price), a = PD.num(amount), hits, take, now, rest;
        if (!me) return notice('Identity not ready — grant WRITE trust in MiniHub and reload.', 'error');
        if (!relays.length) return notice('Add a relay first (RELAYS tab).', 'error');
        if (!p || !p.gt(0) || !a || !a.gt(0)) return notice('Enter a valid price and amount.', 'error');
        hits = crossing(isBuy, price);
        if (hits.length) {
            take = hits[0]; now = Decimal.min(a, D(take.amount)); rest = a.sub(now);
            openTake(take, now.toFixed(), rest.gt(0) ? { side: isBuy ? 'buy' : 'sell', price: p.toFixed(), amount: rest.toFixed() } : null, { isBuy: isBuy, price: p.toFixed(), amount: a.toFixed(), tried: [] });
            return;
        }
        createFast({ side: isBuy ? 'buy' : 'sell', price: p.toFixed(), amount: a.toFixed() }, function (err) { if (!err) { $('amount').value = ''; PD.preview(); fastPreview(); } });
    }
    function createFast(spec, cb) {
        PD.setStage('Publishing fast order…'); PD.paintNotice();
        M.create(AX.mds, client, me, spec, function (err, o, results) {
            PD.setStage('');
            if (err) { notice('Order not placed: ' + err.message, 'error'); return cb && cb(err); }
            var ok = results.filter(function (r) { return r.ok; }).length;
            notice('Fast ' + spec.side + ' ' + spec.amount + ' MINIMA @ ' + spec.price + ' live on ' + ok + '/' + results.length + ' relay' + (results.length === 1 ? '' : 's') + ' — order ' + o.orderId, 'posted');
            PD.appendActivity('Fast order ' + o.orderId + ' published (' + spec.side + ' ' + spec.amount + ' @ ' + spec.price + ')', Date.now());
            loadMyOrders(); if (cb) cb(null, o);
        });
    }

    // ---------- my fast orders ----------
    function loadMyOrders(cb) { M.load(AX.mds, function (err, list) { myOrders = list || []; renderMine(); PD.renderOrdersPage(); PD.renderBookOnly(); if (cb) cb(); }); }
    function mineHtml() {
        var live = myOrders.filter(function (o) { return o.status === 'live'; }), out = [], i, o, total, coins;
        for (i = 0; i < live.length; i++) {
            o = live[i]; total = D(o.remaining).mul(D(o.price)); coins = (o.coins || []).length;
            out.push('<article class="order-card fast-order ' + (o.side === 'sell' ? 'sell-order' : 'buy-order') + (coins ? '' : ' is-pending') + '"><div class="order-top"><div><span class="side">' + (o.side === 'sell' ? 'SELL' : 'BUY')
                + '</span><strong>' + PD.fmt(o.remaining) + ' MINIMA <b>@</b> ' + PD.fmtPrice(o.price) + '</strong></div><div class="order-buttons"><button onclick="DexiconFast.editOrder(\'' + PD.jsArg(o.orderId) + '\',\'' + PD.jsArg(PD.fmtPrice(o.price)) + '\')">EDIT</button><button onclick="DexiconFast.cancelOrder(\'' + PD.jsArg(o.orderId) + '\')">CANCEL</button></div></div>'
                + '<div class="order-meta"><span>' + (o.remaining === o.amount ? '' : 'filled ' + PD.fmt(D(o.amount).sub(D(o.remaining))) + ' of ' + PD.fmt(o.amount) + ' · ') + 'total ' + PD.fmt(total) + ' MxUSD · backed by ' + coins + ' coin' + (coins === 1 ? '' : 's') + ' · seq ' + o.seq + '</span><span>' + (coins ? 'LIVE' : 'RE-BACKING') + '</span></div>'
                + (coins ? '' : '<p>⏳ Not fillable until your node re-backs it (backing coins moved or aged out; the service re-locks them).</p>')
                + '<div class="trade-evidence">order ' + esc(o.orderId) + ' · pays to ' + esc(o.address) + '</div></article>');
        }
        return out.join('');
    }
    function renderMine() { var box = $('fastMine'); if (box) box.innerHTML = pendingRows() + mineHtml(); }
    function cancelOrder(orderId) {
        if (!confirm('Cancel this fast order? It disappears from every relay immediately.')) return;
        M.cancel(AX.mds, client, me, orderId, function (err) { notice(err ? 'Cancel failed: ' + err.message : 'Fast order ' + orderId + ' cancelled', err ? 'error' : 'posted'); loadMyOrders(); });
    }
    function editOrder(orderId, price) {
        var next = prompt('New price (MxUSD per MINIMA)', price || ''), d, o;
        if (next === null) return;
        d = PD.num(next); if (!d || !d.gt(0)) return notice('Enter a valid new price.', 'error');
        o = M.find(myOrders, orderId); if (!o) return;
        M.edit(AX.mds, client, me, orderId, { price: d.toFixed(), amount: o.remaining }, function (err) { notice(err ? 'Edit failed: ' + err.message : 'Fast order ' + orderId + ' repriced to ' + d.toFixed(), err ? 'error' : 'posted'); loadMyOrders(); });
    }

    // ---------- taking ----------
    function openTake(order, amount, rest, retry) {
        takeCtx = { order: order, rest: rest || null, retry: retry || null };
        $('takeTitle').textContent = (order.side === 'sell' ? 'BUY MINIMA — take a FAST ask @ ' : 'SELL MINIMA — take a FAST bid @ ') + order.price;
        $('takeMaker').textContent = 'maker ' + order.address + ' · order ' + order.orderId + ' · ' + order.amount + ' MINIMA available';
        $('takeAmount').value = amount || order.amount; $('takeAmount').max = order.amount;
        $('takeSummary').textContent = '—'; $('takeConfirm').disabled = true;
        $('takeDialog').showModal();
        previewTake();
    }
    function previewTake() {
        if (!takeCtx) return;
        var o = takeCtx.order, amt = $('takeAmount').value.trim(), seqAt = ++previewTake.seq;
        $('takeSummary').textContent = 'checking the maker’s coins on this node…'; $('takeConfirm').disabled = true;
        fetchCoins(o.coins, function (err, makerCoins) {
            if (seqAt !== previewTake.seq) return;
            if (err) return $('takeSummary').textContent = 'cannot see the maker’s coins: ' + err.message;
            M.walletCoins(AX.mds, o.side === 'sell' ? F.MXUSD : F.MINIMA, function (e2, myCoins) {
                if (e2) return $('takeSummary').textContent = 'cannot read your coins: ' + e2.message;
                AX.mds.cmdR('getaddress', function (e3, addr) {
                    if (e3 || !addr) return $('takeSummary').textContent = 'getaddress failed';
                    try {
                        var p = F.plan(o, amt, makerCoins, myCoins, addr.address);
                        takeCtx.plan = p;
                        $('takeSummary').textContent = 'You give ' + p.takerGives + (o.side === 'sell' ? ' MxUSD' : ' MINIMA') + '\nYou receive ' + p.makerGives + (o.side === 'sell' ? ' MINIMA' : ' MxUSD')
                            + '\n' + p.inputs.length + ' inputs · ' + p.outputs.length + ' outputs · final after one block'
                            + (takeCtx.rest ? '\nThen ' + takeCtx.rest.amount + ' MINIMA rests as a FAST ' + takeCtx.rest.side + ' @ ' + takeCtx.rest.price : '');
                        $('takeConfirm').disabled = false;
                    } catch (e) { $('takeSummary').textContent = e.message; }
                });
            });
        });
    }
    previewTake.seq = 0;
    function fetchCoins(ids, cb) {
        var out = [], i = 0;
        (function step() {
            if (i >= ids.length) return cb(null, out);
            var id = ids[i++];
            AX.mds.cmdR('coins coinid:' + id, function (err, rows) {
                if (err) return cb(err);
                var c = Array.isArray(rows) ? rows[0] : rows;
                if (!c || !c.coinid) return cb(new Error('coin ' + id + ' not visible to this node (spent, or outside its chain window)'));
                if (c.spent === true) return cb(new Error('coin ' + id + ' is already spent'));
                out.push(c); step();
            });
        })();
    }
    function confirmTake() {
        if (!takeCtx || !takeCtx.plan) return;
        var o = takeCtx.order, p = takeCtx.plan, rest = takeCtx.rest;
        $('takeConfirm').disabled = true; PD.setStage('Building and signing your side of the fill…'); PD.paintNotice();
        F.build(AX.mds, p, function (err, hex) {
            if (err) { PD.setStage(''); notice('Build failed: ' + err.message, 'error'); $('takeConfirm').disabled = false; return; }
            var inner = JSON.stringify({ k: 'take', orderId: o.orderId, txn: hex, taker: me.publicId() });
            var blob = AX.identity.seal(me, o.pubId, AX.hex.utf8(inner));
            var msg = E.msg(me, o.pubId, blob, nowS() + 300);
            pendingTakes[o.orderId] = { order: o, plan: p, rest: rest, retry: takeCtx.retry, sent: Date.now() };
            savePending();
            client.publish(msg, function (results) {
                var ok = results.filter(function (r) { return r.ok; }).length;
                if (!ok) { delete pendingTakes[o.orderId]; savePending(); $('takeConfirm').disabled = false; PD.setStage(''); return notice('No relay accepted the take: ' + (results[0] && results[0].error), 'error'); }
                $('takeDialog').close(); takeCtx = null;
                PD.setStage('Take sent — waiting for the maker’s node to co-sign…'); PD.paintNotice();
                PD.appendActivity('Take sent for order ' + o.orderId + ' (' + p.filled + ' MINIMA @ ' + o.price + ') to ' + ok + ' relay' + (ok === 1 ? '' : 's'), Date.now());
                $('amount').value = ''; PD.preview(); fastPreview();
                renderMine(); PD.renderOrdersPage();
            });
        });
    }
    /** Lost the race (someone else took it, or its coins moved): re-plan the same limit against the next best fast
     *  level and ask once more. Only for takes that came from the order form, and never twice for the same order. */
    function retryNextLevel(pt, reason) {
        var r = pt && pt.retry;
        if (!r || !/taken|not live|advertised|spent|visible|cover/i.test(String(reason || ''))) return;
        r.tried = (r.tried || []).concat([pt.order.orderId]);
        var hits = crossing(r.isBuy, r.price).filter(function (o) { return r.tried.indexOf(o.orderId) < 0; });
        if (!hits.length) return notice('That level was taken and nothing else crosses ' + r.price + ' — your order was not placed. Place it again to rest it.', 'error');
        var take = hits[0], a = D(r.amount), now = Decimal.min(a, D(take.amount)), rest = a.sub(now);
        notice('That level was taken — next best is ' + take.price + '. Review and confirm to retry.', 'pending');
        openTake(take, now.toFixed(), rest.gt(0) ? { side: r.isBuy ? 'buy' : 'sell', price: r.price, amount: rest.toFixed() } : null, r);
    }
    function savePending() { AX.mds.kvSet('pending_takes', JSON.stringify(pendingTakes), function () { }); }
    function loadPending(cb) { AX.mds.kvGet('pending_takes', '{}', function (v) { try { pendingTakes = JSON.parse(v || '{}'); } catch (e) { pendingTakes = {}; } if (cb) cb(); }); }
    function inboxLoop() {
        if (!client || !client.relays.length || !me) { inboxPolling = false; return; }
        inboxPolling = true;
        client.pollInbox(me.publicId(), 25, function (err, msgs) {
            msgs.forEach(function (m) {
                var opened = AX.identity.open(me, m.env.blob), inner, pt;
                if (!opened || !opened.valid) return;
                try { inner = JSON.parse(AX.hex.utf8Decode(opened.plaintext)); } catch (e) { return; }
                pt = inner && pendingTakes[inner.orderId];
                if (!pt) return;
                if (inner.k === 'taken') {
                    AX.mds.kvSet('fill_' + inner.txpowid, JSON.stringify({ role: 'taker', orderId: inner.orderId, side: pt.order.side === 'sell' ? 'buy' : 'sell', price: pt.order.price,
                        filled: inner.filled, gave: pt.plan.takerGives, got: pt.plan.makerGives, txpowid: inner.txpowid, coins: inner.coins || [], maker: pt.order.address, ts: nowS(), status: 'settling' }), function () { loadFills(); });
                    PD.setStage(''); notice('Filled ' + inner.filled + ' MINIMA @ ' + pt.order.price + ' — txpow ' + inner.txpowid + ' (settling)', 'posted');
                    PD.appendActivity('Maker co-signed: ' + inner.filled + ' MINIMA @ ' + pt.order.price + ' · txpow ' + inner.txpowid, Date.now());
                    delete pendingTakes[inner.orderId]; savePending();
                    if (pt.rest) createFast(pt.rest);
                } else if (inner.k === 'refused') {
                    PD.setStage(''); notice('Maker refused the take: ' + inner.reason, 'error');
                    delete pendingTakes[inner.orderId]; savePending(); renderMine(); PD.renderOrdersPage();
                    retryNextLevel(pt, inner.reason);
                }
            });
            setTimeout(inboxLoop, err ? 2000 : 0);
        });
    }

    // ---------- fills → PandaDEX trade rows (ORDERS › MY TRADES, TRADES, CHART, export) ----------
    function loadFills(cb) {
        AX.mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", function (r) {
            var rows = (r && r.rows) || [], out = [];
            rows.forEach(function (row) { try { out.push(JSON.parse(row.V || row.v)); } catch (e) { } });
            out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            fastFills = out; PD.render(); if (cb) cb();
        });
    }
    function trades() {
        return fastFills.map(function (f) {
            var st = String(f.status || 'settling').toUpperCase();
            return { timems: Number(f.ts || 0) * 1000, buy: f.side === 'buy', size: f.filled, price: f.price, maker: f.role === 'maker', txpowid: f.txpowid, orderid: f.orderId,
                     spentcoin: (f.coins && f.coins[0]) || '', block: f.block || '', source_kind: 'FAST ' + st,
                     verification_status: f.status === 'done' ? 'ON-CHAIN block ' + f.block : (f.status === 'lost' ? 'LOST — never mined' : 'SETTLING'), mine: true, fast: true };
        });
    }
    function pendingRows() {
        return Object.keys(pendingTakes).map(function (k) { var p = pendingTakes[k]; return '<article class="order-card fast-order is-pending pending-row"><div class="order-top"><div><span class="side">' + (p.order.side === 'sell' ? 'BUY' : 'SELL') + '</span><strong>' + PD.fmt(p.plan.filled) + ' MINIMA <b>@</b> ' + PD.fmtPrice(p.order.price) + '</strong></div><div class="order-buttons"><button disabled>WAITING…</button></div></div><div class="order-meta"><span>⏳ waiting for the maker’s node to co-sign (' + Math.round((Date.now() - p.sent) / 1000) + 's)</span><span>' + esc(p.order.orderId) + '</span></div></article>'; }).join('');
    }
    function mergeInto(state) {
        var mine = trades(), tape;
        if (!Array.isArray(state.myTrades)) state.myTrades = [];
        state.myTrades = state.myTrades.concat(mine).sort(function (a, b) { return Number(b.timems) - Number(a.timems); });
        tape = Array.isArray(state.tape) ? state.tape : [];
        state.tape = tape.concat(mine.filter(function (t) { return t.source_kind === 'FAST DONE'; })).sort(function (a, b) { return Number(b.timems) - Number(a.timems); });
    }

    // ---------- relays ----------
    function renderRelays() {
        var box = $('relayList'), html = [], ok = 0, i, u, st;
        if (!box) return;
        for (i = 0; i < relays.length; i++) {
            u = relays[i]; st = client && client.status[u];
            if (st && st.ok) ok++;
            html.push('<div class="relay-row"><b class="' + (st ? (st.ok ? 'ok' : 'bad') : 'unk') + '">●</b><span class="url">' + esc(u) + '</span><span class="meta">' + esc(st ? (st.ok ? 'cursor ' + (client.cursors[u] || 0) : st.error) : 'untried') + '</span><button onclick="DexiconFast.removeRelay(this.parentNode.querySelector(\'.url\').textContent)">REMOVE</button></div>');
        }
        for (i = 0; i < discovered.length; i++) {
            u = discovered[i];
            if (relays.indexOf(u.url) >= 0) continue;
            html.push('<div class="relay-row discovered"><b class="unk">◌</b><span class="url">' + esc(u.url) + '</span><span class="meta">via ' + esc(u.via) + '</span><button onclick="DexiconFast.addRelay(this.parentNode.querySelector(\'.url\').textContent)">ADD</button></div>');
        }
        box.innerHTML = html.join('') || '<div class="empty-card"><strong>No relays yet</strong><span>Add the DEX port of any Parlons node or relay box, then DISCOVER to find the rest.</span></div>';
        $('relayCount').textContent = String(relays.length);
        if ($('relayPill')) { $('relayPill').textContent = '⇄ ' + ok + '/' + relays.length; $('relayPill').className = 'pill ' + (relays.length ? (ok ? 'relays-ok' : 'relays-bad') : ''); }
    }
    function loadRelays(cb) {
        AX.mds.kvGet('relays', '[]', function (val) {
            try { relays = JSON.parse(val || '[]'); } catch (e) { relays = []; }
            if (client) client.setRelays(relays);
            renderRelays(); if (cb) cb();
        });
    }
    function saveRelays() {
        AX.mds.kvSet('relays', JSON.stringify(relays), function (err) {
            if (err) notice('Could not save relays: ' + err.message, 'error');
            if (client) client.setRelays(relays);
            renderRelays(); PD.renderBookOnly();
            if (!polling) pollLoop();
            if (!inboxPolling) inboxLoop();
        });
    }
    function addRelay(url) {
        var u = (url || $('relayInput').value || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^\s/]+/.test(u)) return notice('Enter an http(s) URL like https://host:port', 'error');
        if (relays.indexOf(u) < 0) relays.push(u);
        $('relayInput').value = ''; saveRelays();
        notice('Relay added: ' + u, 'posted');
    }
    function removeRelay(u) { relays = relays.filter(function (x) { return x !== u; }); saveRelays(); }
    /** Decentralised bootstrap: every known relay is asked for the relays IT knows (GET /dex/relays). */
    function discover() {
        if (!relays.length) return notice('Add one relay first; discovery asks it for the others.', 'error');
        var left = relays.length, found = [];
        notice('Asking ' + left + ' relay' + (left === 1 ? '' : 's') + ' for their peers…', 'pending');
        relays.forEach(function (u) {
            var x = new XMLHttpRequest();
            x.open('GET', u + '/dex/relays', true); x.timeout = 8000;
            x.onreadystatechange = function () {
                if (x.readyState !== 4) return;
                try { var j = JSON.parse(x.responseText); (j.relays || []).forEach(function (r) { var ru = String(r.url || r).replace(/\/+$/, ''); if (/^https?:\/\//.test(ru) && relays.indexOf(ru) < 0 && !found.some(function (f) { return f.url === ru; })) found.push({ url: ru, via: u }); }); } catch (e) { }
                if (--left === 0) { discovered = found; renderRelays(); notice(found.length ? found.length + ' new relay' + (found.length === 1 ? '' : 's') + ' discovered — tap ADD on the ones you want.' : 'No new relays reported (relays without /dex/relays are ignored).', found.length ? 'posted' : 'live'); }
            };
            x.send();
        });
    }
    function pollLoop() {
        if (!client || !client.relays.length) { polling = false; return; }
        polling = true;
        client.pollBook(25, function (err, changed, url) {
            renderRelays();
            if (err) PD.appendActivity('Relay ' + url + ': ' + err.message, Date.now()); else if (changed) { PD.renderBookOnly(); fastPreview(); }
            setTimeout(pollLoop, err ? 2000 : 0);
        });
    }

    // ---------- settings ----------
    function loadSettings() {
        AX.mds.kvGet('coin_max_age', '', function (v) { if ($('coinMaxAge')) $('coinMaxAge').value = v || ''; });
        AX.mds.kvGet('mxusd_tokenid', '', function (t) { if ($('devToken')) $('devToken').value = t || ''; if (t) { F.setMxUsd(t); PD.appendActivity('DEV CHAIN: dollar leg is token ' + t, Date.now()); PD.balances(); } });
    }
    function saveSettings() {
        var age = $('coinMaxAge').value.trim(), tok = $('devToken').value.trim();
        if (age && !/^\d+$/.test(age)) return notice('Coin max age must be a whole number of blocks.', 'error');
        if (tok && !/^0x[0-9A-Fa-f]{64}$/.test(tok)) return notice('Token id must be 0x + 64 hex characters.', 'error');
        AX.mds.kvSet('coin_max_age', age, function () { AX.mds.kvSet('mxusd_tokenid', tok, function () { if (tok) F.setMxUsd(tok); notice('Settings saved' + (tok ? ' — dollar leg is now token ' + tok : ''), 'posted'); PD.balances(); }); });
    }
    function usdToken() { return F.MXUSD !== '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90' ? F.MXUSD : null; }
    function copy(text) { if (!text || text === '—' || !navigator.clipboard) return; navigator.clipboard.writeText(String(text)); notice('Copied ' + text, 'posted'); }
    function refresh() { loadMyOrders(); loadFills(); renderRelays(); }

    // ---------- boot ----------
    function boot() {
        fetch('dapp.conf').then(function (r) { return r.json(); }).then(function (c) { version = c.version; $('versionPill').textContent = 'v' + version; window.PANDADEX_VERSION = version; }).catch(function () { });
        setMode(fastMode);
        $('price').addEventListener('input', fastPreview); $('amount').addEventListener('input', fastPreview);
        $('buySide').addEventListener('click', fastPreview); $('sellSide').addEventListener('click', fastPreview);
        AX.prng.init(function () { });
        AX.mds.kvInit(function () {
            AX.mds.cmdR('vault action:seed', function (err, r) {
                if (err || !r || !r.seed) { $('myId').textContent = 'needs WRITE trust'; notice('Grant Dexicon WRITE trust in MiniHub, then reload — the maker service cannot sign without it.', 'error'); }
                else { me = AX.identity.fromSeed(r.seed, 'decks'); $('myId').textContent = me.publicId(); }
                client = new AX.relay.Client(AX.relay.xhrTransport(35000));
                loadSettings();
                loadPending(function () { loadRelays(function () { loadMyOrders(); loadFills(); pollLoop(); inboxLoop(); }); });
            });
        });
    }
    window.DexiconFast = { levels: levels, crossing: crossing, fastMode: function () { return fastMode; }, setMode: setMode, place: place, mineHtml: function () { return pendingRows() + mineHtml(); }, renderMine: renderMine,
        cancelOrder: cancelOrder, editOrder: editOrder, openTake: openTake, previewTake: previewTake, confirmTake: confirmTake, trades: trades, mergeInto: mergeInto,
        addRelay: addRelay, removeRelay: removeRelay, discover: discover, saveSettings: saveSettings, usdToken: usdToken, copy: copy, refresh: refresh, orders: liveOrders };

    MDS.init(function (msg) {
        var packet;
        if (msg.event === 'inited') { PD.inited(); boot(); DexiconDoors.inited(); }
        else if (msg.event === 'NEWBLOCK' || msg.event === 'NEWBALANCE') { PD.balances(); if (msg.event === 'NEWBLOCK') { loadFills(); DexiconDoors.onBlock(); } }
        else if (msg.event === 'MDS_TIMER_10SECONDS') { loadMyOrders(); }
        else if ((msg.event === 'MDSCOMMS' || msg.event === 'MDS_COMMS') && msg.data && !msg.data.public) {
            try { packet = JSON.parse(msg.data.message || '{}'); } catch (e) { return; }
            if (PD.servicePacket(packet)) return;
            if (packet && packet.type === 'fill') { loadFills(); loadMyOrders(); if (packet.status === 'done') PD.appendActivity('Fill settled on chain: txpow ' + packet.txpowid, Date.now()); }
            else if (packet && packet.type === 'door') DexiconDoors.refresh();   // the DOORS engine (service) changed a swap or a forward
        }
    });
})();
