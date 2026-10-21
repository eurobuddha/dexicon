#!/usr/bin/env bash
# Re-vendor the AtomiX MiniDapp TAKER engine (the DOORS: USDT ⇄ MxUSD via HTLCs on both chains) VERBATIM from
# ../atomix-mds into doors/ (flat). Maker-side modules (maker, peg, responder, otc) and AtomiX's own UI (app, ui,
# qrcode) are deliberately NOT vendored: Dexicon only ever TAKES an AtomiX maker's quote, and atomix-mds's
# lib/maker.js defines AX.maker — the same global as Dexicon's own FAST maker (lib/maker.js). Files AtomiX shares
# with Dexicon (rhino_shim, hex, flow, identity, mdsw, prng, crypto/ax_sodium, vendor nacl/blake/sha256/sha512)
# came FROM atomix-mds and stay in lib/ — test/vendor.sh fails if either side drifts. The ETH RPC endpoint list
# therefore has NO fifth copy here: doors/ethrpc.js and doors/ethhtlc.js ARE atomix-mds's bytes.
# doors/ax_service.js is Dexicon-owned (taker-only reduction of atomix-mds service.js, namespaced AXService) and is
# not touched here. Run after any atomix-mds release; `npm test` fails if the copies drift.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../atomix-mds
mkdir -p doors
# load order (service.js / index.html follow it): vendored crypto → decimal/abi → ETH leg → Minima leg → engine
MODULES="vendor/sha3.js vendor/elliptic.js crypto/ax_eth.js lib/decimal.js lib/abi.js lib/ethhtlc.js lib/trading.js lib/signgate.js
lib/ethrpc.js lib/ethtx.js lib/ethops.js lib/swapdb.js lib/htlc.js lib/order.js lib/boot.js lib/identitywatch.js lib/settle.js
lib/orderbook.js lib/take.js lib/swapplan.js lib/engine.js lib/market.js lib/wallet.js"
for m in $MODULES; do cp "$SRC/$m" "doors/$(basename "$m")"; done
# shared files must still be byte-identical to the originals (they are loaded once, from lib/ and vendor/)
for p in lib/rhino_shim.js lib/hex.js lib/flow.js lib/identity.js lib/mdsw.js lib/prng.js crypto/ax_sodium.js vendor/nacl.js vendor/blake.js vendor/sha256.js vendor/sha512.js; do
  cmp -s "$SRC/$p" "$p" || { echo "SHARED FILE DRIFTED: $p vs $SRC/$p — vendor the AtomiX copy under doors/ and resolve the AX.* clash by hand"; exit 1; }
done
VER=$(grep -oE '"version"\s*:\s*"[^"]+"' $SRC/dapp.conf | sed -E 's/.*"([^"]+)".*/\1/')
printf 'Vendored from mds/atomix-mds %s on %s by scripts/vendor-atomix.sh — do not edit these files here (ax_service.js is Dexicon-owned).\nModules: %s\n' "$VER" "$(date +%F)" "$(echo $MODULES | tr '\n' ' ')" > doors/VENDORED.md
echo "vendored atomix-mds $VER"
