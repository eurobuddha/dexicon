/* Every element id the page scripts touch must exist in index.html (PandaDEX's page is dense; a missing id is a silent blank). */
const fs = require('fs'), path = require('path'), ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const dynamic = /^(verify_|mk_)/;   // created at runtime by the page itself
let missing = [];
for (const f of ['ui/pd_app.js', 'ui/app.js', 'ui/doors.js', 'ui/activity.js']) {
    const js = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of js.matchAll(/\b(?:el|\$)\(\s*"([A-Za-z0-9_]+)"\s*\)|\b(?:el|\$)\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) {
        const id = m[1] || m[2];
        if (!ids.has(id) && !dynamic.test(id)) missing.push(f + ': #' + id);
    }
}
// and every onclick handler named in the HTML must be defined somewhere
const handlers = new Set([...html.matchAll(/onclick="([A-Za-z_.]+)\(/g)].map((m) => m[1]).filter((h) => !h.startsWith('document.')));
const allJs = ['ui/pd_app.js', 'ui/app.js', 'ui/doors.js', 'ui/activity.js', 'ui/maker.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
for (const h of handlers) {
    const name = h.split('.').pop();
    if (!new RegExp('function ' + name + '\\s*\\(|\\b' + name + '\\s*:\\s*' ).test(allJs)) missing.push('index.html: onclick ' + h + '() undefined');
}
if (missing.length) { console.error('PAGE IDS FAIL\n' + missing.join('\n')); process.exit(1); }
console.log('PAGE IDS PASS — ' + ids.size + ' ids, ' + handlers.size + ' handlers');
