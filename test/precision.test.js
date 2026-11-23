/* precision.test.js — 0.0.176 (review NIT): lib/fill.js keeps its OWN Decimal at 64 significant digits (resting/covenant.js
   resets the global Decimal to 40, and fill.js used the global: its "EXACT" change was rounded past 40 digits). */
(function () {
    var F = AX.fill;
    // a 45-digit amount (the node reports up to 64 digits / 44 dp; txnoutput stored a 45-digit amount exactly, 2026-10-21)
    var A = '123456789012345678901234567890.123456789012345', B = '0.000000000000001';
    T.eq('0.0.176: 45-digit sum exact under the global Decimal at ' + Decimal.precision, F.plain(F.d(A).plus(F.d(B))), '123456789012345678901234567890.123456789012346');
    T.eq('0.0.176: 45-digit change exact (fit44)', F.plain(F.fit44(F.d(A).minus(F.d('0.00000001')))), '123456789012345678901234567890.123456779012345');
    var coin = { coinid: '0x' + '01'.repeat(32), address: '0x' + 'cc'.repeat(32), tokenid: F.MINIMA, amount: A, state: [] };
    var tc = { coinid: '0x' + '02'.repeat(32), address: '0x' + 'ee'.repeat(32), tokenid: F.MXUSD, amount: '0.000001', tokenamount: '1000', state: [] };
    var p = F.plan({ side: 'sell', price: '0.1', amount: '100', address: '0x' + 'ab'.repeat(32) }, '100', [coin], [tc], '0x' + 'ee'.repeat(32));
    T.eq('0.0.176: the maker\'s change from a 45-digit coin is exact', p.makerChange, '123456789012345678901234567790.123456789012345');

})();
