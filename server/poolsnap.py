#!/usr/bin/env python3
"""
dexicon.org live pool snapshot - READ-ONLY.

The front page's live book reads signed FAST orders straight from the relays, but pools live on chain and a browser
cannot run a Minima node. This writes the reserves of every funded MINIMA/MxUSD PandaPools pool to a JSON file that
dexicon.org serves at /live/pools.json, so the book can show POOL depth next to FAST.

Discovery is the cloud anchor's own (reannouncer.py, imported, not copied): registry beacons at the sentinel, the
0.5 % covenant re-derived with runscript (parseok + address), reserves = the largest coin per leg at that address.
The registry scan is heavy, so the pool list is re-discovered every DISCOVER_SECS; reserves are re-read every run.

Never sends, never signs: only `block`, `coins` and `runscript`. Output is written atomically (tmp + rename).
Env: PP_RPC (default http://127.0.0.1:9005/), POOLSNAP_OUT, POOLSNAP_STATE, POOLSNAP_DISCOVER_SECS.
"""
import json, os, sys, time

sys.path.insert(0, "/root/pandapools-anchor")
import reannouncer as ra   # rpc, resp_list, smap, derive, reserves, block, SENTINEL (same node via PP_RPC)

MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90"   # the Minima dollar token

OUT = os.environ.get("POOLSNAP_OUT", "/var/www/dexicon-live/pools.json")
STATE = os.environ.get("POOLSNAP_STATE", "/var/lib/dexicon-live/pool-index.json")
DISCOVER_SECS = int(os.environ.get("POOLSNAP_DISCOVER_SECS", "900"))


def write_atomic(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def discover():
    """The anchor's discovery: newest beacon per pool key, MxUSD pools only, covenant must parse."""
    keyed = {}
    for c in ra.resp_list(ra.rpc("coins simplestate:true address:%s megammr:true" % ra.SENTINEL)):
        s = ra.smap(c)
        tok, oadr, opk, kmin = s.get("2"), s.get("3"), s.get("4"), s.get("5")
        if not (tok and oadr and opk and kmin) or tok.lower() != MXUSD.lower():
            continue
        created = int(c.get("created", "0") or 0)
        key = (opk + "|" + tok + "|" + kmin).lower()
        if key not in keyed or created > keyed[key]["created"]:
            keyed[key] = {"opk": opk, "oadr": oadr, "tok": tok, "kmin": kmin, "created": created}
    pools = []
    for p in keyed.values():
        parseok, addr = ra.derive(p["opk"], p["oadr"], p["tok"], p["kmin"])
        if parseok and addr:
            pools.append({"address": addr, "tok": p["tok"]})
    return pools


def main():
    try:
        with open(STATE) as f:
            idx = json.load(f)
    except Exception:
        idx = {"at": 0, "pools": []}
    now = int(time.time())
    if now - idx.get("at", 0) >= DISCOVER_SECS or not idx.get("pools"):
        idx = {"at": now, "pools": discover()}
        write_atomic(STATE, idx)
    tip = ra.block()
    live = []
    for p in idx["pools"]:
        rM, rT = ra.reserves(p["address"], p["tok"])
        if rM > 0 and rT > 0:
            live.append({"address": p["address"], "minima": str(rM), "mxusd": str(rT)})
    live.sort(key=lambda x: -float(x["mxusd"]))
    write_atomic(OUT, {"market": "MINIMA/MxUSD", "fee": "0.005", "block": tip, "updated": int(time.time()),
                       "source": "PandaPools reserves read from chain by the eurobuddha.com Minima node", "pools": live})
    print("pools.json: %d funded MxUSD pools at block %d" % (len(live), tip))


if __name__ == "__main__":
    main()
