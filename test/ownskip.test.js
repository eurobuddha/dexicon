/* ownskip.test.js — 0.0.91: an order never fills against my OWN on-chain order; the planners route past them to the
   next best third-party order or pool, inside the same limit. My own pool is allowed (owner decision). */
(function () {
    var P = PandaDEX, C = PandaComposite, B = PandaBook, O = AX.ownskip, ME = '0xME', keys = true, n = 0;
    function order(sell, price, minima, pk) {
        var m = P.d(minima), u = m.mul(price), o = { coinid: '0xC' + (++n), ownerPk: pk, sell: sell, price: P.d(price), minima: m, usdt: u, locked: sell ? m : u,
            wantAmt: sell ? u : m, minRem: P.d(0), created: 100, fillable: true };
        return o;
    }
    function pool(m, t, opk) { return { reserveM: m, reserveT: t, tokDecimals: 8, kmin: '1', tok: P.USDT, address: '0xA1', oadr: '0xB2', opk: opk, coinidM: '0xD1', coinidT: '0xD2' }; }
    function ids(takes) { return takes.map(function (t) { return t.order.coinid; }); }
    O._reset();
    var mineAsk = order(true, '0.0035', '100', ME), theirAsk = order(true, '0.0036', '100', '0xTHEM'), farAsk = order(true, '0.0040', '100', '0xTHEM'),
        mineBid = order(false, '0.0034', '100', ME), theirBid = order(false, '0.0033', '100', '0xTHEM'), book = [mineAsk, theirAsk, farAsk, mineBid, theirBid];
    T.eq('before: the vendored planner does route over my own order (the gap)', ids(B.plan(book, true, '100', '0.0036', 110).takes), [mineAsk.coinid]);

    O.install(C, B, function (o) { return o.ownerPk === ME; }, function () { return keys; });
    O.install(C, B, function () { return false; });   // a second install is ignored (never double-wrapped, never replaced)
    var b = B.plan(book, true, '100', '0.0036', 110), c = C.plan(book, [], true, '100', '0.0036', 110);
    T.eq('book: my ask is best, theirs is behind → theirs fills', ids(b.takes), [theirAsk.coinid]);
    T.eq('book: totals and average are the third party\'s only', [P.plain(b.totalMinima), P.plain(b.totalUsdt), P.plain(b.average)], ['100', '0.36', '0.0036']);
    T.eq('composite: same', [ids(c.orderTakes), P.plain(c.totalMinima), P.plain(c.totalUsdt), P.plain(c.effectivePrice)], [[theirAsk.coinid], '100', '0.36', '0.0036']);
    T.ok('composite: my coin is not a source of the transaction', c.sourceCoinIds.indexOf(mineAsk.coinid) < 0);
    T.eq('sell side: my bid is best, theirs is behind → theirs fills', ids(B.plan(book, false, '100', '0.0033', 110).takes), [theirBid.coinid]);
    T.eq('never past the limit: my ask skipped, theirs is over the limit → nothing', B.plan(book, true, '100', '0.0035', 110).takes.length, 0);
    T.ok('never past the limit (composite)', C.isEmpty(C.plan(book, [], true, '100', '0.0035', 110)));
    T.eq('a big order walks third parties only, best price first', ids(B.plan(book, true, '1000', '0.0040', 110).takes), [theirAsk.coinid, farAsk.coinid]);
    T.eq('the book itself is untouched (what counterparties see)', book.length, 5);

    // only my own orders inside the limit
    T.eq('only own: nothing fills', B.plan(book, true, '100', '0.0035', 110).takes.length, 0);
    T.eq('only own: the plain sentence', O.onlyOwn(book, [], true, '100', '0.0035', 110), O.ONLY_OWN);
    T.ok('only own: says so, is not a refusal', /^Only your own orders are at this price/.test(O.ONLY_OWN) && !/refus|error|cannot/i.test(O.ONLY_OWN));
    T.eq('third party inside the limit → no sentence', O.onlyOwn(book, [], true, '100', '0.0036', 110), '');
    T.eq('nothing at all inside the limit → no sentence (the order just rests)', O.onlyOwn(book, [], true, '100', '0.0030', 110), '');

    // my own pool is liquidity like any other
    var myPool = [pool('1000000', '3500', ME)], viaPool = C.plan([mineAsk], myPool, true, '100', '0.0036', 110);
    T.ok('own pool: fills from the pool, not from my order', !C.isEmpty(viaPool) && C.poolCount(viaPool) === 1 && viaPool.orderTakes.length === 0 && viaPool.totalMinima.gt(0));
    T.eq('own pool inside the limit → no sentence', O.onlyOwn([mineAsk], myPool, true, '100', '0.0036', 110), '');

    // auto-cross: plans against pools only, so my rungs / my book orders on both sides can never be its counterparty
    var rungs = [{ orderId: '0xs', side: 'sell', price: '0.0035', amount: '1200', remaining: '1200', status: 'live', coins: ['c1'] },
                 { orderId: '0xb', side: 'buy', price: '0.0034', amount: '1200', remaining: '1200', status: 'live', coins: ['c2'] }];
    var x = AX.autocross.decide([pool('1000000', '3600', ME)], rungs, 0.00347);
    T.ok('auto-cross: trades the pool, no order of mine in the plan', !!x && x.plan.orderTakes.length === 0 && C.poolCount(x.plan) === 1);

    // keys unread: every order would look foreign → a book is not planned at all; a pool-only plan still is
    keys = false;
    var threw = '';
    try { B.plan(book, true, '100', '0.0036', 110); } catch (e) { threw = e.message; }
    T.ok('keys unread: no plan over a book (' + threw + ')', /cannot be told apart yet/.test(threw));
    T.ok('keys unread: pool-only planning (auto-cross) still works', !C.isEmpty(C.plan([], myPool, true, '100', '0.0036', 110)));
    keys = true;
    O._reset();
    T.eq('reset restores the vendored planners', ids(B.plan(book, true, '100', '0.0036', 110).takes), [mineAsk.coinid]);
})();
