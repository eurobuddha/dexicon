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
- The identity and the pay-to `address` travel together in every order (§3). A taker does NOT require the
  advertised coins to sit at that address (wallets spread coins over many addresses); it requires them to exist,
  be unspent and cover the take. A forged order naming coins the publisher cannot sign is harmless: the fill
  needs the real owner's co-signature, so it is refused or times out and nothing moves.

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
  "pubId": "0x<64 bytes>",           // maker publicId = boxPk‖signPk; takers seal fills to it
  "signPk": "0x<32 bytes>",          // must equal the last 32 bytes of pubId
  "sig": "0x<64 bytes>"              // ed25519_detached(canonical JSON without "sig")
}
```

Rules: a relay and a client keep only the highest `seq` per `(signPk, orderId)` (key compared
case-insensitively); lower or equal `seq` is dropped (relay answers 409); `amount:"0"` is a cancel;
`now < expiry ≤ now + 24 h`; order ≤ 16 KB; `coins` ≤ 32; key set must be EXACTLY the fields above (no
extras); `price` > 0 and `amount` ≥ 0 match `^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$`; `market` matches
`^[A-Za-z0-9/_-]{1,32}$`; `seq` is a non-negative integer ≤ 2^53−1. Edit = new `seq` with new
price/amount/coins. A maker republishes with a new `seq` whenever its backing coins change.

**JSON subset (both sides, so canonical bytes match without a JSON library):** one top-level object;
strings are printable ASCII 0x20–0x7E with no `"` and no `\`; integers only (no floats/exponents,
within ±(2^53−1)); booleans; null; flat arrays of those; no nested objects; no duplicate keys.
Canonical = keys sorted by code unit, no whitespace, `sig` omitted. Reference vector:
`spec/vectors/order-v1-vector.json` (signed by the JS stack under Node and Rhino byte-identically,
verified by the Java relay).

Trade traffic uses `"t":"msg"`: `{v, t:"msg", to:"0x<publicId>", from:"0x<publicId>", blob:"<hex>",
expiry, sig}` where `blob` is AtomiX `identity.seal(me, to, plaintext)` (sealed box carrying an inner
signature), bare hex ≤ 256 KB, `now < expiry ≤ now + 10 min`, and the outer `sig` is verified with the
signPk half (last 32 bytes) of `from`. Inner plaintext kinds:
`take {orderId, txn:"<txnexport hex>", takerAddress}`, `taken {orderId, txpowid}`,
`refused {orderId, reason}`.

## 4. Relay API (the `dexrelay` cape in `parlons-node.jar`, also in `maxima-server.jar`)

Pure Java 11 module `maxima/dexrelay` (`DexRelay.VERSION`), its OWN JDK `HttpServer` on its own public port
(the node gateway binds loopback and shares a small executor; long-polls must not starve `/cmd`), CORS `*`,
token buckets (global 200/s, per-IP 20/s, burst 2 s), no auth (messages self-authenticate), ≤ 512
concurrent long-polls (503 `busy` beyond), memory only, sweep every 30 s. Node flag:
`-Dparlons.dex.port=<port>` (0/absent = off; bind `-Dparlons.dex.bind`, default 0.0.0.0); headless relay
flag: `--dex-port <port>`.

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/dex/publish` | body = one order envelope → 200 `{ok:true,seq,cursor}`; 400 `{ok:false,error}` (shape/sig, `error:"bad signature"` only after shape passes); 409 `stale seq`; 413 too large; 503 `relay full` |
| `GET` | `/dex/book?market=&since=<cursor>&hold=<1..25>` | long-poll up to `hold` s (default 25; MDS backends use ≤ 8) → `{cursor, reset, orders:[raw envelopes]}`. `since=0` or a cursor older than the retained log → `reset:true` + full live snapshot (cancels excluded); otherwise exact deltas (cancels included) |
| `POST` | `/dex/msg` | body = `t:"msg"` envelope → 200 `{ok:true}`; 400; 503 `inbox full` (200 per recipient, 20k total) |
| `GET` | `/dex/inbox?pk=<publicId>&since=<cursor>&hold=` | long-poll → `{cursor, messages:[raw envelopes]}` for `to == pk` |
| `GET` | `/dex/health` | `{ok, version, orders, cursor, uptime}` |

All responses carry `Access-Control-Allow-Origin: *`; `OPTIONS` → 200; wrong method → 405; unknown path → 404;
over the per-IP bucket → 429.

Ed25519 verification is **pure Java** (RFC 8032, BigInteger, extended coordinates, cofactorless check,
canonical `S < L`): two fleet boxes (eurobuddha.com, the Pi) run JDK 11, which has no EdDSA provider.
Cross-checked against JCA on JDK 21 in `Ed25519Test`.
Discovery: relay announces a `dex-relay` capability record in the existing relay directory mesh; clients
resolve N relays at start, union books by `(signPk, orderId, seq)`.

## 5. Fill protocol (fast layer)

1. Taker picks a level, re-fetches the maker's advertised coins (`coins coinid:` each — unspent, right token,
   enough to cover the take; largest first), builds: `txncreate id:T`, `txninput` maker coins + own funding,
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
