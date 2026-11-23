/* one_refusal.js — 0.0.175 (coordinator: ONE refusal regex for node commands everywhere in the engine). Every command this
 * MiniDapp sends passes `[;\x00-\x1f\x7f]` (a ';' runs a second command; a tab starts a new parameter in the node's fast
 * splitter): lib/mdsw.js unsafe (AX.mds.cmd / cmdR, shared with atomix-mds) and resting/safety.js commandFailure
 * (PDService.cmd, vendored) carry exactly that pattern, and no Dexicon-owned file calls MDS.cmd past them. */
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..'), read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ONE = '/[;\\x00-\\x1f\\x7f]/';
assert.ok(read('lib/mdsw.js').includes("if (" + ONE + ".test(command))"), 'lib/mdsw.js unsafe() refuses ' + ONE);
assert.ok(read('resting/safety.js').includes("if (" + ONE + ".test(command))"), 'resting/safety.js commandFailure refuses ' + ONE);
const own = ['service.js', 'doors/ax_service.js'].concat(fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js') && f !== 'mdsw.js' && f !== 'prng.js').map((f) => 'lib/' + f),
    fs.readdirSync(path.join(ROOT, 'ui')).filter((f) => f.endsWith('.js')).map((f) => 'ui/' + f));
const direct = own.filter((f) => /\bMDS\.cmd\(/.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')));
assert.deepStrictEqual(direct, [], 'no Dexicon file sends a node command past the one refusal (MDS.cmd direct): ' + direct.join(', '));
// lib/prng.js (shared with atomix-mds) sends only the constant `random`
assert.ok(!/MDS\.cmd\((?!['"]random['"])/.test(read('lib/prng.js').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'lib/prng.js sends only `random`');
console.log('ONE REFUSAL PASS');
