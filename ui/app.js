/**
 * ui/app.js — Decks page (browser). Identity from the node seed (same derivation as the service), the live union
 * book from the relays (async XHR long-poll), order entry / my orders (AX.maker), the taker flow (AX.fill: plan →
 * build+sign+export → sealed `take` → await `taken`/`refused`), fills, and relay management (shared with the
 * service through kv).
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var me = null, client = null, relays = [], polling = false, inboxPolling = false, myOrders = [], pendingTakes = {}, takeCtx = null;
    var M = AX.maker, F = AX.fill, E = AX.envelope;

    function status(s, bad) { var el = $('status-msg'); el.textContent = s || ''; el.style.color = bad ? '#e5534b' : ''; }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    // ---------- relays ----------
    function renderRelays() {
        var box = $('relays'); box.innerHTML = '';
        if (!relays.length) { box.innerHTML = '<div class="empty">None yet — add the fleet relay or your own node’s DEX port.</div>'; return; }
        relays.forEach(function (u) {
            var st = client && client.status[u];
            var row = document.createElement('div'); row.className = 'relay-row';
            row.innerHTML = '<span class="' + (st ? (st.ok ? 'ok' : 'bad') : '') + '">' + (st && st.ok ? '●' : '○') + '</span>'
                + '<span class="mono" style="flex:1">' + esc(u) + '</span><span style="color:#888">' + esc(st ? (st.ok ? ('cursor ' + (client.cursors[u] || 0)) : st.error) : 'untried') + '</span>';
            var rm = document.createElement('button'); rm.textContent = 'remove';
            rm.onclick = function () { relays = relays.filter(function (x) { return x !== u; }); saveRelays(); };
            row.appendChild(rm); box.appendChild(row);
        });
    }
    function loadRelays(cb) {
        AX.mds.kvGet('relays', '[]', function (val) {
            try { relays = JSON.parse(val || '[]'); } catch (e) { relays = []; }
            if (client) client.setRelays(relays);
            renderRelays(); renderBook(); if (cb) cb();
        });
    }
    function saveRelays() {
        AX.mds.kvSet('relays', JSON.stringify(relays), function (err) {
            if (err) status('could not save relays: ' + err.message, true);
            if (client) client.setRelays(relays);
            renderRelays(); renderBook();
            if (!polling) pollLoop();
            if (!inboxPolling) inboxLoop();
        });
    }

    // ---------- book ----------
    function renderBook() {
        var box = $('orderbook');
        if (!client) { box.textContent = 'Not booted'; return; }
        var orders = client.orders();
        $('book-meta').textContent = orders.length + ' live order' + (orders.length === 1 ? '' : 's');
        if (!orders.length) { box.className = 'empty'; box.textContent = relays.length ? 'Book is empty' : 'No relays configured'; return; }
        box.className = '';
        var mine = {}; myOrders.forEach(function (o) { mine[o.orderId.toLowerCase()] = true; });
        var html = '<table class="ladder"><tr><th style="text-align:left">side</th><th>price MxUSD</th><th>amount MINIMA</th><th style="text-align:left">maker</th><th></th></tr>';
        orders.forEach(function (o, i) {
            var isMine = mine[o.orderId.toLowerCase()] && me && o.signPk.toLowerCase() === ('0x' + AX.hex.to(me.signPk)).toLowerCase();
            html += '<tr class="' + (o.side === 'sell' ? 'ask' : 'bid') + '"><td class="tag">' + o.side + '</td><td class="px">' + esc(o.price) + '</td><td>' + esc(o.amount)
                 + '</td><td class="tag mono">' + esc(o.address) + '</td><td>' + (isMine ? '<span class="tag">yours</span>' : '<button data-i="' + i + '" class="take-btn">' + (o.side === 'sell' ? 'buy' : 'sell') + '</button>') + '</td></tr>';
        });
        box.innerHTML = html + '</table>';
        Array.prototype.forEach.call(box.querySelectorAll('.take-btn'), function (b) { b.onclick = function () { openTake(orders[parseInt(b.getAttribute('data-i'), 10)]); }; });
    }
    function pollLoop() {
        if (!client || !client.relays.length) { polling = false; $('poll-status').textContent = 'idle'; return; }
        polling = true;
        $('poll-status').textContent = 'waiting on ' + client.relays[client.rr % client.relays.length];
        client.pollBook(25, function (err, changed, url) {
            renderRelays();
            if (err) status('poll ' + url + ': ' + err.message, true); else if (changed) renderBook();
            setTimeout(pollLoop, err ? 2000 : 0);
        });
    }

    // ---------- my orders ----------
    function loadMyOrders(cb) { M.load(AX.mds, function (err, list) { myOrders = list || []; renderMyOrders(); renderBook(); if (cb) cb(); }); }
    function renderMyOrders() {
        var box = $('my-orders');
        var live = myOrders.filter(function (o) { return o.status === 'live'; });
        if (!live.length) { box.className = 'empty'; box.textContent = 'No open orders'; return; }
        box.className = '';
        box.innerHTML = live.map(function (o) {
            return '<div class="relay-row"><span class="tag">' + o.side + '</span><span class="px">' + esc(o.price) + '</span><span>' + esc(o.remaining) + ' / ' + esc(o.amount)
                + ' MINIMA</span><span class="tag">' + (o.coins || []).length + ' coin' + ((o.coins || []).length === 1 ? '' : 's') + '</span><span style="flex:1"></span>'
                + '<button data-id="' + o.orderId + '" class="cancel-btn">cancel</button></div>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.cancel-btn'), function (b) {
            b.onclick = function () {
                b.disabled = true; status('cancelling…');
                M.cancel(AX.mds, client, me, b.getAttribute('data-id'), function (err) { status(err ? 'cancel failed: ' + err.message : 'order cancelled', !!err); loadMyOrders(); });
            };
        });
    }
    function placeOrder() {
        var side = $('entry-side').value, price = $('entry-price').value.trim(), amount = $('entry-amount').value.trim();
        if (!me) return status('identity not ready', true);
        if (!client.relays.length) return status('add a relay first', true);
        $('entry-submit').disabled = true; status('selecting coins and publishing…');
        M.create(AX.mds, client, me, { side: side, price: price, amount: amount }, function (err, o, results) {
            $('entry-submit').disabled = false;
            if (err) return status('order not placed: ' + err.message, true);
            var ok = results.filter(function (r) { return r.ok; }).length;
            status('order ' + o.orderId + ' live on ' + ok + '/' + results.length + ' relay(s)');
            $('entry-amount').value = '';
            loadMyOrders();
        });
    }

    // ---------- take flow ----------
    function openTake(order) {
        takeCtx = { order: order };
        $('take-panel').hidden = false;
        $('take-title').textContent = (order.side === 'sell' ? 'Buy MINIMA from' : 'Sell MINIMA to') + ' maker ' + order.address;
        $('take-amount').value = order.amount; $('take-amount').max = order.amount;
        $('take-summary').textContent = ''; $('take-confirm').disabled = true;
        previewTake();
    }
    function previewTake() {
        if (!takeCtx) return;
        var o = takeCtx.order, amt = $('take-amount').value.trim();
        $('take-summary').textContent = 'checking the maker’s coins…'; $('take-confirm').disabled = true;
        fetchCoins(o.coins, function (err, makerCoins) {
            if (err) return $('take-summary').textContent = 'cannot fetch maker coins: ' + err.message;
            M.walletCoins(AX.mds, o.side === 'sell' ? F.MXUSD : F.MINIMA, function (e2, myCoins) {
                if (e2) return $('take-summary').textContent = 'cannot read your coins: ' + e2.message;
                AX.mds.cmdR('getaddress', function (e3, addr) {
                    if (e3 || !addr) return $('take-summary').textContent = 'getaddress failed';
                    try {
                        var p = F.plan(o, amt, makerCoins, myCoins, addr.address);
                        takeCtx.plan = p; takeCtx.makerCoins = makerCoins;
                        $('take-summary').textContent = 'You give ' + p.takerGives + (o.side === 'sell' ? ' MxUSD' : ' MINIMA') + ' and receive ' + p.makerGives + (o.side === 'sell' ? ' MINIMA' : ' MxUSD')
                            + ' (' + p.inputs.length + ' inputs, ' + p.outputs.length + ' outputs). Final after one block.';
                        $('take-confirm').disabled = false;
                    } catch (e) { $('take-summary').textContent = e.message; }
                });
            });
        });
    }
    function fetchCoins(ids, cb) {
        var out = [], i = 0;
        (function step() {
            if (i >= ids.length) return cb(null, out);
            var id = ids[i++];
            AX.mds.cmdR('coins coinid:' + id, function (err, rows) {
                if (err) return cb(err);
                var c = Array.isArray(rows) ? rows[0] : rows;
                if (!c || !c.coinid) return cb(new Error('coin ' + id + ' not found (spent or not yet visible)'));
                if (c.spent === true) return cb(new Error('coin ' + id + ' is already spent'));
                out.push(c); step();
            });
        })();
    }
    function confirmTake() {
        if (!takeCtx || !takeCtx.plan) return;
        var o = takeCtx.order, p = takeCtx.plan;
        $('take-confirm').disabled = true; status('building and signing your side…');
        F.build(AX.mds, p, function (err, hex) {
            if (err) { status('build failed: ' + err.message, true); $('take-confirm').disabled = false; return; }
            var inner = JSON.stringify({ k: 'take', orderId: o.orderId, txn: hex, taker: me.publicId() });
            var blob = AX.identity.seal(me, o.pubId, AX.hex.utf8(inner));
            var msg = E.msg(me, o.pubId, blob, Math.floor(Date.now() / 1000) + 300);
            pendingTakes[o.orderId] = { order: o, plan: p, sent: Date.now() };
            savePending();
            client.publish(msg, function (results) {
                var ok = results.filter(function (r) { return r.ok; }).length;
                status(ok ? 'take sent to ' + ok + ' relay(s); waiting for the maker to co-sign…' : 'no relay accepted the take: ' + (results[0] && results[0].error), !ok);
                if (!ok) { delete pendingTakes[o.orderId]; savePending(); $('take-confirm').disabled = false; }
                renderFills();
            });
        });
    }
    function savePending() { AX.mds.kvSet('pending_takes', JSON.stringify(pendingTakes), function () {}); }
    function loadPending(cb) { AX.mds.kvGet('pending_takes', '{}', function (v) { try { pendingTakes = JSON.parse(v || '{}'); } catch (e) { pendingTakes = {}; } if (cb) cb(); }); }

    /** The page listens for taken/refused replies to its own takes (the service ignores those kinds). */
    function inboxLoop() {
        if (!client || !client.relays.length || !me) { inboxPolling = false; return; }
        inboxPolling = true;
        client.pollInbox(me.publicId(), 25, function (err, msgs) {
            msgs.forEach(function (m) {
                var opened = AX.identity.open(me, m.env.blob);
                if (!opened || !opened.valid) return;
                var inner; try { inner = JSON.parse(AX.hex.utf8Decode(opened.plaintext)); } catch (e) { return; }
                var pt = inner && pendingTakes[inner.orderId];
                if (!pt) return;
                if (inner.k === 'taken') {
                    AX.mds.kvSet('fill_' + inner.txpowid, JSON.stringify({ role: 'taker', orderId: inner.orderId, side: pt.order.side === 'sell' ? 'buy' : 'sell', price: pt.order.price,
                        filled: inner.filled, gave: pt.plan.takerGives, got: pt.plan.makerGives, txpowid: inner.txpowid, maker: pt.order.address, ts: Math.floor(Date.now() / 1000), status: 'settling' }), function () { renderFills(); });
                    status('filled ' + inner.filled + ' MINIMA — txpow ' + inner.txpowid + ' (settling)');
                    delete pendingTakes[inner.orderId]; savePending();
                } else if (inner.k === 'refused') {
                    status('maker refused: ' + inner.reason, true);
                    delete pendingTakes[inner.orderId]; savePending(); renderFills();
                }
            });
            setTimeout(inboxLoop, err ? 2000 : 0);
        });
    }

    // ---------- fills ----------
    function renderFills() {
        AX.mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", function (r) {
            var rows = (r && r.rows) || [], fills = [];
            rows.forEach(function (row) { try { fills.push(JSON.parse(row.V || row.v)); } catch (e) {} });
            fills.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            var pend = Object.keys(pendingTakes).map(function (k) { var p = pendingTakes[k]; return '<div class="relay-row"><span class="tag">pending</span><span>take ' + esc(p.plan.filled) + ' MINIMA @ ' + esc(p.order.price) + '</span><span class="tag">waiting for maker</span></div>'; }).join('');
            var box = $('fills');
            if (!fills.length && !pend) { box.className = 'empty'; box.textContent = 'No fills yet'; return; }
            box.className = '';
            box.innerHTML = pend + fills.map(function (f) {
                return '<div class="relay-row"><span class="tag">' + esc(f.role) + ' ' + esc(f.side) + '</span><span class="px">' + esc(f.price) + '</span><span>' + esc(f.filled) + ' MINIMA</span>'
                    + '<span class="tag">' + esc(f.status) + '</span><span class="mono" style="flex:1">' + esc(f.txpowid) + '</span></div>';
            }).join('');
        });
    }

    // ---------- boot ----------
    MDS.init(function (msg) {
        if (msg.event === 'inited') {
            fetch('dapp.conf').then(function (r) { return r.json(); }).then(function (c) { $('app-version').textContent = 'v' + c.version; }).catch(function () {});
            AX.mds.kvInit(function () {
                AX.mds.cmdR('vault action:seed', function (err, r) {
                    if (err || !r || !r.seed) { $('my-id').textContent = 'needs WRITE trust to derive the identity'; status('grant WRITE trust in MiniHub, then reload', true); }
                    else { me = AX.identity.fromSeed(r.seed, 'decks'); $('my-id').textContent = me.publicId(); }
                    client = new AX.relay.Client(AX.relay.xhrTransport(35000));
                    AX.mds.kvGet('mxusd_tokenid', '', function (t) { if (t) { AX.fill.setMxUsd(t); status('DEV CHAIN: dollar leg is token ' + t, true); } });
                    loadPending(function () { loadRelays(function () { loadMyOrders(); pollLoop(); inboxLoop(); renderFills(); }); });
                });
            });
            $('relay-add').onclick = function () {
                var u = $('relay-input').value.trim().replace(/\/+$/, '');
                if (!/^https?:\/\/[^\s/]+/.test(u)) { status('enter an http(s) URL', true); return; }
                if (relays.indexOf(u) < 0) relays.push(u);
                $('relay-input').value = ''; saveRelays();
            };
            $('entry-submit').onclick = placeOrder;
            $('take-amount').oninput = previewTake;
            $('take-confirm').onclick = confirmTake;
            $('take-close').onclick = function () { $('take-panel').hidden = true; takeCtx = null; };
        } else if (msg.event === 'MDS_COMMS' || msg.event === 'MDS_TIMER_10SECONDS' || msg.event === 'NEWBLOCK') {
            loadMyOrders(); renderFills();
        }
    });
})();
