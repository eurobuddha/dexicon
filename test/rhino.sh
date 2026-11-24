#!/bin/bash
# RELEASE GATE: the signing stack + envelope module under the node's ACTUAL Rhino 1.7.14 (same engine/flags as
# service.js: -version 200, optimisation -1). Node/V8 masks Rhino-only bugs; this is the authoritative check that the
# backend will sign the reference vector byte-identically. Exit non-zero on any mismatch.
set -e
cd "$(dirname "$0")/.."
RHINO="${RHINO_JAR:-/Users/eurobuddha/Projects/minima/core/Minima/lib/rhino-1.7.14.jar}"
[ -f "$RHINO" ] || { echo "rhino jar not found at $RHINO (set RHINO_JAR)"; exit 2; }
TMP="$(mktemp -t dexicon_rhino).js"; trap 'rm -f "$TMP"' EXIT
# Same load order as service.js up to (not incl.) the MDS-dependent wrapper.
grep -oE "MDS.load\('[^']+'\)" service.js | sed "s/MDS.load('//;s/')//" | while read -r f; do
  case "$f" in lib/mdsw.js) continue;; esac
  [ -f "$f" ] || { echo "GATE FAIL: service.js loads missing file $f" >&2; exit 1; }
  cat "$f" >> "$TMP"; echo ";" >> "$TMP"
done
cat >> "$TMP" <<'EOF'
var V = JSON.parse(readFile('spec/vectors/order-v1-vector.json'));
var me = AX.identity.fromSeed('0x' + '11'.repeat(32), 'decks');
var v = V.envelope;
var signed = AX.envelope.order(me, { market: v.market, side: v.side, price: v.price, amount: v.amount, coins: v.coins, scripts: v.scripts,
                                     address: v.address, orderId: v.orderId, seq: v.seq, expiry: v.expiry });
var sig = JSON.parse(signed).sig;
var ok = AX.envelope.verify(signed, 1800000000 - 3600).ok;
print(sig === V.sig && ok ? 'RHINO GATE PASS ' + sig : 'RHINO GATE FAIL got ' + sig + ' want ' + V.sig + ' verify=' + ok);
if (!(sig === V.sig && ok)) quit(1);
// 0.0.143: the myorders lock retry under the node's own limits (ServiceJSRunner: interpreter stack depth 1024, no
// setTimeout, MDS.sql answering synchronously): a lock held by another writer, retried from inside a tick's stack, must
// end in the save's error callback — the retry used to recurse (about 5 frames a try) and kill the tick past ~200 tries.
Packages.org.mozilla.javascript.Context.getCurrentContext().setMaximumInterpreterStackDepth(1024);
globalThis.setTimeout = undefined;   // the rhino shell has one; the node's service scope (initStandardObjects) does not
var LROW = { owner: 'wother.1' }, realNow = Date.now, fk = 0;
// (no `return f()` anywhere below: Rhino's interpreter turns a call in return position into a tail call that keeps no
// frame, while the node's MDS.sql calls back from Java, which always nests)
var smds = { kvGet: function (k, d, cb) { cb('[]'); }, kvSet: function (k, v, cb) { cb(null); }, sql: function (q, cb) {
    var r = /^(CREATE TABLE IF NOT EXISTS `dx_lock`|INSERT INTO `dx_lock`|UPDATE `dx_lock`)/.test(q) ? { status: true }
          : /^SELECT `owner` FROM `dx_lock`/.test(q) ? { status: true, rows: [{ OWNER: LROW.owner }] } : { status: false, error: 'unexpected ' + q };
    cb(r);
} };
function deep(n, f) { if (n > 0) deep(n - 1, f); else f(); }   // a tick's stack under the save
var res = 'no callback';
Date.now = function () { fk += 5; return realNow() + fk; };
try { deep(150, function () { AX.maker.withLock(smds, 'myorders', function (rel) { res = 'acquired a held lock'; rel(function () { }); }, function (e) { res = e.message; }); }); }
catch (e) { res = 'THREW ' + e; }
Date.now = realNow;
print(/held by another writer/.test(res) ? 'RHINO LOCK PASS ' + res : 'RHINO LOCK FAIL ' + res);
if (!/held by another writer/.test(res)) quit(1);
// 0.0.189 / 0.0.199: settleFills under the same limits. The fill_ records are kept for good and the node answers
// synchronously: one frame a record overflowed the 1024 stack at about a thousand records (0.0.188: "Exceeded maximum
// stack depth" with 3000, the settle pass dead for good). They are walked in a loop now.
var NREC = 3000, rowsS = [], kS, doneS = 'no callback';
for (kS = 0; kS < NREC; kS++) rowsS.push({ K: 'fill_x' + kS, V: JSON.stringify({ role: 'maker', orderId: '0x0101010101010101', txpowid: '0x' + ('0000000000000000000000000000000000000000000000000000000000000000' + kS.toString(16)).slice(-64), status: 'done', filled: '1', ts: 1 }) });
var smds2 = { kvGet: function (k, d, cb) { cb('[]'); }, kvSet: function (k, v, cb) { cb(null); },
    sql: function (q, cb) { cb(/^SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'$/.test(q) ? { status: true, rows: rowsS } : { status: false, error: 'unexpected ' + q }); },
    cmdR: function (c, cb) { if (c === 'block') cb(null, { block: '5000' }); else cb(null, []); } };
try { deep(100, function () { AX.maker.settleFills(smds2, { relays: [], publish: function (r, cb) { cb([]); } }, null, function () { }, function () { doneS = 'done'; }); }); }
catch (e) { doneS = 'THREW ' + e; }
print(doneS === 'done' ? 'RHINO SETTLE PASS ' + NREC + ' fill records walked in a loop' : 'RHINO SETTLE FAIL ' + String(doneS).slice(0, 120));
if (doneS !== 'done') quit(1);
EOF
java -jar "$RHINO" -version 200 -opt -1 "$TMP"
