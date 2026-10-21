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

# The DOORS are the AtomiX taker engine, vendored verbatim: fail if any copy drifted from mds/atomix-mds, or if a
# file both apps share (loaded once from lib/) drifted on EITHER side (that would make Dexicon a divergent copy).
AXS=../atomix-mds; [ -d "$AXS" ] || { echo "DOORS VENDOR SKIP (no $AXS)"; exit 0; }
afail=0
for f in doors/*.js; do
  b=$(basename "$f"); [ "$b" = ax_service.js ] && continue
  src=""; for d in lib vendor crypto; do [ -f "$AXS/$d/$b" ] && src="$AXS/$d/$b"; done
  [ -n "$src" ] || { echo "DRIFT: $f has no source in $AXS"; afail=1; continue; }
  cmp -s "$f" "$src" || { echo "DRIFT: $f vs $src"; afail=1; }
done
for p in lib/rhino_shim.js lib/hex.js lib/flow.js lib/identity.js lib/mdsw.js lib/prng.js crypto/ax_sodium.js vendor/nacl.js vendor/blake.js vendor/sha256.js vendor/sha512.js; do
  cmp -s "$p" "$AXS/$p" || { echo "DRIFT (shared): $p vs $AXS/$p"; afail=1; }
done
# the ETH RPC endpoint list must have exactly the two AtomiX copies here and nowhere else (no fifth divergent copy)
grep -rl "ethereum-rpc.publicnode.com" --include=*.js . 2>/dev/null | grep -v node_modules | grep -vE '^\./doors/(ethrpc|ethhtlc)\.js$' | while read -r x; do echo "RPC LIST COPY outside doors/: $x"; done
[ -z "$(grep -rl "ethereum-rpc.publicnode.com" --include=*.js . 2>/dev/null | grep -v node_modules | grep -vE '^\./doors/(ethrpc|ethhtlc)\.js$')" ] || afail=1
[ $afail = 0 ] && echo "DOORS VENDOR PASS — doors match atomix-mds $(grep -oE '"version"\s*:\s*"[^"]+"' $AXS/dapp.conf | sed -E 's/.*"([^"]+)".*/\1/')" || { echo "DOORS VENDOR FAIL — run scripts/vendor-atomix.sh"; exit 1; }
