#!/bin/bash
# Update an installed Dexicon on a LOCAL disposable test node in place (keeps uid + kv): rig-update.sh <rpcport> <uid> [zip]
set -e; cd "$(dirname "$0")/.."
PORT="$1"; UID_="$2"; ZIP="${3:-$(ls -t Dexicon-*.mds.zip | head -1)}"
case "$PORT" in 4446|9005) echo "refusing: $PORT is a real node"; exit 2;; esac
CMD=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "mds action:update uid:$UID_ file:$(pwd)/$ZIP")
curl -sS -m 240 "http://127.0.0.1:$PORT/$CMD" | python3 -c 'import sys,json; r=json.load(sys.stdin); u=r.get("response",{}).get("updated",{}); print("node", sys.argv[1], "->", u.get("conf",{}).get("name"), u.get("conf",{}).get("version"), "" if r.get("status") else ("FAILED: "+str(r.get("error"))))' "$PORT"
