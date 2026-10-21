#!/bin/bash
# The RESTING layer is PandaDEX, vendored verbatim: fail if any copy drifted from mds/pandadex-mds.
cd "$(dirname "$0")/.."
SRC=../pandadex-mds; [ -d "$SRC" ] || { echo "VENDOR SKIP (no $SRC)"; exit 0; }
fail=0
for f in resting/*.js; do b=$(basename "$f"); [ "$b" = pd_service.js ] && continue; cmp -s "$f" "$SRC/$b" || { echo "DRIFT: $f vs $SRC/$b"; fail=1; }; done
for f in style.css parity.css fonts.css; do cmp -s "ui/$f" "$SRC/$f" || { echo "DRIFT: ui/$f"; fail=1; }; done
cmp -s vendor/decimal.js "$SRC/decimal.js" || { echo "DRIFT: vendor/decimal.js"; fail=1; }
# pd_service.js = pandadex service.js minus its loader line and MDS.init block
python3 - "$SRC/service.js" resting/pd_service.js <<'PY' || fail=1
import sys,re
s=open(sys.argv[1]).read(); i=s.rfind('\nMDS.init('); head=s[:i+1]
head=re.sub(r'^MDS\.load\("[^"]+"\);(\s*MDS\.load\("[^"]+"\);)*\s*\n', '/* module loads live in Dexicon service.js (resting/*.js) */\n', head, count=1, flags=re.M)
if head!=open(sys.argv[2]).read(): print('DRIFT: resting/pd_service.js'); sys.exit(1)
PY
[ $fail = 0 ] && echo "VENDOR PASS — resting layer matches pandadex-mds $(grep -oE '"version"\s*:\s*"[^"]+"' $SRC/dapp.conf | sed -E 's/.*"([^"]+)".*/\1/')" || { echo "VENDOR FAIL — run scripts/vendor-pandadex.sh"; exit 1; }
