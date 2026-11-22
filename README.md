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
- **A maker never signs a coin of unknown age.** Backing coins must be fresh (created within `COIN_MAX_AGE`, 500
  blocks) so a light-node taker can see them. When the node's `block` read fails, freshness is unknown, not "fresh"
  (`lib/maker.js` `isFresh`): a new order or edit is refused, a refresh re-signs the order with no coins (takers hide it)
  and relocks nothing, and the next refresh with a readable tip re-backs it. It used to read as age 0, which re-signed
  order 0x77da4748491f267c on coin 0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8, about 1826 blocks
  old, which no light node could take.
- **Only an order this node can take is shown as market** (owner 22 Nov 2026: "If an order is not tradable, it
  shouldn't be displayed anywhere as a real market"). A FAST order lists its backing coins by id; a light node sees a
  third-party coin only when it was created in its last ~1024 blocks and is unspent. `lib/takeable.js` `check` makes an
  order market only when EVERY coin it lists has been returned by this node's `coins coinid:<id> checkmempool:true`,
  unspent and not being spent; one coin spent or unseen hides the whole order, and an order not yet checked is not shown
  either. Your own orders always show and are never taken. Only the orders that can reach the screen or a take are
  looked up: per side, best price first, the orders filling the 10 ladder levels plus the sweep's 12 more (orders
  already known not takeable ride along uncounted); orders past that are not shown and not counted as "checking". At
  most 128 lookups a block, one command at a time: first the coins of the shown orders (oldest check first, so a coin
  spent since is hidden at the next block), then the rest from where the previous block stopped (not from the best
  price again). An order's coins are asked one at a time and the order is dropped at its first missing coin (a junk
  order costs one lookup); a missing coin is asked again only every 10 blocks, or at once when a take needs it. A shown
  order that could not be re-confirmed for 3 blocks goes back to "checking". A take uses only coin rows confirmed in the
  current block and looks any other coin up again first; a take whose build says one of the order's coins is not found
  re-checks that order and the sweep carries on with the next order, saying why in the trade log (whole coin id). A node
  that rejects `checkmempool:` falls back to the plain lookup for the session and says so once in the activity log. The ladder,
  best bid/ask and weighted price, the preview, the button text, the percent buttons and the multi-order sweep all read
  the same filtered book. Under the book: "N FAST orders hidden: not takeable from this node (…)" / "checking N FAST
  orders…"; tap it for each hidden order (the first 50, then "and N more") with its whole order id, maker key and coin
  ids, and why.

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

## Relays in production

The relay is a cape inside `parlons-node.jar` (0.2.132+) and `maxima-server.jar` (0.4.104+); turning it on is one flag and it announces itself in the Maxima mesh so clients discover it from any other relay (`GET /dex/relays`). The fleet rollout, Caddy fronting, verification and rollback steps are in `docs/RELAY-ROLLOUT.md`. The Android pair lives in `apks/dexicon`.
