#!/usr/bin/env bash
# Package Dexicon into an MDS MiniDapp zip, ready to drag into MiniHub.
#
# Safeguards:
#   - Stages files into a temp dir so we never mutate the working tree.
#     (The previous in-place sed trick on index.html would leave a .bak
#     behind on failure and could corrupt the source if the sed failed
#     partway.)
#   - Version injected from dapp.conf into the index.html topbar, so the
#     displayed version always matches the dapp.conf single source of truth.

set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(grep -oE '"version"\s*:\s*"[^"]+"' dapp.conf | sed -E 's/.*"([^"]+)".*/\1/')

# Build-time invariant: dapp.conf MUST request write permission.
# `balance` and `coins` are read-only commands and don't need write,
# but `txnsign publickey:auto` and `txnpost` (used during trade flows)
# do — without write permission the maker's checkAndSignTrade can't
# co-sign a taker's trade_request and trade_complete fails silently.
if ! grep -qE '"permission"\s*:\s*"write"' dapp.conf; then
    echo "ERROR: dapp.conf missing \"permission\": \"write\". Refusing to build."
    echo "       (Trade signing — txnsign / txnpost — requires write permission.)"
    exit 1
fi
OUT="Dexicon-${VERSION}.mds.zip"

# Stage everything into a clean temp dir so source files stay pristine.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/Dexicon-build.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

cp -R dapp.conf service.js mds.js favicon.ico lib vendor crypto ui "$STAGE/"

# Inject version into the staged index.html (source file untouched).
sed -E "s|<span class=\"version\" id=\"app-version\">[^<]*</span>|<span class=\"version\" id=\"app-version\">v${VERSION}</span>|" \
    index.html > "$STAGE/index.html"

# Never delete historical zips — every version built stays on disk so we
# can always roll back to a known-good binary. Refuse to clobber the
# exact version being built instead; bump dapp.conf to produce another.
if [ -f "$OUT" ]; then
    echo "ERROR: $OUT already exists. Bump dapp.conf version before rebuilding."
    exit 1
fi

(cd "$STAGE" && zip -rq - dapp.conf index.html service.js mds.js favicon.ico lib vendor crypto ui) > "$OUT"

echo ""
echo "Built: $(pwd)/${OUT}  (v${VERSION})"
echo "Size : $(du -h "${OUT}" | cut -f1)"
echo ""
echo "Install: drag ${OUT} into any Minima node's MiniHub."
