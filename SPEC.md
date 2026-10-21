# Decks — specification (v0, 2026-10-21)

Working title "Decks". Plan of record: `~/.claude/plans/i-want-to-plan-groovy-donut.md` (approved 2026-10-21).
This file is the build spec the task plan in `tasks/plan.md` executes against.

## 1. Scope and non-goals

- One venue, one pair: **MINIMA ⇄ MxUSD** (`0x00` ⇄ `0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90`).
  The Minima dollar token is always called **MxUSD**.
- Non-custodial: the user's node wallet is the account. No deposit ledger, no operator balances.
- Fast layer: Ed25519-signed off-chain orders over interchangeable relays; a fill is one atomic
  two-party Minima transaction (taker signs, maker's node co-signs). Final after one block.
- Resting layer: the existing PandaDEX covenant book + PandaPools depth, read-only reuse of
  `mds/pandadex-mds` planners; shown in the same ladder, tagged.
- Doors: AtomiX HTLC taker engine for **ERC20 users only** (USDT in, USDT out). MINIMA/MxUSD holders
  enter and exit by plain send. Pure USDT↔MxUSD swap lane requires a node; no custodial lane.
- Non-goals (v0): margin, fees, other pairs, mobile APK (phase 5), swarm transport (phase 6).

## 2. Identity

- Each node derives a **Decks identity** from its seed exactly as AtomiX does
  (`atomix-mds/lib/identity.js` `fromSeed(seed, context)`), context string `"decks"`:
  `boxPk`/`boxSk` (X25519 sealed boxes) and `signPk`/`signSk` (Ed25519). `publicId = 0x<boxPk><signPk>`.
- **Never** sign with the node `sign` command: it spends a one-time Winternitz leaf per call.
- The identity is bound to a pay-to Minima address by appearing together in every envelope (§3) and by
  the taker checking that every advertised maker coin is owned by that address at fill time.

## 3. Order envelope (wire format)

JSON, canonicalised as **sorted keys, no whitespace, strings for all amounts**, UTF-8 bytes signed.

```
{
  "v": 1,
  "t": "order",
  "market": "MINIMA/MxUSD",
  "side": "buy" | "sell",             // side of MINIMA
  "price": "<decimal string, MxUSD per MINIMA, ≤ 8 dp>",
  "amount": "<decimal string MINIMA, ≤ 8 dp>",  // "0" = cancel
  "coins": ["0x<coinid>", ...],      // maker's spendable coins backing this order (sell: MINIMA, buy: MxUSD)
  "address": "0x<maker pay-to address, 0x hex>",
  "orderId": "0x<8 random bytes>",
  "seq": <integer, strictly increasing per orderId>,
  "expiry": <unix seconds>,          // relay drops after this; client treats as cancelled
  "signPk": "0x<32 bytes>",
  "sig": "0x<64 bytes>"              // ed25519_detached(canonical JSON without "sig")
}
```

Rules: a relay and a client keep only the highest `seq` per `(signPk, orderId)`; lower or equal `seq`
is dropped silently; `amount:"0"` is a cancel; `expiry` ≤ now + 24 h; payload ≤ 16 KB; `coins` ≤ 32.
Edit = new `seq` with new price/amount/coins. A maker republishes with a new `seq` whenever its backing
coins change.

Trade traffic uses `"t":"msg"`: `{v, t:"msg", to:"0x<publicId>", from:"0x<publicId>", blob:"<hex>",
expiry, sig}` where `blob` is AtomiX `identity.seal(me, to, plaintext)` (sealed box carrying an inner
signature) and the outer `sig` is over the canonical envelope. Inner plaintext kinds:
`take {orderId, txn:"<txnexport hex>", takerAddress}`, `taken {orderId, txpowid}`,
`refused {orderId, reason}`.

## 4. Relay API (the `dexrelay` cape in `parlons-node.jar`, also in `maxima-server.jar`)

Pure Java 11 module `maxima/dexrelay`, mounted on the node's existing JDK `HttpServer`
(`NodeGateway` pattern), public bind, CORS `*`, own rate buckets, no auth (messages self-authenticate).

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/dex/publish` | body = one envelope; verify size, `expiry`, canonical form, Ed25519 `sig`; keep highest `seq`; 200 `{ok:true, seq}` or 4xx `{ok:false, error}` |
| `GET` | `/dex/book?market=&since=<cursor>` | long-poll ≤ 25 s; returns `{cursor, orders:[envelopes changed since cursor]}`; `since=0` = full snapshot of live orders |
| `POST` | `/dex/msg` | body = `t:"msg"` envelope; verify outer sig; store ≤ 10 min TTL |
| `GET` | `/dex/inbox?pk=<publicId>&since=<cursor>` | long-poll ≤ 25 s; messages addressed `to` that publicId |
| `GET` | `/dex/health` | `{ok, version, orders, uptime}` |

Memory only; no persistence; sweep expired every 30 s. Ed25519 verification via JCA
`KeyFactory.getInstance("Ed25519")` + `X509EncodedKeySpec(DER prefix 302a300506032b6570032100 ‖ pk)` so the
module compiles at `--release 11` and runs on the JDK ≥ 15 every fleet box and desktop bundle ships.
Discovery: relay announces a `dex-relay` capability record in the existing relay directory mesh; clients
resolve N relays at start, union books by `(signPk, orderId, seq)`.

## 5. Fill protocol (fast layer)

1. Taker picks a level, selects maker coins from the envelope (fresh `coins` lookup: all owned by
   `address`, unspent, confirmed), builds: `txncreate id:T`, `txninput` maker coins + own funding,
   `txnoutput` maker payment (to `address`, price×amount in the right token) / taker proceeds / both
   changes, `txnsign id:T publickey:<taker key(s)>`, `txnexport id:T` → hex.
2. Taker seals `take{orderId, txn, takerAddress}` to the maker's publicId and `POST /dex/msg` to every
   relay it uses.
3. Maker `service.js` long-polls `/dex/inbox`; on `take`: `txnimport data:<hex> id:M`, `txnview`/
   `txnbasics` check: inputs owned by me ⊆ advertised coins and ≤ order remaining; output to my
   `address` ≥ price×amount in the right token; no other output or state touches me; per-coin lock
   (3-min TTL). Then `txnsign id:M publickey:<my key>`, `txncheck`, `txnpost`; on ANY failure
   `txndelete id:M`. Reply `taken{txpowid}` or `refused{reason}` sealed to the taker.
4. Maker republishes the order with remaining amount and remaining coins (new `seq`).
5. Both sides show the fill as *settling* until the txpowid is in a block, then *done*.
6. Makers split funding into several coins so concurrent takers land on different coins.

## 6. MiniDapp

Screens: ENTER, TRADE, ORDERS/HISTORY, EXIT, SWAP, RELAYS (as in the plan). Scaffold from
`mds/minimaxtDesk` (relay client, peerBooks union, take flow) and `mds/pandadex-mds` (`txn.js`,
`funding.js`, `signlock.js`, `safety.js`, `decimal.js`, ladder/tape/candles). `service.js` runs the maker
side and the settlement tracker; `MDS.net.GET/POST` only (no WebSocket in the backend).
Identifiers are never truncated anywhere. CSV export column names are stable (dexHistory parses them).

## 7. Hard rules

Version bump per code change (`dapp.conf`); `txndelete` on every error path; never run minimaDesk; spikes
and tests run on a disposable `-solo` node or the MDS dev node `15001`; MxUSD naming; APK pair later.
