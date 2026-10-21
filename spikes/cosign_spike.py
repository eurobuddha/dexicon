"""P0-a — two-signer Minima transaction via txnexport / txnimport, on a DISPOSABLE -solo node.

Proves the fast-layer fill mechanics (SPEC §5): party A builds and signs, exports hex, party B imports,
adds its signature, checks and posts. Negative case: a txn altered after A's signature is rejected.

Run:  DECKS_TEST_RPC=http://127.0.0.1:19105 DECKS_DISPOSABLE_SOLO=YES python3 -I spikes/cosign_spike.py
Solo node: java -jar minima.jar -solo -data <dir> -port 19101 -rpc 19105 -rpcenable
"""
import json, os, sys, time, urllib.parse, urllib.request
from decimal import Decimal

RPC = os.environ.get("DECKS_TEST_RPC", "")


def rpc(cmd, timeout=180):
    if os.environ.get("DECKS_DISPOSABLE_SOLO") != "YES" or not RPC:
        raise RuntimeError("Refusing node access: set DECKS_TEST_RPC and DECKS_DISPOSABLE_SOLO=YES for a disposable solo node")
    if urllib.parse.urlparse(RPC).hostname not in ("localhost", "127.0.0.1", "::1"):
        raise RuntimeError("disposable harness requires loopback RPC")
    with urllib.request.urlopen(RPC.rstrip("/") + "/" + urllib.parse.quote(cmd), timeout=timeout) as r:
        return json.load(r)


def ok(cmd, **kw):
    r = rpc(cmd, **kw)
    if not r.get("status"):
        raise RuntimeError("cmd failed: " + cmd[:160] + " -> " + str(r.get("error") or r.get("response")))
    return r["response"]


def block():
    return int(ok("block")["block"])


def advance(n=1):
    """Solo chain mines on tx: self-send dust to force n blocks."""
    mx = ok("getaddress")["miniaddress"]
    start = block()
    for _ in range(n):
        try:
            rpc("send amount:0.0001 address:" + mx)
        except Exception:
            pass
    for _ in range(90):
        if block() >= start + n:
            return block()
        time.sleep(1)
    return block()


def wait_sendable(need, timeout=400):
    """Wait until the wallet has ≥ need MINIMA sendable (young change from a previous send is not spendable)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = rpc("balance tokenid:0x00").get("response")
        b = r[0] if isinstance(r, list) and r else r
        if b and Decimal(str(b.get("sendable", "0"))) >= need:
            return Decimal(str(b["sendable"]))
        time.sleep(3)
    raise RuntimeError(f"wallet never reached {need} sendable (block {block()})")


def coins_at(addr):
    r = rpc("coins address:" + addr)
    return r.get("response") if isinstance(r.get("response"), list) else []


def biggest_coin(addr, min_amount):
    cs = [c for c in coins_at(addr) if c.get("tokenid") == "0x00" and Decimal(c["amount"]) >= min_amount]
    cs.sort(key=lambda c: Decimal(c["amount"]), reverse=True)
    assert cs, f"no spendable coin ≥ {min_amount} at {addr}"
    return cs[0]


def main():
    for i in ("cs", "cs2", "bad"):   # leftovers from an aborted run
        rpc("txndelete id:" + i)
    print("block", block())
    # Two distinct keys in one wallet stand in for the two parties (the crypto is per-key; the transport is just hex).
    a = ok("newaddress"); b = ok("newaddress"); c = ok("newaddress")
    A, B, C = a["address"], b["address"], c["address"]
    print("A", A, a["publickey"]); print("B", B, b["publickey"]); print("C(payee)", C)

    # One txn funds both parties: a second `send` right after the first fails because the only coin's
    # change is still unconfirmed (solo chain, ~3 confirmations needed).
    print("sendable", wait_sendable(Decimal(90)), "at block", block())
    ok("send multi:" + json.dumps([f"{A}:50", f"{B}:40"]))
    wait_sendable(Decimal(1))   # change matured ⇒ the funded coins are confirmed too
    advance(1)
    ca, cb = biggest_coin(A, Decimal(50)), biggest_coin(B, Decimal(40))
    print("coin A", ca["coinid"], ca["amount"]); print("coin B", cb["coinid"], cb["amount"])

    # A pays 10 to C and 5 to B; B pays 20 to C. Inputs 90 → outputs: A change 35, B change 25, C 30. Sum 90.
    ok("txncreate id:cs")
    ok("txninput id:cs coinid:" + ca["coinid"]); ok("txninput id:cs coinid:" + cb["coinid"])
    ok(f"txnoutput id:cs amount:35 address:{A}"); ok(f"txnoutput id:cs amount:25 address:{B}"); ok(f"txnoutput id:cs amount:30 address:{C}")
    ok("txnsign id:cs publickey:" + a["publickey"])
    exp = ok("txnexport id:cs")
    hexdata = exp["data"] if isinstance(exp, dict) and "data" in exp else exp
    print("exported bytes", len(hexdata) // 2)

    # --- Party B: import, add signature, check, post ---
    ok("txnimport id:cs2 data:" + hexdata)
    # The export carries inputs/outputs/signatures but NOT the MMR proofs + input scripts (the witness the
    # importing node must supply itself) — txnbasics attaches them, exactly as the Parlons gateway's
    # txnimport→txnbasics→txnpost relay path does. Signatures cover the txn, not the witness, so A's stays valid.
    ok("txnbasics id:cs2")
    ok("txnsign id:cs2 publickey:" + b["publickey"])
    chk = ok("txncheck id:cs2")
    print("txncheck", json.dumps({k: chk.get(k) for k in ("valid", "validamounts", "signatures")}, default=str)[:400])
    v = chk["valid"]
    assert v["basic"] and v["mmrproofs"] and v["scripts"] and all(s["valid"] for s in v["signatures"]), "txncheck not fully valid"
    post = ok("txnpost id:cs2")
    txpowid = post.get("txpowid") or post.get("txpow", {}).get("txpowid")
    print("POSTED txpowid", txpowid)
    advance(3)
    paid = [x for x in coins_at(C) if Decimal(x["amount"]) == Decimal(30)]
    assert paid, "payee coin of 30 not found after post"
    print("PROOF two-signer fill confirmed: payee coin", paid[0]["coinid"], "block", block())

    # --- Negative: alter after A signed → must not pass as valid ---
    ok("txnimport id:bad data:" + hexdata)
    ok("txnbasics id:bad")
    ok(f"txnoutput id:bad amount:0.5 address:{C}")   # mutates the txn hash; A's signature no longer matches
    ok("txnsign id:bad publickey:" + b["publickey"])
    chk2 = rpc("txncheck id:bad")
    v = chk2.get("response", {}).get("valid") if chk2.get("status") else None
    posted_bad = rpc("txnpost id:bad")
    rejected = (not posted_bad.get("status")) or (isinstance(v, dict) and not all(bool(x) for x in v.values()))
    print("negative txncheck.valid", v, "| txnpost status", posted_bad.get("status"), "| rejected", rejected)
    assert rejected, "ALTERED TXN WAS ACCEPTED — spike FAILS"
    for i in ("cs", "cs2", "bad"):
        rpc("txndelete id:" + i)
    print("P0-a PASS")


if __name__ == "__main__":
    main()
