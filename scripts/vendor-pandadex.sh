#!/usr/bin/env bash
# Re-vendor the PandaDEX MiniDapp engine (the RESTING layer: V5 covenant book, PandaPools, txn pipeline,
# tape/stats/history/export) VERBATIM from ../pandadex-mds. Only pd_service.js is edited, mechanically:
# its trailing MDS.init(...) block is stripped so Dexicon's service.js owns the one MDS.init and forwards
# events to PDService. Run after any pandadex-mds release; `npm test` fails if the copies drift.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../pandadex-mds
MODULES="safety covenant funding signlock book pool composite txn tape maker price verifier pending stats split chain history balance zip export explorer"
for m in $MODULES; do cp "$SRC/$m.js" "resting/$m.js"; done
# decimal.js is already vendor/decimal.js (byte-identical; cmp enforces it in the test)
cp "$SRC/fonts.css" "$SRC/style.css" "$SRC/parity.css" "$SRC/inter_var.ttf" "$SRC/jetbrains_mono_var.ttf" ui/
# service.js → pd_service.js minus the final MDS.init block (everything from the last "MDS.init(" to EOF)
python3 - "$SRC/service.js" resting/pd_service.js <<'PY'
import sys,re
s=open(sys.argv[1]).read()
i=s.rfind('\nMDS.init(')
assert i>0, 'no MDS.init in pandadex service.js'
head=s[:i+1]
# the loader line: Dexicon's service.js loads the modules itself (different paths)
head=re.sub(r'^MDS\.load\("[^"]+"\);(\s*MDS\.load\("[^"]+"\);)*\s*\n', '/* module loads live in Dexicon service.js (resting/*.js) */\n', head, count=1, flags=re.M)
open(sys.argv[2],'w').write(head)
PY
VER=$(grep -oE '"version"\s*:\s*"[^"]+"' $SRC/dapp.conf | sed -E 's/.*"([^"]+)".*/\1/')
printf 'Vendored from mds/pandadex-mds %s on %s by scripts/vendor-pandadex.sh — do not edit these files here.\n' "$VER" "$(date +%F)" > resting/VENDORED.md
echo "vendored pandadex-mds $VER"
