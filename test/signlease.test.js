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

    // ---- 0.0.194 (review 6): the service was signing when the node died. Its lease stayed on the row and EVERY signing of
    // this node was refused for 200 s after the restart — a void near its deadline too (the maker keeps the taker's signed
    // half meanwhile). At boot the service frees a lease of ANOTHER service boot taken BEFORE this node process started.
    var UP = '0 Years 0 Months 0 Weeks 0 Days 0 Hours 0 Minutes 30 Seconds', kv2 = {}, sent2 = [], lines = [];
    T.eq('0.0.194: the node\'s uptime text in ms', [M.uptimeMs && M.uptimeMs(UP), M.uptimeMs && M.uptimeMs('1 Years 2 Months 3 Weeks 4 Days 5 Hours 6 Minutes 7 Seconds'), M.uptimeMs && M.uptimeMs('3 minutes')],
        [30000, ((((365 + 60 + 21 + 4) * 24 + 5) * 3600) + 6 * 60 + 7) * 1000, -1]);
    function node(uptime) {
        var m = { kvGet: function (k, d, cb) { cb(kv2[k] === undefined ? d : kv2[k]); }, kvSet: function (k, v, cb) { kv2[k] = v; cb && cb(null); },
            sql: function (q, cb) {
                var x;
                if (q === "SELECT `owner`, `ts` FROM `dx_lock` WHERE `id`='signing'") return cb({ status: true, rows: [{ OWNER: row.owner, TS: row.ts }] });
                if ((x = /^UPDATE `dx_lock` SET `owner`='([^']*)', `ts`=(\d+) WHERE `id`='signing'/.exec(q)) && (!row.owner || row.owner === /`owner`='([^']*)'\)$/.exec(q)[1])) row.ts = Number(x[2]);
                cb(lockSql(q));
            },
            cmd: function (c, cb) { sent2.push(c); cb({ status: true }); },
            cmdR: function (c, cb) {
                sent2.push(c);
                if (c === 'status') return uptime ? cb(null, { uptime: uptime }) : cb(new Error('cmd failed: status'));
                if (c === 'block') return cb(null, { block: '5000' });
                if (/^txnpost/.test(c)) return cb(null, T.posted('0x' + 'e7'.repeat(32)));
                cb(null, {});
            } };
        return M.leaseSigning(m);
    }
    /** the service boots `sinceCrash` ms after the lease was taken, then a void relocks my coin (lib/maker.js relock: txnsign) */
    function bootThenVoid(owner, uptime, sinceCrash) {
        var m = node(uptime), res = { err: 'no callback', line: '' }, t0 = 1767300000000;
        row.owner = owner; row.ts = t0; kv2 = {}; sent2.length = 0; clock = t0 + sinceCrash;
        Date.now = function () { clock += 50; return clock; };
        try {
            (M.freeDeadLease || function (x, cb) { cb(''); })(m, function (l) { res.line = l; });
            M.relock(m, [{ coinid: '0x' + 'c7'.repeat(32), address: '0xME', tokenid: '0x00', amount: '7' }], '0xME', function (e) { res.err = e; });
        } finally { Date.now = realNow; }
        res.signed = sent2.some(function (c) { return /^txnsign/.test(c); });
        return res;
    }
    var dead = bootThenVoid('wSoldboot.3', UP, 60000);
    T.ok('0.0.194: the lease of a service that died with the node is freed at boot — a void\'s relock signs at once, not 200 s later (' + (dead.line || (dead.err && dead.err.message)) + ')',
        !dead.err && dead.signed && /before this node started/.test(dead.line) && row.owner === '');
    var live = bootThenVoid('wSoldrunner.9', '0 Years 0 Months 0 Weeks 0 Days 1 Hours 0 Minutes 0 Seconds', 10000);
    T.ok('0.0.194: a lease taken in THIS node process (an updated MiniDapp\'s old runner, still signing) is never freed (' + (live.err && live.err.message) + ')',
        !!live.err && !live.signed && live.line === '' && row.owner === 'wSoldrunner.9');
    var page = bootThenVoid('wpage.4', UP, 60000);
    T.ok('0.0.194: a page\'s lease is never freed early (its command may still run in the node)', !!page.err && !page.signed && row.owner === 'wpage.4');
    var blind = bootThenVoid('wSoldboot.3', '', 60000);
    T.ok('0.0.194: an unreadable uptime frees nothing', !!blind.err && !blind.signed && row.owner === 'wSoldboot.3');
    row.owner = '';
})();
