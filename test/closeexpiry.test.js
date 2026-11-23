/* closeexpiry.test.js — 0.0.166 (review, MINOR): a relay forgets an envelope at its expiry and then takes any envelope of
   that order again, so a cancel or close must not expire before the live envelopes signed before it (relay Store.java
   sweep / publish). Cancels and closes carry max(o.expiry, now + 3600). */
(function () {
    var M = AX.maker, me = AX.identity.fromSeed('0x' + '55'.repeat(32), 'decks'), kv = {}, pub = [], OID = '0x' + '6b'.repeat(8), NOW = Math.floor(Date.now() / 1000);
    var mds = { kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); }, kvSet: function (k, v, cb) { kv[k] = v; cb && cb(null); } };
    var relay = { relays: ['r'], publish: function (raw, cb) { pub.push(JSON.parse(raw)); cb([{ url: 'r', ok: true }]); } };
    function live(exp) { kv.myorders = JSON.stringify([{ orderId: OID, side: 'sell', price: '0.1', amount: '100', remaining: '100', coins: [], scripts: [], address: '0x' + 'aa'.repeat(32), seq: 5, expiry: exp, status: 'live', fillsFrom: 1 }]); }
    live(NOW + 3550);   // re-signed a minute ago
    M.cancel(mds, relay, me, OID, function () { });
    T.ok('0.0.166: a cancel outlives the live envelope before it (' + (pub[0].expiry - NOW) + ' s)', pub[0].amount === '0' && pub[0].expiry >= NOW + 3550 && pub[0].expiry >= NOW + 3600);
    live(NOW + 3550); pub.length = 0;
    M.afterFill(mds, relay, me, OID, '100', [], function () { }, '0x' + 'f1'.repeat(32), '100');
    T.ok('0.0.166: a close by a fill too (' + (pub[0] && pub[0].expiry - NOW) + ' s)', pub[0].amount === '0' && pub[0].expiry >= NOW + 3600);
})();
