# Decks — task plan

Executed by `/build auto`. One task = one commit. Status: `[ ]` pending, `[x]` done, `[!]` blocked.

## Phase 0 — spikes (go/no-go gates)

- [x] **P0-a Two-signer transaction via txnexport/txnimport.** `spikes/cosign_spike.py` against a
  disposable `-solo` node: wallet key A funds input 1, key B funds input 2, outputs to both; sign A →
  export → import under a new id → sign B → `txncheck` → `txnpost`; confirm on-chain. Negative: import
  then alter an output → `txncheck` fails or post rejected.
  *Accept:* script prints the txpowid and the coin created; negative case rejected; RESULTS note in `spikes/RESULTS.md`.
- [x] **P0-b MDS backend long-poll.** `spikes/longpoll/` — a 30-line Python relay stub holding `GET /dex/book`
  up to 20 s, and a throwaway MiniDapp whose `service.js` loops `MDS.net.GET` against it, logging latency.
  Installed on dev node 15001 (MDS 15003) with `mds action:install`.
  *Accept:* node log shows ≥ 10 consecutive polls completing at ~20 s with no timeout error; measured
  wake latency after a publish ≤ 1 s; note in RESULTS.
- [x] **P0-c Envelope sign in JS, verify in Java 11-compatible code.** `spikes/ed25519/`: JS canonicalises
  and signs a sample envelope with the AtomiX sodium stack (vendor `nacl.js`, `sha512.js`,
  `ax_sodium.js`, `identity.js`); Java `Verify.java` compiled `--release 11`, run on JDK 26, verifies
  via `X509EncodedKeySpec` DER prefix. Also run the JS under Rhino 1.7.14 (the node's engine).
  *Accept:* Java prints `VALID` for the JS vector and `INVALID` for a flipped byte; Rhino run matches Node byte-for-byte.

## Phase 1 — protocol + relay cape (maxima repo)

- [x] **P1-1 `SPEC.md` finalised** from P0 results (envelope canonical form frozen, test vectors committed under `spec/vectors/`).
- [x] **P1-2 `maxima/dexrelay` module skeleton** (`--release 11`, zero deps): `Envelope` parse+canonicalise, `Ed25519Verify`, `OrderStore` (highest-seq, expiry sweep). Unit tests: canonical form, seq semantics, forged/replayed/oversized rejects.
- [x] **P1-3 HTTP handlers** on JDK `HttpServer`: publish/book/msg/inbox/health, long-poll with wakeup, CORS, rate buckets. Tests: long-poll wakes within 100 ms of a publish; cursor semantics.
- [x] **P1-4a Mount in `maxima-server.jar`** — `--dex-port <n> [--dex-bind <ip>]`, server 0.4.101 (commit 96e042d8 in maxima). Smoke: fat jar serves `/dex/health`.
- [!] **P1-4b Mount in `parlons-node.jar`** — `-Dparlons.dex.port=<n>` / `-Dparlons.dex.bind` in `ParlonsNodeMain` + `implementation project(':dexrelay')` in `node/build.gradle`, bump `NODE_VERSION`/`version`. BLOCKED 2026-10-21: both files carry the owner's uncommitted changes (maxima tree: 453 dirty files); an autonomous commit must not absorb them. Owner: commit or stash, then re-run `/build auto`.
- [ ] **P1-5 Directory record** `dex-relay` capability publish/resolve via the existing mesh; client resolve helper.
- [ ] **P1-6 Deploy to 3 fleet boxes** via `ops/deploy-parlons-node.sh`; `/dex/health` from outside. *(deploy = ask owner first)*

## Phase 2 — MiniDapp fast layer

- [x] P2-1 Scaffold Decks MiniDapp (dapp.conf, service.js, mds.js, build.sh, hook) from minimaxtDesk; identity module (context `decks`).
- [x] P2-2 Relay client: multi-home long-poll, union books by (signPk, orderId, seq), relay list + RELAYS screen.
- [x] P2-3 Maker: publish/edit/cancel envelopes; auto-republish on balance change; coin split helper.
- [x] P2-4 Taker fill: build two-party txn, sign, export, seal `take`, retry next level on `refused`.
- [x] P2-5 Maker service: inbox long-poll, import+verify+lock+co-sign+post, `txndelete` on failure, reply.
- [x] P2-6 Settlement tracker (settling → done), balances available/in-orders/settling.
- [ ] P2-7 Resting layer: PandaDEX book + pools in the same ladder (reuse pandadex-mds planners).
- [x] P2-9 Maker coin-age refresh: self-send backing coins older than COIN_MAX_AGE blocks (mainnet 500) so light-node takers can still prove them; skip when the taker side is MegaMMR. Found by the two-node run (B's 32-block test window lost the maker's coin).
- [ ] P2-10 Two-node headless E2E green (test/headless.js): maker on A, taker on B, fill on chain. Blocked only on the P0-a2 spike finishing.
- [ ] P2-8 TRADE/ORDERS/HISTORY screens; CSV export with stable columns.

## Phase 3 — doors (AtomiX, ERC20 users only)
- [ ] P3-1 Embed atomix-mds taker engine; ENTER (USDT→MxUSD) with live quote.
- [ ] P3-2 EXIT (MxUSD→USDT) + EthSend to named ETH address.
- [ ] P3-3 SWAP lane to a named Mx address (requires node).

## Phase 4 — fleet + desktop relays
- [ ] P4-1 All 7 boxes; minimaDesk ships `--dex-relay` on behind reachability proof. *(deploy/release = ask owner)*

## Phase 5 — APK pair · Phase 6 — swarm transport
- [ ] Planned later; see plan of record.
