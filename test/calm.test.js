/* lib/calm.js — the calm ledger UI's pure derivations: activity steps, swap steps / proof / headline, ledger lines, publicId split. */
(function () {
    var C = AX.calm, A = AX.activity;
    var TX = '0x0A5F09442E3CA785B7B464FD588731082EA7B0C4922936E0BAE5DC5EF1885B0F', T0 = 1761468584000;
    function marks(list) { return list.map(function (s) { return s.m; }).join(''); }
    function texts(list) { return list.map(function (s) { return s.x; }); }

    // ---- time: blank when unknown, never invented ----
    T.eq('hhmm: unknown → blank', C.hhmm(0), '');
    T.ok('hhmm: HH:MM', /^\d\d:\d\d$/.test(C.hhmm(T0)));
    T.ok('dayLabel: today', C.dayLabel(T0, T0).indexOf('Today · ') === 0);
    T.ok('dayLabel: yesterday', C.dayLabel(T0 - 86400000, T0).indexOf('Yesterday · ') === 0);

    // ---- ACTIVITY stages → steps ----
    var b = { id: 'x', route: 'FAST', role: 'taker', side: 'buy', stage: A.BUILDING, ts: T0 };
    T.eq('FAST taker BUILDING: one live step', marks(C.actSteps(b, 100, T0)), '…');
    var sent = { id: 'x', route: 'FAST', role: 'taker', stage: A.SENT, ts: T0, sentMs: T0 + 1000, relays: 2 };
    T.eq('FAST taker SENT: built ✓, waiting for co-sign …', marks(C.actSteps(sent, 100, T0 + 6000)), '✓…');
    T.ok('SENT: names relays and seconds', C.actSteps(sent, 100, T0 + 6000)[1].x.indexOf('2 relays') > 0 && C.actSteps(sent, 100, T0 + 6000)[1].x.indexOf('(5s)') > 0);
    var cos = { id: 'x', route: 'FAST', role: 'taker', stage: A.COSIGNED, ts: T0, sentMs: T0 + 1000, cosignMs: 8600, relays: 1, txpowid: TX, postBlock: 100 };
    T.eq('COSIGNED, not in block: ✓✓✓…', marks(C.actSteps(cos, 102, T0)), '✓✓✓…');
    T.ok('COSIGNED: blocks since posting', C.actSteps(cos, 102, T0)[3].x.indexOf('(2 blocks since posting)') > 0);
    T.eq('co-sign time = sent + cosignMs', C.actSteps(cos, 102, T0)[2].t, C.hhmm(T0 + 1000 + 8600));
    cos.block = 101;
    T.eq('in block, 1 confirmation: …', texts(C.actSteps(cos, 102, T0)).slice(3), ['In block 101', '1 confirmation of 3']);
    T.eq('in-block time is unknown → blank', C.actSteps(cos, 102, T0)[3].t, '');
    T.eq('FAST done after 3', C.actSteps(cos, 104, T0)[4].x, 'Done — 3 confirmations');
    var slow = A.fromSlow({ txpowid: TX, size: '1', price: '0.1', buy: true, postBlock: 50, sourceKind: 'POOL', sourceCoinids: ['0xAA'] }, T0);
    T.eq('BOOK/POOL posted: posted ✓ + mempool …', marks(C.actSteps(slow, 50, T0)), '✓…');
    T.ok('BOOK/POOL posted names block', C.actSteps(slow, 50, T0)[0].x === 'Posted to the network at block 50');
    slow.block = 51;
    T.eq('BOOK/POOL confirmed wording', C.actSteps(slow, 60, T0)[2].x, 'Confirmed — 9 confirmations');
    var mk = A.fromFill({ role: 'maker', side: 'sell', txpowid: TX, filled: '455.78', price: '0.003675', received: '1.6749915', recvMs: T0, cosignMs: 8600, status: 'done', block: 99, taker: '0x07' });
    T.eq('maker fill: taker took ✓, co-signed ✓, block ✓, done ✓', marks(C.actSteps(mk, 200, T0)), '✓✓✓✓');
    T.eq('maker fill: co-sign wording', C.actSteps(mk, 200, T0)[1].x, 'Your node co-signed in 8.6s');
    var ref = { id: 'x', route: 'FAST', role: 'taker', stage: A.REFUSED, ts: T0, sentMs: T0, cosignMs: 900, relays: 1, reason: 'stale' };
    T.eq('REFUSED: ✓✓ then !', marks(C.actSteps(ref, 1, T0)), '✓✓!');
    T.eq('REFUSED: reason surfaced', C.actSteps(ref, 1, T0)[2].x, 'Refused by the maker — stale');
    var lost = A.fromFill({ role: 'taker', side: 'buy', txpowid: TX, status: 'lost', ts: 1 });
    T.eq('LOST fill: ends in !', C.actSteps(lost, 1, T0).slice(-1)[0].m, '!');
    var drop = { id: 'x', route: 'BOOK', stage: A.DROPPED, ts: T0, txpowid: TX, reason: 'an input was spent by another transaction', postBlock: 5 };
    T.eq('DROPPED: no inclusion lines after the failure', marks(C.actSteps(drop, 9, T0)), '✓!');

    // ---- AtomiX swap → steps / proof / headline ----
    var E1 = '0x1807356ac07321386098ee76db08bcd153faf3f892c66071da3b870dc71b418f', E2 = '0x84dcb566ca73e8ad5bc16551467f80c1267037ff5b3302a10cfc31d5882bdf0a';
    var M1 = '0x000018E5AE5CCC1FF548DC177143D32FDE5445267535A3A4D1440A2F41ECAC4C', MAKER = '0x172215A51CF23DD5F196516A13E95EB1CAA47482EC5D6F46A8BC54460A5AE202';
    var sw = { hash: 'ad0471fa26cf64d37cfcafc98e2cf3710b3bef638297e4dcc259e99324934336', direction: 'ERC20_TO_MINIMA', sellToken: 'USDT', sellAmount: '20.81', buyToken: 'mxUSDT', buyAmount: '20.60396',
        counterparty: MAKER, status: 'STARTED', contractId: '0x8e27aa2d3b1547c209e30d5e6eb4e893cf7dc50b0002a7b6ba283363bb157850', myTimelock: 1761489720, myLegIsMinima: false, created: T0 };
    var ev = [{ event: 'HTLC_STARTED', token: 'ETH:0xdac17f958d2ee523a2206206994597c13d831ec7', amount: '20.81', note: E1, date: T0 },
              { event: 'CPTXN_SENT', token: 'minima', note: 'sent', date: T0 + 30000 }];
    var st = C.swapSteps(sw, ev, null);
    T.eq('STARTED: locked ✓, told ✓, waiting …', marks(st), '✓✓…');
    T.eq('STARTED: plain words, MxUSD never legacy', texts(st), ['Your 20.81 USDT is locked on Ethereum', 'The maker has been told', 'Waiting for the maker to lock your MxUSD']);
    T.eq('event time from the event row', st[1].t, C.hhmm(T0 + 30000));
    T.ok('refund note: ETH leg timelock is unix seconds', C.refundNote(sw).indexOf(C.when(1761489720 * 1000)) > 0);
    T.ok('refund note: Minima leg is a block', C.refundNote({ sellAmount: '5', sellToken: 'mxUSDT', myTimelock: 2386900, myLegIsMinima: true }).indexOf('after block 2386900') > 0);
    T.eq('refund note: none recorded → blank', C.refundNote({ myTimelock: 0 }), '');
    var h = C.swapHead(sw, null);
    T.ok('head: live entry, both amounts', h.live && h.title === 'AtomiX entry' && h.amt === '20.81 USDT → 20.60396 MxUSD' && h.usd);
    sw.status = 'COMPLETE';
    var ev2 = ev.concat([{ event: 'MINIMA_CLAIM_SUBMITTED', token: '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90', note: M1, date: T0 + 300000 },
                         { event: 'CPTXN_COLLECT', token: 'minima', note: M1, date: T0 + 400000 }]);
    st = C.swapSteps(sw, ev2, null);
    T.eq('COMPLETE: maker-locked step inserted before the claim, blank time', [st[2].x, st[2].t], ['The maker locked 20.60396 MxUSD', '']);
    T.eq('COMPLETE: ends in Done (statusText, with the notify output)', st[st.length - 1].x.indexOf('Done — 20.60396 MxUSD received') === 0 && st[st.length - 1].x.indexOf('0.0001') > 0, true);
    T.ok('COMPLETE no forward: not live', !C.swapLive(sw, null) && C.swapChip(sw, null) === 'DONE');
    var proof = C.swapProof(sw, ev2, null);
    T.eq('proof: each id ONCE, full, labelled', proof, [['Swap', sw.hash], ['Your lock (Ethereum tx)', E1], ['Your claim (Minima txpow)', M1], ['Ethereum contract', sw.contractId], ['Maker key', MAKER]]);
    var all = AX.door.txIds(ev2), flat = proof.map(function (p) { return p[1]; });
    T.ok('proof covers every id txIds finds', all.eth.concat(all.minima).every(function (id) { return flat.indexOf(id) >= 0; }));
    var fw = { status: 'failed', err: 'gas', to: '0xe532293d331ec712c053e13db58035babd7cce23', tx: '' };
    T.ok('forward failed: still live (RETRY FORWARD), chip says so', C.swapLive(sw, fw) && C.swapChip(sw, fw) === 'FORWARD FAILED' && C.swapSteps(sw, ev2, fw).slice(-1)[0].m === '!');
    var fs = { status: 'sent', amount: '20.60386', to: 'MxG0829Y2QW3FC679PEUQDG2YY4ASHHY1MUYACAMVF9VQS3EANZCP8P4Q7NGS52', tx: E2 };
    T.ok('forward sent: destination only in proof, not in the step', C.swapSteps(sw, ev2, fs).slice(-1)[0].x.indexOf(fs.to) < 0);
    T.eq('forward sent: proof tail', C.swapProof(sw, ev2, fs).slice(-2), [['Forwarded to', fs.to], ['Forward tx', E2]]);
    sw.status = 'REFUNDED';
    st = C.swapSteps(sw, ev.concat([{ event: 'CPTXN_EXPIRED', token: 'ETH', note: 'confirmed on-chain', date: T0 + 7200000 }]), null);
    T.ok('REFUNDED: no maker-locked step, ends refunded', texts(st).indexOf('The maker locked 20.60396 MxUSD') < 0 && st.slice(-1)[0].x.indexOf('refunded') > 0);
    T.eq('REFUNDED head: muted', [C.swapHead(sw, null).icon, C.swapHead(sw, null).chipTone], ['↺', 'void']);
    sw.status = 'ERROR';
    T.eq('ERROR: ends in !', C.swapSteps(sw, [{ event: 'SWAP_LOST', token: 'ETH', note: 'the maker reclaimed', date: T0 }], null).map(function (s) { return s.m; }), ['!', '!']);
    sw.status = 'LOCKED';
    T.eq('LOCKED: maker locked ✓ then claiming …', marks(C.swapSteps(sw, ev, null)), '✓✓✓…');

    // ---- ledger lines ----
    var fmt = function (v) { return String(v); };
    var r = { timems: T0, buy: true, size: '2728.1472894674', price: '0.003792827565', maker: false, txpowid: TX, spentcoin: '0xORDERCOIN', orderid: '', source_kind: 'POOL', verification_status: 'LOCAL_VERIFIED', block: 2382347 };
    var act = { outs: ['0x995556EB3EC8B6AC7B15DC8DD4521F5EA12716166280C9B2F194533FE4C82E71'], ins: ['0x1ECDD8429185F0825093126A6252020A539EC73A117C343DD329E547D18BA827', '0x28B415AC38ECF8316DFDCDDAD61B2450007885405A0C1A67AAFDFCBF0102C274'] };
    var x = C.ledgerTrade(r, { fmt: fmt, fmtPrice: fmt, value: '10.34739224', act: act });
    T.eq('ledger: Bought line', [x.verb, x.amt, x.l2, x.icon, x.kind], ['Bought', '2728.1472894674 MINIMA', '@ 0.003792827565 · Pool · as taker', '↓', 'buy']);
    T.eq('ledger: facts lead with what you paid, exact', x.facts[0], ['You paid', '10.34739224 MxUSD']);
    T.ok('ledger: settled block', x.facts.some(function (f) { return f[0] === 'Settled' && f[1] === 'block 2382347'; }));
    T.eq('ledger: txpow is proof (tap-to-copy), order coin kept', x.proof, [['Transaction (txpow)', TX], ['Order coin (spent)', '0xORDERCOIN']]);
    T.eq('ledger: coins received + spent groups', x.groups.map(function (gr) { return gr.label + ' ' + gr.ids.length; }), ['Coins you received 1', 'Coins you spent 2']);
    var f = { role: 'maker', side: 'sell', txpowid: TX, coins: ['0xC1', '0xC2'], taker: '0x07fb', cosignMs: 8900, status: 'done' };
    x = C.ledgerTrade({ timems: T0, buy: false, size: '455.78', price: '0.003675', maker: true, txpowid: TX, spentcoin: '0xC1', orderid: '0xc51c9e5026803350', source_kind: 'FAST DONE', verification_status: 'ON-CHAIN block 9', fast: true, fill: f }, { fmt: fmt, fmtPrice: fmt, value: '1.6749915', act: null });
    T.eq('ledger FAST maker: Sold, fast book, as maker', [x.verb, x.l2, x.kind], ['Sold', '@ 0.003675 · Fast book · as maker', 'sell']);
    T.eq('ledger FAST: spentcoin is coins[0] → not repeated; order + taker id', x.proof, [['Transaction (txpow)', TX], ['Order', '0xc51c9e5026803350'], ['Taker ID', '0x07fb']]);
    T.ok('ledger FAST: co-signed fact', x.facts.some(function (q) { return q[0] === 'Co-signed' && q[1] === 'in 8.9s'; }));
    f.status = 'settling';
    T.eq('ledger FAST still settling: muted + status in the line', x = C.ledgerTrade({ timems: T0, buy: true, size: '1', price: '1', fast: true, fill: f, verification_status: 'SETTLING' }, { fmt: fmt, fmtPrice: fmt, value: '1' }).kind, 'void');
    var ls = C.ledgerSwap({ hash: 'h', direction: 'ERC20_TO_MINIMA', sellToken: 'USDT', sellAmount: '20.81', buyToken: 'mxUSDT', buyAmount: '20.60396', status: 'COMPLETE', created: T0 }, null);
    T.eq('ledgerSwap: Swapped', [ls.verb, ls.amt, ls.icon, ls.kind], ['Swapped', '20.81 USDT → 20.60396 MxUSD', '⇄', 'swap']);
    ls = C.ledgerSwap({ hash: 'h', direction: 'ERC20_TO_MINIMA', sellToken: 'USDT', sellAmount: '20.81', buyToken: 'mxUSDT', buyAmount: '20.60396', status: 'REFUNDED', created: T0 }, null);
    T.eq('ledgerSwap: muted Refunded', [ls.verb, ls.amt, ls.kind], ['Refunded', '20.81 USDT', 'void']);

    // ---- publicId split ----
    var pid = '0x' + 'ab'.repeat(32) + 'CD'.repeat(32), k = C.splitId(pid);
    T.eq('splitId: box = first 32 bytes, sign = last 32', [k.box, k.sign], ['0x' + 'ab'.repeat(32), '0x' + 'CD'.repeat(32)]);
    T.eq('splitId: rejoins to the full id', '0x' + k.box.slice(2) + k.sign.slice(2), pid);
    T.eq('splitId: wrong shape → null', C.splitId('0x1234'), null);

    // ---- HTML: ids in full, tap copies data-v, no shortening ----
    var ev1 = C.ev('Swap', sw.hash);
    T.ok('ev: full value displayed AND in data-v', ev1.indexOf('data-v="' + sw.hash + '"') > 0 && ev1.indexOf('>' + sw.hash + '<') > 0);
    T.ok('ev: empty value renders nothing', C.ev('x', '') === '');
    T.ok('steps: blank time cell when unknown', C.steps([C.step('ok', '', 'x')]).indexOf('<span class="tm"></span>') > 0);
    T.ok('fold: closed by default without storage', C.fold('k', 's', 'b').indexOf(' open') < 0 && C.fold('k', 's', 'b', '', true).indexOf(' open>') > 0);
    T.ok('item: live shows steps outside any fold', C.item('k', { live: true, icon: '●', title: 't', amt: 'a' }, [C.step('wait', '', 'w')], [['Swap', 'h']], '').indexOf('<section class="calm-card live') === 0);
    T.ok('esc: no markup injection', C.ev('<b>', '"><script>').indexOf('<script>') < 0);
})();
