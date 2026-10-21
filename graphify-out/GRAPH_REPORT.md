# Graph Report - dexicon  (2026-10-21)

## Corpus Check
- 79 files · ~134,826 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 432 nodes · 680 edges · 51 communities (43 shown, 8 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8a855f3b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- decimal.js
- envelope.js
- maker.js
- headless.js
- app.js
- fill.js
- mdsw.js
- service.js
- Client
- cosign_spike.py
- ed25519/vendor/blake.js
- lib/identity.js
- mds.js
- vendor/identity.js
- dapp/mds.js
- run.js
- crypto/ax_sodium.js
- cosign2_spike.py
- vendor/ax_sodium.js
- finalise
- H
- parseOther
- package.json
- run_node.js
- Verify
- digitsToString
- flow.js
- getPi
- prng.js
- cosine
- log
- maxOrMin
- build.sh
- install.sh
- pre-commit
- rhino.sh
- Dexicon — specification (v0, 2026-10-21)

## God Nodes (most connected - your core abstractions)
1. `refresh()` - 13 edges
2. `edit()` - 12 edges
3. `create()` - 11 edges
4. `finalise()` - 10 edges
5. `verifyAsMaker()` - 9 edges
6. `Client()` - 9 edges
7. `handleTake()` - 9 edges
8. `Dexicon — specification (v0, 2026-10-21)` - 8 edges
9. `verify()` - 8 edges
10. `plan()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `confirmTake()` --indirect_call--> `msg()`  [INFERRED]
  ui/app.js → lib/envelope.js
- `processTakes()` --indirect_call--> `step()`  [INFERRED]
  service.js → test/headless.js
- `"node_modules/tweetnacl/nacl-fast.js"()` --indirect_call--> `msg()`  [INFERRED]
  spikes/ed25519/vendor/nacl.js → lib/envelope.js
- `"node_modules/tweetnacl/nacl-fast.js"()` --indirect_call--> `msg()`  [INFERRED]
  vendor/nacl.js → lib/envelope.js
- `"node_modules/tweetnacl/nacl-fast.js"()` --indirect_call--> `add()`  [INFERRED]
  spikes/ed25519/vendor/nacl.js → vendor/decimal.js

## Import Cycles
- None detected.

## Communities (51 total, 8 thin omitted)

### Community 1 - "envelope.js"
Cohesion: 0.15
Nodes (16): bad(), canonical(), is0x(), isBareHex(), isCancelAmount(), isInt(), msg(), order() (+8 more)

### Community 2 - "maker.js"
Cohesion: 0.28
Nodes (22): afterFill(), ageOf(), backing(), cancel(), chainCtx(), coinsBackingOthers(), create(), edit() (+14 more)

### Community 3 - "headless.js"
Cohesion: 0.14
Nodes (21): args, createOrder(), die(), fetchCoins(), fs, get(), http, https (+13 more)

### Community 4 - "app.js"
Cohesion: 0.27
Nodes (17): confirmTake(), esc(), fetchCoins(), inboxLoop(), loadMyOrders(), loadRelays(), openTake(), placeOrder() (+9 more)

### Community 5 - "fill.js"
Cohesion: 0.27
Nodes (16): bad(), build(), coinValue(), cosign(), d(), down8(), eqAddr(), eqTok() (+8 more)

### Community 6 - "mdsw.js"
Cohesion: 0.25
Nodes (13): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+5 more)

### Community 7 - "service.js"
Cohesion: 0.33
Nodes (15): addressList(), handleTake(), loadRelays(), lockCoins(), log(), logOnce(), notify(), nowS() (+7 more)

### Community 9 - "cosign_spike.py"
Cohesion: 0.41
Nodes (11): advance(), biggest_coin(), block(), coins_at(), main(), ok(), P0-a — two-signer Minima transaction via txnexport / txnimport, on a DISPOSABLE…, Solo chain mines on tx: self-send dust to force n blocks. (+3 more)

### Community 11 - "lib/identity.js"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 12 - "mds.js"
Cohesion: 0.27
Nodes (5): httpPostAsync(), httpPostAsyncPoll(), MDSPostMessage(), PollListener(), postMDSFail()

### Community 13 - "vendor/identity.js"
Cohesion: 0.31
Nodes (9): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+1 more)

### Community 14 - "dapp/mds.js"
Cohesion: 0.27
Nodes (5): httpPostAsync(), httpPostAsyncPoll(), MDSPostMessage(), PollListener(), postMDSFail()

### Community 15 - "run.js"
Cohesion: 0.18
Nodes (9): ctx, fails, FILES, fs, nodeCrypto, path, ROOT, sandbox (+1 more)

### Community 16 - "crypto/ax_sodium.js"
Cohesion: 0.27
Nodes (6): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen()

### Community 17 - "cosign2_spike.py"
Cohesion: 0.40
Nodes (9): coins_of(), fit44(), main(), ok(), P0-a2 — the two-NODE fill: taker (node B) spends a coin owned by the maker…, Exact (64-digit context); the node stored a 45-digit amount verbatim in the…, rpc(), script_for() (+1 more)

### Community 18 - "vendor/ax_sodium.js"
Cohesion: 0.27
Nodes (6): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen()

### Community 19 - "finalise"
Cohesion: 0.24
Nodes (10): ceil(), checkRoundingDigits(), finalise(), floor(), getLn10(), naturalExponential(), naturalLogarithm(), round() (+2 more)

### Community 20 - "H"
Cohesion: 0.32
Nodes (3): BaseHTTPRequestHandler, H, P0-b relay stub: the smallest server that behaves like SPEC §4 /dex/book long-…

### Community 21 - "parseOther"
Cohesion: 0.29
Nodes (8): clone(), convertBase(), getBase10Exponent(), intPow(), isDecimalInstance(), parseDecimal(), parseOther(), truncate()

### Community 22 - "package.json"
Cohesion: 0.29
Nodes (6): description, name, private, scripts, test, version

### Community 23 - "run_node.js"
Cohesion: 0.29
Nodes (5): ctx, fs, order, path, vm

### Community 25 - "digitsToString"
Cohesion: 0.38
Nodes (7): checkInt32(), digitsToString(), finiteToString(), getZeroString(), nonFiniteToString(), random(), toStringBinary()

### Community 29 - "flow.js"
Cohesion: 0.70
Nodes (4): each(), map(), once(), waterfall()

### Community 31 - "getPi"
Cohesion: 0.40
Nodes (5): atan(), atan2(), getPi(), isOdd(), toLessThanHalfPi()

### Community 33 - "prng.js"
Cohesion: 0.83
Nodes (3): init(), initBrowser(), initService()

### Community 34 - "cosine"
Cohesion: 0.67
Nodes (4): cosine(), sine(), taylorSeries(), tinyPow()

### Community 37 - "log"
Cohesion: 0.67
Nodes (3): log(), log10(), log2()

### Community 38 - "maxOrMin"
Cohesion: 0.67
Nodes (3): max(), maxOrMin(), min()

### Community 50 - "Dexicon — specification (v0, 2026-10-21)"
Cohesion: 0.20
Nodes (9): 1. Scope and non-goals, 2. Identity, 3. Order envelope (wire format), 4. Relay API (the `dexrelay` cape in `parlons-node.jar`, also in `maxima-server.jar`), 5. Fill protocol (fast layer), 6. MiniDapp, 7. Hard rules, Dexicon — specification (v0, 2026-10-21) (+1 more)

## Knowledge Gaps
- **42 isolated node(s):** `1. Scope and non-goals`, `2. Identity`, `3. Order envelope (wire format)`, `Discovery — no client ever carries a relay URL`, `5. Fill protocol (fast layer)` (+37 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `add()` connect `envelope.js` to `decimal.js`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `msg()` connect `envelope.js` to `app.js`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `confirmTake()` connect `app.js` to `envelope.js`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **What connects `1. Scope and non-goals`, `2. Identity`, `3. Order envelope (wire format)` to the rest of the system?**
  _42 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `decimal.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `headless.js` be split into smaller, more focused modules?**
  _Cohesion score 0.13852813852813853 - nodes in this community are weakly interconnected._