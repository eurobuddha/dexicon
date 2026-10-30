/* command_safety.test.js — security review 30 Oct: the node splits a command on ';' and runs every piece, so a peer
   value (a take's txn, a reply's coin id) carrying ';' must never reach MDS.cmd. Mirrors the APK's CommandSafety. */
(function () {
    var M = AX.mds, sent = [], real = globalThis.MDS;
    globalThis.MDS = { cmd: function (c, cb) { sent.push(c); cb({ status: true, response: {} }); } };
    M.cmdR('txnview data:00;send address:0x00 amount:1', function (e) { T.ok('safety: ; is refused with an error', !!e && /Unsafe/.test(e.message)); });
    M.cmd('coins coinid:0x00\nsend amount:1', function (r) { T.ok('safety: control chars refused', r && r.status === false); });
    M.cmdR('txnview data:0A0B', function (e) { T.ok('safety: plain command still runs', !e); });
    T.eq('safety: nothing unsafe reached the node', sent, ['txnview data:0A0B']);
    globalThis.MDS = real;
})();
