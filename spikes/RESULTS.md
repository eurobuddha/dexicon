# Phase 0 spike results (2026-10-21)

## P0-a — two-signer transaction via txnexport / txnimport — PASS
Disposable `-solo` node (minima.jar 1.1.2-TEST.4, ports 19101/19105). Two wallet keys A and B fund two inputs;
three outputs (A change 35, B change 25, payee C 30).
- A: `txncreate` → `txninput`×2 → `txnoutput`×3 → `txnsign publickey:A` → `txnexport` (4640 bytes hex).
- B: `txnimport data:` → **`txnbasics`** (the export carries inputs/outputs/signatures but NOT the MMR proofs or
  input scripts; the importing node attaches them — same as the Parlons gateway's `txnimport→txnbasics→txnpost`
  path; signatures cover the txn, not the witness, so A's stays valid) → `txnsign publickey:B` → `txncheck`
  (`basic`, `mmrproofs`, `scripts` all true, both signatures valid) → `txnpost`.
- Posted `0xC2375100B514C8A3667423CE36CB7D718889FCE4C9021B6D15A5F7EF5B16FDB1`; payee coin
  `0xCA3832B9C565E84A0E12A78D08AC64EFEF4F95EDA8C3908968474016042D7507` confirmed at block 33.
- Negative: import the same hex, add one output, sign B → `txncheck` reports A's signature **invalid**,
  `basic/mmrproofs/scripts` false. (`txnpost` still returns status:true — it only queues; the maker MUST gate on
  `txncheck.valid` before posting, never on `txnpost`'s status.)
- Lessons for the engine: fund both parties' coins in one txn on solo; wait for `sendable` not block count;
  always `txndelete` stale ids before `txncreate`.

## P0-c — envelope signed in JS, verified in Java 11-API code — PASS
- `sign_envelope.js` over the AtomiX stack (vendor nacl/blake/sha256/sha512, hex, ax_sodium, identity; context
  `decks`). Canonical form = sorted keys, no whitespace, `sig` excluded.
- Node v24.8.0 and Rhino 1.7.14 (`-version 200 -opt -1`, the node's service.js engine) produce **byte-identical**
  canonical, signPk and sig.
- `Verify.java` compiled `--release 11`, run on JDK 26: vector VALID, flipped signature byte INVALID, tampered
  message INVALID. Note: the JDK throws `SignatureException: Invalid point` on a malformed signature instead of
  returning false — the relay must catch and treat as invalid.
- Vector: signPk `0x782e728cb923b3ce148059e2d063fa37756130c78df1478c817b6713f1a6c850`, sig
  `0x3d1017b44fb5711919061660a64a22660cace0690b8040b501882a96ef3116fe36e640dd9c2b93ac5a1f1ee7809d2e2b4d12447a440e62348cc12f978ea06300`
  (full files: `ed25519/vector.json`, `ed25519/rhino_vector.json`).

## P0-b — MDS backend long-poll — PASS with two hard constraints
Findings that shape the engine (SPEC §4/§6 updated accordingly):
1. **`MDS.net.GET` in the Rhino backend is SYNCHRONOUS.** The callback runs inside the GET call on the same thread
   (`NETService.GET` → `zCallback.call`). Re-polling from the callback is unbounded recursion: v0.0.1 of the spike
   StackOverflow'ed the node's MDS engine at install. Correct pattern: ONE bounded GET per `MDS_TIMER_10SECONDS`
   tick with the relay holding < 10 s (`hold=8`). Worst-case wake latency = hold gap + tick jitter (~2 s), fine for
   the maker inbox; the browser UI uses async fetch and can hold 25 s.
2. **Upstream nodes block private/loopback hosts for MDS net calls** unless started with `-allowallip`:
   `"Blocked host URL.. use -allowallip to enable this host"` (string present in the upstream 1.0.47.x jar, not in
   our fork). Relays MUST be on public hosts for the maker backend to reach them; a LAN/loopback relay only works
   on a node run with `-allowallip`. The fleet relays are public, minimaDesk relays are public once reachability
   is proven — consistent with the design.
3. **Our fork `core/minima-core/jar/minima.jar` ships NO MDS classes** (0 vs 65 in the upstream jar). MiniDapp
   spikes/tests must run on an upstream jar (`~/minima-installer/minima.jar` 1.0.47.16) — a disposable
   `-solo -mdsenable -allowallip` instance on 19301/19305/19303 was used.

Measurement (upstream jar, solo node, relay stub on 127.0.0.1:18555, hold 8 s):
| poll | wall ms | held ms | note |
|---|---|---|---|
| #1–#6 | 8007–8034 | 8000–8005 | one GET per 10 s tick, held the full 8 s, no timeout error |
| publish | 12:43:25.676 | — | landed in the ~2 s gap between #6 returning and #7 starting |
| #7 | 4 | 0 | next GET returned immediately with the new cursor (WAKE) |
| #8–#11 | 8006–8013 | 8001–8005 | steady state resumed |

11 consecutive cycles, zero errors. Wake latency: ≤ hold-gap (~2 s) when the publish lands between polls, ~0 when it
lands during a hold. Accepted for the maker inbox; the UI (async fetch) can hold 25 s.
Disposable node left running for Phase 2: `~/minima-installer/minima.jar -solo … -port 19301 -rpc 19305 -mdsenable
-mdspassword decks -allowallip` (data in the session scratchpad; recreate freely).

## P0-a2 — TWO-NODE fill (maker node A, taker node B) — PASS, then the real app end-to-end — PASS
`spikes/cosign2_spike.py` and `test/headless.js` (2026-10-21, private chain: A `-solo`, B `-test -testchainlength 1024 -connect A`):
- B could not `txninput` A's coin without its address script ("script missing for simple address") → orders publish
  `scripts`; B runs `newscript script:"RETURN SIGNEDBY(0x…)" trackall:false` first.
- `txninput … scriptmmr:true` on B put both scripts and both MMR proofs into the witness and `txnexport` carried them;
  A's `txnbasics` DUPLICATED the proofs ("non unique CoinIDs … uniquesize:2 txncoins:4") → the maker only imports,
  signs, checks, posts.
- Python's 28-digit `decimal` context rounded a 39-digit change to an integer ("Invalid Transaction Inputs and
  Outputs"); the node itself stored a 45-digit amount exactly. fill.js now computes at 64 digits.
- B only sees coins inside its chain window; IBD from the `-solo` node carried its 32-block tree, so a coin from
  block 132 was unprovable at block 217 → maker coin-age refresh (P2-9, kv `coin_max_age`).
- `txnpost`'s txpowid is the PRE-MINING id: `txpow onchain:` never found it while B already held the new coin
  (block 245). Settlement now tracks the fill's output coin ids.
- Final run on Dexicon (then "Decks") 0.0.8 + dexrelay 0.1.2: maker publishes from A → relay → taker on B plans, builds, signs, seals
  the take → A's service verifies, co-signs, posts, replies **3.3 s** after the take was sent → taker's 3 MINIMA coin
  `0xC64C0D0582AE7694A935109CAB012AB6162804560BC2BB5F8780BA45101B771D` on chain at block 289. HEADLESS E2E PASS.
