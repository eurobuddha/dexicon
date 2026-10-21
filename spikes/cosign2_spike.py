"""P0-a2 — the two-NODE fill: taker (node B) spends a coin owned by the maker (node A) by registering the maker's
address script, signs its own inputs, exports; maker imports, registers the taker's script, attaches proofs
(txnbasics), signs, checks, posts. Both nodes are disposable private-chain nodes (A = -solo genesis, B = -test -connect A).

Run: DECKS_RPC_A=http://127.0.0.1:19305 DECKS_RPC_B=http://127.0.0.1:19405 DECKS_TOKEN=0x... DECKS_DISPOSABLE_SOLO=YES python3 -I spikes/cosign2_spike.py
"""
import json, os, sys, time, urllib.parse, urllib.request
from decimal import Decimal, getcontext
getcontext().prec = 64   # Python's default 28-digit context ROUNDED a 39-digit change to an integer and broke validamounts (run 2)

A, B, TOK = os.environ.get("DECKS_RPC_A"), os.environ.get("DECKS_RPC_B"), os.environ.get("DECKS_TOKEN")


def rpc(base, cmd, timeout=180):
    if os.environ.get("DECKS_DISPOSABLE_SOLO") != "YES" or not base:
        raise RuntimeError("Refusing node access: set DECKS_RPC_A/B, DECKS_TOKEN and DECKS_DISPOSABLE_SOLO=YES")
    if urllib.parse.urlparse(base).hostname not in ("localhost", "127.0.0.1", "::1"):
        raise RuntimeError("loopback only")
    with urllib.request.urlopen(base.rstrip("/") + "/" + urllib.parse.quote(cmd), timeout=timeout) as r:
        return json.load(r)


def ok(base, cmd):
    r = rpc(base, cmd)
    if not r.get("status"):
        raise RuntimeError("cmd failed on " + base + ": " + cmd[:140] + " -> " + str(r.get("error") or r.get("response")))
    return r["response"]


def coins_of(base, tokenid):
    r = rpc(base, "coins relevant:true tokenid:" + tokenid).get("response")
    return [c for c in (r if isinstance(r, list) else []) if not c.get("spent") and not c.get("state")]


def value(c):
    return Decimal(c["amount"] if c["tokenid"] == "0x00" else c.get("tokenamount", c["amount"]))


def fit44(x):
    """Exact (64-digit context); the node stored a 45-digit amount verbatim in the 2026-10-21 probe."""
    return Decimal(x)


def script_for(base, address):
    r = ok(base, "scripts address:" + address)
    s = r if isinstance(r, dict) else r[0]
    return s["script"]


def main():
    for i in ("t1", "m1"):
        rpc(A, "txndelete id:" + i); rpc(B, "txndelete id:" + i)
    # maker (A) advertises its biggest MINIMA coin; taker (B) pays 1.5 TestMxUSD for 3 MINIMA
    # The taker's node only has the recent chain window: use the maker's FRESHEST coin that covers the fill.
    fresh = [c for c in coins_of(A, "0x00") if value(c) >= 10]
    mc = max(fresh, key=lambda c: int(c.get("created", 0)))
    tc = max(coins_of(B, TOK), key=value)
    a_addr = ok(A, "getaddress")["address"]; b_addr = ok(B, "getaddress")["address"]
    m_script = script_for(A, mc["address"]); t_script = script_for(B, tc["address"])
    print("maker coin", mc["coinid"], value(mc), "script", m_script[:60])
    print("taker coin", tc["coinid"], value(tc), "script", t_script[:60])

    # --- taker side (B) ---
    print("B: register maker script:", ok(B, 'newscript script:"' + m_script + '" trackall:false').get("address"))
    ok(B, "txncreate id:t1")
    ok(B, "txninput id:t1 coinid:" + mc["coinid"] + " scriptmmr:true")
    ok(B, "txninput id:t1 coinid:" + tc["coinid"] + " scriptmmr:true")
    ok(B, "txnoutput id:t1 amount:3 address:" + b_addr)                                   # MINIMA to taker
    ok(B, "txnoutput id:t1 amount:" + format(fit44(value(mc) - 3), "f") + " address:" + mc["address"])     # MINIMA change, 44 sig digits
    ok(B, "txnoutput id:t1 amount:1.5 address:" + a_addr + " tokenid:" + TOK)            # payment to maker pay-to address
    ok(B, "txnoutput id:t1 amount:" + str(value(tc) - Decimal("1.5")) + " address:" + b_addr + " tokenid:" + TOK)
    print("B: sign own inputs:", ok(B, "txnsign id:t1 publickey:auto"))
    cb = ok(B, "txncheck id:t1"); print("B: txncheck validamounts", cb.get("validamounts"), "valid", json.dumps(cb.get("valid"))[:160])
    exp = ok(B, "txnexport id:t1"); hexdata = exp["data"] if isinstance(exp, dict) else exp
    print("B: exported", len(hexdata) // 2, "bytes")

    # --- maker side (A) ---
    ok(A, "txnimport id:m1 data:" + hexdata)
    chk0 = ok(A, "txncheck id:m1")
    print("A: after import  valid=", json.dumps(chk0.get("valid"))[:200])
    # No txnbasics: the export already carries both scripts and both MMR proofs (txninput scriptmmr:true);
    # re-running basics here DOUBLED the proofs and invalidated the witness in the previous run.
    print("A: sign:", ok(A, "txnsign id:m1 publickey:auto"))
    chk = ok(A, "txncheck id:m1")
    v = chk["valid"]
    print("A: after sign valid=", json.dumps(v)[:300], "validamounts", chk.get("validamounts"))
    assert v["basic"] and v["mmrproofs"] and v["scripts"] and all(s["valid"] for s in v["signatures"]) and chk.get("validamounts"), "not valid"
    post = ok(A, "txnpost id:m1")
    txpowid = post.get("txpowid") or post.get("txpow", {}).get("txpowid")
    print("A: POSTED", txpowid)
    # txnpost's txpowid is the PRE-MINING id (the mined TxPoW hashes differently): settle by the output coins.
    for _ in range(120):
        bal = [c for c in coins_of(B, "0x00") if value(c) == 3]
        if bal:
            print("B now holds the 3 MINIMA coin", bal[0]["coinid"], "created block", bal[0].get("created")); break
        time.sleep(3)
    else:
        raise RuntimeError("B never received the 3 MINIMA coin")
    print("P0-a2 TWO-NODE PASS")


if __name__ == "__main__":
    main()
