/* poolscan.test.js — 0.0.173 (vendored PandaDEX 0.4.35 Pool.validParams): anyone can put a coin at the PandaPools sentinel,
   and its state reaches `runscript script:"…"`. The node's FAST splitter (CommandRunner.splitterQuotedPattern: every ':'
   spaced, then "([^"]*)"|(\S+)) ignores `\"`, so a `"` in a beacon value closes the quote and a second `script:` follows;
   the node keeps the LAST duplicate parameter — a stranger chose the derived "pool" script. The stand-in node below splits
   on ';' and parses exactly so. */
(function () {
    var Pool = PandaPool, P = PandaDEX, ran = [];
    /** the node's fast splitter, ported: name:value pairs, the last duplicate wins */
    function nodeParams(command) {
        var ss = command.trim().replace(/:/g, ' : '), re = /"([^"]*)"|(\S+)/g, m, tok = [], out = {}, name = false, nv = '', i;
        while ((m = re.exec(ss))) tok.push(m[1] !== undefined ? m[1] : m[2]);
        for (i = 1; i < tok.length; i++) {
            if (!name) { name = true; nv = tok[i]; }
            else if (tok[i].trim() === ':') nv += ':';
            else { name = false; nv += tok[i]; out[nv.slice(0, nv.indexOf(':'))] = nv.slice(nv.indexOf(':') + 1); }
        }
        return { cmd: tok[0], p: out };
    }
    var OPK = '0x' + 'a1'.repeat(32), OADR = '0x' + 'b2'.repeat(32), EVIL = 'RETURN TRUE';
    function beacon(opk, oadr, tok, kmin) { return { coinid: '0x' + 'c0'.repeat(32), state: [{ port: 2, data: tok }, { port: 3, data: oadr }, { port: 4, data: opk }, { port: 5, data: kmin }] }; }
    function cmd(command, cb) {
        command.split(';').forEach(function (one) {
            var n = nodeParams(one);
            if (n.cmd === 'coins' && n.p.address === Pool.SENTINEL) return cb({ status: true, response: [beacon(OPK, OADR, P.USDT, '1'), beacon(OPK, OADR, P.USDT, '2" script:"' + EVIL)] });
            if (n.cmd === 'runscript') { ran.push(n.p.script); return cb({ status: true, response: { parseok: true, script: { address: '0x' + 'd' + ran.length + 'd'.repeat(62) } } }); }
            cb({ status: true, response: [] });
        });
    }
    var got = null;
    Pool.scan(cmd, function (err, pools) { got = pools; });
    T.eq('0.0.173: a beacon whose value carries `"` + ` script:"…"` never reaches runscript: one runscript, the intended script only', ran, [Pool.script(OPK, OADR, P.USDT, '1')]);
    T.ok('0.0.173: ... and no pool is derived from a stranger\'s script', ran.indexOf(EVIL) < 0 && ran.every(function (s) { return s === Pool.script(OPK, OADR, P.USDT, '1'); }));
})();
