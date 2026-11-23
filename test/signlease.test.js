/* signlease.test.js — 0.0.163 (review, MAJOR): page and service sign with the same keys in separate JS contexts, so every
   signing command holds the SQL lease dx_lock 'signing' (lib/maker.js leaseSigning / leaseCmd). Held by the other context
   → REFUSED, nothing reaches the node; free → acquired, sent, released; reads never touch the lease. */
(function () {
    var M = AX.maker, row = { owner: '' }, sent = [], sqls = [], clock = 1767225600000, realNow = Date.now;
    function lockSql(q) {
        var m;
        sqls.push(q);
        if (/^CREATE TABLE IF NOT EXISTS `dx_lock`/.test(q) || /^INSERT INTO `dx_lock` .* SELECT 'signing'/.test(q)) return { status: true };
        if ((m = /^UPDATE `dx_lock` SET `owner`='([^']*)', `ts`=\d+ WHERE `id`='signing' AND \(`owner`='' OR `owner` IS NULL OR `owner`='([^']*)'\)$/.exec(q))) { if (!row.owner || row.owner === m[2]) row.owner = m[1]; return { status: true }; }
        if ((m = /^UPDATE `dx_lock` SET `owner`='' WHERE `id`='signing' AND `owner`='([^']*)'$/.exec(q))) { if (row.owner === m[1]) row.owner = ''; return { status: true }; }
        if (q === "SELECT `owner` FROM `dx_lock` WHERE `id`='signing'") return { status: true, rows: [{ OWNER: row.owner }] };
        return { status: false, error: 'unexpected ' + q };
    }
    var mds = { sql: function (q, cb) { cb(lockSql(q)); }, cmdR: function (c, cb) { sent.push(c + ' [lease ' + (row.owner ? 'held' : 'free') + ']'); cb(null, {}, { status: true }); } };
    M.leaseSigning(mds);
    var out = null;
    mds.cmdR('balance', function (e) { out = e; });
    T.eq('0.0.163: a read never takes the signing lease', [out, sent, sqls.length], [null, ['balance [lease free]'], 0]);
    mds.cmdR('txnsign id:x publickey:0x' + 'dd'.repeat(32), function (e) { out = e; });
    T.eq('0.0.163: a signing command is sent while holding the lease, then the lease is free', [out, sent[1], row.owner], [null, 'txnsign id:x publickey:0x' + 'dd'.repeat(32) + ' [lease held]', '']);
    // the other context (the page) holds it: refused within the bounded wait, nothing reaches the node
    row.owner = 'wpage.7'; sent.length = 0;
    Date.now = function () { clock += 50; return clock; };
    try { mds.cmdR('send amount:1 address:0x' + 'aa'.repeat(32), function (e) { out = e; }); } finally { Date.now = realNow; }
    T.ok('0.0.163: held by the other context → refused, nothing signed (' + (out && out.message) + ')', !!out && /^refused, nothing was signed: /.test(out.message) && sent.length === 0);
    // the resting engine's raw command function (PDService.cmd) gets the same lease
    var raw = [], pd = M.leaseCmd(mds, function (c, cb) { raw.push(c); cb({ status: true }); }), res = null;
    Date.now = function () { clock += 50; return clock; };
    try { pd('txnsign id:y publickey:auto', function (r) { res = r; }); } finally { Date.now = realNow; }
    T.ok('0.0.163: PDService.cmd signing while held → refused result, nothing sent', res && res.status === false && /refused, nothing was signed/.test(res.error) && raw.length === 0);
    row.owner = '';
    pd('txnsign id:y publickey:auto', function (r) { res = r; });
    pd('coins relevant:true', function (r) { res = r; });
    T.eq('0.0.163: free → sent; a read passes untouched', [raw, row.owner], [['txnsign id:y publickey:auto', 'coins relevant:true'], '']);
})();
