# Dexicon

A decentralised DEX for **MINIMA ⇄ MxUSD** that runs as a MiniDapp inside your own Minima node.

- **Your node is the account.** Nothing is deposited anywhere. Balances are your node wallet, split into available / in orders / settling.
- **Fast book.** Orders are Ed25519-signed envelopes published to interchangeable relays (a cape inside `parlons-node.jar`). Place, edit and cancel are instant; a fill is one atomic two-party Minima transaction co-signed by taker and maker and final after one block.
- **Resting book.** The PandaDEX covenant book and PandaPools depth appear in the same ladder for makers who want orders to survive their node going offline.
- **Doors for ERC20 users.** USDT in / USDT out via the AtomiX HTLC taker engine. MINIMA and MxUSD holders enter and exit directly.

## DOORS — USDT in, USDT out (ERC20 users only)

The DOORS tab is the AtomiX **taker** engine (`mds/atomix-mds` 0.1.38) vendored verbatim under `doors/`
(`scripts/vendor-atomix.sh`; `npm test` fails on drift, on drift of the files both apps share in `lib/`, and on any
copy of the Ethereum RPC endpoint list outside `doors/ethrpc.js` + `doors/ethhtlc.js`). Dexicon only ever TAKES an
AtomiX maker's quote; it never makes a market there. Anyone already holding MINIMA or MxUSD needs no door — the
receive address on ASSETS is the way in and a plain send is the way out.

| Pane | Flow | Delivery |
|---|---|---|
| **ENTER** | USDT → MxUSD **or** USDT → MINIMA: your USDT locks on Ethereum first (HTLC vault), the maker locks the coin, this node claims it | the coin into this node's wallet |
| **EXIT** | MxUSD → USDT **or** MINIMA → USDT: your coin locks on Minima, the maker locks USDT, this node withdraws it | one ERC20 transfer to the Ethereum address you name (its gas is shown in the quote) |
| **SWAP** | either direction, either market | the coin to this node's wallet or forwarded by one `send` to any Minima address; USDT to any Ethereum address |

**Both AtomiX markets, side by side.** AtomiX runs two books — the MxUSD market (sentinel `USDTSWAP`) and the MINIMA
market (`MINIMASWAP`). Every pane scans both and shows both quotes as two cards: what you receive, average price, the
ceiling (sweepable depth within 2 % slippage on a buy) and the number of live makers; tap a card to pick the route.
ENTER compares the same USDT in; EXIT/SWAP-out quote the typed amount in each route's own coin (with your balance of
it). The market is selected through the engine's own `AX.trading.setActive` (`lib/door.js` `withMarket`/`selectMarket`)
— `doors/*.js` is untouched. Settlement is market-agnostic (each swap carries its own label), so one service settles both.

- The **ETH deposit address** is derived from this node's seed exactly as AtomiX does (`seedrandom modifier:ethbridge`),
  never stored, and shown in full with tap-to-copy. Fund it with USDT (ERC20) and a little ETH for gas to ENTER; an EXIT
  also pays ETH gas from it (the withdraw, plus the forward).
- Every door swap and its forward survive a reload: swaps live in AtomiX's `swapdb` tables, forwards in `ax_kv`
  (`door_fwd_<hash>`). `service.js` (`doors/ax_service.js`, namespaced `AXService`) settles — claims, withdraws, refunds,
  forwards — on every block, page open or not. DOOR SWAPS lists each swap with the swap hash, ETH contract id, maker key,
  every ETH and Minima transaction id and the forward tx, all in full, each line tap-to-copy.
- Timelocks are AtomiX's: 2 h on the Ethereum leg, 144 blocks on the Minima leg; an unmatched leg refunds itself.
- A forwarded MxUSD / MINIMA amount is the claimed amount less the 0.0001 notify output (same coin) every AtomiX claim pays.
- Door swaps also appear on ACTIVITY, merged by time, with their stage (STARTED = your lock sent → LOCKED = maker locked
  → CLAIMING → DONE / FORWARDING, or REFUNDED / ERROR) and every transaction id in full.

Design and phases: `SPEC.md`. Task list: `tasks/plan.md`. Approved plan of record (2026-10-21):
`~/.claude/plans/i-want-to-plan-groovy-donut.md`.

> Development software. Real funds, real chain. Every code change bumps `dapp.conf` version (pre-commit hook: `sh .githooks/install.sh`).

## Trading rules

- **MEXC is the only price.** The maker's peg and auto-cross read MEXC's MINIMA/USDT book (depth, then bookTicker:
  `resting/price.js`). Only when neither call can be reached does the feed read MEXC's own ticker as CoinGecko
  rebroadcasts it (`lib/ladder.js` `feed`, `exchange_ids=mxc`; mirror of the APK's `MexcFeed`): the `mxc` USDT row only,
  refused when CoinGecko flags it stale or anomalous, aged from CoinGecko's fetch time, through the same spread and jump
  rules, and shown as "MEXC via CoinGecko mid (MEXC direct unreachable)". Never another exchange; no price is no price.
- **An order never fills against your own order.** FAST takes skip your own orders (`ui/app.js` `crossing`; `lib/fill.js`
  refuses one as the last line). On-chain, `lib/ownskip.js` takes your own orders out of the book before the vendored
  planners run (`PandaComposite.plan`, `PandaBook.plan`), so a limit or market-style order routes past them to the next
  best third-party order or pool inside its limit; totals and the average price count only what fills. Pools are
  liquidity like any other, your own pool included. With nothing but your own orders inside the limit, nothing is sent
  and the page says "Only your own orders are at this price". While the node's keys are unread, no book is planned.
- **A maker never signs a coin of unknown age.** Backing coins must be fresh (created within `COIN_MAX_AGE`, 900
  blocks since 0.0.101, 500 before; the BACKING COIN MAX AGE setting can only lower it, 1 to 900, and a larger saved
  value is read as 900) so a light-node taker can see them. The smallest taker window measured in this family is ~1024
  blocks (a `-isclient -mobile` node held 1098 blocks of chain; upstream classic Minima holds 2048), so a take on a coin
  at the limit still has ~124 blocks to be built, co-signed and mined.
- **A coin the maker's node can prove backs an order at any age: the coin proof hand-over** (0.0.111–0.0.113, owner
  22 Nov 2026: keeping coins young by self-sends is "the opposite of fast"). A light-node taker cannot see a coin older
  than its window, but the maker's node can prove any of its own unspent coins (`coinexport coinid:`) and the taker's
  node verifies the proof against its own chain (`coinimport data: track:false`), after which the unchanged take works.
  The proof cannot travel inside the order (every relay, every earlier Dexicon and the Android verifier refuse an
  order whose keys are not exactly the spec set), so a taker whose node does not see a backing coin asks the order's
  maker for it in a sealed `proofs?` message; the maker's service answers with `coinexport` of the asked coins that back
  its live orders (`lib/proofs.js`, SPEC §3). Anyone can ask, so the maker's work is bounded (0.0.120): one inbox poll
  seals at most 2 messages / 120K chars (≤14000 chars of proof data a message) in at most 3 s, after its takes; the
  rest waits in a queue for the next polls; a coin goes to one taker at most once per 10 heights (a repeat at the same
  height gets the message already sealed). A taker sends ONE request per maker per height covering all of that
  maker's missing coins (0.0.121; at most 32 coins, 8 makers a height); an order that does not fit this height's
  requests is "checking…" and re-checked at the next height (it used to be hidden for 10), and proofs over the import
  cap are imported at the next height instead of being asked for again: a book of 30 old-coin orders from 5 makers is
  fully judged within 2 heights (`test/proofbook.test.js`; it took 40+ on 0.0.120). The taker imports only proofs it asked that maker for, whose bytes name the
  asked coin at one of the order's script addresses (at most 16 a block); its node refuses a stale or forged proof
  ("Invalid MMR Proof"); the order is shown only once the unchanged rules pass on the node's own row of the coin.
  A coin the taker sees only through an imported proof is takeable only in the orders of the maker whose proof it
  imported (0.0.123): another identity listing that coin is hidden ("its backing coin … was proved to this node by
  another maker") and never displaces the real order. This does not cover a coin young enough to be seen without a
  proof, nor a copycat that answers with a proof first — the coin-key attestation below does.
  **No phantom balance** (0.0.118): `coinimport` of a coin the node already holds in its tree marks it RELEVANT whatever
  `track:false` says (coinimport.java's "already have it" branch), so the maker's coin would show in the taker's balance.
  A coin is imported only when `coins coinid:` answered without it (a lookup error imports nothing; asked again later)
  and the created block read from the proof's own bytes is more than 4 blocks under the node's tree root (`status`
  chain.block − chain.length, once a height): a coin inside the window is never imported. One that comes back relevant
  anyway (two pages importing at the same moment) is untracked again (`cointrack enable:false`). A node whose chain
  tree is shorter than the depth makers prove at ("TreeNode at Blocktime not found (proof too old)") can never import:
  it says so once, asks nothing for 10 heights, doubling to 640, and the hidden orders give that reason (0.0.125). So
  `lib/maker.js` treats a stale coin its node can export as usable (`proofedOf`): placed on it, an order is live at
  once with nothing relocked, and refresh never relocks it for its age. A coin whose export fails keeps the rule
  below (relocked, coinless meanwhile), and the failure is logged. A successful export counts for 10 heights (100
  before 0.0.126) and is forgotten at once when an export for a taker fails, so the order falls back to the relock
  rule at the next refresh (≤ 1 minute).
  **kv `legacy_fresh`** — **default ON since 0.0.122** (review 23 Nov, M5). Android Dexicon has neither the proof
  hand-over nor the takeable filter, so with it off an Android taker SHOWS an order on a coin older than its window and
  every take of it fails ("Maker coin … not found") — against the owner's rule that an untradable order is never shown.
  - **ON** (unset, empty, `1`, `on`, anything not listed below): the 0.0.110 rule — every backing coin is kept under
    `COIN_MAX_AGE` by relocks; an order placed on old coins is published coinless and goes live after the relock's
    block. The maker still answers proof requests and updated takers still import, so a coin that slips past the age
    limit (a missed relock, a long-idle maker) is still takeable by them instead of hidden.
  - **OFF** (`0`, `false`, `off`, `no`, any case): a coin this node can prove backs an order at any age, live at once
    with nothing relocked. Older takers (MiniDapp before 0.0.112, every Android build so far, any host vendoring an
    older engine) cannot take such an order.
  - **Who flips it when:** each MAKER flips it OFF (`kv legacy_fresh = 0`) once the takers it trades with run the
    proof hand-over — i.e. after an Android Dexicon release with the taker half (`proofs?`/`proofs`, coin import, the
    takeable filter) is out and adopted; until then leave it unset. Takers have nothing to flip.
- **The maker proves it controls its backing coins: the coin-key attestation** (0.0.128–0.0.129, owner 23 Nov 2026:
  "make the maker prove he owns the coins"). An order lists coins and the scripts of their addresses
  (`RETURN SIGNEDBY(pk)`: the pk is public), so any identity could list another maker's coins. The key of each backing
  address signs `SHA3-256("dexicon-backing-v1" ‖ maker signPk ‖ address)` once (`sign publickey:<pk> data:…`, kept
  in kv `attest_<signPk>_<address>`, never signed again); a taker asks for it with the proof request (`proofs?
  attest:[addresses]`, also for young coins it already sees), and checks it on its own node with `verify` (READ),
  rebuilding the statement from the ORDER's own signPk. An attestation is public once sent and useless to anyone else:
  it names one identity, so an order by another identity on that address fails `verify`, and a copycat cannot sign an
  order as the real identity. In the book: an address attested for another identity (and not this one), or a
  signature the node refused, hides the order ("its maker has not proved it controls this coin"); an attested order
  is marked so internally. Verified pairs are kept in kv `attested` across reloads.
  **Key-use cost:** one signature per backing address per identity, ever — a maker's coins sit at its wallet's
  default addresses (64 keys, 32 under `-blockaskeyuses`), so at most 64 key uses in an identity's lifetime (each a
  legacy key of 262,144 uses; under block-as-key-uses each advances the one global counter by at most one past the
  tip). At most 4 fresh signs per inbox poll; the attestations ride in the same per-poll caps.
  **kv `require_attest`** (taker side, default OFF): OFF — an order with no attestation yet is shown as before (old
  makers cannot attest); ON (`1`, `true`, `on`, `yes`) — it is hidden too. **Flip it ON** once the makers you trade
  with run 0.0.128+ (and Android makers have the maker half); a copycat on an attested address is hidden either way.
- **Old coins never refuse an order, and placing one never waits** (0.0.102, owner 22 Nov 2026). When fresh coins do
  not cover a new order or edit, `lib/maker.js` `placement` picks the free coins of any age that do, starts the relock
  of the stale ones among them at once (one self-send of exactly those; since 0.0.110 a fresh one is held for the order
  in `relocking`, never self-sent), saves the order live and publishes it with no coins; the caller is told
  "placed; goes live to takers after the next block (refreshing your coins)". The service re-backs it on the block that
  confirms the relock (`service.js` `rebackOnBlock`: only an order coinless because a relock of its coins is pending, and
  never while another refresh runs, since 0.0.109). Only a balance that cannot cover it is refused, saying what is held
  and what is needed. A relock failure is kept on the order (`relockError`), shown and logged; the order stays coinless
  (never re-signed on a stale coin) and the relock is retried after a backoff.
- **A relock is bounded** (0.0.106, `lib/maker.js` `relock`): at most 20 inputs from at most 5 distinct signing
  addresses (the node's own `consolidate` limits: a TxPoW over 64 KB is refused only after signing); an order needing
  more is relocked over successive passes. After any failure its coins back off (kv `relock_backoff`): 2 blocks,
  doubling to 64, so a failing set is signed at most ~32 times a day, and a failure after `txnsign` is never signed again
  inside its window by any caller (placement, refresh, the voids). A post that returns no txpowid is "possibly posted":
  no error, and its coins are looked at again once the window has passed.
- **No lost order updates between the page and the service** (0.0.107): both load kv `myorders`, wait on relays and save.
  `lib/maker.js` `save` re-reads the stored list and merges per order: an order created meanwhile survives, one the
  saver did not change keeps the stored copy, and when both changed one, a user action (create, cancel, edit) beats a
  background pass (refresh, fill bookkeeping, the ladder batch, the relay sync), the winner's seq is raised above the
  loser's and it is published again. Refresh never re-signs an order whose stored status or seq moved since it loaded.
  **The save itself is atomic between the page and the service** (0.0.132): its read and write of kv `myorders` run
  under a lease lock row (table `dx_lock`; one UPDATE taking it when free or stale, read back; a unique token per save;
  a holder that died frees it after 15 s). Before, a write landing between another writer's read and write was lost —
  a page cancel could put back an order the service had just marked filled (and refresh re-sold it). A save that cannot
  get the lock within ~8 s fails loudly and writes nothing.
  **A fill always wins over an edit** (0.0.119): a filled or cancelled order never comes back to life by any merge; an
  edit whose order part-filled meanwhile is refused ("part of this order filled while you were editing (N MINIMA left)")
  and the stored copy stands; a fill saved after an edit is applied to the edit capped by what the fill left
  (min(the edit's size, the size the take was verified against − filled)), so the maker never sells more than the order
  had left. A field another writer changed (relocking, relockError) is never silently overwritten by a save that left
  it alone.
- **A relock keeps the coin sizes** (one output per input, since 0.0.103), so two orders whose coins are refreshed in one
  transaction get two coins back. There is no background self-send of free coins: the keep-fresh pass of 0.0.103 was
  removed in 0.0.104 (it relocked the whole free balance about every 8 hours). A refresh never re-backs an order on a
  coin its own relock just sent.
- **One "held" rule for every coin chooser** (0.0.105): order placement and edits, refresh (its re-backing and its
  relocks), the ladder batch and the ladder split never pick a coin backing or relocking for another live order, in a
  take of mine awaiting its maker or being voided (kv `pending_takes` / `void_takes`), or reserved by the resting engine
  (`PandaCoinLock`, `PoolInputClaims`) — `lib/maker.js` `holds`. On the page (which loads neither resting file) the
  same two are read from what the service keeps (0.0.124): kv `coinlock_held` (service.js mirrors every
  `PandaCoinLock` reserve/claim/finish/release) and the durable `pp_posted_inputs` table. Before 0.0.124 the page's
  create and edit silently ignored them.
- **An unread chain tip is never "fresh".** When the node's `block` read fails (it is retried once), freshness is unknown, not
  "fresh" (`lib/maker.js` `isFresh`): a new order or edit is refused (the typed values stay), and a refresh tick is
  skipped, every order left as signed (an envelope lives at most 60 minutes and its coins were fresh when signed).
  Before 0.0.95 that refresh re-signed every order with no coins, pulling the whole book. It used to read as age 0, which re-signed
  order 0x77da4748491f267c on coin 0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8, about 1826 blocks
  old, which no light node could take.
- **Only an order this node can take is shown as market** (owner 22 Nov 2026: "If an order is not tradable, it
  shouldn't be displayed anywhere as a real market"). A FAST order lists its backing coins by id; a light node sees a
  third-party coin only when it was created in its last ~1024 blocks and is unspent. `lib/takeable.js` `check` makes an
  order market only when EVERY coin it lists has been returned by this node's `coins coinid:<id> checkmempool:true`,
  unspent and not being spent; one coin spent or unseen hides the whole order, and an order not yet checked is not shown
  either. Your own orders always show and are never taken. Per side, best price first, the 'ok' orders filling the 10
  ladder levels plus the sweep's 12 more are shown; only 'ok' orders count, so an unknown or rejected order never takes
  a slot or pushes a shown one out, and orders past the point where those slots are full are neither shown, counted nor
  looked up. **Checking (0.0.99)**: at most 128 lookups (node commands) per block HEIGHT — more NEWBLOCK events or book
  changes for the same height never add budget. Each pass builds ONE queue: (0) the shown orders not yet confirmed at
  this height, oldest confirmation first (at most 96 lookups while anything else waits, then the rest after); (1)
  orders with no evidence against them — a lookup that errored or timed out, an 'ok' gone stale, a coin that was being
  spent in the mempool, an order shown before (also after its maker re-signs it) — oldest attempt first; (2) orders never
  checked, best price first; (3) rejected orders whose 10 heights have passed, oldest first. An order attempted at this
  height is not queued again; its coins are asked one at a time and it is left at its first failing condition (a junk
  order costs one lookup); a coin shared by orders is asked once per height. A coin of a shown/'ok' order that the
  mempool check does not return is asked once more without it: being spent → rejected for 2 heights only (an honest
  spend that never mines comes back quickly); gone → 10. A lookup error never hides a shown order; a shown order not
  re-confirmed for more than 3 heights goes back to "checking" (P1). A take uses only coin rows read at the current
  height (P3) and looks any other coin up again first. When the node catches up (NEWBLOCKs less than 10 s apart) the
  budget is not reset and verdicts are not aged until the tip has stood still for 10 s (the page's 10-second timer);
  rows are still dropped at every new height. Bounds, proven in `test/takeable.test.js`: the shown book is re-confirmed
  every height while it needs at most 96 lookups (a normal book of 20 orders a side with 2 coins each costs 80 a
  height and nothing more); an order with no evidence against it is asked within ceil(W / 32) heights, W = the older
  tier-1 work, however many new junk orders arrive (with 150 junk orders a height at better and worse prices, an honest
  order whose lookup failed once, or a shown order re-signed with new coins, is shown again at the next height).
  **On a MegaMMR node** (0.0.114; budget cut 0.0.127): `coins coinid: megammr:true` copies the node's whole unspent-coin
  table under the database read lock and scans it, per lookup. The plain lookup goes first (it finds every coin inside
  the tree), and only a coin it misses is asked of the MegaMMR, at most 16 times a height — at most 12 of them for the
  shown orders' re-checks while other orders wait; past that an order is "checking" and re-checked at the next height.
  16 because a shown book is ~44 orders a side, almost all on young coins: ~36 shown old-coin orders stay confirmed
  within 3 heights, and the lock is taken at most 16 times a block instead of up to 128.
  **What checking in the page cannot do**: the budget is fixed, so a flood of fresh junk orders beyond it delays the
  discovery of NEW honest orders that arrive during the flood (it never hides orders already shown, nor orders shown
  before). The real cure for spam is at the relay — **follow-up for the owner**: the relay should cap the live orders
  per maker identity (signPk), say 20, refusing a new order from a maker at the cap until one of its orders expires or
  is cancelled. That bounds what one identity can push into every client's queue, so a flood needs many identities.
  A node that rejects `checkmempool:` falls back to the plain lookup for the session and says so once in the activity log. The ladder,
  best bid/ask and weighted price, the preview, the button text, the percent buttons and the multi-order sweep all read
  the same filtered book. Under the book: "N FAST orders hidden: not takeable from this node (…)" / "checking N FAST
  orders…"; tap it for each hidden order (the first 50, then "and N more") with its whole order id, maker key and coin
  ids, and why.
- **"Market" means takeable AS DISPLAYED (0.0.98).** Seeing a coin unspent is not enough: a forged order could list
  anybody's visible coin. An order is market only when the rows this node returned show EVERY listed coin (a) unspent
  and out of the mempool, (b) of the token the maker gives (MINIMA for an ask, MxUSD for a bid) and (c) state-free —
  the same `AX.fill.makerCoinProblem` rule the take's `plan()` refuses on — (d) at the address of one of the order's own
  published `scripts` (computed in the page, no node call: `AX.takeable.scriptAddress`, the node's own one-leaf-MMR
  hash, pinned in the tests against the AtomiX HTLC addresses), and (e) together covering what it shows (an ask:
  `amount` MINIMA; a bid: `up8(amount × price)` MxUSD; less → hidden as "backing coins cover only X of Y"). (f) A coin
  backs at most one shown order — the first by price, then time (the earlier expiry, i.e. signed earlier); later ones
  are hidden saying which order took it. Orders are keyed by maker + orderId, so another maker reusing an orderId is a
  different order. What the page cannot prove before the take: that the maker holds the KEY of those scripts (the order
  envelope is signed by the maker's relay identity, not by the coin key), so a copy of an honest order's coins and
  scripts at a better price passes (a)–(e); (f) then shows the copy and hides the original, and a take sent to the
  copy is never co-signed (its maker has no key): it counts as possibly filled and is voided after 5 minutes. In a sweep, a build or plan failure that is the ORDER's fault (a maker coin not found,
  a script the node lacks, coins that do not cover the take, an order listing your own coins or scripts) hides that
  order with the node's reason (`'no'` for 10 blocks unless it is re-signed), re-checks it and goes on to the next
  order; only your own faults end the run (your wallet does not cover, your guard has no key for your coins, one of
  your own input coins, create/sign/export).

## Desktop / host bridge

A native desktop screen shows the page's verdicts and never its own, and sweeps through the page's own run.
`window.DexiconFast` exposes (plain strings, whole ids, copies):

Read-only views (no node command, no storage, no repaint):

- `bookView(sell, tick?)` → the FAST ladder of one side as drawn, best price first, at most 10 levels:
  `[{price, exact, size, cumulative, own}]` (`tick` '' = exact; omitted = the page's current grouping).
- `crossingView(isBuy, limit, amount?)` → exactly what a click (or `take`) at `limit` walks, best price first, never
  your own: `[{orderId, side, price, amount, signPk, pubId, address, coins, take, skip}]` — `take` is the exact MINIMA
  the run takes from that order (the 1-MINIMA min-remainder floor applied, `'0'` when skipped), `skip` is `''` or why
  the run passes it (`'your earlier take of it is still settling'`, `'your earlier take of it is still being voided'`,
  `'a partial take would leave under 1 MINIMA'`). With `amount` the walk stops where the run stops: the amount covered
  or 12 orders (skipped ones count). It assumes every take is co-signed in full.
- `hiddenView()` → the line under the book and its list: `{no, unknown, summary, entries: [[lines]] (first 50), more}`.

Change signal (0.0.100):

- `rev()` → a number that increases whenever what the views return changes (the takeable book: every shown order's
  id, seq, price and amount; the hidden counts and line).
- `onChange(fn)` → calls `fn(rev)` on each such change; returns the current `rev`.
- `ready()` → `true` once the first lookup pass over the current book has completed. Before that, `bookView` holds
  only your own orders: a host shows "checking", not an empty market. Changing the relay list makes it `false` again.

The take (0.0.100):

- `take({ isBuy, limit, amount, takeOnly: true }, cb)` → the SAME run as the page's own button (`place()` reads the
  form, then both call one function), but it NEVER rests: `takeOnly` must be strictly `true`; any other value
  (`'true'`, `1`, `false`, missing) is refused. `cb({ ok, got, unanswered, tried, reason })`, exact decimal strings:
  `got` = MINIMA co-signed and sent; `unanswered` = MINIMA sent to makers who did not answer within 30 s (each may
  still be co-signed within its 5-minute void window); `tried` = the order ids walked; `reason` = why it ended.
  `ok: false` = refused before anything was sent (bad arguments, a run already going, no identity or relay) or ended
  by a fault of yours (your wallet does not cover, your side could not be built, no relay took the message); nothing
  crossing is `ok: true, got '0'` and nothing is sent. A host sizes its next step as `amount − got − unanswered`. The
  page's amount field is left alone.

On-chain, a client that swept FAST first sends the rest as `LIMIT` with `takeOnly: true` (resting/pd_service.js, from
pandadex-mds): it takes what crosses the limit up to the amount and never rests; nothing crossing answers ERROR
"Nothing on-chain crosses <limit>. Nothing was sent."; a partial cross says the untraded remainder. Since 0.4.33
`takeOnly` is strict: `true` = take-only, absent or `false` = a normal LIMIT, anything else is refused with ERROR
"takeOnly must be true or false (got <value>). Nothing was sent.". Since 0.4.34 a partial take on the resting book
never trades more than asked nor past the limit (the maker's rounding used to add a grain: selling 3.33333333 to a 0.3
bid delivered 3.33333334); the size shrinks by grains instead. The stage names the exact MINIMA traded and the
POSTED message the exact untraded remainder.

## Tests

```bash
npm test                       # node test/run.js (unit, Rhino-shaped sandbox) + test/rhino.sh (real Rhino 1.7.14 gate)
```

Headless end-to-end against a REAL node and relay, no browser (the maker side is the installed service.js):

```bash
# a disposable UPSTREAM node with MDS:  java -jar minima.jar -solo -data <dir> -port 19301 -rpc 19305 -rpcenable -mdsenable -mdspassword <pw> -allowallip
# a relay:  java -jar maxima-server.jar --port 19701 --data <dir> --blobstore 0 --dex-port 19702 --dex-bind 127.0.0.1
# install the zip with trust:write, then take the Dexicon sessionid from:  curl http://127.0.0.1:19305/mds
node test/headless.js --mds https://127.0.0.1:19303 --session 0x<sessionid> --relay http://127.0.0.1:19702 \
     --token 0x<dev dollar tokenid> --price 0.5 --amount 10 --take 3
```

The coin proof hand-over and the coin-key attestation on a THROWAWAY private `-test` chain (manual, never in `npm
test`; the setup is in the script's header; it refuses ports below 29000, a non-TEST node, p2p enabled, a peer not on
`--peer-ports`, differing or day-old genesis blocks). The relay stand-in enforces the Java relay's limits (262,144 chars
a message, 200 per inbox, 20,000 in all). With the taker requiring attestation: a maker order on a coin older than the
taker's window is placed live with no relock, asked for (proof + attestation in one request), verified, imported (never
relevant on the taker), taken, co-signed and MINED with exact balances; an 18-coin order's proofs arrive chunked over
several messages; a young coin's proof is never imported, neither when the visibility lookup fails nor when it lies;
a copycat identity listing the maker's coin with the maker's script and its relayed attestation is hidden while the
real order is shown; an order from a maker that does not attest is shown with `require_attest` off and hidden with it
on; a tampered MMR tail, a tampered coin body (amount), another coin's proof and a stale proof are each refused with
nothing built.

```bash
node scripts/e2e-coinproof-private-chain.cjs --genesis-rpc 29305 --maker-rpc 29315 --taker-rpc 29325 \
     --peer-ports 29301,29311,29321 --token 0x<the maker's stand-in dollar> --out <empty dir>
```

## Relays in production

The relay is a cape inside `parlons-node.jar` (0.2.132+) and `maxima-server.jar` (0.4.104+); turning it on is one flag and it announces itself in the Maxima mesh so clients discover it from any other relay (`GET /dex/relays`). The fleet rollout, Caddy fronting, verification and rollback steps are in `docs/RELAY-ROLLOUT.md`. The Android pair lives in `apks/dexicon`.
