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
| **ENTER** | USDT → MxUSD: your USDT locks on Ethereum first (HTLC vault), the maker locks MxUSD, this node claims it | MxUSD into this node's wallet |
| **EXIT** | MxUSD → USDT: your MxUSD locks on Minima, the maker locks USDT, this node withdraws it | one ERC20 transfer to the Ethereum address you name (its gas is shown in the quote) |
| **SWAP** | either direction | MxUSD to this node's wallet or forwarded by one `send` to any Minima address; USDT to any Ethereum address |

- The **ETH deposit address** is derived from this node's seed exactly as AtomiX does (`seedrandom modifier:ethbridge`),
  never stored, and shown in full with tap-to-copy. Fund it with USDT (ERC20) and a little ETH for gas to ENTER; an EXIT
  also pays ETH gas from it (the withdraw, plus the forward).
- Every door swap and its forward survive a reload: swaps live in AtomiX's `swapdb` tables, forwards in `ax_kv`
  (`door_fwd_<hash>`). `service.js` (`doors/ax_service.js`, namespaced `AXService`) settles — claims, withdraws, refunds,
  forwards — on every block, page open or not. DOOR SWAPS lists each swap with the swap hash, ETH contract id, maker key,
  every ETH and Minima transaction id and the forward tx, all in full, each line tap-to-copy.
- Timelocks are AtomiX's: 2 h on the Ethereum leg, 144 blocks on the Minima leg; an unmatched leg refunds itself.
- A forwarded MxUSD amount is the claimed amount less the 0.0001 MxUSD notify output every AtomiX claim pays.

Design and phases: `SPEC.md`. Task list: `tasks/plan.md`. Approved plan of record (2026-10-21):
`~/.claude/plans/i-want-to-plan-groovy-donut.md`.

> Development software. Real funds, real chain. Every code change bumps `dapp.conf` version (pre-commit hook: `sh .githooks/install.sh`).

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
