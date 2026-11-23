#!/bin/bash
# 0.0.176 (review NIT): test/vendor.sh must FAIL, not skip, when a sibling source is missing — unless ALLOW_NO_VENDOR=1.
cd "$(dirname "$0")/.."
NONE=/nonexistent/dexicon-vendor-guard
if PANDADEX_SRC=$NONE bash test/vendor.sh >/dev/null 2>&1; then echo "VENDOR GUARD FAIL: no pandadex-mds, yet vendor.sh passed"; exit 1; fi
if [ -d ../pandadex-mds ] && ATOMIX_SRC=$NONE bash test/vendor.sh >/dev/null 2>&1; then echo "VENDOR GUARD FAIL: no atomix-mds, yet vendor.sh passed"; exit 1; fi
PANDADEX_SRC=$NONE ALLOW_NO_VENDOR=1 bash test/vendor.sh >/dev/null 2>&1 || { echo "VENDOR GUARD FAIL: ALLOW_NO_VENDOR=1 did not skip"; exit 1; }
echo "VENDOR GUARD PASS"
