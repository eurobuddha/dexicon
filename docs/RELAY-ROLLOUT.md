# Dexicon relay rollout — Phase 4 runbook (owner-gated; nothing here has been run)

The DEX relay is a cape inside the binaries the fleet already runs. Turning it on is a flag, not a
new service. Everything below is reversible by removing the flag and restarting the unit.

## What ships where

| binary | version with the cape | flag | boxes |
|---|---|---|---|
| `parlons-node.jar` | 0.2.132 (maxima main `cfa91ff7`) | `-Dparlons.dex.port=<port>` (+ `-Dparlons.dex.bind`, `-Dparlons.dex.public`) | sally, eurobuddha.com, megammr, vigilance, the Pi |
| `maxima-server.jar` | 0.4.104 | `--dex-port <port>` (+ `--dex-bind`, `--dex-public`) | maxlite, openproject |

Standard DEX port: **9602** (free on every box as far as the inventory shows; 9501 is the relay,
9585 the gateway). Confirm per box with `ss -ltnp | grep 9602` before enabling.

## Discovery (why no relay is hardcoded)

A box with the cape on announces `dex` = its public DEX URL in its Maxima greeting; every mesh peer
records it (`RelayPeers`, 2 h TTL, self-nomination rule: claimed host must equal the source IP).
`GET /dex/relays` on any one cape returns every cape the mesh knows. The MiniDapp's RELAYS tab
"DISCOVER FROM RELAYS" asks each configured relay and offers the new ones. So a user only ever needs
ONE working URL to find the rest, and that one can be their own minimaDesk node.

## Rollout order (3 boxes first, as the plan says)

1. **Build once:** `cd ~/Projects/minima/maxima && ./gradlew :node:fatJar :server:fatJar` →
   `node/build/libs/parlons-node-0.2.132.jar`, `server/build/libs/maxima-server-0.4.104.jar`.
2. **eurobuddha.com (Hetzner, behind Caddy)** — TLS front, cape on loopback:
   `ops/deploy-parlons-node.sh hetzner --jar node/build/libs/parlons-node-0.2.132.jar --dex 9602 --dex-public https://eurobuddha.com/dex-relay`
   then add a Caddy route `handle_path /dex-relay/* { reverse_proxy 127.0.0.1:9602 }` and reload Caddy.
3. **megammr (Vultr London)** — plain port: `ops/deploy-parlons-node.sh root@minimammr.com --jar … --dex 9602`
4. **openproject (maxima-server box)** — `ops/deploy-relay.sh` is the existing path for the two
   RAM-bound boxes; add `--dex-port 9602` to the unit's ExecStart (the script does not take a dex flag
   yet — do it by hand once, then fold into the script).
5. **Verify from outside, each box:** `curl -s https://eurobuddha.com/dex-relay/dex/health`,
   `curl -s http://192.248.151.55:9602/dex/relays` → the `relays` list must show all three within ~2 h
   (mesh TTL) — in practice within minutes of the next greeting exchange.
6. **Point the MiniDapp at one of them**, DISCOVER, confirm the other two appear, run a real fast fill
   between two of your own nodes on mainnet with dust (1 MINIMA).
7. **Remaining four boxes** the same way (sally and maxlite are `-Xmx96m`: the cape is memory-only and
   bounded — 512 holds, 20k inbox messages — but watch RSS for a day before enabling there).

## minimaDesk

`desktop/minimaDesk` pins the Parlons Node jar it bundles. Bumping it to 0.2.132 and adding
`-Dparlons.dex.port=9602` to its launch args makes every desktop user a relay; the existing
reachability machinery (NAT-PMP/UPnP + outside proof) decides whether the greeting advertises it.
That is a minimaDesk release (signed + notarized, three platforms) — a separate, owner-approved step.

## Rollback

Remove the flag from the unit (`/etc/systemd/system/parlons-node.service` or the relay unit),
`systemctl daemon-reload && systemctl restart parlons-node`. The cape holds nothing persistent, so
nothing is lost; the mesh forgets the record after 2 h.
