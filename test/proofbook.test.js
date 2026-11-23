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
        proven: function (ids, by) { VC.proven(ids, by); warm(); } });
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

    // review 23 Nov (COPYCAT, partial): another identity lists a coin this node sees only through maker 0's imported proof,
    // at a better price, with maker 0's own script: it is hidden and the real order keeps its place
    var real = book[0], copy = { orderId: '0x00000000000000c1', side: 'sell', price: '0.001', amount: '10', coins: real.coins.slice(), scripts: real.scripts.slice(),
        signPk: '0x' + 'C7'.repeat(32), pubId: '0x' + 'C8'.repeat(64), seq: 1, expiry: 1000 };
    book.push(copy); TIP++; VC.onBlock(TIP); PF.onBlock(TIP); warm();
    var lay = K.layout(book, VC.verdicts(), ME);
    T.ok('COPYCAT: the copycat order on another maker\'s proved coin is hidden', !lay.shown[K.okey(copy)]);
    T.ok('COPYCAT: the real order keeps its place', !!lay.shown[K.okey(real)]);
    T.eq('COPYCAT: the reason names the maker that proved it', lay.list.filter(function (x) { return x.order === copy; }).map(function (x) { return x.check.reason; }),
        ['its backing coin ' + real.coins[0] + ' was proved to this node by another maker, ' + real.pubId.toLowerCase()]);
    // 0.0.130: the copycat answered first, so it is recorded as the coin's prover; once the real maker attests its address,
    // its order is shown and the copycat's hidden (the attestation says who controls the coin)
    var coin2 = book[6].coins[0], real2 = book[6], copy2 = { orderId: '0x00000000000000c2', side: 'sell', price: '0.001', amount: '10', coins: [coin2], scripts: real2.scripts.slice(),
        signPk: '0x' + 'C9'.repeat(32), pubId: '0x' + 'CA'.repeat(32) + 'C9'.repeat(32), seq: 1, expiry: 1000 };
    VC.owners[coin2.toLowerCase()] = copy2.pubId.toLowerCase();
    VC.attest(K.scriptAddress(real2.scripts[0]), real2.signPk, true);
    lay = K.layout(book.concat([copy2]), VC.verdicts(), ME);
    T.ok('COPYCAT: the copycat recorded as prover — the real maker\'s attested order is still shown, the copycat\'s hidden', !!lay.shown[K.okey(real2)] && !lay.shown[K.okey(copy2)]);

    // review 23 Nov (MAJOR-2): the copycat lists the honest maker's coin at a WORSE price (visited last), asks the honest
    // maker for the proof and relays it first. Each maker is asked separately; the coin is contested, so no prover is
    // recorded: the honest order is shown and the copycat's hidden — with no attestation (require_attest off: the
    // one-coin-one-order rule, best price first) and with the honest maker's attestation (require_attest off and on)
    var hk = '0x' + '4A'.repeat(32), hs = 'RETURN SIGNEDBY(' + hk + ')', hcoin = '0x' + '4B'.repeat(32), hpub = '0x' + '4C'.repeat(32) + '4A'.repeat(32);
    var honest = { orderId: '0x00000000000000d1', side: 'sell', price: '0.002', amount: '10', coins: [hcoin], scripts: [hs], signPk: hk, pubId: hpub, seq: 1, expiry: 1000 };
    var cat = { orderId: '0x00000000000000d2', side: 'sell', price: '0.003', amount: '10', coins: [hcoin], scripts: [hs], signPk: '0x' + '4D'.repeat(32), pubId: '0x' + '4E'.repeat(32) + '4D'.repeat(32), seq: 1, expiry: 1000 };
    ROWS[hcoin.toLowerCase()] = { coinid: hcoin, address: K.scriptAddress(hs), tokenid: '0x00', amount: '100', spent: false, state: [] };
    var book2 = [honest, cat];
    TIP++; sent = []; VC.onBlock(TIP); PF.onBlock(TIP); VC.warm(book2, ME, function () { }); PF.flush();
    T.eq('MAJOR-2: both makers are asked for the coin, each separately', sent.map(function (x) { return x.to; }).sort(), [hpub, cat.pubId].sort());
    var relayed = {}; relayed[hcoin] = proofOf(hcoin, K.scriptAddress(hs));
    PF.reply(cat.pubId, relayed);                                   // the copycat answers first, with the honest maker's proof
    VC.warm(book2, ME, function () { });
    var l3 = K.layout(book2, VC.verdicts(), ME);
    T.eq('MAJOR-2: no attestation, require off: the contested coin records no prover; the honest (better) order shown, the copycat hidden', [VC.owners[hcoin.toLowerCase()], !!l3.shown[K.okey(honest)], !!l3.shown[K.okey(cat)]], ['*', true, false]);
    VC.attest(K.scriptAddress(hs), hk, true);
    l3 = K.layout(book2, VC.verdicts(), ME);
    T.ok('MAJOR-2: the honest maker attests (require off): honest shown, copycat hidden', !!l3.shown[K.okey(honest)] && !l3.shown[K.okey(cat)]);
    VC.requireAttest = true; l3 = K.layout(book2, VC.verdicts(), ME);
    T.ok('MAJOR-2: ... require on: honest shown, copycat hidden', !!l3.shown[K.okey(honest)] && !l3.shown[K.okey(cat)]);
    VC.requireAttest = false;
})();
