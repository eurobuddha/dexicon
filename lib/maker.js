/**
 * maker — MY orders: the kv-backed model shared by the page (which creates/edits/cancels) and the service
 * (which co-signs fills, republishes on coin changes and refreshes expiry). Backing coins are selected from the
 * wallet's state-free, unspent coins of the token the order gives away (sell → MINIMA, buy → MxUSD).
 * Rhino-safe (ES5). Requires AX.mds, AX.fill, AX.envelope, AX.relay. Attaches to AX.maker.
 *
 * kv 'myorders' = JSON array of { orderId, side, price, amount, remaining, coins:[coinid], address, seq, expiry, status }
 *   status: 'live' | 'cancelled' | 'filled'. seq increases on every republish (edit, cancel, refresh, coin change).
 *   relocking:[coinid] = coins being refreshed by a self-send for this order (it is published coinless meanwhile);
 *   relockError = why the last relock of them failed (refresh retries it; the order stays coinless until it works).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var F = AX.fill, E = AX.envelope;
    // owner 7 Nov, the maker heartbeat (mirror of APK 0.2.77): orders live 60 min and are re-signed once under 50 min remain,
    // so a silent maker drops off every relay within 60 min; takers hide orders not re-signed in 65 min (relay.js LIVE_SECONDS)
    // MAX_COINS (0.0.164, review MINOR): at most 8 backing coins an order, so a take of the WHOLE order fits one take message
    // (lib/fill.js MAX_TAKE_TXN_BYTES: each input carries its coin, script and MMR proof); it was 32 — a full take of such an
    // order was signed by the taker and then could not be sent
    var MARKET = 'MINIMA/MxUSD', EXPIRY_SECONDS = 60 * 60, REFRESH_BEFORE_SECONDS = 50 * 60, MAX_COINS = 8;
    /** A light-node taker proves a coin only inside its chain window. Backing coins older than this are re-locked by a
     *  self-send before they fall out of every taker's view. kv 'coin_max_age' overrides, lower only: a saved value above
     *  it is read as COIN_MAX_AGE (maxAgeOf).
     *  0.0.101 (owner 22 Nov 2026: 500 is too low): 900. MEASURED 22 Nov on a light node of this family (-isclient -mobile,
     *  minima-core fork, GlobalParams MINIMA_CASCADE_START_DEPTH 1024): tip 2433919, cascade start 2432821, so 1098 blocks
     *  of chain held, and a coin created 2193 blocks back was not visible; upstream classic Minima holds 2048. The smallest
     *  taker window is therefore ~1024 blocks. 900 leaves 124 blocks (~1.7 h) for a take on a coin at the limit to be
     *  built, co-signed and mined before the coin leaves that window. */
    var COIN_MAX_AGE = 900;
    var WHY_MAX_AGE = 'a light node cannot take an order backed by a coin older than its chain window';
    /** The saved BACKING COIN MAX AGE as used: 1..COIN_MAX_AGE blocks; empty, 0 or junk → COIN_MAX_AGE. */
    function maxAgeOf(v) { var m = parseInt(v, 10); return m > 0 ? Math.min(m, COIN_MAX_AGE) : COIN_MAX_AGE; }
    /** A remainder under 1 MINIMA after a fill is dust nobody can usefully take: the order closes instead of dangling
     *  on every relay (owner, 2026-10-22). Takers also lift a whole order rather than leave less than this behind. */
    var DUST = '1';
    function dust(remaining, amount) { var r = F.d(remaining); return r.gt(0) && r.lt(F.d(DUST)) && r.lt(F.d(amount)); }

    function now() { return Math.floor(Date.now() / 1000); }
    /** 0.0.166 (review, MINOR): the expiry of a cancel or close of `o`. A relay drops an envelope once it expires (dexrelay
     *  Store.sweep) and then accepts ANY envelope of that order again (publish keeps the highest seq only of what it still
     *  holds), so a cancel carried now+600 while the live envelopes before it carried up to now+3600: once the relay swept
     *  the cancel, anyone could republish the older live envelope and the order was live again. Every envelope of an
     *  order expires at most EXPIRY_SECONDS after it was signed (or at o.expiry), so a close signed now lasts at least
     *  as long as any of them. */
    function closeExpiry(o) { return Math.max(Number(o && o.expiry) || 0, now() + EXPIRY_SECONDS); }
    function nextSeq(o) { var s = now(); return s > (o.seq || 0) ? s : (o.seq || 0) + 1; }

    function parseList(v) { try { var l = JSON.parse(v || '[]'); return Object.prototype.toString.call(l) === '[object Array]' ? l : []; } catch (e) { return []; } }
    /** The list, plus list._base: a copy of what was loaded (an array's named property is not serialised), so save()
     *  can tell which orders THIS caller changed. */
    function load(mds, cb) {
        mds.kvGet('myorders', '[]', function (v) {   // mdsw.kvGet calls back with the VALUE only
            var list = parseList(v); list._base = parseList(v);
            cb(null, list);
        });
    }
    /** Review 22 Nov (M4): the page and the service each load the list, wait on relays, then saved the WHOLE list, so the
     *  later save wiped the other's work (a cancel made during a refresh was undone; an order created during one vanished).
     *  save() re-reads the stored list and merges PER ORDER: an order this caller did not change keeps the stored copy;
     *  a new one is added; one changed here whose stored copy did not move (status, seq) takes this caller's changes, field
     *  by field: a field another writer changed meanwhile that this caller left alone (relocking, relockError) is kept
     *  (review 23 Nov, MINOR). One changed here AND moved in the store since load is a conflict — a user action (`mine`:
     *  create / cancel / edit) wins, a background pass (refresh, afterFill, the ladder batch, the relay sync) loses —
     *  EXCEPT (review 23 Nov, M4) when the stored copy filled meanwhile: a filled or cancelled order never comes back to
     *  life by any merge, and an order whose remaining dropped (part-filled) is never restored to its old size by an edit:
     *  the stored copy stands and the edit is refused (a cancel still applies, on the stored remaining). The winner's seq
     *  is raised above the loser's and it is returned in `bumped` to be published again (the loser may already have
     *  reached a relay at its seq). cb(err, bumped, lost): lost = the orderIds whose change by this caller did not land
     *  (`list` then holds the stored copy of them). */
    /**
     * Review 23 Nov (MAJOR-1): save()'s read (kvGet) and write (kvSet) were two commands, and the page and the service run
     * apart: a write landing between them was overwritten — the page's cancel of Y put back an order X the service had
     * just marked filled (refresh then re-backed and re-sold it), or a service write undid a page cancel. The MDS SQL
     * reply to an UPDATE carries no affected-row count, and H2 2.x keeps kv values as CLOBs (no compare-and-set on them),
     * so the read-merge-write runs under a lease lock row (table dx_lock, the ax_ethlock pattern of lib/mdsw.js): taken
     * with one UPDATE … WHERE free-or-stale and read back; a unique token per call, so two saves of the same runtime
     * exclude each other too. A holder that died frees it after LOCK_TTL_MS. Not acquired within LOCK_TRIES attempts
     * (LOCK_WAIT_MS): the save FAILS loudly (nothing written). withLock(mds, id, body(release, token), cb(err)): where
     * no SQL is wired (tests, early boot) it runs unlocked (token null), as before.
     *
     * Review 23 Nov (lease, 0.0.142): a holder that outlived its lease (a 16 s page stall) still wrote, and its write put
     * back an order the thief had marked filled; and staleness was judged by the HOLDER's `ts` (the page's browser clock,
     * which may be another machine's). Now:
     *   - the write itself is FENCED by the lock token, in ONE statement (fencedWrite): `UPDATE ax_kv SET v=… WHERE
     *     k='myorders' AND EXISTS (SELECT 1 FROM dx_lock WHERE id='myorders' AND owner='<token>')`, and the value is read
     *     back: MDS SQL gives no affected-row count, so a save whose read-back is not what it wrote FAILS loudly (a
     *     holder whose lease was taken over writes nothing);
     *   - a lease is stale when THIS runtime has seen the same owner token on the row for LOCK_TTL_MS by its OWN clock
     *     (lockSeen; tokens are unique per acquisition, so an unchanged token means one unbroken hold). The holder's `ts`
     *     is written for old readers only and never judged. The observation outlives one save: a dead holder's lease is
     *     taken over by a later save once it has been seen for 15 s, and only by a compare-and-set on that exact token
     *     (`… OR owner='<the stale token>'`).
     */
    var LOCK_TTL_MS = 15000, LOCK_TRIES = 200, LOCK_WAIT_MS = 8000, lockSeq = 0, lockBase = 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36), lockReady = {}, lockSeen = {};
    var TOKEN = /^[A-Za-z0-9._-]{1,80}$/;
    function withLock(mds, id, body, cb, ttlMs) {
        var TTL = ttlMs > 0 ? ttlMs : LOCK_TTL_MS;
        function free(k) { k(); }
        if (typeof mds.sql !== 'function') return body(free, null);
        // review 23 Nov (0.0.144): SQL that is wired but FAILS no longer means "unlocked, as before" — the caller gets the
        // error and it is logged: a save of `myorders` never writes without the lock (and so never unfenced)
        function broken(r) {
            var e = new Error('the ' + id + ' store lock could not be used (' + ((r && r.error) || 'no reply from the node database') + '): nothing was saved; try again');
            lockReady[id] = false;
            if (g.MDS && typeof g.MDS.log === 'function') g.MDS.log('[dexicon] ' + e.message);
            cb(e);
        }
        (lockReady[id] ? function (k) { k(null); } : function (k) {
            mds.sql("CREATE TABLE IF NOT EXISTS `dx_lock` (`id` varchar(32) NOT NULL PRIMARY KEY, `owner` varchar(80), `ts` bigint)", function (r) {
                if (!r || !r.status) return k(r || {});
                mds.sql("INSERT INTO `dx_lock` (`id`,`owner`,`ts`) SELECT '" + id + "','',0 WHERE NOT EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='" + id + "')", function () { lockReady[id] = true; k(null); });
            });
        })(function (bad) {
            if (bad) return broken(bad);
            var tok = lockBase + '.' + (++lockSeq), tries = 0, t0 = Date.now(), steal = '', inside = false, more = false;
            // review 23 Nov (0.0.143): with no setTimeout (the node's Rhino service) and a synchronous MDS.sql the retry used
            // to call attempt() from inside its own callback: 200 tries nested ~1000 interpreter frames and Rhino's 1024
            // limit (ServiceJSRunner) killed the tick (StackOverflow at ~220 tries from an empty stack). Now a retry asked
            // for from inside a synchronous attempt only flags the loop below (iterative, constant depth), after a 20 ms
            // pause timed by Date.now(); the tries and LOCK_WAIT_MS bound it and the caller gets the error.
            function again() {
                if (typeof g.setTimeout === 'function') return g.setTimeout(run, 25);
                if (!inside) return run();
                // ponytail: busy pause (Rhino has no sleep) so the page's own SQL gets the node's DB between tries; ≤ 200 × 20 ms
                for (var until = Date.now() + 20; Date.now() < until;) { }
                more = true;
            }
            function run() { do { more = false; inside = true; attempt(); inside = false; } while (more); }
            run();
            function attempt() {
                mds.sql("UPDATE `dx_lock` SET `owner`='" + tok + "', `ts`=" + Date.now() + " WHERE `id`='" + id + "' AND (`owner`='' OR `owner` IS NULL OR `owner`='" + steal + "')", function () {
                    mds.sql("SELECT `owner` FROM `dx_lock` WHERE `id`='" + id + "'", function (r) {
                        var row = r && r.rows && r.rows[0], owner, seen, now = Date.now();
                        if (!r || !r.status || !row) return broken(r && r.status ? { error: 'no ' + id + ' lock row' } : r);
                        owner = String(row.OWNER !== undefined ? row.OWNER : (row.owner !== undefined ? row.owner : '')).replace(/^null$/, '');
                        if (owner === tok) { delete lockSeen[id]; return body(function (k) { mds.sql("UPDATE `dx_lock` SET `owner`='' WHERE `id`='" + id + "' AND `owner`='" + tok + "'", function () { k(); }); }, tok); }
                        seen = lockSeen[id];
                        if (!seen || seen.owner !== owner) seen = lockSeen[id] = { owner: owner, since: now };
                        steal = owner && TOKEN.test(owner) && now - seen.since >= TTL ? owner : '';   // held unchanged for the TTL by MY clock
                        if (++tries >= LOCK_TRIES || now - t0 > LOCK_WAIT_MS) return cb(new Error('the ' + id + ' store is held by another writer of this node (page or service): nothing was saved; try again'));
                        again();
                    });
                });
            }
        });
    }
    /**
     * 0.0.163 (review, MAJOR — decision recorded, the safe default): the page and the service sign with the same wallet
     * keys in separate JS contexts. The per-context gate (doors/signgate.js, inside AX.mds.cmdR) serialises each context;
     * only a node whose Wallet.signData is synchronised serialises the two, and upstream stock is not (core/Minima
     * Wallet.java signData): a click during a service signing could sign one Winternitz leaf twice and leak it. So EVERY
     * signing command (AX.signgate.signs: send, txnsign, sign, consolidate, tokencreate, multisig) also holds the SQL lease
     * `dx_lock` row 'signing' (withLock: unique token per command, observer-clock staleness, Rhino's iterative bounded
     * wait), in both contexts. Not acquired within the wait → the command is REFUSED (callback error, nothing sent to the
     * node): a refused signature is safe, a concurrent one is not. SIGN_TTL_MS = 200 s: a holder is taken over only after
     * this runtime has seen the same token for longer than the node's own 180 s write timeout, so a slow signing is never
     * judged dead. leaseSigning(mds) wraps mds.cmdR once (installed on AX.mds as this file loads, before the doors engine);
     * leaseCmd(cmd) wraps a raw result-style cmd (the service's PDService.cmd). The per-context gate stays inside.
     */
    var SIGN_TTL_MS = 200000;
    function signs(command) { return !!(g.AX && g.AX.signgate && g.AX.signgate.signs(command)); }
    function leaseSigning(mds) {
        if (!mds || mds._signLease || typeof mds.cmdR !== 'function') return mds;
        var raw = mds.cmdR;
        mds.cmdR = function (command, cb) {
            if (!signs(command)) return raw(command, cb);
            withLock(mds, 'signing', function (release) {
                raw(command, function (e, resp, r) { release(function () { cb(e, resp, r); }); });
            }, function (err) {
                var m = 'refused, nothing was signed: ' + err.message;
                if (g.MDS && typeof g.MDS.log === 'function') g.MDS.log('[dexicon] signing ' + String(command).split(' ')[0] + ' ' + m);
                cb(new Error(m), null, { status: false, error: m });
            }, SIGN_TTL_MS);
        };
        mds._signLease = true;
        return mds;
    }
    /** The same lease around a result-style command function cmd(command, cb(result)) (PDService.cmd). */
    function leaseCmd(mds, cmd) {
        return function (command, cb) {
            if (!signs(command)) return cmd(command, cb);
            withLock(mds, 'signing', function (release) { cmd(command, function (r) { release(function () { cb(r); }); }); },
                function (err) { cb({ status: false, error: 'refused, nothing was signed: ' + err.message }); }, SIGN_TTL_MS);
        };
    }

    /** The save's one write, fenced by the lock token `tok` (header): the row is made if missing ('[]', what a missing row
     *  reads as), then written only while `tok` holds the lock, then read back. cb(err): an error unless the stored value
     *  is exactly `json`. No token (no SQL wired): the plain kv write, as before. */
    function fencedWrite(mds, json, tok, cb) {
        if (!tok) return mds.kvSet('myorders', json, cb);
        mds.sql("INSERT INTO ax_kv (k, v) SELECT 'myorders', '[]' WHERE NOT EXISTS (SELECT 1 FROM ax_kv WHERE k='myorders')", function () {
            mds.sql("UPDATE ax_kv SET v='" + json.split("'").join("''") + "' WHERE k='myorders' AND EXISTS (SELECT 1 FROM `dx_lock` WHERE `id`='myorders' AND `owner`='" + tok + "')", function (w) {
                if (!w || !w.status) return cb(new Error('the save of your orders failed (' + ((w && w.error) || 'no reply') + '): nothing was saved'));
                mds.sql("SELECT v FROM ax_kv WHERE k='myorders'", function (r) {
                    var row = r && r.status && r.rows && r.rows[0], v = row ? (row.V !== undefined ? row.V : row.v) : null;
                    cb(v === json ? null : new Error('the save of your orders did not land: its hold on the store (' + (LOCK_TTL_MS / 1000) + ' s) lapsed and another writer of this node took it over — nothing was saved; try again'), v);
                });
            });
        });
    }
    function save(mds, list, cb, mine) {
        var base = list._base;
        if (!base) return mds.kvSet('myorders', JSON.stringify(list), function (err) { cb(err, [], []); });   // not from load(): as before
        withLock(mds, 'myorders', function (release, tok) { saveLocked(mds, list, base, mine, tok, function (err, bumped, lost) { release(function () { cb(err, bumped, lost); }); }); }, function (err) { cb(err, [], []); });
    }
    /** The stored list for the save, read under the lock. NIT (review 23 Nov, mdsw.js:81): kv.kvGet answers its default
     *  for a FAILED read too, so a save after a failed read wrote a list missing every stored order. With SQL wired the
     *  row is read directly: a failed read, or a stored value that is not a JSON list, fails the save (cb(err)); no row
     *  is '[]'. No SQL: kvGet, as before. */
    function readStored(mds, tok, cb) {
        if (!tok) return mds.kvGet('myorders', '[]', function (v) { cb(null, parseList(v)); });
        mds.sql("SELECT v FROM ax_kv WHERE k='myorders'", function (r) {
            if (!r || !r.status) return cb(new Error('your stored orders could not be read (' + ((r && r.error) || 'no reply') + '): nothing was saved; try again'));
            var row = r.rows && r.rows[0], v = row ? (row.V !== undefined ? row.V : row.v) : '[]', l = null;
            try { l = JSON.parse(v); } catch (e) { l = null; }
            if (Object.prototype.toString.call(l) !== '[object Array]') return cb(new Error('your stored orders are unreadable (not a list): nothing was saved'));
            cb(null, l);
        });
    }
    function saveLocked(mds, list, base, mine, tok, cb) {
        readStored(mds, tok, function (re, out) {
            if (re) return cb(re, [], []);
            var bumped = [], lost = [], keep = [];
            list.forEach(function (o, li) {
                var b = find(base, o.orderId), c = find(out, o.orderId), win, lose, k;
                if (!c) { if (!b) out.push(o); return; }                        // new here → added; gone from the store → stays gone
                if (b && JSON.stringify(b) === JSON.stringify(o)) return;      // not changed by this caller: the stored copy stands
                if (JSON.stringify(c) === JSON.stringify(o)) return;            // already stored exactly so (a repeated save)
                // gate review 23 Nov (a): a stored `remaining` or `fills` that changed since load moved too (a refresh that
                // reconciled a fill but could not publish saved it at the same seq: merged field by field, a background
                // afterFill that loaded before it dropped that fill — 80 left where 40 was right)
                var moved = !b || c.status !== b.status || c.seq !== b.seq || c.remaining !== b.remaining || JSON.stringify(c.fills || []) !== JSON.stringify(b.fills || []) || JSON.stringify(c.prov || []) !== JSON.stringify(b.prov || []);
                if (c.status !== 'live' && o.status === 'live') win = c;       // filled / cancelled: never live again
                else if (!moved) {
                    for (k in c) if (c.hasOwnProperty(k) && JSON.stringify(c[k]) !== JSON.stringify(b[k]) && JSON.stringify(o[k]) === JSON.stringify(b[k])) o[k] = c[k];
                    win = o;
                } else if (!mine || c.status !== 'live') win = c;
                else if (b && F.d(c.remaining || '0').lt(F.d(b.remaining || '0'))) {
                    if (o.status === 'cancelled') { o.remaining = c.remaining; o.coins = c.coins; win = o; } else win = c;
                } else win = o;
                lose = win === o ? c : o;
                if (win === c) { lost.push(o.orderId); keep.push(li); }
                if ((moved || win === c) && win.seq <= lose.seq) { win.seq = lose.seq + 1; bumped.push(win); }
                out[out.indexOf(c)] = win;
            });
            fencedWrite(mds, JSON.stringify(out), tok, function (err, back) {
                // 0.0.171 (review, open item — create's lease-takeover edge): the read-back differs from what was written
                // when the write DID land and another writer that took the lease over wrote after it (merging ours in). The
                // save then reported failure though the order was stored (a create the user saw fail went live from the
                // store). The stored list is read for the truth: every order this caller changed, stored exactly as it
                // wrote it → landed (`out` becomes the stored list); else the error stands.
                if (err && typeof back === 'string') { var st = parseList(back); if (landed(list, base, out, st)) { err = null; out = st; } }
                if (!err) {   // review 23 Nov (MINOR): `list` follows what was stored, so a lost change never wins a later save
                    keep.forEach(function (li) { list[li] = find(out, list[li].orderId); });
                    list._base = parseList(JSON.stringify(out));
                }
                cb(err, bumped, lost);
            });
        });
    }
    /** 0.0.171: did this caller's changes land in the stored list `st`? Each order of `list` changed here (new, or not as
     *  loaded) and kept by the merge (in `out` as this caller has it) is in `st` exactly so; at least one such order. */
    function landed(list, base, out, st) {
        var n = 0, ok = true;
        list.forEach(function (o) {
            var b = find(base, o.orderId), w = find(out, o.orderId);
            if (b && JSON.stringify(b) === JSON.stringify(o)) return;            // not changed here
            if (!w || JSON.stringify(w) !== JSON.stringify(o)) return;          // lost to the merge: not ours to check
            n++; if (JSON.stringify(find(st, o.orderId)) !== JSON.stringify(o)) ok = false;
        });
        return ok && n > 0;
    }
    /** save(), then publish every order it raised above a conflicting copy (a failed publish is re-sent by syncRelays,
     *  which sees the relay hold a lower seq). cb(err, lost) (lost: see save). */
    function commit(mds, relay, me, list, mine, cb) {
        save(mds, list, function (err, bumped, lost) {
            var i = 0;
            (function next() { if (err || i >= bumped.length) return cb(err, lost || []); publish(mds, relay, me, bumped[i++], function () { next(); }); })();
        }, mine);
    }
    /** M4: did the stored copy of `o` move (status or seq) since `list` was loaded? Then it is not ours to re-sign. cb(moved). */
    function movedSince(mds, list, o, cb) {
        var b = list._base && find(list._base, o.orderId);
        if (!b) return cb(false);
        mds.kvGet('myorders', '[]', function (v) { var c = find(parseList(v), o.orderId); cb(!c || c.status !== b.status || c.seq !== b.seq); });
    }

    var SIMPLE = /^RETURN SIGNEDBY\(0x[0-9A-Fa-f]{64}\)$/;
    /** address(lower) → simple script text, of MY rows only (0.0.159: F.ownScripts — a key the wallet holds; a
     *  counterparty's RETURN SIGNEDBY row that a take's `newscript` registered matched SIMPLE too, and a coin there that an
     *  import made relevant could be picked to back an order this node cannot sign). cb(err, map). */
    function simpleScripts(mds, cb) {
        F.ownScripts(mds, function (err, rows) {
            if (err) return cb(err);
            var map = {};
            for (var i = 0; i < rows.length; i++) if (SIMPLE.test(String(rows[i].script))) map[String(rows[i].address).toLowerCase()] = rows[i].script;
            cb(null, map);
        });
    }

    /** Spendable, state-free, unspent coins of one token (relevant:true = mine). Only coins at SIMPLE addresses are
     *  usable as backing: a taker needs the address script (published in the order) and txnsign auto signs simple
     *  inputs only. Each coin gets `.script` attached. cb(err, coins). */
    function walletCoins(mds, tokenid, cb) {
        simpleScripts(mds, function (e0, scripts) {
            if (e0) return cb(e0);
            mds.cmdR('coins relevant:true checkmempool:true tokenid:' + tokenid, function (err, r) {   // checkmempool: a coin a pending txn spends is already gone
                if (err) return cb(err);
                var rows = Object.prototype.toString.call(r) === '[object Array]' ? r : [];
                var out = [];
                for (var i = 0; i < rows.length; i++) {
                    var c = rows[i];
                    if (!c || c.spent === true || (c.state && c.state.length) || String(c.tokenid).toLowerCase() !== tokenid.toLowerCase()) continue;
                    var sc = scripts[String(c.address).toLowerCase()];
                    if (!sc) continue;
                    c.script = sc; out.push(c);
                }
                cb(null, out);
            });
        });
    }

    /** Distinct address scripts for a set of coins (the order's `scripts`). */
    function scriptsFor(coins, ids) {
        var want = {}; for (var i = 0; i < ids.length; i++) want[String(ids[i]).toLowerCase()] = true;
        var seen = {}, out = [];
        for (i = 0; i < coins.length; i++) { var c = coins[i]; if (want[String(c.coinid).toLowerCase()] && c.script && !seen[c.script]) { seen[c.script] = true; out.push(c.script); } }
        return out;
    }

    /** Age in blocks of a coin at `tip` (0 when unknown). */
    function ageOf(c, tip) { var cr = parseInt(c.created, 10); return (tip > 0 && cr > 0) ? Math.max(0, tip - cr) : 0; }
    /** 22 Nov 2026: a tip that could not be read (0) means freshness is UNKNOWN, never fresh. It used to read as age 0,
     *  so a maker whose `block` read failed re-signed orders backed by coins far older than COIN_MAX_AGE: a live maker
     *  publishing an order no light-node taker can see. */
    function isFresh(c, tip, maxAge, proofed) {
        return tip > 0 && (ageOf(c, tip) <= Math.min(maxAge || COIN_MAX_AGE, COIN_MAX_AGE) || !!(proofed && proofed[String(c.coinid).toLowerCase()]));
    }
    /** 0.0.113, the coin proof hand-over (lib/proofs.js): a coin my node can PROVE (`coinexport`) may back an order at any
     *  age — an updated taker whose node cannot see it asks for its proof — so it is never relocked for its age and an order
     *  on it is live at once. cb(proofed: lc coin id → true) for the stale coins among `coins` that export now. kv
     *  'legacy_fresh' on (the default since 0.0.122, legacyOn): {} — the 0.0.110 rule (every backing coin kept under COIN_MAX_AGE by relocks), for takers on
     *  versions before the hand-over, which cannot take an order on a coin older than their window. */
    function proofedOf(mds, coins, tip, maxAge, legacy, cb) {
        if (legacy || !(tip > 0) || !AX.proofs) return cb({});
        AX.proofs.exportable(mds, (coins || []).filter(function (c) { return !isFresh(c, tip, maxAge); }), tip, cb);
    }

    /** Coins a maker needs to back `side`/`price`/`amount`, excluding coins already backing other live orders.
     *  Only FRESH coins (age ≤ maxAge at `tip`) or PROVED ones (`proofed`, 0.0.113) qualify: a stale coin with no proof is
     *  invisible to light-node takers. */
    function backing(side, price, amount, coins, excludeIds, tip, maxAge, proofed) {
        var give = side === 'sell' ? F.d(amount) : F.up8(F.d(amount).times(F.d(price)));
        if (!(tip > 0)) throw new Error('chain tip unreadable, so coin freshness is unknown: not signing an order with backing coins of unknown age');
        var ex = {}; for (var i = 0; i < (excludeIds || []).length; i++) ex[String(excludeIds[i]).toLowerCase()] = true;
        var free = coins.filter(function (c) { return !ex[String(c.coinid).toLowerCase()] && isFresh(c, tip || 0, maxAge, proofed); });
        var p = F.pick(free, give, MAX_COINS);
        if (!p) throw new Error('not enough free, fresh ' + (side === 'sell' ? 'MINIMA' : 'MxUSD') + ' coins to back ' + F.plain(give) + (side === 'sell' ? ' MINIMA' : ' MxUSD'));
        return p.coins.map(function (c) { return c.coinid; });
    }

    function giveOf(side, price, amount) { return side === 'sell' ? F.d(amount) : F.up8(F.d(amount).times(F.d(price))); }
    /** 0.0.102 (owner 22 Nov 2026: refusing an order because its coins are old, or making the user wait a block before
     *  placing it, is unacceptable). Backing for create/edit: fresh coins as before → {coins, relock: [], relocking: []}.
     *  When fresh coins cannot cover it, the free coins of ANY age that can → {coins: [], relocking: all their ids,
     *  relock: the STALE ones only}: the caller relocks those at once (0.0.110: a fresh coin among them is held for the
     *  order in `relocking` but never self-sent) and publishes the order coinless; refresh re-backs it after the next block.
     *  Throws for an unread tip (0.0.92) and when the free coins cannot cover it at all, saying held vs needed. Pure. */
    function placement(side, price, amount, coins, excludeIds, tip, maxAge, proofed) {
        try { return { coins: backing(side, price, amount, coins, excludeIds, tip, maxAge, proofed), relock: [], relocking: [] }; }
        catch (e) { if (!(tip > 0)) throw e; }
        var give = giveOf(side, price, amount), name = side === 'sell' ? 'MINIMA' : 'MxUSD', ex = {}, held = F.d(0), i;
        for (i = 0; i < (excludeIds || []).length; i++) ex[String(excludeIds[i]).toLowerCase()] = true;
        var free = coins.filter(function (c) { return !ex[String(c.coinid).toLowerCase()]; });
        for (i = 0; i < free.length; i++) held = held.plus(F.coinValue(free[i]));
        var p = F.pick(free, give, MAX_COINS);
        if (!p) throw new Error(held.gte(give)
            ? 'not enough ' + name + ' in ' + MAX_COINS + ' coins: the order needs ' + F.plain(give) + ' ' + name + ' and the ' + F.plain(held) + ' ' + name + ' free is spread over ' + free.length + ' coins — consolidate first'
            : 'not enough ' + name + ': the order needs ' + F.plain(give) + ' ' + name + ', this wallet holds ' + F.plain(held) + ' ' + name + ' free (not backing another order, not being spent)');
        return { coins: [], relock: p.coins.filter(function (c) { return !isFresh(c, tip, maxAge, proofed); }), relocking: p.coins.map(function (c) { return c.coinid; }) };
    }
    var PENDING_NOTICE = 'placed; goes live to takers after the next block (refreshing your coins)';
    /** create/edit: start the relock of the coins placement() chose, at once. A failure is kept on the order (refresh
     *  retries it; the order stays coinless meanwhile, never re-signed on a stale coin) and told. cb(notice). */
    function startRelock(mds, o, coins, address, cb) {
        if (!coins.length) return cb('');
        relock(mds, coins, address, function (e) {
            if (e && !e.pending) { o.relockError = e.message; return cb('placed, but refreshing your coins failed (' + e.message + '): it goes live to takers once a retry succeeds (retried automatically, backing off after each failure)'); }
            delete o.relockError; cb(PENDING_NOTICE);
        });
    }

    /** kv legacy_fresh (review 23 Nov, M5: default ON until every taker can import a coin proof — Android Dexicon has no
     *  proof hand-over and no takeable filter, so it SHOWS an order on a coin older than its window and every take of it
     *  fails). ON (unset, '', '1', anything else): the 0.0.110 rule — every backing coin is kept under COIN_MAX_AGE by
     *  relocks, a new order on old coins is placed coinless and goes live after the relock's block; the maker still
     *  answers proof requests and updated takers still import, so a coin that slips past the age limit stays takeable
     *  for them. OFF only for '0', 'false', 'off', 'no' (any case): a coin this node can prove backs an order at any age.
     *  NIT (maker.js:197): it used to be ON only for exactly '1' or 'true' — ' 1', 'on', 'TRUE' silently read as off. */
    function legacyOn(v) { return !/^(0|false|off|no)$/i.test(String(v === undefined || v === null ? '' : v).replace(/^\s+|\s+$/g, '')); }
    /** Current tip block + configured max coin age + legacyOn(kv legacy_fresh). cb(tip, maxAge, legacy). A
     *  failed tip read is retried once; tip 0 means it is still unknown (callers refuse to sign, or skip the refresh). */
    function chainCtx(mds, cb) {
        function readTip(tries) {
            mds.cmdR('block', function (err, b) {
                var tip = (!err && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
                if (!tip && tries > 1) return readTip(tries - 1);
                mds.kvGet('coin_max_age', '', function (v) { mds.kvGet('legacy_fresh', '', function (lf) { cb(tip, maxAgeOf(v), legacyOn(lf)); }); });
            });
        }
        readTip(2);
    }

    /**
     * Re-lock stale coins: ONE transaction spending exactly these coins back to my own address (same token), so they
     * become fresh coins light-node takers can prove. The node signs all inputs (they are mine). cb(err, txpowid).
     * 0.0.103: one output per input, of the same amount — a relock keeps the wallet's coin sizes. It used to merge them
     * into one coin, so two orders whose stale coins were relocked together came back with ONE coin, which backs one
     * order only (a coin backs at most one order): the other stayed coinless.
     */
    /** 0.0.106 (review 22 Nov, M3): one relock is capped at the node's own `consolidate` limits, 20 inputs from at most 5
     *  distinct signing addresses (a TxPoW over 64 KB is rejected only AFTER signing); the rest goes in later passes.
     *  After ANY failure its coins back off (kv relock_backoff, coinid → {until, wait}): 2 blocks, doubling to 64. Every
     *  caller (placement, refresh, both voids) goes through here, so a failure after txnsign is never re-signed inside
     *  its window. cb(err, txpowid, sentIds): err.backoff = every coin given is still waiting (nothing signed);
     *  err.pending = posted without a txpowid, possibly in the mempool: the coins are looked at again after the window. */
    var RELOCK_MAX_INPUTS = 20, RELOCK_MAX_SIGNERS = 5, BACKOFF_FIRST = 2, BACKOFF_MAX = 64;
    function relock(mds, coins, toAddress, cb) {
        if (!coins.length) return cb(null, null, []);
        mds.cmdR('block', function (eb, b) {
            var tip = (!eb && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
            if (!tip) return cb(new Error('relock: chain tip unreadable, so its backoff cannot be judged'), null, []);
            // ponytail: read-modify-write of one kv key shared by page and service; a lost entry costs one early retry
            mds.kvGet('relock_backoff', '{}', function (v) {
                var bo = {}, batch = [], signers = {}, nS = 0, until = 0, i, k;
                try { bo = JSON.parse(v || '{}') || {}; } catch (e) { bo = {}; }
                for (i = 0; i < coins.length && batch.length < RELOCK_MAX_INPUTS; i++) {
                    var c = coins[i], w = bo[String(c.coinid).toLowerCase()], a = String(c.address).toLowerCase();
                    if (w && tip < w.until) { until = Math.max(until, w.until); continue; }
                    if (!signers[a]) { if (nS >= RELOCK_MAX_SIGNERS) continue; signers[a] = true; nS++; }
                    batch.push(c);
                }
                if (!batch.length) { var eW = new Error('relock: backing off after a failure, retried from block ' + until); eW.backoff = true; return cb(eW, null, []); }
                var ids = batch.map(function (x) { return x.coinid; });
                function done(err, txpowid) {
                    for (k in bo) if (tip - bo[k].until > 1000) delete bo[k];
                    var wait = 0;
                    batch.forEach(function (x) {
                        var key = String(x.coinid).toLowerCase(), was = bo[key];
                        if (!err && txpowid) return delete bo[key];
                        wait = Math.min(BACKOFF_MAX, was ? was.wait * 2 : BACKOFF_FIRST);
                        bo[key] = { until: tip + wait, wait: wait };
                    });
                    // MINOR 7: no txpowid after a post is "possibly posted", not a failure to retry at once
                    if (!err && !txpowid) { err = new Error('relock: posted without a txpowid, possibly in the mempool: its coins are looked at again from block ' + (tip + wait)); err.pending = true; }
                    mds.kvSet('relock_backoff', JSON.stringify(bo), function () { cb(err, txpowid || null, ids); });
                }
                var tok = batch[0].tokenid, id = 'rl' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), n = 0;
                var steps = ['txncreate id:' + id];
                for (i = 0; i < batch.length; i++) steps.push('txninput id:' + id + ' coinid:' + batch[i].coinid + ' scriptmmr:true');
                for (i = 0; i < batch.length; i++) steps.push('txnoutput id:' + id + ' amount:' + F.plain(F.coinValue(batch[i])) + ' address:' + toAddress + (String(tok).toLowerCase() === F.MINIMA ? '' : ' tokenid:' + tok));
                steps.push('txnsign id:' + id + ' publickey:auto');
                (function step() {
                    if (n >= steps.length) {
                        return mds.cmdR('txnpost id:' + id, function (e, post) {
                            var txpowid = F.postedId(post);   // 0.0.157: top level on a real node
                            mds.cmd('txndelete id:' + id, function () { done(e ? new Error('txnpost: ' + e.message) : null, txpowid); });
                        });
                    }
                    var c = steps[n++];
                    mds.cmdR(c, function (e) { if (e) return mds.cmd('txndelete id:' + id, function () { done(new Error(c.split(' ')[0] + ': ' + e.message)); }); step(); });
                })();
            });
        });
    }

    /** review 22 Nov (M2): ONE "held" rule for every coin chooser (placement, refresh re-backing and relocks, the ladder
     *  batch, the ladder split): a coin in a take of mine awaiting its maker or being voided (kv pending_takes / void_takes
     *  `mine`), or reserved by the resting engine (PandaCoinLock, PoolInputClaims), is never picked. Coins backing or
     *  relocking for another live order are excluded by the callers (coinsBackingOthers, allocate's taken).
     *  cb(unheld) where unheld(coins) → those of `coins` not held. */
    function holds(mds, cb) {
        var ids = {};
        mds.kvGet('pending_takes', '{}', function (pt) { mds.kvGet('void_takes', '{}', function (vt) { mds.kvGet('myorders', '[]', function (mo) {
            [pt, vt].forEach(function (v) { var m = {}; try { m = JSON.parse(v || '{}') || {}; } catch (e) { m = {}; }
                Object.keys(m).forEach(function (k) { ((m[k] && m[k].mine) || []).forEach(function (id) { ids[String(id).toLowerCase()] = true; }); }); });
            // 0.0.161: my coins in a PROVISIONAL fill (posted, not yet mined or given back) — never picked until it settles
            // 0.0.179: and its payment coin (`p`), the evidence settleFills proves it mined by
            parseList(mo).forEach(function (o) { ((o && o.prov) || []).forEach(function (p) { ((p && p.c) || []).concat(p && p.p ? [p.p] : []).forEach(function (id) { ids[String(id).toLowerCase()] = true; }); }); });
            pageHolds(mds, ids, function () {
                cb(function (coins) {
                    return (coins || []).filter(function (c) {
                        var k = String(c.coinid).toLowerCase();
                        return !ids[k] && !(g.PandaCoinLock && g.PandaCoinLock.isReserved(k)) && !(g.PoolInputClaims && g.PoolInputClaims.blocked([k]));
                    });
                });
            });
        }); }); });
    }
    /** Review 23 Nov (MINOR): the page (index.html) loads neither resting/funding.js nor resting/input-claims.js, so there
     *  PandaCoinLock and PoolInputClaims are undefined and holds() ignored the resting engine's reservations. Where they
     *  are missing, read what the service keeps: kv 'coinlock_held' ({lc coin id: until ms}, service.js mirrorCoinLock)
     *  and the durable claims table pp_posted_inputs (resting/input-claims.js). Adds to `ids`. */
    function pageHolds(mds, ids, done) {
        if (g.PandaCoinLock && g.PoolInputClaims) return done();
        mds.kvGet('coinlock_held', '{}', function (v) {
            var m = {}, now = Date.now(), k; try { m = JSON.parse(v || '{}') || {}; } catch (e) { m = {}; }
            for (k in m) if (m.hasOwnProperty(k) && Number(m[k]) > now) ids[String(k).toLowerCase()] = true;
            if (typeof mds.sql !== 'function') return done();
            mds.sql('SELECT coinid FROM pp_posted_inputs', function (r) {   // no table yet: nothing claimed
                ((r && r.status && r.rows) || []).forEach(function (row) { var c = row.COINID || row.coinid; if (c) ids[String(c).toLowerCase()] = true; });
                done();
            });
        });
    }

    function coinsBackingOthers(list, exceptId) {
        var ids = [];
        for (var i = 0; i < list.length; i++) if (list[i].status === 'live' && list[i].orderId !== exceptId) ids = ids.concat(list[i].coins || [], list[i].relocking || []);
        return ids;
    }

    function envelopeFor(me, o) {
        return E.order(me, { market: MARKET, side: o.side, price: o.price, amount: o.status === 'live' ? o.remaining : '0',
                             coins: o.status === 'live' ? o.coins : [], scripts: o.status === 'live' ? (o.scripts || []) : [],
                             address: o.address, orderId: o.orderId, seq: o.seq, expiry: o.expiry });
    }

    /** Publish one order's current state to the relays and persist. cb(err, results). */
    function publish(mds, relay, me, o, cb) {
        var raw;
        try { raw = envelopeFor(me, o); } catch (e) { return cb(e); }
        relay.publish(raw, function (results) {
            var ok = 0; for (var i = 0; i < results.length; i++) if (results[i].ok) ok++;
            cb(ok ? null : new Error('no relay accepted the order' + (results.length ? ': ' + results[0].error : ' (no relays)')), results);
        });
    }

    /** Create: select backing coins, save, sign and publish (0.0.149: saved first). cb(err, order, relayResults, notice).
     *  err: nothing was placed. notice is '' when the order is live to takers now, else what placement() needed (its coins
     *  are being refreshed: live after the next block), or that no relay took it yet (it is stored: re-sent by syncRelays). */
    function create(mds, relay, me, params, cb) {
        var side = params.side, price = F.plain(F.d(params.price)), amount = F.plain(F.down8(F.d(params.amount)));
        if (side !== 'buy' && side !== 'sell') return cb(new Error('side must be buy or sell'));
        if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(price) || F.d(price).lte(0)) return cb(new Error('price must be a positive decimal with at most 8 dp'));
        if (F.d(amount).lte(0)) return cb(new Error('amount must be positive'));
        load(mds, function (e0, list) {
            mds.cmdR('getaddress', function (e1, addr) {
                if (e1 || !addr || !addr.address) return cb(e1 || new Error('getaddress failed'));
                walletCoins(mds, side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, all) {
                    if (e2) return cb(e2);
                    holds(mds, function (unheld) { var coins = unheld(all);
                    chainCtx(mds, function (tip, maxAge, legacy) { proofedOf(mds, coins, tip, maxAge, legacy, function (pf) {
                    var pl;
                    try { pl = placement(side, price, amount, coins, coinsBackingOthers(list, null), tip, maxAge, pf); } catch (e) { return cb(e); }
                    var bytes = new Uint8Array(8);
                    fillRandom(bytes);
                    var o = { orderId: '0x' + AX.hex.to(bytes), side: side, price: price, amount: amount, remaining: amount, coins: pl.coins, scripts: scriptsFor(coins, pl.coins),
                              address: addr.address, seq: now(), expiry: now() + EXPIRY_SECONDS, status: 'live', created: now(), fillsFrom: now() };
                    if (pl.relocking.length) o.relocking = pl.relocking;
                    // review 23 Nov (0.0.149): SAVED first, as edit and cancel since 0.0.140. It was published first, so a save
                    // that failed (the store lock held past its wait) left a GHOST on every relay: in no store, refused on
                    // take, never cancelled. Now a failed save publishes and relocks nothing; once saved, a relay that
                    // refuses is no failure of the order: syncRelays re-sends every live order a relay lacks
                    list.push(o);
                    commit(mds, relay, me, list, true, function (e4) {
                        if (e4) return cb(e4);
                        publish(mds, relay, me, o, function (e3, results) {
                            if (e3) return cb(null, o, results || [], 'placed, but no relay took it yet (' + (e3.message || e3) + '): it is re-sent to the relays within a minute');
                            var had = o.relockError;
                            startRelock(mds, o, pl.relock, addr.address, function (notice) {
                                if (o.relockError === had) return cb(null, o, results, notice);
                                commit(mds, relay, me, list, true, function (e5) { cb(e5, o, results, notice); });   // keep the relock's outcome
                            });
                        });
                    });
                    }); });
                    });
                });
            });
        });
    }
    /** orderId only needs uniqueness, not secrecy: browser CSPRNG when present, else Math.random (Rhino). */
    function fillRandom(u8) {
        if (g.crypto && g.crypto.getRandomValues) { g.crypto.getRandomValues(u8); return; }
        for (var i = 0; i < u8.length; i++) u8[i] = Math.floor(Math.random() * 256);
    }

    /** Cancel: amount 0 with a higher seq, saved, then published. Review 23 Nov (MINOR-6): the save (the merge) decides
     *  first and only what it kept is published — it used to publish before the merge, so a cancel of an order that had
     *  filled meanwhile went out anyway. */
    function cancel(mds, relay, me, orderId, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o) return cb(new Error('unknown order'));
            o.status = 'cancelled'; o.seq = nextSeq(o); o.expiry = closeExpiry(o);
            commit(mds, relay, me, list, true, function (e2, lost) {
                var st = find(list, orderId);   // review 23 Nov (M4): it filled while the cancel was on its way
                if (e2) return cb(e2, o);
                if (lost.indexOf(orderId) >= 0) return cb(st && st.status === 'filled' ? new Error('this order filled before the cancel landed — nothing to cancel') : null, st);
                publish(mds, relay, me, o, function (e1, results) { overStale(mds, relay, me, list, o, results, e1, cb); });   // a refusal: syncRelays re-sends it
            });
        });
    }

    /** The highest seq of a LIVE copy of MY order `orderId` among relay envelopes `has` (-1: none). */
    function liveSeqOn(has, mySignPk, orderId) {
        var top = -1;
        (has || []).forEach(function (e) { if (e && e.orderId === orderId && String(e.signPk).toLowerCase() === String(mySignPk).toLowerCase() && !E.isCancelAmount(String(e.amount)) && Number(e.seq) > top) top = Number(e.seq); });
        return top;
    }
    /** Gate review 23 Nov (b): 'stale seq' = a relay holds this order at the same or a newer seq. That used to be taken as
     *  "the cancel is there already" — but the copy it holds may be a LIVE re-sign signed after the cancel's seq was taken,
     *  and the order then stayed live on that relay. Each relay that said so is asked for its book: a live copy at a seq ≥
     *  the cancel's raises the stored seq above it, saved (mine), and the cancel is sent again; 'stale seq' is no error only
     *  after that bump, or when the relay holds no live copy (the cancel sent twice). A relay whose book cannot be read
     *  keeps the publish's error (syncRelays re-sends it). cb(err, o). */
    function overStale(mds, relay, me, list, o, results, e1, cb) {
        var urls = (results || []).filter(function (r) { return r && r.error === 'stale seq'; }).map(function (r) { return r.url; }), top = -1, unread = false, i = 0;
        if (!urls.length) return cb(e1, o);
        if (typeof relay.snapshot !== 'function') return cb(e1, o);
        (function next() {
            if (i < urls.length) return relay.snapshot(urls[i++], function (err, has) { if (err) unread = true; else top = Math.max(top, liveSeqOn(has, '0x' + AX.hex.to(me.signPk), o.orderId)); next(); });
            if (top < o.seq) return cb(unread ? e1 : null, o);
            o.seq = Math.max(top + 1, nextSeq(o)); o.expiry = closeExpiry(o);
            commit(mds, relay, me, list, true, function (e2, lost) {
                var st = find(list, o.orderId);
                if (e2) return cb(e2, o);
                if (lost.indexOf(o.orderId) >= 0) return cb(st && st.status === 'filled' ? new Error('this order filled before the cancel landed — nothing to cancel') : null, st);
                publish(mds, relay, me, o, function (e3) { cb(e3 && /stale seq$/.test(String(e3.message || e3)) ? null : e3, o); });
            });
        })();
    }

    /** Review 22 Nov (MINOR 1): is a relock of `o`'s coins still on its way, judged from the coins themselves? Yes when one
     *  of its `relocking` coins is missing from the wallet (read with checkmempool) yet unspent on chain: it sits in the
     *  mempool. A coin spent on chain means the relock confirmed (its new coin is free, or went to another order). It
     *  used to be "none of them in the wallet", which stayed true after the relock confirmed. cb(yes). */
    function relockInFlight(mds, o, wallet, cb) {
        var gone = (o.relocking || []).filter(function (id) { return !wallet.some(function (c) { return String(c.coinid).toLowerCase() === String(id).toLowerCase(); }); });
        (function next() {
            if (!gone.length) return cb(false);
            mds.cmdR('coins relevant:true coinid:' + gone.shift(), function (e, rows) { if (!e && rows && rows.length) return cb(true); next(); });
        })();
    }

    /** Edit price and/or amount: re-select backing (placement(), as create), higher seq, publish. cb(err, order, notice). */
    function edit(mds, relay, me, orderId, params, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o || o.status !== 'live') return cb(new Error('order is not live'));
            var price = params.price !== undefined ? F.plain(F.d(params.price)) : o.price;
            var amount = params.amount !== undefined ? F.plain(F.down8(F.d(params.amount))) : o.remaining;
            if (F.d(price).lte(0) || F.d(amount).lte(0)) return cb(new Error('price and amount must be positive'));
            walletCoins(mds, o.side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, all) {
                if (e2) return cb(e2);
                holds(mds, function (unheld) { var coins = unheld(all);
                chainCtx(mds, function (tip, maxAge, legacy) { proofedOf(mds, coins, tip, maxAge, legacy, function (pf) {
                var pl;
                try { pl = placement(o.side, price, amount, coins, coinsBackingOthers(list, orderId), tip, maxAge, pf); }
                catch (e) {
                    // its own relock is still confirming: re-priced, still waiting (never for more than the relock brings back)
                    if (!(tip > 0) || (o.coins || []).length || giveOf(o.side, price, amount).gt(giveOf(o.side, o.price, o.remaining))) return cb(e);
                    return relockInFlight(mds, o, all, function (yes) { if (!yes) return cb(e); go({ coins: [], relock: [], relocking: [] }, true); });
                }
                go(pl, false);
                function go(pl, waiting) {
                o.price = price; o.amount = amount; o.remaining = amount; o.coins = pl.coins; o.scripts = scriptsFor(coins, pl.coins); o.seq = nextSeq(o); o.expiry = now() + EXPIRY_SECONDS;
                delete o.prov;   // 0.0.161: the size set here is what is advertised; a provisional fill never gives back on top of it
                if (pl.relocking.length) o.relocking = pl.relocking;
                else if (!waiting) { delete o.relocking; delete o.relockError; }
                // review 23 Nov (MINOR-6): saved first — a fill that landed meanwhile refuses the edit before anything reaches a relay
                commit(mds, relay, me, list, true, function (e4, lost) {
                    if (e4) return cb(e4, o, '');
                    if (lost.indexOf(orderId) >= 0) return cb(new Error(editLost(find(list, orderId))), find(list, orderId), '');   // M4: the stored copy stands
                    publish(mds, relay, me, o, function (e3) {
                        // a refused publish relocks nothing now: refresh relocks o.relocking within a minute (syncRelays re-sends)
                        if (e3 || !pl.relock.length) return cb(e3, o, waiting ? PENDING_NOTICE : '');
                        var had = o.relockError;
                        startRelock(mds, o, pl.relock, o.address, function (notice) {
                            if (o.relockError === had) return cb(null, o, notice);
                            commit(mds, relay, me, list, true, function (e5) { cb(e5, o, notice); });   // keep the relock's outcome
                        });
                    });
                });
                }
                }); });
                });
            });
        });
    }

    /** 0.0.161: record a provisional fill on `o` once (by txpowid). 0.0.179: `p` = the take's payment coin id, held from
     *  every chooser until the fill settles (so this MiniDapp never spends the evidence before settleFills has seen it). */
    function addProv(o, txpowid, filled, coins, block, pay) {
        if ((o.prov || []).some(function (p) { return p.t === txpowid; })) return;
        var e = { t: txpowid, f: F.plain(F.d(filled)), c: (coins || []).slice(), b: Number(block) || 0 };
        if (TXID.test(String(pay || ''))) e.p = String(pay);
        o.prov = (o.prov || []).concat([e]);
    }

    function editLost(st) {
        if (!st) return 'the order changed while you were editing — nothing was changed';
        if (st.status === 'filled') return 'this order filled while you were editing — nothing was changed';
        if (st.status !== 'live') return 'this order was cancelled while you were editing — nothing was changed';
        return 'part of this order filled while you were editing (' + st.remaining + ' MINIMA left) — nothing was changed; edit it again';
    }

    /**
     * After a fill the maker signed: reduce remaining, drop the spent coins (the change coin joins once it
     * confirms, via refresh), republish or mark filled. cb(err, order). txpowid (0.0.133): the fill's posted txpowid.
     * Review 23 Nov (M4): a user edit saved between this load and its save makes this background save lose; the fill is
     * then applied again to the stored copy (at most 3 rounds), the spent coins dropped. A cancelled order stays
     * cancelled. Every round: remaining = min(stored remaining, `verified`) − filled, `verified` = the remaining the take
     * was checked against (service.js passes it; else the first load's), so an edit never adds back what was sold.
     * Review 23 Nov (MINOR-3): the applied fill's txpowid is recorded on the order (o.fills), so it is applied once;
     * after 3 lost rounds, or any failed save, the callback gets an ERROR (it used to report success with the fill
     * never deducted), and refresh deducts it from its kv fill_ record (reconcileFills).
     */
    /** 0.0.161 (review, MAJOR — phantom fills): `prov` ({b: the tip block at the post}) marks the fill PROVISIONAL: posted,
     *  not yet mined. It is deducted here as before (so the published size never exceeds what can still be sold) and kept
     *  on the order as o.prov [{t: txpowid, f: filled, c: my spent coins, b}] until settleFills sees it mined (entry
     *  dropped) or never mined (the size given back to a still-live order: settleProv). Its coins stay held (holds()). */
    function afterFill(mds, relay, me, orderId, filled, spentCoinIds, cb, txpowid, verified, prov) {
        var base = null;
        // review 23 Nov (0.0.146): the txpowid is what makes a fill count ONCE (o.fills; reconcileFills deducts every maker
        // fill_ record whose txpowid an order does not list). Applied without one, the next refresh deducted it AGAIN (a
        // host that passed none — the desktop desk — sold the order down twice). So it is required: without it nothing is
        // deducted here, loudly, and the refresh deducts the fill from its record, once.
        if (!/^0x[0-9A-Fa-f]{64}$/.test(String(txpowid || ''))) return cb(new Error('the fill of ' + filled + ' MINIMA on order ' + orderId + ' was NOT applied: afterFill needs its txpowid to count it once (nothing deducted here; the next refresh deducts it from its fill_ record)'));
        (function round(r) {
            load(mds, function (e0, list) {
                var o = find(list, orderId);
                if (!o) return cb(new Error('unknown order'));
                if ((o.fills || []).indexOf(txpowid) >= 0) return cb(null, o);   // applied already
                if (r && o.status !== 'live') return cb(null, o);                          // cancelled or filled by the writer that won
                // 0.0.139: the fill counts against the size the take was checked against (`verified`, the order's remaining
                // then), whatever an edit did meanwhile: remaining = min(stored, verified) − filled. An edit that landed
                // between the take's check and this load used to have the fill deducted from ITS size (150 − 100 = 50 live
                // on an order that had sold all 100)
                if (base === null) base = verified !== undefined && verified !== null ? F.d(verified) : F.d(o.remaining);
                var cur = F.d(o.remaining), rem = (cur.lt(base) ? cur : base).minus(F.d(filled));
                var spent = {}; for (var i = 0; i < spentCoinIds.length; i++) spent[String(spentCoinIds[i]).toLowerCase()] = true;
                o.coins = (o.coins || []).filter(function (c) { return !spent[String(c).toLowerCase()]; });
                o.remaining = rem.gt(0) ? F.plain(rem) : '0';
                if (rem.lte(0) || dust(rem, o.amount)) o.status = 'filled';   // dust left over closes the order
                o.fills = (o.fills || []).concat([txpowid]);   // 0.0.147: never cut here; reconcileFills compacts it
                if (prov) addProv(o, txpowid, filled, spentCoinIds, prov.b, prov.p);
                o.seq = nextSeq(o);
                if (o.status === 'filled') { o.expiry = closeExpiry(o); }
                // gate review 23 Nov (b): SAVED first, then published only if the save kept it (as cancel): it used to publish
                // before the merge, so a round that lost still put its envelope on the relays
                commit(mds, relay, me, list, false, function (e2, lost) {
                    if (e2) return cb(e2, find(list, orderId));
                    if (lost.indexOf(orderId) >= 0) {
                        if (r < 2) return round(r + 1);
                        return cb(new Error('the fill of ' + filled + ' MINIMA (txpow ' + txpowid + ') was NOT applied to order ' + orderId + ': another writer changed it three times; the next refresh deducts it from the fill record'), find(list, orderId));
                    }
                    publish(mds, relay, me, o, function (e1) { cb(e1, find(list, orderId)); });   // a refusal: syncRelays re-sends it
                });
            });
        })(0);
    }
    /** 0.0.147 (review 23 Nov, the FILLS_KEPT cascade): `fills` was cut to its last 200 ids, so once an order had more than
     *  200 applied fills the refresh re-deducted every one that fell off (measured: 99598 left instead of 99799) — and a
     *  ladder rung lives for days. It is never cut now. Instead each refresh compacts it against the fill_ records (the
     *  source of truth): the ids of fills recorded more than FILLS_SETTLED_S ago — by then written, and applied by
     *  afterFill or by this pass — leave the list and `fillsFrom` (the high-water mark: records before it are never
     *  looked at again) moves past them. */
    var FILLS_SETTLED_S = 600, PLAIN = /^[0-9]+(\.[0-9]+)?$/;
    function sizeOf(v) { var n = Number(v); return n > 0 ? n : 0; }   // sort key only
    /** MINOR-3: deduct every maker fill (kv fill_<txpowid>, role maker, written by service.js handleTake before afterFill)
     *  of a live order that its `fills` does not list yet, once; tracking starts at o.fillsFrom (set at create, or at the
     *  first refresh of an order made before 0.0.133, so older fills are never deducted twice). Changes `list`; cb(changed
     *  orders). No SQL (tests): nothing. */
    function reconcileFills(mds, list, cb) {
        var changed = [];
        list.forEach(function (o) { if (o.status === 'live' && !(o.fillsFrom > 0)) { o.fillsFrom = now(); } });
        if (typeof mds.sql !== 'function') return cb(changed);
        // NIT (review 23 Nov, 0.0.148): the fill_ records are kept for good (history, ledgers), and every refresh read them
        // ALL. Only the records of the orders live here are read now (a record names its order: `"orderId":"<id>"`); the
        // match is re-checked below, so a looser LIKE only costs a row
        var pats = list.filter(function (o) { return o.status === 'live' && o.orderId; }).map(function (o) { return "v LIKE '%" + ('"orderId":' + JSON.stringify(String(o.orderId))).split("'").join("''") + "%'"; });
        if (!pats.length) return cb(changed);
        mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%' AND (" + pats.join(' OR ') + ")", function (r) {
            var todo = [];
            ((r && r.status && r.rows) || []).forEach(function (row) {
                var f; try { f = JSON.parse(row.V || row.v); } catch (e) { return; }
                if (!f || f.role !== 'maker' || f.status === 'lost' || !/^0x[0-9A-Fa-f]{64}$/.test(String(f.txpowid))) return;
                // gate review 23 Nov (c): only a plain decimal fill > 0, and a `verified` (when the record has one) that is a
                // plain non-negative decimal: a negative fill ADDED to the order, and junk `verified` fell back to the
                // stored size. A record that cannot be applied is never waited for
                if (!PLAIN.test(String(f.filled)) || !F.d(String(f.filled)).gt(0)) return;
                if (f.verified !== undefined && f.verified !== null && !PLAIN.test(String(f.verified))) return;
                todo.push(f);
            });
            // review 23 Nov (0.0.145): in the order they were taken (time, then the larger checked size first: a later take
            // of one order was checked against what the earlier one left)
            todo.sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0) || (sizeOf(b.verified) - sizeOf(a.verified)); });
            todo.forEach(function (f) {
                var o = find(list, f.orderId), rem, cur, v;
                if (!o || o.status !== 'live' || !(Number(f.ts) >= o.fillsFrom) || (o.fills || []).indexOf(f.txpowid) >= 0) return;
                // review 23 Nov (0.0.145, the 0.0.139 rule afterFill keeps): the fill counts against the size its take was
                // checked against (`verified`, kept on the record by service.js), not against an edit saved after the check:
                // remaining = min(stored, verified) − filled. A record without it (before 0.0.145): stored − filled.
                try { cur = F.d(o.remaining); v = PLAIN.test(String(f.verified)) ? F.d(String(f.verified)) : cur; rem = (v.lt(cur) ? v : cur).minus(F.d(f.filled)); } catch (e) { return; }
                o.remaining = rem.gt(0) ? F.plain(rem) : '0';
                if (rem.lte(0) || dust(rem, o.amount)) { o.status = 'filled'; o.expiry = closeExpiry(o); }
                o.fills = (o.fills || []).concat([f.txpowid]);
                if (f.prov === true && f.status === 'settling') addProv(o, f.txpowid, f.filled, f.ins || [], f.postBlock, f.pay && f.pay.id);   // 0.0.161
                if (changed.indexOf(o) < 0) changed.push(o);
            });
            // 0.0.147: every record of a live order from fillsFrom on is applied now (or the order closed above); those
            // older than FILLS_SETTLED_S leave `fills`, and fillsFrom moves past them
            var cut = now() - FILLS_SETTLED_S;
            list.forEach(function (o) {
                if (o.status !== 'live' || !(o.fills || []).length) return;
                var old = {};
                todo.forEach(function (f) { if (f.orderId === o.orderId && Number(f.ts) <= cut) old[f.txpowid] = true; });
                var keep = o.fills.filter(function (id) { return !old[id]; });
                if (keep.length < o.fills.length) { o.fills = keep; o.fillsFrom = Math.max(o.fillsFrom, cut + 1); }
            });
            cb(changed);
        });
    }

    /**
     * 0.0.161 (review, MAJOR — phantom fills). `txnpost` does no mempool double-spend check (txnpost.java postTxn; a
     * locally mined TxPoW meets checkMemPoolCoins only afterwards, in NIOMessage, and is then dropped silently), so a fill
     * counted at the post could be a sale that never happens. A maker fill is therefore PROVISIONAL (fill_ record
     * prov:true with `ins` = my spent coins and `postBlock`, o.prov on the order) until this pass settles it.
     *
     * 0.0.179 (review, MAJOR 1 + 2): settled by POSITIVE EVIDENCE only, never by "my first input is spent" — any transaction
     * spending that coin (a relock, a split, the resting engine, a wallet send, another take) spends it, and every one of
     * them has its outputs at the very same coin ids (lib/fill.js outputCoinId: unique per spent coin, not per transaction).
     * Nothing here runs unless `block` answers a tip > 0 and ≥ the post's block (a resync, megammrsync or restore answers
     * `coins` with status true and [] — read as "spent" that used to settle and give back blind); a read error is
     * "unknown, look again next pass".
     *   MINED   the take's OWN payment coin `pay` (the first output paying my order address: id hash(first input, k), its
     *           address, token and amount — lib/fill.js cosign) is mine, so `coins relevant:true coinid:` finds it at any
     *           age; it must match in all four. Seen once, the sighting is kept on the record (`seen`, its created block), so
     *           a payment I spend straight away stays proven. Failing that, `txpow relevant:true` (this node keeps its
     *           relevant TxPoWs for days) is searched for a transaction with the same first input, and `txpow onchain:`
     *           gives its block (a txnpost id is pre-mining: the mined one is found by its first input, never by that id).
     *           'done' only CONFIRM_BLOCKS (64, ~53 min) after the payment's block: until then the fill stays provisional
     *           (deducted, coins held) and a reorg that brings my input back unspent clears the sighting. 64 is past any
     *           ordinary reorg; a split as long as 13 Nov 2026 (days on the wrong branch) is past every depth, and then
     *           this pass is as wrong as the chain it reads — the deduction it keeps is the safe side.
     *   SPENT ELSEWHERE  the coin at the payment's id is mine but NOT this payment, or an on-chain transaction with the same
     *           first input pays something else → 'lost' (why says so) and a still-live order gets the size back.
     *   NEVER MINED  my input `ins[0]` unspent and out of the mempool GIVE_BACK_BLOCKS (16) past the post → 'lost', the
     *           size back to a still-live order (settleProv).
     *   otherwise (in the mempool, younger, or no evidence either way) it is looked at again on the next pass: never 'done'
     *           and never given back on silence.
     * A 'lost' record whose payment later proves mined (the same evidence) is re-applied ONCE through afterFill (its
     * txpowid counts it once), provisional again with `reapplied`, and settles as above. Records without `pay` (0.0.161–
     * 0.0.178) are judged by the payments they can only have made: hash(ins[0], k) for k < 4 at the order's address, token
     * and `received`. Records written before 0.0.161 (no `ins`) keep the old rule (an output coin on chain → done; 2 hours
     * without → lost). Taker records carrying `pay` (0.0.179: my received coin) settle by the same evidence; nothing is given
     * back for them. notify(obj) is told of every record that changed. cb().
     */
    var GIVE_BACK_BLOCKS = 16, CONFIRM_BLOCKS = 64, SCAN_EVERY = 10, LOST_RECHECK_S = 24 * 3600, OLD_LOST_S = 2 * 3600, TXID = /^0x[0-9A-Fa-f]{64}$/;
    function lcEq(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
    /** A node row `c` IS payment `p` (same id, and address when `p` names one, token and exact amount). */
    function isPay(c, p) {
        if (!c || !lcEq(c.coinid, p.id) || !lcEq(c.tokenid, p.tokenid) || (p.address && !lcEq(c.address, p.address))) return false;
        try { return F.coinValue(c).eq(F.d(p.amount)); } catch (e) { return false; }
    }
    /** The payments record `f` can have made: [{id, k, address, tokenid, amount, exact}]. exact = recorded at the co-sign. */
    function paysOf(f, list) {
        var o, out = [], k;
        if (f.pay && TXID.test(String(f.pay.id))) return [Object.assign({ exact: true }, f.pay)];
        if (f.role === 'maker' && f.ins && TXID.test(String(f.ins[0])) && PLAIN.test(String(f.received)) && (o = find(list || [], f.orderId)) && o.address) {
            for (k = 0; k < 4; k++) { try { out.push({ id: F.outputCoinId(f.ins[0], k), k: k, address: o.address, tokenid: f.side === 'sell' ? F.MXUSD : F.MINIMA, amount: f.received }); } catch (e) { return []; } }
        } else if (f.role === 'taker' && f.coins && TXID.test(String(f.coins[0])) && PLAIN.test(String(f.got))) {
            out.push({ id: f.coins[0], k: 0, tokenid: f.side === 'buy' ? F.MINIMA : F.MXUSD, amount: f.got });
        }
        return out;
    }
    /** cb({paid: block} | {other: why} | {}) — the evidence for `f` (see settleFills). */
    function evidence(mds, f, list, tip, cb) {
        var ps = paysOf(f, list), j = 0;
        if (!ps.length) return cb({});
        (function next() {
            if (j >= ps.length) return f.seen > 0 ? cb({ paid: Number(f.seen) }) : scan();
            var p = ps[j++];
            mds.cmdR('coins relevant:true coinid:' + p.id, function (e, rows) {
                var c = !e && Object.prototype.toString.call(rows) === '[object Array]' ? rows[0] : null;
                if (c && isPay(c, p)) return cb({ paid: parseInt(c.created, 10) || tip });
                if (c && p.exact) return cb({ other: 'coin ' + p.id + ' (output ' + p.k + ' of every transaction spending ' + (f.first || (f.ins || [])[0]) + ') is ' + F.plain(F.coinValue(c)) + ' at ' + c.address + ', not this take\'s payment of ' + p.amount + ' to ' + p.address });
                next();
            });
        })();
        // a payment I already spent before any pass saw it: the mined transaction, found by its first input
        function scan() {
            var p = ps[0];
            if (!p.exact || !TXID.test(String(f.first)) || (f.scanAt > 0 && tip - f.scanAt < SCAN_EVERY)) return cb({});
            f.scanAt = tip;
            mds.cmdR('txpow relevant:true max:100', function (e, txps) {
                var none = { scanned: true };
                var hits = [], k = 0;
                (Object.prototype.toString.call(txps) === '[object Array]' ? txps : []).forEach(function (x) {
                    var t = x && x.body && x.body.txn, i0 = t && t.inputs && t.inputs[0], o = t && t.outputs && t.outputs[p.k];
                    if (!i0 || !lcEq(i0.coinid, f.first) || !TXID.test(String(x.txpowid))) return;
                    hits.push({ id: x.txpowid, pays: !!o && isPay(Object.assign({}, o, { coinid: p.id }), p) });
                });
                (function on() {
                    if (k >= hits.length) return cb(none);
                    var h = hits[k++];
                    mds.cmdR('txpow onchain:' + h.id, function (e2, r) {
                        var b = !e2 && r && r.found === true ? parseInt(r.block, 10) : 0;
                        if (!(b > 0)) return on();
                        cb(h.pays ? { paid: b } : { other: 'txpow ' + h.id + ' on chain at block ' + b + ' spends ' + f.first + ' without this take\'s payment' });
                    });
                })();
            });
        }
    }
    function settleFills(mds, relay, me, notify, cb) {
        notify = notify || function () { };
        cb = cb || function () { };
        if (typeof mds.sql !== 'function') return cb();
        mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", function (r) {
            var rows = (r && r.status && r.rows) || [], i = 0, tip = 0, open = {}, list = [];
            mds.cmdR('block', function (eb, b) {
                tip = (!eb && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
                if (!(tip > 0)) return cb();   // MAJOR 2: no tip, no verdict (a null tip answers every `coins` with [])
                load(mds, function (e0, l) {
                    list = l || [];
                    list.forEach(function (o) { (o.prov || []).forEach(function (p) { open[p.t] = true; }); });
                    step();
                });
            });
            function save(f, then) { mds.kvSet('fill_' + f.txpowid, JSON.stringify(f), function () { notify({ type: 'fill', txpowid: f.txpowid, status: f.status }); then(); }); }
            function step() {
                if (i >= rows.length) return cb();
                var f = null; try { f = JSON.parse(rows[i].V || rows[i].v); } catch (e) { f = null; } i++;
                if (!f || !TXID.test(String(f.txpowid))) return step();
                if (tip < (Number(f.postBlock) || 0)) return step();   // MAJOR 2: this node is behind the post: unknown
                if (f.prov === true && Object.prototype.toString.call(f.ins) === '[object Array]' && TXID.test(String(f.ins[0]))) return prov(f);
                if (f.status === 'settling' && f.role === 'taker' && paysOf(f, list).length) return taker(f);
                if (f.status === 'settling') return old(f);
                step();
            }
            function drop(f, give) { if (!open[f.txpowid]) return step(); settleProv(mds, relay, me, f.orderId, f.txpowid, give, function () { step(); }); }
            function lose(f, why) { f.status = 'lost'; f.lostAt = now(); f.why = why; delete f.seen; save(f, function () { drop(f, true); }); }
            /** paid at block `blk`: 'done' once CONFIRM_BLOCKS deep, else the sighting is kept (provisional) */
            function paid(f, blk, then) {
                var was = f.seen;
                f.seen = Number(f.seen) > 0 ? Math.min(Number(f.seen), blk) : blk;
                if (tip - f.seen >= CONFIRM_BLOCKS) { f.status = 'done'; f.block = f.seen; delete f.why; return save(f, then); }
                if (was !== f.seen) return save(f, function () { step(); });
                step();
            }
            function prov(f) {
                if (f.status === 'done') return drop(f, false);
                if (f.status === 'lost') return lost(f);
                if (f.status !== 'settling') return step();
                mds.cmdR('coins relevant:true coinid:' + f.ins[0], function (e0, onChain) {
                    if (e0 || Object.prototype.toString.call(onChain) !== '[object Array]') return step();   // unknown
                    if (!onChain.length) {
                        return evidence(mds, f, list, tip, function (ev) {
                            if (ev.paid > 0) return paid(f, ev.paid, function () { drop(f, false); });
                            if (ev.other) return lose(f, 'spent elsewhere: ' + ev.other + ' — the size went back to the order');
                            if (ev.scanned) return save(f, step);   // keep the scan pacing
                            step();
                        });
                    }
                    if (f.seen) { delete f.seen; return save(f, step); }   // my input is back unspent (a reorg): not mined here
                    mds.cmdR('coins relevant:true checkmempool:true coinid:' + f.ins[0], function (e1, rs) {
                        if (e1 || !(rs && rs.length)) return step();   // being spent (the fill, in the mempool): wait
                        var from = Number(f.postBlock) || Number(f.seenBlock) || 0;
                        if (!from) { f.seenBlock = tip; return save(f, step); }   // no post height recorded: counted from now
                        if (tip - from < GIVE_BACK_BLOCKS) return step();
                        lose(f, 'never mined: my coin ' + f.ins[0] + ' was unspent and out of the mempool ' + (tip - from) + ' blocks after the post — the size went back to the order');
                    });
                });
            }
            function lost(f) {
                if (open[f.txpowid]) return drop(f, true);   // the give-back did not save last time: again
                if (f.reapplied || now() - (Number(f.lostAt) || Number(f.ts) || 0) > LOST_RECHECK_S) return step();
                evidence(mds, f, list, tip, function (ev) {
                    if (!(ev.paid > 0)) return ev.scanned ? save(f, step) : step();
                    // it mined after all (a reorg, a late rebroadcast): deducted again, provisional, settled as any other
                    afterFill(mds, relay, me, f.orderId, f.filled, f.ins, function (e) {
                        if (e) return step();   // tried again next pass (afterFill counts it once by its txpowid)
                        f.status = 'settling'; f.reapplied = true; f.seen = ev.paid; delete f.why;
                        save(f, step);
                    }, f.txpowid, f.verified, { b: Number(f.postBlock) || tip, p: f.pay && f.pay.id });
                });
            }
            function taker(f) {
                evidence(mds, f, list, tip, function (ev) {
                    if (ev.paid > 0) return paid(f, ev.paid, step);
                    if (ev.other) { f.status = 'lost'; f.lostAt = now(); f.why = ev.other; return save(f, step); }
                    if (ev.scanned) return save(f, step);
                    step();
                });
            }
            function old(f) {
                var probe = (f.coins && f.coins.length) ? f.coins[0] : null;
                if (!probe || !TXID.test(String(probe))) return step();
                mds.cmdR('coins coinid:' + probe, function (err, res) {
                    var c = (!err && res) ? (Object.prototype.toString.call(res) === '[object Array]' ? res[0] : res) : null;
                    if (c && c.coinid) { f.status = 'done'; f.block = c.created; return save(f, step); }
                    if (f.ts && now() - f.ts > OLD_LOST_S) { f.status = 'lost'; return save(f, step); }   // two hours without a block
                    step();
                });
            }
        });
    }
    /**
     * 0.0.180 (review, MAJOR 2): the state of MY coin `id`, judged only at a known tip. cb(state, tip):
     *   'unknown'  `block` gave no tip, or one below `minBlock` (the coin was known at that height: a node behind it, a
     *              resync, a megammrsync or a restore answers `coins` with status true and [] for everything), or a read
     *              failed — look again later, never a verdict;
     *   'unspent'  returned, and returned with checkmempool:true (not being spent);
     *   'mempool'  returned, but not with checkmempool:true (a pending transaction spends it);
     *   'spent'    not returned at a tip >= minBlock (`coins relevant:true` finds my unspent coin at any age).
     */
    function coinState(mds, id, minBlock, cb) {
        if (!TXID.test(String(id))) return cb('unknown', 0);
        mds.cmdR('block', function (eb, b) {
            var tip = (!eb && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
            if (!(tip > 0) || tip < (Number(minBlock) || 0)) return cb('unknown', tip);
            mds.cmdR('coins relevant:true coinid:' + id, function (e0, on) {
                if (e0 || Object.prototype.toString.call(on) !== '[object Array]') return cb('unknown', tip);
                if (!on.length) return cb('spent', tip);
                mds.cmdR('coins relevant:true checkmempool:true coinid:' + id, function (e1, rs) {
                    if (e1 || Object.prototype.toString.call(rs) !== '[object Array]') return cb('unknown', tip);
                    cb(rs.length ? 'unspent' : 'mempool', tip, rs[0] || on[0]);
                });
            });
        });
    }
    /** 0.0.180: a void record for a take I signed, from its pending record `pt` ({mine, act, plan, block}): `pay` = the take's
     *  output 0 to me (lib/fill.js plan: maker → taker), whose sight proves the take mined; `block` = the tip it was sent at. */
    function voidOf(pt) {
        var v = { mine: (pt && pt.mine) || [], act: (pt && pt.act) || '' }, p = pt && pt.plan, o = p && p.outputs && p.outputs[0];
        if (pt && Number(pt.block) > 0) v.block = Number(pt.block);
        try { if (o && p.inputs && p.inputs[0]) v.pay = { id: F.outputCoinId(p.inputs[0], 0), address: o.address, tokenid: o.tokenid, amount: o.amount }; } catch (e) { }
        return v;
    }
    /**
     * 0.0.180 (review, MAJOR 2): judge a void record `v` — a take I signed that was refused or unanswered; the maker keeps my
     * signed half (a free option) until one of my coins in it is spent. cb(verdict) with verdict:
     *   {settled: note}  my coin (`v.probe`: the first coin a relock of the void sent, else my first coin in the take) is
     *                    spent at a known tip AND there is POSITIVE evidence: the relock's own output (hash(coin, 0), its
     *                    token and amount: `v.rl`) or the take's own payment to me (`v.pay`) is on chain, or the coin has
     *                    stayed spent for VOID_SPENT_BLOCKS at known tips (v.spentAt: the first height it was seen spent);
     *   {relock: rows}   it is unspent and not being spent: relock these (all my coins of the take that are, when `v.all`);
     *   {wait: true}     being spent, spent without evidence yet, or unknown (no tip, a failed read): look again later.
     * v may be changed (spentAt): the caller saves it when `v.changed`.
     */
    var VOID_SPENT_BLOCKS = 16;
    function voidCheck(mds, v, cb) {
        var probe = String(v.probe || (v.mine || [])[0] || '');
        if (!TXID.test(probe)) return cb({ settled: '' });
        coinState(mds, probe, v.block, function (st, tip, row) {
            if (st === 'unknown' || st === 'mempool') return cb({ wait: true });
            if (st === 'unspent') {
                if (v.spentAt) { delete v.spentAt; v.changed = true; }
                if (!v.all) return cb({ relock: [row] });
                var rows = [row], rest = (v.mine || []).filter(function (x) { return TXID.test(String(x)) && !lcEq(x, probe); });
                return (function more() {
                    if (!rest.length) return cb({ relock: rows });
                    var id = rest.shift();
                    mds.cmdR('coins relevant:true checkmempool:true coinid:' + id, function (e, rs) { if (!e && rs && rs[0]) rows.push(rs[0]); more(); });
                })();
            }
            // spent at a known tip: positive evidence, or a spent state that has held for VOID_SPENT_BLOCKS
            var ev = [v.rl, v.pay].filter(function (x) { return x && TXID.test(String(x.id)); });
            (function next() {
                if (!ev.length) {
                    if (!(v.spentAt > 0)) { v.spentAt = tip; v.changed = true; }
                    if (tip - v.spentAt >= VOID_SPENT_BLOCKS) return cb({ settled: v.relocked ? 'Take voided: your coin ' + probe + ' was spent back to you, so the maker can no longer post your signed half.' : 'Your coin ' + probe + ' in this take is spent (for ' + (tip - v.spentAt) + ' blocks) — the maker can no longer post your signed half; check TRADES.' });
                    return cb({ wait: true });
                }
                var x = ev.shift();
                mds.cmdR('coins relevant:true coinid:' + x.id, function (e, rs) {
                    var c = !e && rs && rs[0];
                    if (c && isPay(c, x)) return cb({ settled: x === v.rl ? 'Take voided: your coin ' + probe + ' was spent back to you (coin ' + x.id + '), so the maker can no longer post your signed half.' : 'The maker posted this take: you received coin ' + x.id + ' — check TRADES.' });
                    next();
                });
            })();
        });
    }
    /** 0.0.180: after a void's relock posted: the evidence of it (output 0 of the relock = hash(its first input, 0), same
     *  token and amount), kept on `v`. rows = the coins given to relock(), sentIds = what it sent. */
    function voidRelocked(v, rows, sentIds) {
        var first = (sentIds || [])[0], r = (rows || []).filter(function (c) { return c && lcEq(c.coinid, first); })[0];
        v.relocked = true;
        if (!r) return;
        v.probe = r.coinid;
        try { v.rl = { id: F.outputCoinId(r.coinid, 0), tokenid: r.tokenid, amount: F.plain(F.coinValue(r)) }; } catch (e) { }
    }
    /** 0.0.162: the maker fill_ record of a posting record `p` posted as `txpowid` at tip `postBlock` (provisional). */
    function fillRecord(p, txpowid, postBlock) {
        var r = { role: 'maker', orderId: p.orderId, side: p.side, price: p.price, filled: p.filled, received: p.received, paid: p.paid, txpowid: txpowid,
                 coins: (p.outs || []).slice(), taker: p.taker, ts: Number(p.ts) || now(), status: 'settling', verified: p.verified, prov: true,
                 ins: (p.ins || []).slice(), postBlock: Number(postBlock) || 0 };
        if (p.pay) { r.pay = p.pay; r.first = p.first; }   // 0.0.179: the take's own payment coin (settleFills' evidence)
        return r;
    }
    /** 0.0.162: kv `posting_<orderId>` — written by the maker service right before `txnpost` (lib/fill.js cosign prePost)
     *  and deleted once afterFill applied the fill. cb(record | null). While one exists the order takes no take. */
    function postingOf(mds, orderId, cb) {
        mds.kvGet('posting_' + orderId, '', function (v) { var p = null; try { p = v ? JSON.parse(v) : null; } catch (e) { p = null; } cb(p && p.orderId ? p : null); });
    }
    /** 0.0.181 (review, MAJOR 3): why a `posting_` record cannot be applied ('' when it can), as reconcileFills judges fill_
     *  records: its key names its own order; `filled` a plain decimal > 0 and `verified` a plain decimal (a negative fill
     *  GREW an order: 100 → 150 in the review's probe), the fill within the size it was checked against; and, while its order
     *  is live, its first coin one of that order's own (backing, relocking or provisional) coins. Only the maker service
     *  writes these records; a host must refuse page writes of `posting_*` (docs/HOST-ADOPTION.md). */
    function postingProblem(p, k, o) {
        var ins = p.ins, own = {};
        if (k !== 'posting_' + p.orderId) return 'its key does not name its order ' + p.orderId;
        if (!PLAIN.test(String(p.filled)) || !F.d(String(p.filled)).gt(0)) return 'its fill ' + p.filled + ' is not a plain amount above 0';
        if (!PLAIN.test(String(p.verified))) return 'its checked size ' + p.verified + ' is not a plain amount';
        if (F.d(String(p.filled)).gt(F.d(String(p.verified)))) return 'its fill ' + p.filled + ' exceeds the size it was checked against (' + p.verified + ')';
        if (Object.prototype.toString.call(ins) !== '[object Array]' || !TXID.test(String(ins[0]))) return 'it names no coin of mine';
        if (o && o.status === 'live') {
            ((o.coins || []).concat(o.relocking || [])).forEach(function (c) { own[String(c).toLowerCase()] = true; });
            (o.prov || []).forEach(function (e) { ((e && e.c) || []).forEach(function (c) { own[String(c).toLowerCase()] = true; }); });
            if (!own[String(ins[0]).toLowerCase()]) return 'its coin ' + ins[0] + ' does not back order ' + p.orderId;
        }
        return '';
    }
    /**
     * 0.0.162 (review, MINOR): nothing durable stood between a successful `txnpost` and the fill record (whose kvSet error
     * was ignored), and an order whose afterFill failed kept taking takes on its old remaining. Each posting_ record
     * left over (the service at boot and on every settle pass):
     *   - with its txpowid (posted; the fill record or afterFill may have failed): gone once the order lists the fill (or
     *     the order is closed / gone, or the fill's record is older than the order's fillsFrom: applied and compacted);
     *     a missing fill record is written from it (the refresh's reconcileFills then deducts it, once);
     *   - without one (the service stopped between the record and the post's answer), judged by its first coin of mine at
     *     a known tip >= the record's block `b` (0.0.180, coinState): unspent and NOT being spent → nothing was posted (or
     *     it was dropped): removed; in my mempool, or spent on chain → it may have been posted: the fill is recovered under
     *     its payment coin id as its txpowid (the real one is lost; that id is unique per spent coin and is what every
     *     lookup of the fill needs), recorded provisional and applied — settleFills then proves it or gives it back.
     * A record younger than 2 minutes without a txpowid is left alone (its take may still be on its way). cb(lines).
     */
    function reconcilePostings(mds, relay, me, cb) {
        var lines = [];
        if (typeof mds.sql !== 'function') return cb(lines);
        mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'posting_%'", function (r) {
            var rows = (r && r.status && r.rows) || [], i = 0;
            if (!rows.length) return cb(lines);
            mds.cmdR('block', function (eb, b) {
                var tip = (!eb && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
                load(mds, function (e0, list) {
                    (function next() {
                        if (i >= rows.length) return cb(lines);
                        var row = rows[i++], k = String(row.K || row.k || ''), p = null, o;
                        try { p = JSON.parse(row.V || row.v); } catch (e) { p = null; }
                        function del(why) { if (why) lines.push(why); mds.kvDel(k, function () { next(); }); }
                        if (!/^posting_0x[0-9a-fA-F]{16}$/.test(k)) return next();
                        if (!p || !p.orderId) return del('posting record ' + k + ' is unreadable — removed');
                        o = find(list, p.orderId);
                        var bad = postingProblem(p, k, o);   // 0.0.181 (review, MAJOR 3): validated before anything is applied
                        if (bad) return del('posting record ' + k + ' refused, nothing applied: ' + bad + ' — removed');
                        if (TXID.test(String(p.txpowid))) {
                            if (!o || o.status !== 'live' || (o.fills || []).indexOf(p.txpowid) >= 0) return del('');
                            return mds.kvGet('fill_' + p.txpowid, '', function (v) {
                                var f = null; try { f = v ? JSON.parse(v) : null; } catch (e) { f = null; }
                                if (f && Number(f.ts) < (Number(o.fillsFrom) || 0)) return del('');
                                if (f) return next();   // the refresh's reconcileFills applies it; removed on a later pass
                                mds.kvSet('fill_' + p.txpowid, JSON.stringify(fillRecord(p, p.txpowid, p.postBlock || tip)), function (e1) {
                                    lines.push('fill ' + p.txpowid + ' on ' + p.orderId + ': its fill record was missing — ' + (e1 ? 'NOT written (' + e1.message + ')' : 'written from the posting record'));
                                    next();
                                });
                            });
                        }
                        if (now() - (Number(p.ts) || 0) < 120) return next();
                        var c = (p.ins || [])[0];
                        if (!TXID.test(String(c))) return del('posting record of ' + p.orderId + ' names no coin of mine — removed');
                        // 0.0.180 (review, MAJOR 2): judged at a known tip only (a null tip answered [] and read as "spent: it was
                        // posted"); a coin spent or being spent is RECOVERED as a provisional fill — the deduction is the safe
                        // side, and settleFills gives the size back on positive evidence that it never mined
                        coinState(mds, c, p.b, function (st) {
                            if (st === 'unknown') return next();
                            if (st === 'unspent') return del('a take of ' + p.orderId + ' was never posted (my coin ' + c + ' is unspent and not being spent) — nothing was sold');
                            recover();   // in my mempool, or spent on chain: it may have been posted
                        });
                        function recover() {
                            var id = (p.pay && p.pay.id) || (p.outs || [])[0];   // 0.0.179: the computed payment coin id
                            if (!TXID.test(String(id))) return del('a posted take of ' + p.orderId + ' has no output coin to record it by — removed; check TRADES');
                            p.txpowid = id; p.recovered = true; p.postBlock = p.postBlock || tip;
                            var rec = fillRecord(p, id, p.postBlock); rec.recovered = true;
                            mds.kvSet('fill_' + id, JSON.stringify(rec), function (e3) {
                                if (e3) return next();
                                mds.kvSet(k, JSON.stringify(p), function () {
                                    afterFill(mds, relay, me, p.orderId, p.filled, p.ins || [], function (e4) {
                                        lines.push('a take of ' + p.orderId + ' was posted but never recorded: recovered as fill ' + id + (e4 ? ' (not applied yet: ' + e4.message + ')' : ' and applied'));
                                        if (e4) return next();
                                        del('');
                                    }, id, p.verified, { b: p.postBlock, p: p.pay && p.pay.id });
                                });
                            });
                        }
                    })();
                });
            });
        });
    }
    /** 0.0.161: settle the provisional entry `txpowid` of order `orderId`: dropped; with `give`, a still-LIVE order gets its
     *  size back (remaining + filled, the txpowid out of `fills` so a later re-apply counts once) and is re-published.
     *  A background save: up to 3 rounds against a conflicting writer. cb(err, changed). */
    function settleProv(mds, relay, me, orderId, txpowid, give, cb) {
        (function round(r) {
            load(mds, function (e0, list) {
                var o = find(list, orderId), p = o && (o.prov || []).filter(function (x) { return x.t === txpowid; })[0], back;
                if (!p) return cb(null, false);
                o.prov = o.prov.filter(function (x) { return x.t !== txpowid; });
                if (!o.prov.length) delete o.prov;
                back = give && o.status === 'live';
                if (back) { o.remaining = F.plain(F.d(o.remaining).plus(F.d(p.f))); o.fills = (o.fills || []).filter(function (x) { return x !== txpowid; }); o.seq = nextSeq(o); }
                commit(mds, relay, me, list, false, function (e2, lost) {
                    if (e2) return cb(e2, false);
                    if (lost.indexOf(orderId) >= 0) return r < 2 ? round(r + 1) : cb(new Error('order ' + orderId + ' changed three times while its provisional fill ' + txpowid + ' was settled: tried again next pass'), false);
                    if (!back) return cb(null, true);
                    publish(mds, relay, me, find(list, orderId) || o, function () { cb(null, true); });   // a refusal: syncRelays re-sends it
                });
            });
        })(0);
    }

    /**
     * Periodic refresh (service): for every live order make sure its coins still exist unspent, are FRESH and cover
     * the remaining amount (re-select if not), re-lock stale backing coins by a self-send, and republish when coins
     * changed or expiry is within 2 hours. cb(err, republishedCount, relockedTxpowid, relockErrors[]).
     * 0.0.102: an order's `relocking` coins back in the wallet (a relock that failed or was dropped) are relocked again;
     * a relock failure is no longer swallowed: it is returned and kept on the order (relockError).
     * 0.0.104: keep-fresh (0.0.103) is gone; every coin this pass's relocks sent is out of the re-backing candidates,
     * whether its relock worked or not, so an order is never re-signed on a coin being spent.
     */
    function refresh(mds, relay, me, cb) {
        load(mds, function (e0, list) { reconcileFills(mds, list, function (reconciled) {
            // MINOR-3: an order a reconciled fill closed is published closed now; one it reduced is re-signed below
            reconciled.forEach(function (o) { if (o.status === 'filled') { o.seq = nextSeq(o); publish(mds, relay, me, o, function () { }); } });
            var live = list.filter(function (o) { return o.status === 'live'; });
            if (!live.length) return reconciled.length ? commit(mds, relay, me, list, false, function (e) { cb(e, reconciled.length, null); }) : cb(null, 0, null);
            var byTok = { sell: null, buy: null }, n = 0;
            walletCoins(mds, F.MINIMA, function (eA, minima) {
                walletCoins(mds, F.MXUSD, function (eB, mxusd) {
                    if (eA || eB) return cb(eA || eB);
                    holds(mds, function (unheld) {
                    byTok.sell = unheld(minima); byTok.buy = unheld(mxusd);   // M2: a held coin is neither relocked nor re-backed on
                    chainCtx(mds, function (tip, maxAge, legacy) {
                    // 0.0.95: the tip could not be read (twice): coin freshness is unknown, so this tick is SKIPPED and every
                    // order is left as signed (an envelope lives at most 60 minutes and its coins were fresh when signed).
                    // It used to re-sign every order coinless, pulling the maker's whole book for a minute.
                    if (!(tip > 0)) return cb(new Error('chain tip unreadable, so coin freshness is unknown: refresh skipped, orders left as they are'), 0, null);
                    // 0.0.113: a coin my node can prove is never relocked for its age and keeps backing (proofedOf)
                    proofedOf(mds, byTok.sell.concat(byTok.buy), tip, maxAge, legacy, function (pf) {
                    mds.cmdR('getaddress', function (eG, addr) {
                    var myAddr = (!eG && addr && addr.address) || null;
                    // 1. stale coins backing live orders → one relock txn per token (they come back fresh after a block; the
                    //    orders keep their (now unspendable) coin ids until the next refresh re-backs them). relock() takes
                    //    at most 20 of them from 5 signing addresses; the rest go in the next passes.
                    var stale = [], seen = {};
                    live.forEach(function (o) { var mine = (o.coins || []).concat(o.relocking || []); byTok[o.side].forEach(function (c) {
                        if (tip > 0 && mine.indexOf(c.coinid) >= 0 && !isFresh(c, tip, maxAge, pf)) {   // unknown age is not stale: never relock blind
                            if (!seen[c.coinid]) { seen[c.coinid] = true; stale.push(c); }
                            o.relocking = o.relocking || []; if (o.relocking.indexOf(c.coinid) < 0) o.relocking.push(c.coinid);
                        }
                    }); });
                    var byToken = {}; stale.forEach(function (c) { var t = String(c.tokenid).toLowerCase(); (byToken[t] = byToken[t] || []).push(c); });
                    var toks = Object.keys(byToken), ti = 0, relocked = null, relockErrs = [], sent = {};
                    if (toks.length && !myAddr) relockErrs.push('relock: getaddress failed (' + (eG ? eG.message : 'no address') + ')');
                    (function relockNext() {
                        if (ti >= toks.length || !myAddr) return orders();
                        var tok = toks[ti++], ids = byToken[tok].map(function (c) { return c.coinid; });
                        ids.forEach(function (id) { sent[String(id).toLowerCase()] = true; });
                        relock(mds, byToken[tok], myAddr, function (eR, txpowid, sentIds) {
                            // a coin set still backing off sends nothing and keeps its order's error; "possibly posted" is no failure
                            if (txpowid) relocked = txpowid;
                            else if (eR && !eR.backoff && !eR.pending) relockErrs.push('relock of ' + sentIds.join(', ') + ' failed: ' + eR.message);
                            live.forEach(function (o) { if ((o.relocking || []).some(function (id) { return sentIds.indexOf(id) >= 0; })) { if (eR && !eR.pending) o.relockError = eR.message; else delete o.relockError; } });
                            relockNext();
                        });
                    })();
                    function orders() {
                    // review 22 Nov (M1): byTok is the pre-relock snapshot; a coin sent above must never back an order
                    ['sell', 'buy'].forEach(function (sd) { byTok[sd] = byTok[sd].filter(function (c) { return !sent[String(c.coinid).toLowerCase()]; }); });
                    var i = 0;
                    function step() {
                        if (i >= live.length) return commit(mds, relay, me, list, false, function (e) { cb(e, n, relocked, relockErrs); });
                        var o = live[i++];
                        // M4: an order the page cancelled or edited since this pass loaded the list is never re-signed here.
                        // 0.0.181: nor one whose take is still being posted or applied (`posting_`): its coins stay as they are
                        // until reconcilePostings has judged it (it checks the record's coin against the order's own)
                        movedSince(mds, list, o, function (moved) { if (moved) return step(); postingOf(mds, o.orderId, function (busy) { if (busy) step(); else one(o); }); });
                    }
                    function one(o) {
                        if (dust(o.remaining, o.amount)) { o.status = 'filled'; o.seq = nextSeq(o); o.expiry = closeExpiry(o); return publish(mds, relay, me, o, function () { n++; step(); }); }   // a dust remainder from before the rule
                        var have = {}; byTok[o.side].forEach(function (c) { if (isFresh(c, tip, maxAge, pf)) have[String(c.coinid).toLowerCase()] = true; });
                        var stillThere = (o.coins || []).every(function (c) { return have[String(c).toLowerCase()]; });
                        var covers = false;
                        try { var cov = F.pick(byTok[o.side].filter(function (c) { return (o.coins || []).indexOf(c.coinid) >= 0 && isFresh(c, tip, maxAge, pf); }), o.side === 'sell' ? F.d(o.remaining) : F.up8(F.d(o.remaining).times(F.d(o.price))), MAX_COINS); covers = !!cov; } catch (e) { covers = false; }
                        var needRepub = !stillThere || !covers || (o.expiry - now() < REFRESH_BEFORE_SECONDS) || reconciled.indexOf(o) >= 0;
                        var oldSeq = o.seq, oldExp = o.expiry, oldCoins = o.coins, oldScripts = o.scripts, oldRl = o.relocking, oldRe = o.relockError;
                        if (!stillThere || !covers) {
                            try { o.coins = backing(o.side, o.price, o.remaining, byTok[o.side], coinsBackingOthers(list, o.orderId), tip, maxAge, pf); o.scripts = scriptsFor(byTok[o.side], o.coins); delete o.relocking; delete o.relockError; }
                            catch (e) {
                                // Nothing fresh to back it with right now (e.g. the relock is still confirming): keep the order
                                // but publish it with NO coins — takers skip it; next refresh re-backs it.
                                o.coins = []; o.scripts = [];
                            }
                        }
                        if (!needRepub) return step();
                        o.seq = nextSeq(o); o.expiry = now() + EXPIRY_SECONDS;
                        // review 7 Nov (M2): only a re-sign some relay accepted is kept; a rejected one stays due for the next pass.
                        // Gate review 23 Nov (a): EXCEPT the seq and expiry of an order this pass just reconciled a fill into: its
                        // remaining dropped, so it is saved at the raised seq — syncRelays sees every relay hold a lower one and
                        // re-sends the deducted version (restored, the relays kept the old size at an equal seq, never re-sent)
                        publish(mds, relay, me, o, function (pe) {
                            if (!pe) n++;
                            else { if (reconciled.indexOf(o) < 0) { o.seq = oldSeq; o.expiry = oldExp; } o.coins = oldCoins; o.scripts = oldScripts; if (oldRl) o.relocking = oldRl; if (oldRe) o.relockError = oldRe; }
                            step();
                        });
                    }
                    step();
                    }
                    });
                    });
                    });
                    });
                });
            });
        }); });
    }

    /** Back every op from ONE wallet snapshot, in order, never giving a coin to two orders (mirror of
     *  MakerEngine.allocate): an op may reuse its own order's coins, never another live order's or one an earlier op
     *  just took. ops: [{key, orderId|null, side, price, amount}]. Returns [{coins}|{err}]. Pure. */
    function allocate(ops, minima, mxusd, list, tip, maxAge, proofed) {
        var taken = {}, own = {}, out = [], i, j;
        // M2/MINOR 2: an order's relocking coins are its own too, never another op's
        for (i = 0; i < list.length; i++) if (list[i].status === 'live') { own[list[i].orderId] = (list[i].coins || []).concat(list[i].relocking || []); own[list[i].orderId].forEach(function (id) { taken[String(id).toLowerCase()] = true; }); }
        for (i = 0; i < ops.length; i++) {
            var op = ops[i], mine = (op.orderId && own[op.orderId]) || [], ownLc = {}, excl = [], k;
            for (j = 0; j < mine.length; j++) ownLc[String(mine[j]).toLowerCase()] = true;
            for (k in taken) if (!ownLc[k]) excl.push(k);
            try {
                var ids = backing(op.side, op.price, op.amount, op.side === 'sell' ? minima : mxusd, excl, tip, maxAge, proofed);
                for (k in ownLc) delete taken[k];
                for (j = 0; j < ids.length; j++) taken[String(ids[j]).toLowerCase()] = true;
                out.push({ coins: ids });
            } catch (e) { out.push({ err: e.message }); }
        }
        return out;
    }

    /** The whole ladder in one go (owner 2026-10-26, like the minimaXT overlay's single book update): ONE address,
     *  ONE tip, backing planned from the caller's wallet snapshot, every order saved ONCE, then signed and published back to back (0.0.149: saved first; a failed save publishes nothing). A saved order a
     *  relay refused is kept (syncRelays re-sends it): a create is in `made` with its error. cb(errors {key: message},
     *  made {key: order}). */
    function batch(mds, relay, me, ops, minima, mxusd, cb) {
        var errors = {}, made = {};
        if (!ops.length) return cb(errors, made);
        var anyCreate = ops.some(function (o) { return !o.orderId; });
        var go = function (addr) {
            load(mds, function (e0, list) { holds(mds, function (unheld) {
                minima = unheld(minima); mxusd = unheld(mxusd);
                chainCtx(mds, function (tip, maxAge, legacy) { proofedOf(mds, minima.concat(mxusd), tip, maxAge, legacy, function (pf) {
                    var norm = [], i;
                    for (i = 0; i < ops.length; i++) {
                        try {
                            var price = F.plain(F.d(ops[i].price)), amount = F.plain(F.down8(F.d(ops[i].amount)));
                            if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(price) || F.d(price).lte(0) || F.d(amount).lte(0)) throw new Error('bad');
                            norm.push({ key: ops[i].key, orderId: ops[i].orderId, side: ops[i].side, price: price, amount: amount });
                        } catch (e) { errors[ops[i].key] = 'bad price or amount'; }
                    }
                    var alloc = allocate(norm, minima, mxusd, list, tip, maxAge, pf), send = [];
                    for (i = 0; i < norm.length; i++) {
                        var op = norm[i], a = alloc[i], o;
                        if (a.err) { errors[op.key] = a.err; continue; }
                        if (!op.orderId) {
                            if (!addr) { errors[op.key] = 'getaddress failed'; continue; }
                            var bytes = new Uint8Array(8); fillRandom(bytes);
                            o = { orderId: '0x' + AX.hex.to(bytes), side: op.side, address: addr, status: 'live', created: now(), seq: now(), fillsFrom: now() };
                        } else {
                            o = find(list, op.orderId);
                            if (!o || o.status !== 'live') { errors[op.key] = 'order is not live'; continue; }
                            o.seq = nextSeq(o);
                        }
                        o.price = op.price; o.amount = op.amount; o.remaining = op.amount; o.coins = a.coins; delete o.prov;   // 0.0.161: as edit
                        o.scripts = scriptsFor(op.side === 'sell' ? minima : mxusd, a.coins); o.expiry = now() + EXPIRY_SECONDS;
                        send.push({ op: op, o: o });
                    }
                    // review 23 Nov (0.0.149): SAVED first, then published (as create, edit and cancel). The batch used to
                    // publish first and ignore the save's error: a save that failed left ghost rungs on the relays. Now a
                    // failed save publishes nothing (every op gets the error); an edit the merge refused (the order moved
                    // meanwhile) is not published; a saved order a relay refused is kept (made) with the error, and
                    // syncRelays re-sends it
                    send.forEach(function (x) { if (!x.op.orderId) list.push(x.o); });
                    commit(mds, relay, me, list, false, function (ce, lost) {
                        if (ce) { send.forEach(function (x) { errors[x.op.key] = 'not saved, nothing published: ' + (ce.message || ce); }); return cb(errors, made); }
                        var k = 0;
                        (function next() {
                            if (k >= send.length) return cb(errors, made);
                            var x = send[k++];
                            if (x.op.orderId && (lost || []).indexOf(x.o.orderId) >= 0) { errors[x.op.key] = 'the order changed meanwhile: not re-quoted'; return next(); }
                            if (!x.op.orderId) made[x.op.key] = x.o;
                            publish(mds, relay, me, x.o, function (e) {
                                if (e) errors[x.op.key] = e.message + (x.op.orderId ? '' : ' (saved: re-sent to the relays within a minute)'); else made[x.op.key] = x.o;
                                next();
                            });
                        })();
                    });
                }); });
            }); });
        };
        if (!anyCreate) return go(null);
        mds.cmdR('getaddress', function (e, a) { go(!e && a && a.address ? a.address : null); });
    }

    /** Of one relay's live orders, which of MINE must be re-sent: any it shows live that is cancelled / filled here,
     *  an older version of one that is live here, or one live here (and unexpired) that the relay does not hold at
     *  all — a relay keeps its book in memory, so a restart drops every order (28 Oct). Mirror of MakerEngine.stale. */
    function stale(relayHas, mySignPk, list) {
        var out = [], held = {};
        relayHas.forEach(function (e) {
            if (String(e.signPk).toLowerCase() !== String(mySignPk).toLowerCase()) return;
            held[e.orderId] = true;
            var o = find(list, e.orderId);
            if (o && (o.status !== 'live' || o.seq > e.seq)) out.push(o);
        });
        list.forEach(function (o) { if (o.status === 'live' && o.expiry > now() + 60 && !held[o.orderId]) out.push(o); });
        return out;
    }

    /** Make every relay agree with this node (owner 2026-10-26: a cancelled order must never stay live on any relay).
     *  cb({checked, fixed, failed, lines}). */
    function syncRelays(mds, relay, me, cb) {
        var rep = { checked: 0, fixed: 0, failed: 0, lines: [] }, urls = relay.relays.slice(), touched = false, mySignPk = '0x' + AX.hex.to(me.signPk);
        load(mds, function (e0, list) {
            (function nextRelay() {
                if (!urls.length) return touched ? commit(mds, relay, me, list, false, function () { cb(rep); }) : cb(rep);
                var url = urls.shift();
                relay.snapshot(url, function (err, has) {
                    if (err) return nextRelay();
                    rep.checked++;
                    var fix = stale(has, mySignPk, list);
                    (function nextFix() {
                        if (!fix.length) return nextRelay();
                        var o = fix.shift(), raw, over = o.status !== 'live' ? liveSeqOn(has, mySignPk, o.orderId) : -1;
                        // gate review 23 Nov (b): the relay shows a LIVE copy at a seq ≥ the stored cancel's: a re-send at the
                        // stored seq is refused 'stale seq' and the order stays live there — raise the stored seq above it
                        if (over >= o.seq) { o.seq = over + 1; touched = true; } else over = -1;
                        if (o.status !== 'live' && o.expiry <= now() + 60) { o.expiry = closeExpiry(o); touched = true; }   // a cancel must still be valid to land (and outlive every live copy)
                        try { raw = envelopeFor(me, o); } catch (e) { rep.failed++; return nextFix(); }
                        relay.publishTo(url, raw, function (r) {
                            if (r.ok || (r.error === 'stale seq' && over < 0)) { rep.fixed++; rep.lines.push('relay ' + url + ' still showed ' + o.orderId + ' — re-sent (' + o.status + ')'); }
                            else { rep.failed++; rep.lines.push('relay ' + url + ' still shows ' + o.orderId + ' and refused the fix: ' + r.error); }
                            nextFix();
                        });
                    })();
                });
            })();
        });
    }

    function find(list, orderId) { for (var i = 0; i < list.length; i++) if (list[i] && list[i].orderId === orderId) return list[i]; return null; }
    /** A live order published coinless BECAUSE a relock of its coins is pending (`relocking`, placed or edited on coins
     *  being refreshed, or whose backing aged out): the service re-backs it on the next block, not at the minute's refresh
     *  (service.js rebackOnBlock). 0.0.109 (review 22 Nov, MINOR 5): any other coinless order (nothing on its way, e.g.
     *  the wallet is short) waits for the minute's refresh; it used to run a refresh on every block. */
    function awaitingBacking(list) { return (list || []).some(function (o) { return o.status === 'live' && !(o.coins || []).length && (o.relocking || []).length > 0; }); }

    if (AX.mds) leaseSigning(AX.mds);   // page and service: mdsw.js is loaded before this file
    AX.maker = { leaseSigning: leaseSigning, leaseCmd: leaseCmd, SIGN_TTL_MS: SIGN_TTL_MS, MARKET: MARKET, COIN_MAX_AGE: COIN_MAX_AGE, WHY_MAX_AGE: WHY_MAX_AGE, maxAgeOf: maxAgeOf, load: load, save: save, withLock: withLock, walletCoins: walletCoins, holds: holds, simpleScripts: simpleScripts, scriptsFor: scriptsFor, backing: backing,
                 placement: placement, proofedOf: proofedOf, PENDING_NOTICE: PENDING_NOTICE, awaitingBacking: awaitingBacking, ageOf: ageOf, isFresh: isFresh, chainCtx: chainCtx, legacyOn: legacyOn, relock: relock, RELOCK_MAX_INPUTS: RELOCK_MAX_INPUTS, RELOCK_MAX_SIGNERS: RELOCK_MAX_SIGNERS, envelopeFor: envelopeFor,
                 publish: publish, create: create, cancel: cancel, edit: edit, afterFill: afterFill, settleFills: settleFills, CONFIRM_BLOCKS: CONFIRM_BLOCKS, coinState: coinState, voidOf: voidOf, voidCheck: voidCheck, voidRelocked: voidRelocked, VOID_SPENT_BLOCKS: VOID_SPENT_BLOCKS, settleProv: settleProv, fillRecord: fillRecord, postingOf: postingOf, postingProblem: postingProblem, reconcilePostings: reconcilePostings, GIVE_BACK_BLOCKS: GIVE_BACK_BLOCKS, refresh: refresh, reconcileFills: reconcileFills, find: find, DUST: DUST, dust: dust, allocate: allocate, batch: batch, stale: stale, syncRelays: syncRelays };
})(typeof globalThis !== 'undefined' ? globalThis : this);
