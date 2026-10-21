/**
 * ui/app.js — Decks page (browser). v0.0.2 scope: relay list management (shared with service.js via kv),
 * the live union book from the relays (async XHR long-poll, all relays over successive rounds), and the inbox
 * the service surfaced. Order entry / fills arrive in P2-3..P2-5.
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var client = null, relays = [], polling = false, inboxShown = {};

    function status(s) { $('status-msg').textContent = s || ''; }

    function renderRelays() {
        var box = $('relays'); box.innerHTML = '';
        if (!relays.length) { box.innerHTML = '<div class="empty">None yet — add the fleet relay or your own node’s DEX port.</div>'; return; }
        relays.forEach(function (u) {
            var st = client && client.status[u];
            var row = document.createElement('div'); row.className = 'relay-row';
            var dot = document.createElement('span'); dot.className = st ? (st.ok ? 'ok' : 'bad') : ''; dot.textContent = st ? (st.ok ? '●' : '○') : '○';
            var url = document.createElement('span'); url.className = 'mono'; url.textContent = u; url.style.flex = '1';
            var info = document.createElement('span'); info.style.color = '#888'; info.textContent = st ? (st.ok ? ('cursor ' + (client.cursors[u] || 0)) : st.error) : 'untried';
            var rm = document.createElement('button'); rm.textContent = 'remove';
            rm.onclick = function () { relays = relays.filter(function (x) { return x !== u; }); saveRelays(); };
            row.appendChild(dot); row.appendChild(url); row.appendChild(info); row.appendChild(rm);
            box.appendChild(row);
        });
    }

    function renderBook() {
        var box = $('orderbook');
        if (!client) { box.textContent = 'Not booted'; return; }
        var orders = client.orders();
        $('book-meta').textContent = orders.length + ' live order' + (orders.length === 1 ? '' : 's');
        if (!orders.length) { box.className = 'empty'; box.textContent = relays.length ? 'Book is empty' : 'No relays configured'; return; }
        box.className = '';
        var html = '<table class="ladder"><tr><th style="text-align:left">side</th><th>price MxUSD</th><th>amount MINIMA</th><th style="text-align:left">maker</th></tr>';
        orders.forEach(function (o) {
            html += '<tr class="' + (o.side === 'sell' ? 'ask' : 'bid') + '"><td class="tag">' + o.side + '</td><td class="px">' + o.price + '</td><td>' + o.amount
                 + '</td><td class="tag mono">' + o.address + '</td></tr>';
        });
        box.innerHTML = html + '</table>';
    }

    function loadRelays(cb) {
        AX.mds.kvGet('relays', '[]', function (err, val) {
            try { relays = JSON.parse(val || '[]'); } catch (e) { relays = []; }
            if (client) client.setRelays(relays);
            renderRelays(); renderBook();
            if (cb) cb();
        });
    }
    function saveRelays() {
        AX.mds.kvSet('relays', JSON.stringify(relays), function (err) {
            if (err) status('could not save relays: ' + err.message);
            if (client) client.setRelays(relays);
            renderRelays(); renderBook();
            if (!polling) pollLoop();
        });
    }

    /** Browser: async XHR, so one long-poll at a time per page, hold 25 s, relays round-robin. */
    function pollLoop() {
        if (!client || !client.relays.length) { polling = false; $('poll-status').textContent = 'idle'; return; }
        polling = true;
        $('poll-status').textContent = 'waiting on ' + client.relays[client.rr % client.relays.length];
        client.pollBook(25, function (err, changed, url) {
            renderRelays();
            if (err) status('poll ' + url + ': ' + err.message); else if (changed) { status(''); renderBook(); }
            setTimeout(pollLoop, err ? 2000 : 0);
        });
    }

    function loadInbox() {
        AX.mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'inbox_%' ORDER BY k DESC", function (r) {
            var rows = (r && r.rows) || [];
            var box = $('inbox');
            if (!rows.length) { box.className = 'empty'; box.textContent = 'No messages'; return; }
            box.className = '';
            box.innerHTML = rows.map(function (row) {
                var env = {}; try { env = JSON.parse(row.V || row.v); } catch (e) {}
                return '<div class="relay-row mono">from ' + (env.from || '?') + ' — ' + ((env.blob || '').length / 2) + ' bytes, expires ' + env.expiry + '</div>';
            }).join('');
        });
    }

    MDS.init(function (msg) {
        if (msg.event === 'inited') {
            fetch('dapp.conf').then(function (r) { return r.json(); }).then(function (c) { $('app-version').textContent = 'v' + c.version; }).catch(function () {});
            AX.mds.kvInit(function () {
                AX.mds.kvGet('publicId', '', function (err, pid) { $('my-id').textContent = pid || 'service not booted yet (grant WRITE trust)'; });
                client = new AX.relay.Client(AX.relay.xhrTransport(35000));
                loadRelays(function () { pollLoop(); loadInbox(); });
            });
            $('relay-add').onclick = function () {
                var u = $('relay-input').value.trim().replace(/\/+$/, '');
                if (!/^https?:\/\/[^\s/]+/.test(u)) { status('enter an http(s) URL'); return; }
                if (relays.indexOf(u) < 0) relays.push(u);
                $('relay-input').value = ''; saveRelays();
            };
        } else if (msg.event === 'MDS_COMMS' || (msg.event === 'MDS_TIMER_10SECONDS')) {
            loadInbox();
        }
    });
})();
