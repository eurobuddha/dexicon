# Host adoption — re-vendoring the Dexicon engine 0.0.157 → 0.0.197

For every HOST of this engine: the desktop apps (`main/dexicon/service.desktop.js`, their page bridge
`main/dexicon.js`, their command and SQL allow-lists), a market-making host (DexiconPro), and the Android app
(`apks/dexicon`, a Java mirror — list at the end). The MiniDapp itself (`service.js`, `ui/`) already does
everything below; it is the reference.

Copying `lib/*.js` is NOT enough. Between 0.0.157 and 0.0.197 the engine moved settlement, recovery, voids and
signing out of "the host does it somehow" and into the library, and it changed what it asks of the node and of the
store. A host that copies the files and keeps its old glue will: sign nothing (no SHA3), refuse honest takes
(allow-lists), book fills twice (its own settle), or hold sizes off orders for good (no posting records).

Each item says **what changed**, **what the host must do**, and the version that introduced it. 0.0.198 and 0.0.199
change tests only (the engine is the one of 0.0.197).

Proven on a real private chain, not only against stand-ins: the maker → taker coin proof hand-over and the taker → maker
one (`scripts/e2e-coinproof-private-chain.cjs`, the second with `--only taker-handover`: a light maker whose window
does not hold the taker's coin, the coin imported from the take's own proof and never relevant to the maker, a coin the
maker can see never imported, the take mined, the fill seen and then done 64 blocks later by the real `settleFills`).

---

## 1. Hard prerequisites — without these the engine signs nothing or refuses everything

### 1.1 SHA3 must be loaded in the engine's context (0.0.179)

`AX.fill.outputCoinId(first, k)` computes every output coin id of a take
(`SHA3-256(MiniData(first input coin id) ‖ MiniNumber(k))`) and `cosign` refuses to sign when it cannot:

```
refused: the output coin ids of this take cannot be computed (outputCoinId: SHA3 is not loaded (doors/sha3.js)) — nothing was signed
```

It reads `globalThis.AXSHA3.sha3_256(byteArray) → hex string` (what `doors/sha3.js` provides).

- A host WITHOUT it co-signs nothing at all.
- Electron: `require('crypto').createHash('sha3-256')` THROWS in the packaged desktop apps although tests pass
  (BoringSSL has no SHA-3). Use the host's own `main/sha3.js` and expose it as `AXSHA3 = { sha3_256: … }` in the
  engine's context, or load `doors/sha3.js` there.
- Self-check at host boot, against a real node's ids (private chain, 23 Nov 2026):

```
outputCoinId('0x6EFEB2DBE01CAB3EB62FB57CAA993599440FFE82BCD027F07D439380B9D8355C', 0)
  === '0x59DFFF1D0AA4488DB3E95DA2E4053B88897AAEC6FBB6D1463600A5C92191307D'
outputCoinId('0x6EFEB2DBE01CAB3EB62FB57CAA993599440FFE82BCD027F07D439380B9D8355C', 1)
  === '0x433196F8848C6361C4E921B97B679AD53B7D929F623156E0B2ECFEFCD970BF29'
```

Refuse to start the maker side when it fails.

### 1.2 Node commands the engine now sends — the host's command allow-list must pass them

| command | who sends it | since |
|---|---|---|
| `keys` — **with no parameters only** | `AX.fill.ownScripts` (page: `build`; service: `cosign`, `walletCoins`) | 0.0.159 |
| `coins relevant:true coinid:<id>` and `… checkmempool:true coinid:<id>` | `coinState`, `settleFills`, `voidCheck`, `reconcilePostings`, ACTIVITY | 0.0.161 / 0.0.180 |
| `coins coinid:<id> megammr:true` and `… checkmempool:true megammr:true` | `cosign` on a MegaMMR node | 0.0.184 |
| `status` | `cosign` (megammr, tree root), `takerProofs`, `freeDeadLease` | 0.0.183 / 0.0.184 / 0.0.194 |
| `coinexport coinid:<id>` | `takerProofs` (the taker's own coins) | 0.0.183 |
| `coinimport data:<hex> track:false` | `AX.proofs.importUnseen` from `cosign` (maker side too now) | 0.0.183 |
| `txpow relevant:true max:100` | `settleFills` (`minedBy`) | 0.0.179 |
| `txpow onchain:<txpowid>` | `settleFills` (`minedBy`) | 0.0.179 |
| `txpow block:<number>` | `settleFills` (`minedBy`) | 0.0.197 |

`keys`: pass the bare verb and NOTHING else from a page. Never `keys action:genkey`, `keys action:new`, or any
other `action:` — those create keys and move the wallet's key state. The service's `keys action:list`
(`resting/pd_service.js`, `doors/htlc.js`) is the service's, not the page's.

A failed `keys` read is tolerated (the `scripts` rows rule alone decides); a failed `status` read is tolerated
(0.0.190: asked once a take, the take goes on without `megammr:true`).

### 1.3 Page SQL allow-list

**Lock ids.** `AX.maker.withLock(mds, id, …)` is used with FIVE ids. The four `dx_lock` statement shapes are
unchanged, but a bridge that allows only `(myorders|coinimport)` must allow:

```
myorders | coinimport | signing | pending_takes | void_takes
```

- `signing` (0.0.163): EVERY signing command of the page (`send`, `txnsign`, `sign`, `consolidate`,
  `tokencreate`, `multisig` — `AX.signgate.signs`) takes it first. A bridge that refuses it makes every page
  signature fail with `refused, nothing was signed: the signing store lock could not be used (…)`.
- `pending_takes`, `void_takes` (0.0.168): two open pages merge their takes and voids under these.

**Statement shapes** (every SQL statement the engine issues; `<…>` is engine-made, never user text):

```
CREATE TABLE IF NOT EXISTS `dx_lock` (`id` varchar(32) NOT NULL PRIMARY KEY, `owner` varchar(80), `ts` bigint)
INSERT INTO `dx_lock` (`id`,`owner`,`ts`) SELECT '<id>','',0 WHERE NOT EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='<id>')
UPDATE `dx_lock` SET `owner`='<token>', `ts`=<ms> WHERE `id`='<id>' AND (`owner`='' OR `owner` IS NULL OR `owner`='<token or empty>')
UPDATE `dx_lock` SET `owner`='' WHERE `id`='<id>' AND `owner`='<token>'
SELECT `owner` FROM `dx_lock` WHERE `id`='<id>'
INSERT INTO ax_kv (k, v) SELECT 'myorders', '[]' WHERE NOT EXISTS (SELECT 1 FROM ax_kv WHERE k='myorders')
UPDATE ax_kv SET v='<json>' WHERE k='myorders' AND EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='myorders' AND `owner`='<token>')
SELECT v FROM ax_kv WHERE k='myorders'
SELECT coinid FROM pp_posted_inputs                                                   -- page: holds()
```

Service only (never from a page):

```
SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'                                          -- settleFills
SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%' AND (v LIKE '%"orderId":"<id>"%' OR …)   -- reconcileFills (0.0.148), reconcilePostings (0.0.193)
SELECT k, v FROM ax_kv WHERE k LIKE 'posting_%'                                       -- reconcilePostings (0.0.162)
SELECT `owner`, `ts` FROM `dx_lock` WHERE `id`='signing'                              -- freeDeadLease (0.0.194)
UPDATE `dx_lock` SET `owner`='' WHERE `id`='signing' AND `owner`='<token>'            -- freeDeadLease (same shape as a release)
```

Lock tokens match `[A-Za-z0-9._-]{1,80}`. Since 0.0.194 they start `wS` for the engine with no page (the
service, a desktop main process) and `w` + lowercase for a page.

**Page writes the bridge must refuse** (the service is their only writer):

- `posting_*` (0.0.162 / 0.0.181) — a forged one grew an order from 100 to 150 in review. `reconcilePostings`
  validates them (`postingProblem`), but a page must not be able to write one at all.
- recommended: maker `fill_*` records. The page writes TAKER records (`role:"taker"`) only, and the refresh's
  `reconcileFills` deducts every maker record of a live order: refuse a page write of a `fill_` value with
  `"role":"maker"`.

---

## 2. Co-signing a take — `AX.fill.cosign`

```
cosign(mds, hex, keys, verifyFn, cb, prePost, opts)
  verifyFn(txn, wallet) → { ok, reason } | { ok:true, filled, received, paid, payAt }
  cb(err, txpowid, verdict, outCoins, pay)        err.maybePosted === true: see 2.4
  prePost(info, k(err))                           info = { mine, all, outs, verdict, pay, first }
  opts = { proofs, lock }
```

### 2.1 `verifyFn`'s wallet: pass ONLY cosign's `wallet` — drop `addressList()` (0.0.159)

`wallet` is the list of addresses of script rows the wallet HOLDS A KEY for (`AX.fill.ownRows`: `simple` true,
a real 64-hex `publickey`, and in the node's `keys` list when that could be read).

A host that passes `addressList().concat(wallet)` (the addresses of every relevant coin) breaks two makers for
each other for good: once maker M has taken an order of X, a coin of X is "relevant" on M's node, X's address
is "mine", and every later take by X of M's orders is refused (`input … is mine but was not advertised`).

```js
// wrong (pre-0.0.159 hosts)
AX.fill.verifyAsMaker(txn, order, o.coins, rem, addressList().concat(wallet));
// right
AX.fill.verifyAsMaker(txn, order, o.coins, rem, wallet);
```

### 2.2 `verifyAsMaker` refuses a take whose first input is not the order's (0.0.191)

A host that verifies with its own function instead of `AX.fill.verifyAsMaker` must add the same rule: the FIRST
input must be one of the order's advertised coins. Every honest client builds so (`lib/fill.js plan()` since
Decks 0.0.3, Android `FillPlan.java` since 0.1.0). `verdict.payAt` (0.0.179) is the index of the first output
paying the order address: cosign needs it to compute `pay`.

### 2.3 `prePost` — a durable posting record BEFORE `txnpost` (0.0.162)

Nothing is posted unless `prePost` calls `k(null)`. The host writes kv `posting_<orderId>` there:

```js
posting = { orderId, side, price, ins: info.mine, outs: info.outs,
            filled: info.verdict.filled, received: info.verdict.received, paid: info.verdict.paid,
            verified: <the remaining the take was checked against>, taker, ts: <unix s>,
            pay: info.pay, first: info.first,      // 0.0.179: the take's own payment coin, its first input
            txins: info.all,                       // 0.0.189: EVERY input coin id of the take, in order
            b: <tip block now> };                  // 0.0.180: the tip my coins were known at
```

After the post: set `posting.txpowid`, `posting.postBlock`, save it again, write the fill record with
`AX.maker.fillRecord(posting, txpowid, postBlock)` (never a hand-made object), call `afterFill` (section 3),
and delete the posting record ONLY when `afterFill` succeeded. While a posting record exists the order takes
no take: check `AX.maker.postingOf(mds, orderId, cb)` first and answer
`its last fill is still being applied — try again in a minute`.

### 2.4 An error FROM `txnpost` is ambiguous: keep the posting record (0.0.187)

`err.maybePosted === true` means the node may have taken the post before the reply failed. Do NOT delete the
posting record, do NOT tell the taker "refused" as a fact about the chain; `reconcilePostings` judges it by the
coins. **This replaces a host's own "post unanswered" path** (`fill_unanswered_*`, `unansweredId`, `status:
"unknown"`, `settleUnknown`): the host's transport must surface "the node did not answer txnpost" as the error
of the `txnpost` command, and the engine does the rest. Recommended: delete the host path. If it is kept for
one release, it must not also run for a take that has a posting record (the fill would be counted twice).

### 2.5 `opts.proofs`, `opts.lock` — the taker's coin proofs (0.0.183)

The take message now may carry `proofs` (section 5). Pass them through: `{ proofs: take.proofs }`. The maker
imports one (`coinimport … track:false`) ONLY while its node cannot see that coin, under the import lock —
default `AX.maker.withLock(mds, 'coinimport', …)`, shared with the page; `opts.lock(body(release), fail)`
replaces it. A coin the node CAN see is never imported (re-importing one makes it relevant: a phantom balance).

### 2.6 Signing

- only the order's keys whose input is in THIS take sign (0.0.160), never `publickey:auto`;
- every signing command holds the `signing` lease (0.0.163). A host with its own signing gate
  (`main/dexicon-signgate.js`) keeps it INSIDE: `AX.maker.leaseSigning(AX.mds)` runs as `lib/maker.js` loads and
  wraps `mds.cmdR`; a raw result-style command function (`PDService.cmd`) is wrapped with
  `PDService.cmd = AX.maker.leaseCmd(AX.mds, PDService.cmd)`.
- at engine boot, once the store is up: `AX.maker.freeDeadLease(AX.mds, function (line) { if (line) log(line); … })`
  (0.0.194). It frees a `signing` lease only when it is owned by an engine seat of another boot AND was taken
  before the node process started (`status` uptime). **Only call it where the engine runs on the node's own
  machine clock** (the node's Rhino service; a desktop main process on the same machine). Without it, a node
  killed mid-sign blocks all signing for 200 s after the restart.

---

## 3. After the post — `afterFill`, its 10th argument, and what "applied" means

```
afterFill(mds, relay, me, orderId, filled, spentCoinIds, cb, txpowid, verified, prov)
                                                              8th       9th      10th
```

- `txpowid` (8th) is REQUIRED (0.0.146): without a 64-hex id nothing is deducted and the callback gets an error.
- `verified` (9th, 0.0.139): the remaining the take was checked against.
- **`prov` (10th, 0.0.161 / 0.0.179): `{ b: <post block>, p: <pay.id> }` marks the fill PROVISIONAL.** The order
  keeps `prov: [{ t: txpowid, f: filled, c: [my spent coins], b, p }]` until `settleFills` settles it; its coins
  and its payment coin are held from every chooser (`holds`).

**Every call site must pass `prov`** — a call without it deducts the fill for good: `settleFills` then has no
entry to give back when the take never mines, and the payment coin is free to be spent before it was seen.

1. the call right after the post — `{ b: postBlock, p: posting.pay && posting.pay.id }`;
2. **the host's `FILL_PENDING` retries** (an `afterFill` whose save did not land, retried each tick): pass the
   same `prov` again — keep it on the pending entry;
3. **the unanswered path**, if the host still has one: the same, with the block of the attempt.

Better: drop `FILL_PENDING` for takes. The posting record already does its job across a restart — an order with
a posting record takes no take, and `reconcilePostings` (boot + every settle pass) applies or recovers it.

---

## 4. Settlement — replace the host's own settle with the engine's

### 4.1 Delete the host's `settleFills` / `settleUnknown`; call the engine's

```js
// boot, and every settle pass (the MiniDapp: every third 10 s tick), in this order:
AX.maker.reconcilePostings(AX.mds, RELAY, ME, function (lines) {
    (lines || []).forEach(log);
    AX.maker.settleFills(AX.mds, RELAY, ME, notify, function () { });
});
```

A host's old rule — "one of the fill's output coins exists → done; two hours without → lost" — is wrong both
ways: an output coin id is `hash(first input, n)` for EVERY transaction spending that input (the maker's own
relock "settles" a take that never mined), and a `lost` after two hours gives nothing back.

### 4.2 The settle design as of 0.0.197

Nothing is judged without a chain tip (`block` > 0) at or above the record's `postBlock`. A node with no tip
(resync, megammrsync, restore) answers `coins` with status true and `[]`: that is never "spent".

| verdict | evidence |
|---|---|
| **mined** | the take's OWN payment coin `pay` — `coins relevant:true coinid:<pay.id>` returns a coin with the same id, address, token and exact amount. The sighting is kept (`seen` = its block). Failing that: a relevant TxPoW whose first input is `first` and whose output `pay.k` is that payment, `txpow onchain:` found, AND `txpow block:<b>` is the block it named (0.0.197). |
| **done** | `CONFIRM_BLOCKS` = **64** blocks after `seen`. Until then the fill stays provisional (deducted, coins held); my input back unspent (a reorg) clears the sighting. |
| **lost — spent elsewhere** | the coin at `pay.id` is mine but is not the payment; or an on-chain relevant transaction spends `first` or my first coin `ins[0]` (any position, 0.0.191) and is not this take. The size goes back. |
| **lost — never mined** | my input `ins[0]` unspent and out of the mempool `GIVE_BACK_BLOCKS` = 16 after the post. The size goes back. |
| **no verdict** | anything else — in the mempool, younger, a failed read. Looked at again next pass. |

**One payment coin settles exactly one record (0.0.189).** A second take of the same size on the same coin has
the same payment id, address, token and amount. A lost record is re-applied only when no other maker record of
its order (settling or done) can have made that payment AND the mined transaction has exactly its `txins`. A
settling record with a rival is paid when the mined transaction has its inputs, lost when it has another take's.

**Giving back (0.0.161, 0.0.195).** A still-live order gets `remaining + filled`. An order the take CLOSED is
re-opened only when the owner placed it (`user: true`, set by `create` and `edit`), it was not cancelled, its
last live envelope has not expired (`liveUntil`) and more than dust comes back. A ladder rung (`batch`) is left
closed: the ladder may already have replaced it.

### 4.3 64 confirmations and a deep chain split — an OWNER DECISION

`done` after 64 blocks (~53 minutes) is past any ordinary reorg. It does **not** survive a split as deep as
13 November 2026 (this fleet followed the wrong branch for days, from block 2417237): a fill `done` on a branch
that is later abandoned stays `done`, its size stays deducted, and nothing re-opens it. No depth protects
against that; raising the number only delays every `done`.

What the owner has to decide, and what a host must NOT decide on its own: whether a host acts on `done`
irreversibly (a hedge closed, a ledger row final) at 64, at a larger depth of its own, or only after a human
looked. The engine's default is the safe side for the ORDER (the deduction stands, nothing is sold twice); it is
not a guarantee for anything a host does off-chain on `done`.

### 4.4 Records — fields a host may read, and must keep when it rewrites one

Posting record `posting_<orderId>`: `orderId, side, price, ins, outs, filled, received, paid, verified, taker,
ts, pay, first, txins, b` + after the post `txpowid, postBlock` (+ `recovered`).

Maker fill record `fill_<txpowid>` (`AX.maker.fillRecord`): `role:"maker", orderId, side, price, filled, received,
paid, txpowid, coins, taker, ts, status, verified, prov:true, ins, postBlock, pay, first, txins`; added by the
settler: `seen, block, why, lostAt, reapplied, scanAt, seenBlock`; added by the service: `recvMs, cosignMs`;
`recovered:true` on a recovered one.

- `pay` = `{ id, k, address, tokenid, amount }` — the first output paying the order address.
- `first` = the take's first input coin id. `ins` = MY input coin ids. `txins` = ALL input coin ids, in order.
- `status`: `settling` → `done` | `lost`; `lost` → `settling` again (with `reapplied:true`) → `done`.

A host that rewrites a record (to add its own fields) must write back the WHOLE object it read.

### 4.5 `recovered:true` records are keyed by an output coin id, not a txpowid

When a post was never recorded (a crash between the record and the answer, or `maybePosted`), `reconcilePostings`
recovers the fill under its **payment coin id**: key `fill_<pay.id>`, `txpowid: <pay.id>`, `recovered: true`. The
real txpowid is lost. A host must not look that id up as a TxPoW (`txpow txpowid:` finds nothing) nor show it
as a transaction id: it is a coin id (`coins coinid:` finds the payment). Since 0.0.193 a take already recorded
under its real txpowid is never recovered a second time.

---

## 5. The taker side

### 5.1 `build` — third callback argument (0.0.183)

```
AX.fill.build(mds, plan, function (err, hex, proofs) { … })
```

`proofs` = `{ <coinid>: <coinexport data> }` for the taker's inputs older than half its own tree (at most
`PROOF_AGE` 900 blocks). Send them: `{ k: 'take', orderId, txn: hex, taker, proofs }` (omit `proofs` when
empty). A host that drops the third argument makes every take paid with an old coin fail at a light maker
(`… is older than this maker's chain window …`).

Size (0.0.164 / 0.0.192): the take is refused BEFORE signing when transaction + `SIG_BYTES` (6000) a signing
key + proofs (their bytes + `PROOF_JSON_BYTES` 37 each + `PROOFS_JSON_BYTES` 6) exceed `MAX_TAKE_TXN_BYTES`
(32000). A host's maker inbox bounds a take the same way (`service.js cheapTake` / `cheapProofs`: hex only, at
most 20 proofs, each a 32-byte coin id → hex of at most `AX.proofs.MAX_PROOF_CHARS`).

### 5.2 Pending takes carry `block`; voids are judged by the engine (0.0.180, 0.0.185)

The pending record: `{ order, plan, rest, sent, act, outs, mine, block }` — `block` = the tip the take was
signed at. Then:

```js
voids[orderId] = AX.maker.voidOf(pt);            // { mine, act, block, pay }: pay = output 0, the maker's payment to me
if (windowRefusal) voids[orderId].all = true;    // 0.0.185: relock ALL my coins of that take in one go
AX.maker.voidCheck(mds, v, function (vd) {
    if (vd.settled !== undefined) done(vd.settled);          // positive evidence, or 16 blocks spent at known tips
    else if (vd.wait) { if (v.changed) save(v); }            // unknown, mempool, or no evidence yet
    else AX.maker.relock(mds, vd.relock, myAddress, function (e, txpowid, sentIds) {
        if (!e) { AX.maker.voidRelocked(v, vd.relock, sentIds); save(v); }
    });
});
```

A host with its own "my coin is gone → the void is settled" rule drops a void on a node with no tip and leaves
the maker the taker's signed half as a free option.

### 5.3 The sweep-stop reason text (0.0.185)

A refusal matching `/older than this maker's chain window/` STOPS the taker's sweep (the next order would be
paid with the same coins and refused the same way, a key use each) and voids with `all`. The run ends with:

```
maker refused: <reason> — counted as possibly filled until voided. Stopped: no other order was signed. Your coins in that take are being refreshed by one self-send (a key use); trade again after the next block.
```

A host that matches refusal texts (to retry, to classify) must know this one, and must not change the maker's
wording that it matches.

### 5.4 ACTIVITY rows (0.0.196)

A FAST taker row carries `mine` (my coins in the take) and `pay` (`{ id, k: 0, address, tokenid, amount }`,
output 0). "In block" = that payment coin with all four fields (`AX.maker.isPay`); "an input was spent" =
`AX.maker.coinState(mds, id, minBlock, cb)` says `spent`. A host tracker that looks at `outs[0]` alone, or
reads an empty `coins` answer as spent, shows trades that never happened.

`AX.maker.coinState(mds, id, minBlock, cb, any)` → `unknown | unspent | mempool | spent`; `any` true for a coin
that may not be mine (plain lookup, same tip rule). `lib/autocross.js` REVIEW/RELEASE uses it.

---

## 6. Orders — fields and behaviour a host UI meets

| field | meaning | since |
|---|---|---|
| `prov` | provisional fills `[{ t, f, c, b, p }]`; cleared by an edit | 0.0.161 |
| `fills`, `fillsFrom` | applied fill ids (compacted), the high-water mark | 0.0.133 / 0.0.147 |
| `relocking`, `relockError` | coins being refreshed; why the last relock failed | 0.0.102 |
| `backError` | why a live order is coinless although the wallet holds the coins — text starts `needs more than 8 coins: consolidate` — show it on the order card | 0.0.188 |
| `user` | placed or edited by the owner (not a ladder rung) | 0.0.195 |
| `liveUntil` | on a fill-closed order: when its last live envelope expires | 0.0.195 |

- `MAX_COINS` = 8 backing coins an order (0.0.164). **`GRANDFATHER_COINS` = 16** (0.0.188): an order placed
  before the limit keeps up to 16 of its own coins while they are all there, fresh and cover it; with more it is
  re-backed with at most 8 or carries `backError`.
- The save never brings a filled or cancelled order back to life — except the engine's own re-open (4.2). A
  host that writes `myorders` itself must go through `AX.maker.save` / the fenced write, never around it.

---

## 7. A market-making host — journal mapping

| engine event | journal |
|---|---|
| `afterFill` applied, record `settling` | **provisional fill** — may hedge, must be able to reverse |
| record → `lost` (`why` says which) | **reverse the hedge**; the size is back on the order (or the order is re-opened, 4.2) |
| record `lost` → `settling` with `reapplied:true` → `done` | **late fill**: book it as a NEW fill at its `block`, do not un-reverse silently |
| record → `done` | final at 64 blocks — subject to the owner decision in 4.3 |
| `recovered:true` | a fill with NO txpowid: its id is its payment coin id (4.5) |

`notify({ type: 'fill', txpowid, status })` fires for every record the settler changes. Never journal from the
`taken` reply or from the post alone.

---

## 8. Refusal texts added or changed since 0.0.157

Makers send them to takers (prefix `refused: ` stripped); takers show them. A host that matches or translates
texts needs all of them.

```
the first input of a take must be one of the order's own coins — update Dexicon                       0.0.191
the output coin ids of this take cannot be computed (<why>) — nothing was signed                      0.0.179
none of the order's keys signs an input of this take                                                  0.0.160
cannot check my coins in the take (<why>)                                                             0.0.161
my coin <coinid> in this take is already being spent                                                  0.0.161
cannot check the taker's inputs (<why>)                                                               0.0.161
a taker input is already being spent (mempool)                                                        0.0.161
your coin <coinid> is older than this maker's chain window, so it cannot be checked against the mempool and the take carries no proof of it — pay with a coin from the last ~1000 blocks (send it to yourself first), or update Dexicon (it hands its proofs over)   0.0.161 / 0.0.183
… and the proof the take carries is not a proof of that coin at its address                           0.0.183
… and my node refused its proof (<why>)                                                               0.0.183
… and its proof says it is inside my window (spent, or not here yet)                                  0.0.183
… and its proof could not be imported now — try again                                                 0.0.183
… and my node's import lock is busy — try again                                                       0.0.183
the fill could not be recorded before posting (<why>): nothing was posted                             0.0.162
its last fill is still being applied — try again in a minute                                          0.0.162
txnpost: <why> — it may have been posted                                (err.maybePosted, 2.4)        0.0.187
refused, nothing was signed: the signing store is held by another writer of this node (page or service): nothing was saved; try again   0.0.163
refused, nothing was signed: the signing store lock could not be used (<why>): nothing was saved; try again                            0.0.163
```

Taker side (never sent): `the order's <n> backing coins make this take too large to send (about <n> bytes
signed…; one take message carries at most 32000)` and `your <n> coins make this take too large to send —
consolidate your coins first (…)` (0.0.164; `, <n> of them the proofs of your older coins` since 0.0.183).

An order this node never had gets NO reply (0.0.165); refusals are bounded per poll.

---

## 9. Checklist for a re-vendor

1. SHA3 in the engine context; the two-id self-check passes (1.1).
2. Command allow-list: the table in 1.2; `keys` bare only.
3. Page SQL: five lock ids; refuse page writes of `posting_*` and of maker `fill_*` (1.3).
4. `verifyFn` passes cosign's `wallet` only (2.1).
5. `prePost` writes the posting record with `pay`, `first`, `txins`, `b`; `fillRecord` writes the fill (2.3).
6. `maybePosted` keeps the posting record; the host's unanswered path is gone or cannot double-count (2.4).
7. `{ proofs: take.proofs }` into cosign; the inbox bounds them (2.5, 5.1).
8. `afterFill` gets `prov` at EVERY call site (3).
9. The host's settle is deleted; `reconcilePostings` then `settleFills` at boot and each settle pass (4.1).
10. `freeDeadLease` at boot where the clocks allow it; `leaseCmd` around any raw signing path (2.6).
11. Taker: `build`'s third argument sent as `proofs`; pending takes carry `block`; voids through
    `voidOf` / `voidCheck` / `voidRelocked` (5).
12. UI: `backError` on the order card; ACTIVITY by `pay` / `coinState` (5.4, 6).
13. Journal by record status, `recovered` ids are coin ids (7, 4.5).
14. The owner's decision on what `done` at 64 blocks may trigger off-chain is recorded for this host (4.3).
15. Run the engine's own tests against the vendored copy (`npm test`), not only the host's.

---

## 10. Android mirror list (`apks/dexicon`, Java)

Android does not vendor these files; each rule is mirrored by hand. This is the ENGINE's side of the list — the
rules to check in `apks/dexicon` for parity with 0.0.197; it does not say which of them Android already has:

| engine rule | Android place | since |
|---|---|---|
| "mine" = a script row with a key the wallet holds, never every relevant address | `FillTxn` maker verify, wallet address source | 0.0.159 |
| sign only with the order keys of MY inputs in this take | `FillTxn` co-sign | 0.0.160 |
| provisional fills; my coins and the payment coin held until settled | `MakerEngine` / `MakerService` | 0.0.161 |
| durable posting record before `txnpost`; an order with one takes no take | `MakerService` | 0.0.162 |
| one signing lease across every signer of the node | the app's signer (one process: a mutex is enough) | 0.0.163 |
| a take sized before it is signed; 8 backing coins an order, 16 grandfathered | `FillTxn` build, `MakerEngine.allocate` | 0.0.164 / 0.0.188 |
| closes and cancels expire no earlier than any live envelope | `MakerEngine` | 0.0.166 |
| output coin ids computed (`hash(first input, n)`), never read from the taker's bytes; `pay` | `FillTxn` co-sign | 0.0.179 |
| settle by the take's OWN payment coin; 64 confirmations; spent elsewhere / never mined → size back | `MakerService` settle | 0.0.179 |
| no coin verdict without a chain tip ≥ the record's block | every `coins` verdict (settle, void, split, posting) | 0.0.180 |
| posting records validated before anything is applied | `MakerService` | 0.0.181 |
| the take carries proofs of the taker's old coins; the maker imports one only while it cannot see the coin | `FillTxn` build + co-sign (Android has NO proof hand-over yet: `legacy_fresh` stays on for it) | 0.0.183 |
| `megammr:true` lookups on a MegaMMR node | co-sign | 0.0.184 |
| a window refusal stops the sweep; the void relocks all the take's coins | taker sweep, `voidStaleTakes` | 0.0.185 |
| a lost fill removes its posting record; an ambiguous `txnpost` error keeps it | `MakerService` | 0.0.186 / 0.0.187 |
| one payment coin settles one record; `txins` on every record | settle | 0.0.189 |
| `status` asked once a take; a failed read never loops | co-sign | 0.0.190 |
| the first input of a take must be the order's own coin (verify) — the builder already does so | `FillTxn` maker verify | 0.0.191 |
| proof JSON wrapping counted in the take size | build (with the proof hand-over) | 0.0.192 |
| a recorded take is never recovered twice | posting reconcile | 0.0.193 |
| an owner-placed order closed by a phantom take is re-opened | settle give-back | 0.0.195 |
| ACTIVITY "in block" by the payment coin; "spent" only at a known tip | `ActivityTab` tracker | 0.0.196 |
| `txpow onchain:` checked against `txpow block:` | settle | 0.0.197 |

Not applicable to Android: the SQL lease fencing of `myorders` (one process), `freeDeadLease` (no second
context; the app's signer dies with its process), the page SQL allow-list.
