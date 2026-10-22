/* lib/door.js — naming, leg tx ids, forward queue. */
(function () {
    var D = AX.door;
    T.eq('label: engine legacy label → MxUSD', D.label('mxUSDT'), 'MxUSD');
    T.eq('label: token id → MxUSD', D.label('0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90'), 'MxUSD');
    T.eq('label: ETH leg → USDT', D.label('ETH:0xdac17f958d2ee523a2206206994597c13d831ec7'), 'USDT');
    T.eq('label: 0x00 → MINIMA', D.label('0x00'), 'MINIMA');
    T.ok('isMxAddr: Mx form', D.isMxAddr('MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G'));
    T.ok('isMxAddr: hex form', D.isMxAddr('0x0CDCD61692F186EB0BBCFA289F438043F586FF7B3F6864193358E29166E8454A'));
    T.ok('isMxAddr: rejects injection', !D.isMxAddr('MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G amount:1'));
    T.ok('isEthAddr', D.isEthAddr('0xdAC17F958D2ee523a2206206994597C13D831ec7') && !D.isEthAddr('0xdac1'));
    T.eq('fwdKey normalises', D.fwdKey('0xABCD'), 'door_fwd_abcd');

    var H1 = '0x' + '11'.repeat(32), H2 = '0x' + '22'.repeat(32), H3 = '0x' + '33'.repeat(32);
    var ids = D.txIds([{ token: 'ETH:0xdac17f958d2ee523a2206206994597c13d831ec7', note: H1 }, { token: '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90', note: H2 },
        { token: 'minima', note: H2 }, { token: 'ETH', note: 'confirmed on-chain' }, { token: 'minima', note: H3 }]);
    T.eq('txIds: ETH leg', ids.eth, [H1]);
    T.eq('txIds: Minima leg, deduped, full ids', ids.minima, [H2, H3]);

    var s = { sellToken: 'USDT', sellAmount: '10', buyToken: 'mxUSDT', buyAmount: '9.9', status: 'COMPLETE' };
    T.ok('statusText never says the legacy label', D.statusText(s, null).indexOf('mxUSDT') < 0 && D.statusText(s, null).indexOf('MxUSD') >= 0);
    T.ok('statusText: forward sent names the full destination', D.statusText(s, { status: 'sent', amount: '9.8999', to: 'MxABC' }).indexOf('MxABC') > 0);

    // ---- forward queue against a mock kv + mock swapdb ----
    var kv = {}, cmds = [], mds = {
        kvSet: function (k, v, cb) { kv[k] = String(v); cb && cb(null); },
        kvGet: function (k, d, cb) { cb(kv[k] === undefined ? d : kv[k]); },
        sql: function (q, cb) { var rows = []; for (var k in kv) if (k.indexOf('door_fwd_') === 0) rows.push({ K: k, V: kv[k] }); cb({ status: true, rows: rows }); },
        cmdR: function (c, cb) { cmds.push(c); cb(null, { txpowid: '0x' + 'aa'.repeat(32) }); }
    };
    var swaps = {}; var realGet = AX.swapdb.getSwap; AX.swapdb.getSwap = function (h, cb) { cb(null, swaps[AX.swapdb.norm(h)] || null); };
    var realSend = AX.wallet.sendUsdt, usdtSends = [];
    AX.wallet.sendUsdt = function (rpc, priv, from, to, amt, cb) { usdtSends.push([to, amt]); cb(null, '0x' + 'bb'.repeat(32)); };
    D.queueForward(mds, H1, 'minima', 'bad address', function (e) { T.ok('queueForward rejects a bad Mx address', !!e); });
    D.queueForward(mds, H1, 'minima', 'MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G', function (e) { T.ok('queueForward minima ok', !e); });
    D.queueForward(mds, H2, 'usdt', '0xdAC17F958D2ee523a2206206994597C13D831ec7', function (e) { T.ok('queueForward usdt ok', !e); });
    D.queueForward(mds, H3, 'usdt', '0xdAC17F958D2ee523a2206206994597C13D831ec7', function (e) { T.ok('queueForward usdt ok (2)', !e); });
    swaps[AX.swapdb.norm(H1)] = { hash: H1, status: 'STARTED', buyToken: 'mxUSDT', buyAmount: '9.9' };
    swaps[AX.swapdb.norm(H2)] = { hash: H2, status: 'COMPLETE', buyToken: 'USDT', buyAmount: '4.95' };
    swaps[AX.swapdb.norm(H3)] = { hash: H3, status: 'REFUNDED', buyToken: 'USDT', buyAmount: '1' };
    D.processForwards({ mds: mds, rpc: {}, ctx: { eth: { privKey: '0x01', address: '0x' + '00'.repeat(20) } } }, function () {
        D.listForwards(mds, function (list) {
            var m = D.byHash(list);
            T.eq('pending swap: forward still pending, untouched', m[AX.swapdb.norm(H1)].status, 'pending');
            T.eq('complete swap: USDT forwarded once', usdtSends, [['0xdAC17F958D2ee523a2206206994597C13D831ec7', '4.95']]);
            T.eq('complete swap: recorded as sent with the full tx id', [m[AX.swapdb.norm(H2)].status, m[AX.swapdb.norm(H2)].tx], ['sent', '0x' + 'bb'.repeat(32)]);
            T.eq('refunded swap: forward voided', m[AX.swapdb.norm(H3)].status, 'void');
            T.eq('no Minima send fired yet', cmds.length, 0);
            swaps[AX.swapdb.norm(H1)].status = 'COMPLETE';
            D.processForwards({ mds: mds }, function () {
                T.eq('MxUSD forward = buyAmount minus the 0.0001 notify output, one send, exact token id',
                    cmds, ['send amount:9.8999 address:MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G tokenid:0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90']);
                D.processForwards({ mds: mds }, function () {
                    T.eq('a sent forward is never re-sent', cmds.length, 1);
                    // failure path: a failing send keeps the row pending (with the reason) until MAX_ATTEMPTS
                    var H4 = '0x' + '44'.repeat(32);
                    swaps[AX.swapdb.norm(H4)] = { hash: H4, status: 'COMPLETE', buyToken: 'mxUSDT', buyAmount: '1' };
                    mds.cmdR = function (c, cb) { cb(new Error('cmd failed: send — Insufficient funds')); };
                    D.queueForward(mds, H4, 'minima', 'MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G', function () {
                        D.processForwards({ mds: mds }, function () {
                            D.listForwards(mds, function (l2) {
                                var f = D.byHash(l2)[AX.swapdb.norm(H4)];
                                T.eq('failed send: still pending with the reason, attempts counted', [f.status, f.attempts, /Insufficient/.test(f.err)], ['pending', 1, true]);
                                f.attempts = D.MAX_ATTEMPTS - 1; kv[D.fwdKey(H4)] = JSON.stringify(f);
                                D.processForwards({ mds: mds }, function () {
                                    D.listForwards(mds, function (l3) {
                                        T.eq('after MAX_ATTEMPTS the forward is marked failed', D.byHash(l3)[AX.swapdb.norm(H4)].status, 'failed');
                                        D.retryForward(mds, H4, function () {
                                            D.listForwards(mds, function (l4) { T.eq('retry resets to pending', D.byHash(l4)[AX.swapdb.norm(H4)].status, 'pending'); });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
    AX.swapdb.getSwap = realGet; AX.wallet.sendUsdt = realSend;
})();

/* lib/door.js — BOTH AtomiX markets: route selection through the engine's own AX.trading API, both quotes. */
(function () {
    var D = AX.door, TR = AX.trading;
    T.eq('routes: MxUSD market then MINIMA market', D.ROUTES, ['mxusdt', 'minima']);
    T.eq('coinOf names MxUSD, never the legacy label', [D.coinOf('mxusdt'), D.coinOf('minima')], ['MxUSD', 'MINIMA']);

    TR.setActive(TR.MXUSDT);
    var seen = D.withMarket('minima', function () { return TR.active().orderBookAddr; });
    T.eq('withMarket: engine sees the MINIMA sentinel inside', seen, TR.MINIMA.orderBookAddr);
    T.ok('withMarket: selection restored after', TR.active() === TR.MXUSDT);
    try { D.withMarket('minima', function () { throw new Error('x'); }); } catch (e) { }
    T.ok('withMarket: selection restored after a throw', TR.active() === TR.MXUSDT);
    D.selectMarket('minima');
    T.ok('selectMarket: take path holds the MINIMA market', TR.active() === TR.MINIMA && AX.take.address() === TR.MINIMA.takeAddr);
    D.selectMarket('mxusdt');

    // scanBoth asks the node for BOTH sentinels, each with the selection it belongs to, and leaves the selection alone.
    var realCmd = AX.mds.cmd, asked = [];
    AX.mds.cmd = function (c, cb) { var m = /address:(0x[0-9A-F]+)/i.exec(c); if (/^coins /.test(c)) asked.push(m && m[1]); cb({ status: true, response: [] }); };
    var got = null; D.scanBoth(function (b) { got = b; });
    AX.mds.cmd = realCmd;
    T.eq('scanBoth: scans USDTSWAP then MINIMASWAP', asked, [TR.MXUSDT.orderBookAddr, TR.MINIMA.orderBookAddr]);
    T.eq('scanBoth: one (empty) book per market', got, { mxusdt: {}, minima: {} });
    T.ok('scanBoth: selection untouched', TR.active() === TR.MXUSDT);

    // Synthetic books: the MxUSD market quotes ~1 USDT, the MINIMA market ~0.02 USDT; two makers each.
    function mk(pk, bid, ask, depth) {
        var o = AX.order.fromJson({ mpk: '0x01', eth: '0x' + '02'.repeat(20), cid: '', ts: 1, bal: { m: depth, u: depth * bid },
            pairs: { USDT: { en: true, buy: ask, sell: bid, min: 0, bids: [{ p: bid, a: depth }], asks: [{ p: ask, a: depth }] } } });
        o.signerPk = pk; return o;
    }
    var books = {
        mxusdt: { '0xa1': mk('0xa1', 0.99, 1.01, 100), '0xa2': mk('0xa2', 0.98, 1.02, 100) },
        minima: { '0xb1': mk('0xb1', 0.019, 0.021, 10000), '0xb2': mk('0xb2', 0.018, 0.022, 10000) }
    };
    var buy = D.quoteBoth(books, false, '10', {});
    T.eq('ENTER quotes both routes in order', buy.map(function (r) { return r.key + ':' + r.coin; }), ['mxusdt:MxUSD', 'minima:MINIMA']);
    T.ok('ENTER MxUSD route: 10 USDT buys ~9.9 MxUSD at the best ask', buy[0].plan && Math.abs(buy[0].plan.filledMinima - 9.90099) < 1e-4 && buy[0].plan.totalUsdt <= 10 + 1e-9);
    T.ok('ENTER MINIMA route: 10 USDT buys ~476 MINIMA, never over budget', buy[1].plan && Math.abs(buy[1].plan.filledMinima - 476.190476) < 1e-3 && buy[1].plan.totalUsdt <= 10 + 1e-9);
    T.eq('ENTER: live makers counted per market', [buy[0].makers, buy[1].makers], [2, 2]);
    T.ok('ENTER: ceilings are each market’s own depth (MINIMA: second ask is beyond 2% slippage)', buy[0].depth === 200 && buy[1].depth === 10000);
    var sell = D.quoteBoth(books, true, '5', {});
    T.ok('EXIT MxUSD route: 5 MxUSD → 4.95 USDT at the best bid', sell[0].plan && Math.abs(sell[0].plan.totalUsdt - 4.95) < 1e-9);
    T.ok('EXIT MINIMA route: 5 MINIMA → 0.095 USDT at the best bid', sell[1].plan && Math.abs(sell[1].plan.totalUsdt - 0.095) < 1e-9);
    T.eq('no-amount quote: best prices only, no plan', [D.planRoute(books.minima, 'minima', true, '', null).plan, D.planRoute(books.minima, 'minima', true, '', null).best], [null, 0.019]);
    var none = D.planRoute({}, 'minima', false, '10', null);
    T.ok('empty book: names the coin and refuses', !none.plan && /selling MINIMA/.test(none.err));
    T.ok('statusText names the MINIMA notify output', D.statusText({ sellToken: 'USDT', sellAmount: '1', buyToken: 'MINIMA', buyAmount: '47', status: 'COMPLETE' }, null).indexOf('0.0001 MINIMA') > 0);
})();
