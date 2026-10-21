# Decks (working title)

A decentralised DEX for **MINIMA ⇄ MxUSD** that runs as a MiniDapp inside your own Minima node.

- **Your node is the account.** Nothing is deposited anywhere. Balances are your node wallet, split into available / in orders / settling.
- **Fast book.** Orders are Ed25519-signed envelopes published to interchangeable relays (a cape inside `parlons-node.jar`). Place, edit and cancel are instant; a fill is one atomic two-party Minima transaction co-signed by taker and maker and final after one block.
- **Resting book.** The PandaDEX covenant book and PandaPools depth appear in the same ladder for makers who want orders to survive their node going offline.
- **Doors for ERC20 users.** USDT in / USDT out via the AtomiX HTLC taker engine. MINIMA and MxUSD holders enter and exit directly.

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
# install the zip with trust:write, then take the Decks sessionid from:  curl http://127.0.0.1:19305/mds
node test/headless.js --mds https://127.0.0.1:19303 --session 0x<sessionid> --relay http://127.0.0.1:19702 \
     --token 0x<dev dollar tokenid> --price 0.5 --amount 10 --take 3
```
