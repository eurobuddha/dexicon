/* autocross.test.js — same cases as the APK's AutoCrossTest (owner 2026-10-29: PandaPools out of line with my own
   ladder → my node trades the pool back to my best rung). */
(function () {
    var X = AX.autocross, P = PandaDEX;
    function pool(m, t) { return { reserveM: m, reserveT: t, tokDecimals: 8, kmin: '1', tok: P.USDT, address: '0xA1', oadr: '0xB2', opk: '0xAA', coinidM: '0xC1', coinidT: '0xC2' }; }
    function rung(side, price, status) { return { orderId: '0x' + side + price, side: side, price: price, amount: '1200', remaining: '1200', status: status, coins: ['coin' + price] }; }
    var LADDER = [rung('sell', '0.0035', 'live'), rung('sell', '0.00355', 'live'), rung('sell', '0.0036', 'live'), rung('sell', '0.00345', 'cancelled'),
                  rung('buy', '0.0034', 'live'), rung('buy', '0.00335', 'live'), rung('buy', '0.0033', 'live')], MEXC = 0.00347;

    var s = X.decide([pool('1000000', '3600')], LADDER, MEXC);
    T.ok('cross: pool above asks sells', !!s && s.sell);
    T.eq('cross: sell stops at my best ask', s && P.plain(s.limit), '0.0035');
    T.eq('cross: sell sized to the rungs the pool moved past', s && P.plain(s.want), '2400');
    T.ok('cross: sell fills ~all of it', s && s.plan.totalMinima.lte(2400) && s.plan.totalMinima.gte(2399));
    T.eq('cross: sell spends the crossed rungs\' own coins', s && s.coins.join(','), 'coin0.0035,coin0.00355');
    var bare = LADDER.slice(); bare[0] = rung('sell', '0.0035', 'live'); bare[0].coins = [];
    var u = X.decide([pool('1000000', '3600')], bare, MEXC);
    T.eq('cross: an unbacked rung is not crossed', u && P.plain(u.want), '1200');
    T.eq('cross: only the backed rung\'s coin', u && u.coins.join(','), 'coin0.00355');
    T.ok('cross: sell beats my rung and MEXC', s && s.plan.effectivePrice.gte(s.limit) && s.plan.effectivePrice.toNumber() > MEXC);

    var b = X.decide([pool('1000000', '3300')], LADDER, MEXC);
    T.ok('cross: pool below bids buys', !!b && !b.sell);
    T.eq('cross: buy stops at my best bid', b && P.plain(b.limit), '0.0034');
    T.eq('cross: buy sized to the rungs', b && P.plain(b.want), '2400');
    T.ok('cross: buy beats my rung and MEXC', b && b.plan.effectivePrice.lte(b.limit) && b.plan.effectivePrice.toNumber() < MEXC);

    T.ok('cross: pool inside my spread → nothing', X.decide([pool('1000000', '3470')], LADDER, MEXC) === null);
    T.ok('cross: under 1 MINIMA → nothing', X.decide([pool('1000', '3.52')], LADDER, MEXC) === null);
    T.ok('cross: never sells below MEXC', X.decide([pool('1000000', '3600')], LADDER, 0.0036) === null);
    T.ok('cross: no MEXC price → nothing', X.decide([pool('1000000', '3600')], LADDER, 0) === null);
    var w = X.warning('pool 0.85% above your best ask — sell 1500 MINIMA @ avg 0.003169164227 (auto-cross off)', '3');
    T.ok('warning: says what would cross now', w.indexOf('YES — pool 0.85% above your best ask — sell 1500 MINIMA @ avg 0.003169164227.\n') >= 0 && w.indexOf('(auto-cross off)') < 0);
    T.ok('warning: states the hourly cap', w.indexOf('Up to 3 trades an hour') >= 0);
    T.ok('warning: nothing when in line', X.warning('pool in line with your ladder', '5').indexOf('Nothing. The pool is in line') >= 0);
    T.ok('warning: unknown before the ladder runs', X.warning('', '').indexOf('Not known yet') >= 0 && X.warning('waiting for the MEXC price', '').indexOf('Not known yet') >= 0);
    T.ok('cross: no pools / no rungs → nothing', X.decide([], LADDER, MEXC) === null && X.decide([pool('1000000', '3600')], [], MEXC) === null);
})();
