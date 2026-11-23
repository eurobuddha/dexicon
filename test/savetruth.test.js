/* savetruth.test.js — 0.0.171 (review, open item: create's lease-takeover edge): a save whose fenced write DID land, but
   whose read-back shows another writer's later write (it took the lease over and merged our order in), used to report
   "did not land" — a create the user saw fail went live from the store. The stored list now decides. */
(function () {
    var M = AX.maker, kv = { myorders: '[]' }, lock = { owner: '' }, thief = null;
    function unq(x) { return x.split("''").join("'"); }
    var mds = {
        kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); }, kvSet: function (k, v, cb) { kv[k] = v; cb && cb(null); },
        sql: function (q, cb) {
            var m;
            if (/^CREATE TABLE IF NOT EXISTS `dx_lock`/.test(q) || /^INSERT INTO `dx_lock`/.test(q) || /^INSERT INTO ax_kv/.test(q)) return cb({ status: true });
            if ((m = /^UPDATE `dx_lock` SET `owner`='([^']*)', `ts`=\d+ WHERE `id`='myorders' AND \(`owner`='' OR `owner` IS NULL OR `owner`='([^']*)'\)$/.exec(q))) { if (!lock.owner || lock.owner === m[2]) lock.owner = m[1]; return cb({ status: true }); }
            if ((m = /^UPDATE `dx_lock` SET `owner`='' WHERE `id`='myorders' AND `owner`='([^']*)'$/.exec(q))) { if (lock.owner === m[1]) lock.owner = ''; return cb({ status: true }); }
            if (/^SELECT `owner` FROM `dx_lock`/.test(q)) return cb({ status: true, rows: [{ OWNER: lock.owner }] });
            if ((m = /^UPDATE ax_kv SET v='((?:[^']|'')*)' WHERE k='myorders' AND EXISTS/.exec(q))) {
                kv.myorders = unq(m[1]);
                if (thief) { var l = JSON.parse(kv.myorders); l.push(thief); kv.myorders = JSON.stringify(l); lock.owner = 'wthief.1'; thief = null; }   // took the lease over, merged ours in, wrote
                return cb({ status: true });
            }
            if (q === "SELECT v FROM ax_kv WHERE k='myorders'") return cb({ status: true, rows: [{ V: kv.myorders }] });
            cb({ status: false, error: 'unexpected ' + q });
        }
    };
    var mine = { orderId: '0x' + '7c'.repeat(8), side: 'sell', price: '0.1', amount: '5', remaining: '5', coins: [], scripts: [], seq: 1, expiry: 9e9, status: 'live' };
    thief = { orderId: '0x' + '7d'.repeat(8), side: 'buy', price: '0.09', amount: '5', remaining: '5', coins: [], scripts: [], seq: 1, expiry: 9e9, status: 'live' };
    var err = 'none';
    M.load(mds, function (e, list) { list.push(mine); M.save(mds, list, function (e2) { err = e2; }, true); });
    T.eq('0.0.171: the write landed and another writer merged it in → the save reports the truth: saved', [err, JSON.parse(kv.myorders).map(function (o) { return o.orderId; })], [null, [mine.orderId, '0x' + '7d'.repeat(8)]]);
    // a write that really did not land (the other writer's list lacks it) still fails loudly
    kv.myorders = '[]'; lock.owner = ''; var gone = { orderId: '0x' + '7e'.repeat(8), side: 'sell', price: '0.1', amount: '1', remaining: '1', coins: [], scripts: [], seq: 1, expiry: 9e9, status: 'live' };
    var realSql = mds.sql; mds.sql = function (q, cb) { if (q === "SELECT v FROM ax_kv WHERE k='myorders'" && lock.owner === '') return cb({ status: true, rows: [{ V: '[]' }] }); realSql(q, cb); };
    M.load(mds, function (e, list) { list.push(gone); lock.owner = ''; mds.sql = function (q, cb) { if (/^UPDATE ax_kv SET v=/.test(q)) { kv.myorders = '[]'; return cb({ status: true }); } realSql(q, cb); }; M.save(mds, list, function (e2) { err = e2; }, true); });
    T.ok('0.0.171: a write that did not land still fails loudly (' + (err && err.message) + ')', !!err && /did not land/.test(err.message));
})();
