/**
 * P0-b throwaway MiniDapp (v0.0.2): the backend long-polls the relay stub with MDS.net.GET.
 *
 * LESSON from v0.0.1: in the Rhino backend MDS.net.GET is SYNCHRONOUS — the callback runs inside the GET call on
 * the same thread. A "re-poll from the callback" loop is therefore unbounded recursion (StackOverflowError at
 * install). The correct backend pattern: one bounded GET per MDS_TIMER_10SECONDS tick, hold < 10 s.
 */
'use strict';
var BASE = 'http://127.0.0.1:18555/dex/book';
var HOLD = 8;           // seconds the relay may hold; must stay under the 10 s timer period
var cursor = 0, n = 0, errors = 0;

function pollOnce() {
    var t0 = Date.now();
    MDS.net.GET(BASE + '?since=' + cursor + '&hold=' + HOLD, function (resp) {
        var dt = Date.now() - t0;
        if (!resp || !resp.status) {
            errors++;
            MDS.log('DECKS-LP ERR #' + errors + ' after ' + dt + 'ms resp=' + JSON.stringify(resp).slice(0, 300));
            return;
        }
        var body = null;
        try { body = JSON.parse(resp.response); } catch (e) { MDS.log('DECKS-LP bad json: ' + String(resp.response).slice(0, 120)); return; }
        var woke = body.cursor > cursor;
        cursor = body.cursor; n++;
        MDS.log('DECKS-LP #' + n + ' wall=' + dt + 'ms held=' + body.held_ms + 'ms cursor=' + cursor + (woke ? ' WAKE' : ' timeout'));
    });
}

MDS.init(function (msg) {
    if (msg.event === 'inited') { MDS.log('DECKS-LP v0.0.2 inited; one GET per 10s tick, hold ' + HOLD + 's'); pollOnce(); }
    else if (msg.event === 'MDS_TIMER_10SECONDS') { pollOnce(); }
});
