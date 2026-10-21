"""P0-b relay stub: the smallest server that behaves like SPEC §4 /dex/book long-poll.

GET  /dex/book?since=N  -> blocks up to HOLD seconds until cursor > N, then {"cursor":c,"orders":[...],"held_ms":t}
POST /dex/publish       -> bumps the cursor (body kept as the "order"), wakes all waiters
Run: python3 -I spikes/longpoll/relay_stub.py 18555
"""
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOLD = 20.0
_lock = threading.Condition()
_cursor = 0
_orders = []


class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        global _cursor
        u = urlparse(self.path)
        if u.path != "/dex/book":
            return self._json(404, {"ok": False})
        q = parse_qs(u.query)
        since = int(q.get("since", ["0"])[0]); hold = float(q.get("hold", [str(HOLD)])[0])
        print(time.strftime("%H:%M:%S"), "GET book since", since, "hold", hold, "from", self.client_address[0], flush=True)
        t0 = time.time()
        with _lock:
            while _cursor <= since and time.time() - t0 < hold:
                _lock.wait(timeout=hold - (time.time() - t0))
            cur, orders = _cursor, _orders[since:]
        self._json(200, {"cursor": cur, "orders": orders, "held_ms": int((time.time() - t0) * 1000)})

    def do_POST(self):
        global _cursor
        if urlparse(self.path).path != "/dex/publish":
            return self._json(404, {"ok": False})
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode() if n else ""
        with _lock:
            _cursor += 1; _orders.append({"seq": _cursor, "body": body, "ts": time.time()})
            _lock.notify_all()
        print(time.strftime("%H:%M:%S.") + str(int(time.time()*1000)%1000).zfill(3), "PUBLISH cursor", _cursor, flush=True)
        self._json(200, {"ok": True, "cursor": _cursor})

    def log_message(self, *a):  # quiet
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18555
    print("relay stub on", port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
