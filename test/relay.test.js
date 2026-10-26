/* relay.test.js — union/seq/cancel/expiry semantics and round-robin polling against a fake transport. */
(function () {
    var E = AX.envelope;
    var NOW = 1800000000 - 3600;
    var maker = AX.identity.fromSeed('0x' + '11'.repeat(32), 'decks');
    var maker2 = AX.identity.fromSeed('0x' + '44'.repeat(32), 'decks');
    var ADDR = '0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A';
    var COIN = '0xF19FE115E66277A5785D69CA53BDA431B0D7CDB5B7DB1C4AE8C3CA01558C045F';
    function ord(me, id, seq, side, price, amount, expiry) {
        return E.order(me, { market: 'MINIMA/MxUSD', side: side, price: price, amount: amount, coins: [COIN], address: ADDR, orderId: id, seq: seq, expiry: expiry || NOW + 3600 });
    }
    var A1 = ord(maker, '0x0000000000000001', 1, 'sell', '0.02', '100');
    var A2 = ord(maker, '0x0000000000000001', 2, 'sell', '0.019', '90');        // edit
    var B1 = ord(maker2, '0x0000000000000002', 1, 'buy', '0.018', '50');
    var C1 = ord(maker, '0x0000000000000003', 1, 'buy', '0.017', '10', NOW + 1);   // expires soon
    var A3cancel = ord(maker, '0x0000000000000001', 3, 'sell', '0.019', '0');

    // Fake transport: two relays with different views; records requests.
    var served = { 'http://r1': { cursor: 5, orders: [A1, B1] }, 'http://r2': { cursor: 9, orders: [A2, C1] } };
    var requests = [], posts = [];
    var transport = {
        get: function (url, cb) {
            requests.push(url);
            var base = url.split('/dex/')[0];
            if (url.indexOf('/dex/inbox') > 0) return cb(null, JSON.stringify({ cursor: 1, messages: [] }));
            var s = served[base]; if (!s) return cb(new Error('down'));
            cb(null, JSON.stringify({ cursor: s.cursor, reset: true, orders: s.orders }));
        },
        post: function (url, body, cb) { posts.push(url); cb(null, JSON.stringify({ ok: true, seq: JSON.parse(body).seq, cursor: 1 })); }
    };
    var c = new AX.relay.Client(transport, { now: function () { return NOW; } });
    c.setRelays(['http://r1/', 'http://r1', ' http://r2 ', 'ftp://bad', 'http://r3']);
    T.eq('relay list cleaned + deduped', c.relays, ['http://r1', 'http://r2', 'http://r3']);

    // Poll round-robin: r1 → r2 → r3 (down) → r1 …
    c.pollBook(8, function (err, changed, url) {
        T.eq('first poll hits r1', url, 'http://r1'); T.eq('r1 changed 2', changed, 2);
        T.ok('cursor stored', c.cursors['http://r1'] === 5);
        T.ok('hold param sent', requests[0].indexOf('&hold=8') > 0 && requests[0].indexOf('since=0') > 0);
    });
    c.pollBook(8, function (err, changed, url) {
        T.eq('second poll hits r2', url, 'http://r2');
        T.eq('r2: A2 replaces A1, C1 added', changed, 2);
    });
    c.pollBook(8, function (err, changed, url) {
        T.eq('third poll hits r3', url, 'http://r3'); T.ok('r3 down → error', !!err && c.status['http://r3'].ok === false);
    });
    var live = c.orders();
    T.eq('union = 3 live orders', live.length, 3);
    T.eq('bids first (desc), then asks', live.map(function (o) { return o.side + ':' + o.price; }), ['buy:0.018', 'buy:0.017', 'sell:0.019']);
    T.eq('asks only', c.orders('sell').map(function (o) { return o.amount; }), ['90']);

    // Stale seq ignored; cancel hides; expiry hides.
    T.ok('stale A1 ignored', c.applyOrder(A1) === false);
    T.ok('cancel applies', c.applyOrder(A3cancel) === true);
    T.eq('after cancel: 2 live', c.orders().length, 2);
    c.now = function () { return NOW + 2; };
    T.eq('after expiry of C1: 1 live', c.orders().length, 1);
    c.now = function () { return NOW; };

    // A forged envelope from a relay never enters the book.
    T.ok('forged rejected', c.applyOrder(B1.replace('"amount":"50"', '"amount":"5000"')) === false);

    // A cancel that arrives after its own 10-minute expiry still removes the live copy (no ghost for 23 h).
    (function () {
        var t2 = NOW, c2 = new AX.relay.Client(transport, { now: function () { return t2; } });
        var live = ord(maker, '0x0000000000000009', 1, 'sell', '0.02', '100', NOW + 23 * 3600);
        var cancel = ord(maker, '0x0000000000000009', 2, 'sell', '0.02', '0', NOW + 600);
        T.ok('live applies', c2.applyOrder(live) === true);
        t2 = NOW + 601;
        T.ok('late expired cancel supersedes', c2.applyOrder(cancel) === true);
        T.eq('ghost gone', c2.orders().length, 0);
        T.ok('older expired copy ignored', c2.applyOrder(ord(maker, '0x0000000000000009', 1, 'sell', '0.02', '100', NOW + 1)) === false);
        var k = cancel.indexOf('"sig":"0x') + 9;
        T.ok('expired forgery still rejected', c2.applyOrder(cancel.slice(0, k) + (cancel[k] === '0' ? '1' : '0') + cancel.slice(k + 1)) === false);
    })();

    // Publish fans out to every relay with the right path.
    c.publish(A2, function (results) {
        T.eq('published to 3 relays', results.length, 3);
        T.ok('publish path', posts.slice(-3).every(function (u) { return /\/dex\/publish$/.test(u); }));
    });
    var blob = AX.identity.seal(maker2, maker.publicId(), AX.hex.utf8('hi'));
    c.publish(E.msg(maker2, maker.publicId(), blob, NOW + 60), function (results) {
        T.ok('msg path', posts.slice(-3).every(function (u) { return /\/dex\/msg$/.test(u); }));
    });

    // Inbox poll dedupes by sig and filters by recipient.
    var m1 = E.msg(maker2, maker.publicId(), blob, NOW + 60);
    var mOther = E.msg(maker2, maker2.publicId(), blob, NOW + 60);
    var inboxTransport = { get: function (url, cb) { cb(null, JSON.stringify({ cursor: 3, messages: [m1, m1, mOther] })); }, post: function () {} };
    var ic = new AX.relay.Client(inboxTransport, { now: function () { return NOW; } });
    ic.setRelays(['http://r1']);
    ic.pollInbox(maker.publicId(), 8, function (err, msgs) { T.eq('one fresh message for me', msgs.length, 1); });
    ic.pollInbox(maker.publicId(), 8, function (err, msgs) { T.eq('replay yields none', msgs.length, 0); });

    // fresh install bootstraps from the public relays; a saved list (even empty) is respected
    T.eq('unset kv → defaults', AX.relay.fromKv('unset').length, 3);
    T.eq('null kv → defaults', AX.relay.fromKv(null)[0], 'https://eurobuddha.com/dex-relay');
    T.eq('saved empty list respected', AX.relay.fromKv('[]'), []);
    T.eq('saved list respected', AX.relay.fromKv('["https://x.example/dex"]'), ['https://x.example/dex']);
    T.eq('defaults are https (MiniHub pages cannot use http relays)', AX.relay.DEFAULTS.every(function (u) { return u.indexOf('https://') === 0; }), true);
})();
