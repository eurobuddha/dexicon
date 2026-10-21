#!/bin/bash
# RELEASE GATE: the signing stack + envelope module under the node's ACTUAL Rhino 1.7.14 (same engine/flags as
# service.js: -version 200, optimisation -1). Node/V8 masks Rhino-only bugs; this is the authoritative check that the
# backend will sign the reference vector byte-identically. Exit non-zero on any mismatch.
set -e
cd "$(dirname "$0")/.."
RHINO="${RHINO_JAR:-/Users/eurobuddha/Projects/minima/core/Minima/lib/rhino-1.7.14.jar}"
[ -f "$RHINO" ] || { echo "rhino jar not found at $RHINO (set RHINO_JAR)"; exit 2; }
TMP="$(mktemp -t decks_rhino).js"; trap 'rm -f "$TMP"' EXIT
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
var signed = AX.envelope.order(me, { market: v.market, side: v.side, price: v.price, amount: v.amount, coins: v.coins,
                                     address: v.address, orderId: v.orderId, seq: v.seq, expiry: v.expiry });
var sig = JSON.parse(signed).sig;
var ok = AX.envelope.verify(signed, 1800000000 - 3600).ok;
print(sig === V.sig && ok ? 'RHINO GATE PASS ' + sig : 'RHINO GATE FAIL got ' + sig + ' want ' + V.sig + ' verify=' + ok);
if (!(sig === V.sig && ok)) quit(1);
EOF
java -jar "$RHINO" -version 200 -opt -1 "$TMP"
