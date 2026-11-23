/* proofbook.test.js — review 23 Nov (M2): the reviewer's simulation, re-run. A book of 30 orders on coins older than this
 * node's window, from 5 makers (6 each): the page's verdict cache (lib/takeable.js) and coin proof taker (lib/proofs.js)
 * wired as ui/app.js wires them, a stub node that sees a coin only once its proof is imported, and makers that answer
 * every request within the height it is sent. Measured on 0.0.120: full view after ~20 heights. Wanted: within 2. */
(function () {
    var K = AX.takeable, P = AX.proofs, ME = '0x' + 'ab'.repeat(32);
    function hex2(n) { return ('0' + n.toString(16)).slice(-2).toUpperCase(); }
    function mn(v) { var h = v.toString(16); if (h.length % 2) h = '0' + h; if (parseInt(h.slice(0, 2), 16) & 0x80) h = '00' + h; return '00' + hex2(h.length / 2) + h; }
    function proofOf(coin, address) {   // Coin.writeDataStream (created block 7) + MMR proof filler
        return ('0x00000020' + coin.slice(2) + '00000020' + address.slice(2) + '000203EB' + '0000000100' + '01' + '0001000000000105' + '00' + mn(7) + '000100' + '00' + '0123456789ABCDEF'.repeat(50)).slice(0, 900);
    }
    var makers = [], book = [], ROWS = {}, VISIBLE = {}, i, j;
    for (i = 0; i < 5; i++) {
        var pk = '0x' + hex2(0x50 + i).repeat(32), mk = { pub: '0x' + hex2(0x60 + i).repeat(64), signPk: pk, script: 'RETURN SIGNEDBY(' + pk + ')' };
        makers.push(mk);
        for (j = 0; j < 6; j++) {
            var coin = '0x' + hex2(0x10 + i * 6 + j).repeat(32);
            book.push({ orderId: '0x' + ('000000000000000' + (i * 6 + j + 1).toString(16)).slice(-16), side: 'sell', price: String(0.004 + (i * 6 + j) / 100000), amount: '10', coins: [coin], scripts: [mk.script], signPk: pk, pubId: mk.pub, seq: 1, expiry: 1000 });
            ROWS[coin.toLowerCase()] = { coinid: coin, address: K.scriptAddress(mk.script), tokenid: '0x00', amount: '100', spent: false, state: [] };
        }
    }
    var TIP = 5000, sent = [];
    function node(c, cb) {
        if (c === 'status') return cb(null, { chain: { block: String(TIP), length: '100' } });
        if (c.indexOf('coinimport data:') === 0) { VISIBLE[P.named(c.split(' ')[1].slice(5)).coinid.toLowerCase()] = true; return cb(null, {}); }
        if (c.indexOf('coins relevant:true') === 0) return cb(null, []);
        if (c.indexOf('coins coinid:') === 0) { var id = c.split(' ')[1].slice(7).toLowerCase(); return cb(null, VISIBLE[id] ? [ROWS[id]] : []); }
        cb(new Error('unexpected ' + c));
    }
    var VC = null, PF = null;
    function warm() { VC.warm(book, ME, function () { }); if (PF.flush) PF.flush(); }   // 0.0.121: the page flushes after each pass
    VC = new K.Cache(node, { onMissing: function (o) { return PF.want(o); }, afterPass: function () { if (PF.flush) PF.flush(); } });
    PF = new P.Taker({ cmd: node, count: function () { VC.spent++; }, send: function (o, ids) { sent.push({ to: o.pubId, ids: ids }); },
        proven: function (ids) { VC.proven(ids); warm(); } });
    function okCount() { return book.filter(function (o) { return K.check(o, VC.verdicts(), ME).state === 'ok'; }).length; }
    var heights = 0, perHeight = [], msgs = [];
    while (okCount() < book.length && heights < 40) {
        TIP++; heights++; sent = [];
        VC.onBlock(TIP); PF.onBlock(TIP); warm();
        msgs.push(sent.length);
        // every maker answers what it was asked, within the height (its service: lib/proofs.js answer, at most 2 messages a poll)
        sent.forEach(function (s) { var m = {}; s.ids.forEach(function (c) { m[c] = proofOf(c, K.scriptAddress(makers.filter(function (x) { return x.pub === s.to; })[0].script)); }); PF.reply(s.to, m); });
        perHeight.push(okCount());
    }
    T.log('  30 old-coin orders from 5 makers: ' + heights + ' height(s) to a full view; ok after each height: ' + perHeight.join(', ') + '; requests a height: ' + msgs.join(', '));
    T.ok('M2: a book of 30 old-coin orders from 5 makers is fully judged (all ok) within 2 heights (took ' + heights + ')', okCount() === book.length && heights <= 2);
    T.ok('M2: one request per maker per height (' + msgs.join(', ') + ')', msgs.every(function (n) { return n <= makers.length; }));
})();
