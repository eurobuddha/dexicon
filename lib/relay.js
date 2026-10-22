/**
 * relay — multi-homed client for the Dexicon relay cape (SPEC §4). Transport-agnostic: the caller injects
 *   transport = { get(url, cb(err, text)), post(url, body, cb(err, text)) }
 * so the same code runs in the browser (XHR, async) and in the Rhino backend (AX.mds.net*, synchronous).
 *
 * Union semantics: every order envelope from any relay is verified locally (AX.envelope.verify) and kept only if
 * its seq beats what we hold for (signPk|orderId). Cancels (amount 0) and expiry (local clock) hide an order.
 * Polling is ONE relay per call, round-robin — a backend tick must stay under 10 s, and a sender publishes to
 * every relay it uses, so any one relay has the whole book it was told about. Rhino-safe (ES5). Attaches to AX.relay.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var E = AX.envelope;

    function Client(transport, opts) {
        opts = opts || {};
        this.t = transport;
        this.market = opts.market || 'MINIMA/MxUSD';
        this.now = opts.now || function () { return Math.floor(Date.now() / 1000); };
        this.relays = [];
        this.cursors = {};        // url -> book cursor
        this.inboxCursors = {};   // url -> inbox cursor
        this.status = {};         // url -> { ok, lastMs, error, orders }
        this.book = {};           // key -> verified order result
        this.seenMsgs = {};       // sig -> true (dedupe across relays)
        this.rr = 0;
    }

    Client.prototype.setRelays = function (urls) {
        var clean = [];
        for (var i = 0; i < urls.length; i++) {
            var u = String(urls[i] || '').trim().replace(/\/+$/, '');
            if (/^https?:\/\/[^\s/]+/.test(u) && clean.indexOf(u) < 0) clean.push(u);
        }
        this.relays = clean;
    };

    /** Apply one raw order envelope; returns true if it changed the book. */
    Client.prototype.applyOrder = function (raw) {
        var v = E.verify(raw, this.now());
        if (!v.ok || v.kind !== 'order') return false;
        var have = this.book[v.key];
        if (have && have.env.seq >= v.env.seq) return false;
        this.book[v.key] = v;
        return true;
    };

    /** Live orders for the market: not cancelled, not expired. side optional ('buy'|'sell'). Sorted best-first. */
    Client.prototype.orders = function (side) {
        var now = this.now(), out = [], k;
        for (k in this.book) {
            var v = this.book[k], e = v.env;
            if (e.market !== this.market || e.expiry <= now || E.isCancelAmount(e.amount)) continue;
            if (side && e.side !== side) continue;
            out.push(e);
        }
        out.sort(function (a, b) {
            var pa = parseFloat(a.price), pb = parseFloat(b.price);
            if (a.side !== b.side) return a.side === 'sell' ? 1 : -1;      // bids first, then asks
            return a.side === 'sell' ? pa - pb : pb - pa;                   // asks ascending, bids descending
        });
        return out;
    };

    Client.prototype._next = function () {
        if (!this.relays.length) return null;
        var u = this.relays[this.rr % this.relays.length];
        this.rr++;
        return u;
    };

    Client.prototype._mark = function (url, ok, err, extra) {
        var s = this.status[url] || {};
        s.ok = ok; s.lastMs = Date.now(); s.error = ok ? '' : String(err || 'error');
        if (extra) for (var k in extra) s[k] = extra[k];
        this.status[url] = s;
    };

    /** Long-poll ONE relay's book (round-robin). cb(err, changedCount, url). */
    Client.prototype.pollBook = function (hold, cb) {
        var url = this._next(), self = this;
        if (!url) return cb(new Error('no relays'), 0, null);
        var since = this.cursors[url] || 0;
        this.t.get(url + '/dex/book?market=' + encodeURIComponent(this.market) + '&since=' + since + '&hold=' + hold, function (err, text) {
            if (err) { self._mark(url, false, err); return cb(err, 0, url); }
            var body;
            try { body = JSON.parse(text); } catch (e) { self._mark(url, false, 'bad json'); return cb(new Error('bad json from ' + url), 0, url); }
            if (!body || typeof body.cursor !== 'number' || Object.prototype.toString.call(body.orders) !== '[object Array]') {
                self._mark(url, false, 'bad body'); return cb(new Error('bad body from ' + url), 0, url);
            }
            var changed = 0;
            for (var i = 0; i < body.orders.length; i++) {
                var o = body.orders[i];
                if (self.applyOrder(typeof o === 'string' ? o : JSON.stringify(o))) changed++;
            }
            self.cursors[url] = body.cursor;
            self._mark(url, true, null, { orders: body.orders.length, reset: !!body.reset });
            cb(null, changed, url);
        });
    };

    /** Publish one envelope (raw JSON) to EVERY relay. cb(results: [{url, ok, status, error}]). Sequential (Rhino-safe). */
    Client.prototype.publish = function (raw, cb) {
        var self = this, i = 0, results = [];
        var path = '/dex/publish';
        try { var v = JSON.parse(raw); if (v && v.t === 'msg') path = '/dex/msg'; } catch (e) { return cb([{ url: null, ok: false, error: 'bad json' }]); }
        function step() {
            if (i >= self.relays.length) return cb(results);
            var url = self.relays[i++];
            self.t.post(url + path, raw, function (err, text) {
                var r = { url: url, ok: false, status: 0, error: '' };
                if (err) { r.error = String(err); }
                else {
                    try { var b = JSON.parse(text); r.ok = !!(b && b.ok); r.error = b && b.error ? String(b.error) : ''; }
                    catch (e) { r.error = 'bad json'; }
                }
                self._mark(url, r.ok || r.error === 'stale seq', r.error);
                results.push(r);
                step();
            });
        }
        step();
    };

    /** Long-poll ONE relay's inbox for my publicId (round-robin). cb(err, newMessages[], url). Deduped by sig. */
    Client.prototype.pollInbox = function (publicId, hold, cb) {
        var url = this._next(), self = this;
        if (!url) return cb(new Error('no relays'), [], null);
        var since = this.inboxCursors[url] || 0;
        this.t.get(url + '/dex/inbox?pk=' + publicId + '&since=' + since + '&hold=' + hold, function (err, text) {
            if (err) { self._mark(url, false, err); return cb(err, [], url); }
            var body;
            try { body = JSON.parse(text); } catch (e) { self._mark(url, false, 'bad json'); return cb(new Error('bad json from ' + url), [], url); }
            if (!body || typeof body.cursor !== 'number' || Object.prototype.toString.call(body.messages) !== '[object Array]') {
                self._mark(url, false, 'bad body'); return cb(new Error('bad body from ' + url), [], url);
            }
            var fresh = [], now = self.now();
            for (var i = 0; i < body.messages.length; i++) {
                var m = body.messages[i], raw = typeof m === 'string' ? m : JSON.stringify(m);
                var v = E.verify(raw, now);
                if (!v.ok || v.kind !== 'msg' || v.env.to.toLowerCase() !== publicId.toLowerCase()) continue;
                if (self.seenMsgs[v.env.sig]) continue;
                self.seenMsgs[v.env.sig] = true;
                fresh.push(v);
            }
            self.inboxCursors[url] = body.cursor;
            self._mark(url, true, null);
            cb(null, fresh, url);
        });
    };

    /** Browser transport: XMLHttpRequest, callback style. */
    function xhrTransport(timeoutMs) {
        function req(method, url, body, cb) {
            var x = new g.XMLHttpRequest();
            x.open(method, url, true);
            x.timeout = timeoutMs || 35000;
            x.onreadystatechange = function () {
                if (x.readyState !== 4) return;
                if (x.status === 0) return cb(new Error('network'));
                cb(null, x.responseText);
            };
            x.ontimeout = function () { cb(new Error('timeout')); };
            if (body != null) x.setRequestHeader('Content-Type', 'application/json');
            x.send(body == null ? null : body);
        }
        return { get: function (u, cb) { req('GET', u, null, cb); }, post: function (u, b, cb) { req('POST', u, b, cb); } };
    }

    /** MDS backend transport: MDS.net.GET/POST are SYNCHRONOUS in Rhino — never re-enter from the callback. */
    function mdsTransport(mds) {
        function unwrap(r, cb) {
            if (!r || !r.status) return cb(new Error((r && r.error) || 'net failed'));
            cb(null, typeof r.response === 'string' ? r.response : JSON.stringify(r.response));
        }
        return {
            get: function (u, cb) { mds.netGet(u, function (r) { unwrap(r, cb); }); },
            post: function (u, b, cb) { mds.netPost(u, b, function (r) { unwrap(r, cb); }); }
        };
    }

    /** Bootstrap list for a FRESH install (kv 'relays' never set). These are ordinary untrusted relays, not
     *  authorities; DISCOVER grows the list from any of them, and a list the user saved (even empty) wins. */
    var DEFAULTS = ['https://eurobuddha.com/dex-relay', 'https://store.eurobuddha.com/dex-relay', 'https://minimammr.com/dex-relay'];
    /** kv value → relay list: unset (null/'' /'unset') → DEFAULTS; anything parseable → exactly that. */
    function fromKv(val) {
        if (val === null || val === undefined || val === '' || val === 'unset') return DEFAULTS.slice();
        try { var l = JSON.parse(val); return Object.prototype.toString.call(l) === '[object Array]' ? l : DEFAULTS.slice(); } catch (e) { return DEFAULTS.slice(); }
    }
    AX.relay = { Client: Client, xhrTransport: xhrTransport, mdsTransport: mdsTransport, DEFAULTS: DEFAULTS, fromKv: fromKv };
})(typeof globalThis !== 'undefined' ? globalThis : this);
