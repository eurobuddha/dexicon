/* activity.test.js — the ACTIVITY stage machine (lib/activity.js), mirroring the Android ActivityLogTest. */
(function () {
    var A = AX.activity, OUT = '0x' + 'ab'.repeat(32), IN = '0x' + 'cd'.repeat(32);
    function posted(route) { return { id: 'x', route: route, role: 'taker', side: 'buy', amount: '1000', price: '0.0123', ts: 1000, stage: A.POSTED, postBlock: 100, tip: 100, outs: [OUT], ins: [IN] }; }

    var a = posted('POOL');
    T.eq('height alone never proves inclusion', A.depth(a, 999999), -1);
    T.ok('not confirmed by a high tip', !A.confirmed(a, 999999));
    A.observe(a, 150, false, 0, 1000000);
    T.eq('still no block', a.block || 0, 0);
    T.eq('posted wording', A.status(a, 150, 0), "Posted · in the node's mempool, waiting for a block (50 blocks since posting)");

    a = posted('BOOK+POOL');
    T.ok('output created → changed', A.observe(a, 101, false, 101, 0));
    T.eq('in block 0 conf', A.status(a, 101, 0), 'In block 101 · 0 confirmations');
    T.eq('chip in block', A.chip(a, 101), 'IN BLOCK');
    T.eq('1 confirmation', A.status(a, 102, 0), 'In block 101 · 1 confirmation');
    T.ok('2 deep not confirmed', !A.confirmed(a, 103));
    T.eq('confirmed at 3', A.status(a, 104, 0), 'Confirmed · block 101 · 3 confirmations');
    T.eq('chip confirmed', A.chip(a, 104), 'CONFIRMED');
    a.tip = 110;
    T.eq('row tip counts', A.status(a, 0, 0), 'Confirmed · block 101 · 9 confirmations');
    T.ok('found output never re-probed', !A.observe(a, 110, true, 0, 0) && a.block === 101);

    a = posted('BOOK');
    T.ok('input spent elsewhere drops', A.observe(a, 102, true, 0, 0) && a.stage === A.DROPPED);
    T.eq('drop reason', A.status(a, 102, 0), 'Dropped — an input was spent by another transaction');
    T.ok('dropped still watched', A.watch(a, 102, 1000 + 60000));
    T.ok('dropped not watched after 2h', !A.watch(a, 102, 1000 + A.REVIVE_MS + 1));
    T.ok('late block revives', A.observe(a, 103, false, 103, 0) && a.stage === A.POSTED && a.block === 103);

    a = posted('POOL');
    A.observe(a, 100 + A.DROP_BLOCKS, false, 0, 0);
    T.eq('not yet dropped at the window', a.stage, A.POSTED);
    A.observe(a, 101 + A.DROP_BLOCKS, false, 0, 0);
    T.eq('dropped after the window', A.status(a, 0, 0), 'Dropped — not mined after 60 blocks');

    a = { id: 'f', route: 'FAST', role: 'taker', side: 'sell', amount: '5', price: '0.01', ts: 0, stage: A.SENT, relays: 3, sentMs: 10000 };
    T.eq('take sent', A.status(a, 0, 14000), 'Take sent to 3 relays · waiting for the maker to co-sign (4s)');
    a.stage = A.COSIGNED; a.cosignMs = 3240; a.outs = [OUT];
    T.eq('chip co-signed', A.chip(a, 0), 'CO-SIGNED');
    A.observe(a, 500, false, 0, 20000);
    T.eq('first tip is the post block', a.postBlock, 500);
    T.eq('co-signed wording', A.status(a, 500, 0), "Maker co-signed in 3.2s · in the node's mempool, waiting for a block");
    A.observe(a, 501, false, 501, 20000);
    T.eq('settling', A.status(a, 502, 0), 'Settling · in block 501 · 1 confirmation');
    T.eq('done chip', A.chip(a, 504), 'DONE');

    a = { route: 'FAST', stage: A.SENT, sentMs: 0 };
    A.observe(a, 1, false, 0, A.LOST_MS);
    T.eq('not lost at 10 min', a.stage, A.SENT);
    A.observe(a, 1, false, 0, A.LOST_MS + 1);
    T.eq('lost after 10 min', a.stage, A.LOST);

    a = { route: 'FAST', stage: A.REFUSED, reason: 'taken' };
    T.eq('refused wording', A.status(a, 0, 0), 'Refused by the maker — taken');
    T.ok('refused not pending', !A.hasPending([a], 0, 0));

    var taker = 'Mx' + 'Q'.repeat(60);
    T.ok('maker names taker in full', A.status({ route: 'FAST', role: 'maker', stage: A.COSIGNED, cosignMs: 800, counterparty: taker }, 0, 0).indexOf('Co-signed for ' + taker + ' in 0.8s') === 0);

    // merge (ActivityTimeline port): exact txpowid joins, maker fills become rows, settled fill lends its block
    var rows = [{ id: 'r1', txpowid: '0xAA', ts: 5000, stage: A.COSIGNED, route: 'FAST' }];
    var fills = [{ txpowid: '0xaa', status: 'done', block: 77, ts: 4 }, { role: 'maker', txpowid: '0xbb', side: 'sell', filled: '2', price: '0.1', received: '0.2', taker: taker, status: 'settling', ts: 9, coins: [OUT] }];
    var m = A.merge(rows, fills);
    T.eq('merge rows', m.length, 2);
    T.eq('maker fill newest first', m[0].txpowid, '0xbb');
    T.eq('maker fill counterparty full', m[0].counterparty, taker);
    T.eq('maker mxusd', m[0].mxusd, '0.2');
    T.eq('joined row takes the settled block', m[1].block, 77);
    T.eq('upsert caps and orders', A.upsert([{ id: 'a', ts: 1 }], { id: 'b', ts: 2 }).map(function (r) { return r.id; }), ['b', 'a']);

    // proceeds coin (slow path output evidence)
    var tok = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
    var coins = [{ coinid: '0x01', tokenid: tok, amount: '0.000001', tokenamount: '12.5', created: '99' },
                 { coinid: '0x02', tokenid: tok, amount: '0.000001', tokenamount: '12.5', created: '120' },
                 { coinid: '0x03', tokenid: '0x00', amount: '12.5', created: '121' }];
    T.eq('proceeds: token value, created ≥ post block', (A.proceedsCoin(coins, tok, '12.50', 100) || {}).coinid, '0x02');
    T.eq('proceeds: MINIMA', (A.proceedsCoin(coins, '0x00', '12.5', 100) || {}).coinid, '0x03');
    T.eq('proceeds: none', A.proceedsCoin(coins, tok, '12.6', 100), null);
    var slow = A.fromSlow({ txpowid: '0xcc', size: '1000', price: '0.0123', buy: true, proceeds: '1000', postBlock: 50, sourceKind: 'POOL', sourceCoinids: [IN] }, 7);
    T.eq('slow row from PDService fill_state', [slow.route, slow.stage, slow.postBlock, slow.ins[0]], ['POOL', A.POSTED, 50, IN]);
})();
