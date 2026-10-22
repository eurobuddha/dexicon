# Dexicon — task plan

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
- [x] **P1-4a Mount in `maxima-server.jar`** — `--dex-port <n> [--dex-bind <ip>]`, server 0.4.102 (commit 3263cb67 in maxima, branch `work/decks-relay-2026-10-21`; was 0.4.101 before the 2026-10-21 rebase onto GitHub main 57d08f57). Smoke: fat jar serves `/dex/health`.
- [x] **P1-4b Mount in `parlons-node.jar`** — `-Dparlons.dex.port=<n>` / `-Dparlons.dex.bind` in `ParlonsNodeMain`, `implementation project(':dexrelay')` in `node/build.gradle`, node 0.2.131 (commit c945df29 in maxima, branch `work/decks-relay-2026-10-21`, worktree `maxima/build/decks-relay`). Smoke: fresh data dir, `/dex/health` answered 2 s after boot. Unblocked after the owner's maxima agent reconciled the tree 2026-10-21. NOT PUSHED: the five commits sit on that branch awaiting the owner's merge/push.
- [x] **P1-5 Directory record** — `dex` key in the Maxima greeting `extraData` (captured by `RelayPeers`), `GET /dex/relays` on every cape (dexrelay 0.1.3, server 0.4.104, node 0.2.132, maxima commits 017d4ce3 a9106c2b 3c142828 cfa91ff7); MiniDapp RELAYS tab "DISCOVER FROM RELAYS" (0.0.10). Nothing hardcoded.
- [ ] **P1-6 Deploy to 3 fleet boxes** via `ops/deploy-parlons-node.sh`; `/dex/health` from outside. *(deploy = ask owner first)*

## Phase 2 — MiniDapp fast layer

- [x] P2-1 Scaffold Dexicon MiniDapp (dapp.conf, service.js, mds.js, build.sh, hook) from minimaxtDesk; identity module (context `decks`).
- [x] P2-2 Relay client: multi-home long-poll, union books by (signPk, orderId, seq), relay list + RELAYS screen.
- [x] P2-3 Maker: publish/edit/cancel envelopes; auto-republish on balance change; coin split helper.
- [x] P2-4 Taker fill: build two-party txn, sign, export, seal `take`, retry next level on `refused`.
- [x] P2-5 Maker service: inbox long-poll, import+verify+lock+co-sign+post, `txndelete` on failure, reply.
- [x] P2-6 Settlement tracker (settling → done), balances available/in-orders/settling.
- [x] P2-7 Resting layer — the PandaDEX engine vendored verbatim under `resting/` (scripts/vendor-pandadex.sh; test/vendor.sh fails on drift): V5 covenant book + PandaPools in the same ladder (levels tagged FAST / BOOK / POOL), on-chain limit orders, GTC renew, reprice, on-chain MAKER ladder, tape/stats/candles (0.0.10).
- [x] P2-9 Maker coin-age refresh: self-send backing coins older than COIN_MAX_AGE blocks (mainnet 500) so light-node takers can still prove them; skip when the taker side is MegaMMR. Found by the two-node run (B's 32-block test window lost the maker's coin).
- [x] P2-10 Two-node headless E2E green (test/headless.js): maker on A, taker on B, fill on chain. Blocked only on the P0-a2 spike finishing.
- [x] P2-8 Screens + CSV — PandaDEX page (ui/pd_app.js + ui/style.css tokens): TRADE / CHART / TRADES / ORDERS / ASSETS / MAKER / RELAYS; fast fills merged into MY TRADES, tape, candles and the EXPORT + RECONCILE zip (PandaExport column names unchanged; `source_kind` = FAST SETTLING/DONE/LOST) (0.0.10). Browser-visual check owed.

## Phase 3 — doors (AtomiX, ERC20 users only) — scope fixed by the owner 2026-10-21: MINIMA/MxUSD holders enter and exit through their node wallet; the door is for ERC20 USDT in / USDT out only
- [x] P3-1 Embed atomix-mds taker engine; ENTER (USDT→MxUSD) with live quote — 0.0.12 (doors/ vendored verbatim by scripts/vendor-atomix.sh, drift-checked incl. the shared lib/ files and the RPC endpoint list), 0.0.13 (service.js → AXService: AtomiX taker settlement on every block, lib/door.js forward queue), 0.0.14 (DOORS tab: ENTER pane, node-derived ETH deposit address in full + tap-to-copy, live sweep quote + ceiling, gas disclosure, DOOR SWAPS progress with both legs' full tx ids from swapdb — survives reload), 0.0.15 (test-chain token override).
  *Verified* on the private rig (node B 19405, headless Chrome, zero console errors): boot in both hosts (page + service log the SAME derived ETH address and swap key), live ETH/USDT/gas reads over the public RPC list, book scan of a seeded fake AtomiX maker, quote/ceiling/per-part maker keys, two-part sweep, fund checks failing closed, review refused with the reason. 27 unit tests on lib/door.js; Rhino gate concatenates every doors module.
  *NOT verified* (no Ethereum test chain on this Mac, mainnet forbidden): the USDT lock (approve + newContract), the maker's MxUSD counter-lock, the automatic claim, refunds, a real end-to-end ENTER. The engine is byte-identical to atomix-mds 0.1.38, which has settled these live; Dexicon's glue around it has not.
- [x] P3-2 EXIT (MxUSD→USDT) + EthSend to named ETH address — 0.0.14: EXIT pane (amount, destination Ethereum address, quote, withdraw + forward gas disclosed), forward record `door_fwd_<hash>` queued per part, carried out by the service once the swap is COMPLETE (AX.wallet.sendUsdt), RETRY on failure. *Verified:* quote, address validation, gas/fund validation, review path (rig). *NOT verified:* the MxUSD lock, the maker's USDT counter-lock, the withdraw, the forward transfer (ETH side).
- [x] P3-3 SWAP lane to a named Mx address (requires node) — 0.0.14: SWAP pane, both directions; MxUSD to this node or forwarded by one `send` (claimed amount − 0.0001 notify) to the named Minima address; USDT to the named Ethereum address. *Verified:* quote both ways, partial-fill copy, Mx/0x address validation, the forward queue + the exact `send` command and token id (unit tests), review path (rig). *NOT verified:* a completed swap driving a real forward on the rig (needs the ETH leg).

## Phase 4 — fleet + desktop relays
- [~] P4-1 All 7 boxes; minimaDesk ships the cape on behind reachability proof. *(deploy/release = ask owner)* — 2026-10-22: owner said eurobuddha.com + sally + megammr → DONE on those three (0.2.132; eurobuddha.com over TLS at https://eurobuddha.com/dex-relay, sally http://95.179.179.181:9602, megammr blocked by the Vultr cloud firewall until TCP 9602 is opened in the console). Remaining: the other boxes, TLS fronts for sally/megammr, minimaDesk. Originally READY: jars parlons-node 0.2.132 / maxima-server 0.4.104 carry the cape + discovery; `ops/deploy-parlons-node.sh --dex 9602 [--dex-public URL]` prepared; step-by-step in `docs/RELAY-ROLLOUT.md`. Not run (2026-10-21).

## Phase 5 — APK pair · Phase 6 — swarm transport
- [x] P5-1 APK scaffold — `apks/dexicon` 0.1.0 (`com.eurobuddha.dexicon`, eurobuddha/minima-core-android-dexicon PRIVATE), Java + classic Views from apks/pandadex, minimaapi broadcast IPC; identity/envelope (byte-exact signature vector test), relay client, fill plan + taker build + maker co-sign (same command sequence as fill.js, txndelete on every path), MakerService foreground co-signer, TRADE/ORDERS/HISTORY(CSV)/ASSETS/RELAYS. 12 JVM tests + assembleDebug green (2026-10-21).
- [x] P5-2 APK on-device gate — DONE end to end 2026-10-21 (Android emulator API 36 + minimaCore Classic 2.0.39 joined to the PRIVATE test chain via `minima_extra_params` = `-test -testchainlength 1024 -connect 10.0.2.2:19301 -port 11009`; the adb phones were NOT touched): APK 0.1.6 paired (Apps → Enabled + Admin), identity from `vault action:seed`, balances/block/getaddress over IPC; funded from node A (20 MINIMA, 10 TestMxUSD); then a real fill THROUGH THE APK against the MiniDapp maker on node A — coins fetched, plan 2 @ 0.5, txn built + signed over IPC, sealed take published, maker co-signed and posted (txpow 0xA161321C7ED1098397DE7FD497FE6A586041DC55A9764D711B8E5995500967AE), HISTORY shows BUY 2 · TAKER · DONE with the four output coins, ASSETS 20→22 MINIMA / 10→9 MxUSD. Fixes found on device: cleartext relays (0.1.2), Android org.json re-serialisation (0.1.4), screen re-registers until enabled (0.1.5), stale 'waiting for the maker' line (0.1.6). Rig gotchas: node A refuses a second IBD to the same peer address within 30 min (change the emulator node's `-port`); a maker coin older than the light node's window must be relocked (set the maker's `coin_max_age` kv low to force it).
- [x] P5-3 APK parity: a partly filled crossing order rests its remainder as a fast order (0.1.7); a refused take retries at the next level (0.1.1); coin-spread pick (0.1.1). Left as designed: the service is the only inbox poller; the APK CSV's `mxusd_*` columns have no dexHistory parser yet (nothing ships them).
- [ ] P6 Swarm transport (keets topic carrying the same envelopes) — later, as planned.
- [x] P3-4 BOTH AtomiX markets in the doors (owner 2026-10-22) — 0.0.19: ENTER/EXIT/SWAP quote USDT⇄MxUSD and USDT⇄MINIMA side by side (amount out, avg price, ceiling, live makers), user picks the route; market selected via AX.trading.setActive (lib/door.js withMarket/selectMarket/scanBoth/planRoute/quoteBoth), doors/*.js untouched; door swaps merged into ACTIVITY. *Verified:* unit tests (route switch, both-sentinel scan, both quotes on synthetic books), Rhino gate, vendor drift. *NOT verified:* any on-chain leg, any ETH transaction, the page on a live node.
