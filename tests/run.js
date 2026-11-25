// Serve the project folder and open /tests/run.html. Runs the real script with faked GM_*, location, document.
const nav = (p, b) => `<ul class="modtabs"><li><a href="/vein/mods/207?tab=posts">Posts ${p}</a></li>${b === null ? '' : `<li><a href="/vein/mods/207?tab=bugs">Bugs ${b}</a></li>`}</ul>`;
const li = (id, who, text, kids = '') => `<li class="comment " id="comment-${id}"><div class="comment-head"><span class="comment-name"><a> ${who} </a></span></div><div class="comment-content"><time data-date="1"></time><div class="comment-content-text" id="comment-content-${id}">${text}</div></div><ol class="comment-kids">${kids}</ol></li>`;
const pager = (w, n, sel) => n < 2 ? '<div class="pagination"><a class="page-selected">1</a></div>' : `<div class="pagination"><a class="page-selected"> ${sel} </a><a onclick="return window.RH_${w}.Send('page', '${n}');">${n}</a></div>`;
const rh = (w, o) => `<script>RH.id = '${w}'; RH.in_items = JSON.parse(${JSON.stringify('{"search_text":""}')}); RH.out_items = JSON.parse(${JSON.stringify(JSON.stringify(o))});</` + 'script>';
const posts = (lis, count, b = 0, pages = 1) => `<title>Mod</title><body>${nav(count, b)}${rh('CommentContainer', { game_id: 8175, object_id: 207, page_size: 10 })}<div id="comment-container"><h2 id="comment-count" data-comment-count="${count}"></h2>${pager('CommentContainer', pages, 1)}<ol>${lis}</ol></div>`;
const row = (id, title, n) => `<tr class="mod-issue-row" data-issue-id="${id}"><td><a class="issue-title">${title}</a></td><td class="table-bug-replies">${n}</td></tr>`;
const bugs = (rows, n) => `<title>Mod</title><body>${nav(2, n)}<div id="tab-modbugs"><select id="status"><option value="-1" selected>All</option></select>${rows ? `<table>${rows}</table>` : 'No issues reported at this time.'}</div>`;
const CH = '<title>Just a moment...</title><body>Performing security verification';
const P = 'https://www.nexusmods.com/vein/mods/207?tab=posts', B = P.replace('posts', 'bugs');
const two = li(1, 'XestrangedX', 'Not working.<br>Help', li(2, 'VitaKaninen', 'Which version?'));
const p2 = `<div id="comment-container">${pager('CommentContainer', 2, 2)}<ol>${li(3, 'Al', 'old')}</ol></div>`;
const api = JSON.stringify({ data: { mods: { totalCount: 1, nodes: [{ modId: 207, name: 'SSM', status: 'published', game: { domainName: 'vein' } }] } } });

let src;
// One simulated page load sharing `w` (store, pages) with earlier ones.
async function load(w, url = 'https://example.com/', html = '<body>', wait = 400) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const menu = {};
    const g = {
        GM_getValue: (k) => w.store[k] === undefined ? undefined : JSON.parse(w.store[k]),
        GM_setValue: (k, v) => { w.store[k] = JSON.stringify(v); },
        GM_deleteValue: (k) => { delete w.store[k]; },
        GM_addValueChangeListener() {}, GM_unregisterMenuCommand() {},
        GM_registerMenuCommand: (c, f) => { menu[c] = f; return c; },
        GM_notification: (o) => w.notes.push(o),
        GM_openInTab: (u) => { const t = {}; w.tabs.push({ u, t }); return t; },
        GM_xmlhttpRequest: (o) => {
            w.reqs.push(o.url);
            const r = o.url.includes('api.') ? api : typeof w.pages === 'function' ? w.pages(o.url, o) : w.pages[o.url];
            setTimeout(() => r === undefined ? o.onerror() : o.onload({ status: r === CH ? 403 : 200, responseText: r, responseHeaders: '' }), 1);
        },
        GM_info: { script: { version: 'test' } }, location: new URL(url), document: doc, confirm: () => true,
        setTimeout: (f, ms) => setTimeout(f, ms > 10000 ? 1e6 : Math.min(ms, 8)),
    };
    new Function(...Object.keys(g), src)(...Object.values(g));
    await new Promise(r => setTimeout(r, wait));
    return menu;
}
const world = (pages) => ({ store: {}, notes: [], tabs: [], reqs: [], pages });
const val = (w, k) => w.store[k] && JSON.parse(w.store[k]);
const day = (w) => { w.store.nc_lastOk = String(Date.now() - 25 * 36e5); w.store.nc_lastTry = '0'; };
const alerts = (w) => val(w, 'nc_alerts') || [];

const T = {
    async 'first run alerts all, reply nested, own counted'(ok) {
        const w = world({ [P]: posts(two, 2) });
        await load(w);
        ok(alerts(w).length === 2, alerts(w));
        ok(alerts(w)[0].text === 'Not working. Help' && alerts(w)[0].who === 'XestrangedX', alerts(w)[0]);
        ok(alerts(w)[1].who === 'VitaKaninen' && alerts(w)[1].text === 'Which version?', alerts(w)[1]);
        ok(val(w, 'nc_lastOk') > 0 && !val(w, 'nc_lock') && !val(w, 'nc_run'), w.store);
        ok(w.notes.length === 2, w.notes);
        ok(!w.reqs.includes(B), w.reqs);
        const n = w.reqs.length;
        await load(w);
        ok(w.reqs.length === n, 'second load within 24h fetched');
        day(w);
        await load(w);
        ok(alerts(w).length === 2 && w.reqs.length > n, 'repeat run');
    },
    async 'own ignored when off, and not replayed'(ok) {
        const w = world({ [P]: posts(two, 2) });
        w.store.nc_countOwn = 'false';
        const m = await load(w);
        ok(alerts(w).length === 1, alerts(w));
        m['☐ Count my own comments']();
        await m['Check now']();
        ok(val(w, 'nc_countOwn') === true && alerts(w).length === 1, alerts(w));
    },
    async 'two tabs at once run one check'(ok) {
        const w = world({ [P]: posts(two, 2) });
        await Promise.all([load(w), load(w)]);
        ok(w.reqs.filter(u => u === P).length === 1, w.reqs);
    },
    async 'challenge: one tab, live harvest after passing'(ok) {
        const w = world({ [P]: CH, [B]: CH });
        await load(w);
        ok(w.tabs.length === 1 && w.tabs[0].u === P, w.tabs);
        ok(!val(w, 'nc_lastOk'), 'lastOk set');
        w.store.nc_lastTry = '0';
        await load(w);
        await load(w);
        ok(w.tabs.length === 1, 'opened again');
        await load(w, P + '&__cf_chl_rt_tk=x', CH);
        ok(w.tabs.length === 1 && val(w, 'nc_cf'), 'challenge page');
        await load(w, P, posts(two, 2, 1));
        ok(alerts(w).length === 2, alerts(w));
        ok(w.tabs.length === 2 && w.tabs[1].u === B, w.tabs);
        await load(w, B, bugs(row(9, 'Crash', 0), 1));
        ok(alerts(w).length === 3 && alerts(w)[2].text === 'Crash', alerts(w));
        ok(val(w, 'nc_lastOk') > 0, 'not done');
    },
    async 'closed challenge waits an hour, then reopens'(ok) {
        const w = world({ [P]: CH });
        await load(w);
        w.tabs[0].t.onclose();
        w.store.nc_lastTry = '0';
        await load(w);
        ok(w.tabs.length === 1, 'early');
        const c = val(w, 'nc_cf');
        c.opened -= 37e5;
        w.store.nc_cf = JSON.stringify(c);
        w.store.nc_lastTry = '0';
        await load(w);
        ok(w.tabs.length === 2, w.tabs);
    },
    async 'passing but always blocked cannot loop'(ok) {
        const w = world({ [P]: CH });
        await load(w);
        for (let i = 0; i < 5; i++) await load(w, 'https://www.nexusmods.com/vein', '<title>x</title><body>hi');
        ok(w.tabs.length === 2, w.tabs.length);
    },
    async 'bugs: new, then new reply'(ok) {
        let n = 1;
        const w = world((u) => u === P ? posts(two, 2, 1) : u === B ? bugs(row(9, 'Crash', n), 1)
            : '<span class="comment-name"><a>Bob</a></span><div class="comment-content-text">boom</div>');
        await load(w);
        const b = alerts(w).filter(a => a.tab === 'Bugs');
        ok(b.length === 1 && b[0].who === 'Bob' && b[0].text === 'Crash: boom', b);
        n = 2;
        day(w);
        await load(w);
        ok(alerts(w).filter(a => a.tab === 'Bugs').length === 2, alerts(w));
    },
    async 'posts pagination walks while new'(ok) {
        const w = world((u) => u === P ? posts(two, 3, 0, 2) : p2);
        await load(w);
        ok(alerts(w).length === 3, alerts(w));
        ok(w.reqs.some(u => u.endsWith('CommentContainer?RH_CommentContainer=game_id:8175,object_id:207,page_size:10,page:2')), w.reqs);
        day(w);
        const k = w.reqs.length;
        await load(w);
        ok(!w.reqs.slice(k).some(u => /Widgets/.test(u)), 'walked with nothing new');
    },
    async 'blocked page 2 warns and is re-walked next time'(ok) {
        let good = false;
        const w = world((u) => u === P ? posts(two, 3, 0, 2) : good ? p2 : CH);
        await load(w);
        ok(alerts(w).some(a => a.warn) && w.tabs.length === 0, alerts(w));
        good = true;
        day(w);
        await load(w);
        ok(alerts(w).some(a => a.k.endsWith('/3')), alerts(w));
    },
    async 'layout change fails loudly; disabled bugs fine; count mismatch warns'(ok) {
        const w = world({ [P]: '<title>Mod</title><body>' + nav(2, 0) });
        await load(w);
        ok(alerts(w)[0] && alerts(w)[0].warn && !val(w, 'nc_lastOk'), alerts(w));
        const x = world({ [P]: posts(two, 2, null) });
        await load(x);
        ok(val(x, 'nc_lastOk') > 0 && alerts(x).length === 2, x.store);
        const y = world({ [P]: posts(two, 5) });
        await load(y);
        ok(alerts(y).some(a => /says 5/.test(a.text)), alerts(y));
    },
    async 'comment quoting the challenge text is not a challenge'(ok) {
        const w = world({ [P]: posts(li(1, 'A', 'Performing security verification Just a moment'), 1) });
        await load(w);
        ok(alerts(w).length === 1 && !w.tabs.length, w);
    },
    async 'network failure: quiet, retried; reset works'(ok) {
        const w = world({});
        const m = await load(w);
        ok(!alerts(w).length && val(w, 'nc_failUntil') > 0 && !val(w, 'nc_lastOk'), w.store);
        w.pages = { [P]: posts(two, 2) };
        await m['Check now']();
        ok(alerts(w).length === 2, alerts(w));
        m['Reset saved state']();
        ok(!alerts(w).length && !val(w, 'nc_seen'), w.store);
        await m['Check now']();
        ok(alerts(w).length === 2, 'after reset');
    },
};

(async () => {
    src = await (await fetch('../Nexus-Check.user.js', { cache: 'no-store' })).text();
    const out = [];
    let bad = 0;
    for (const [name, f] of Object.entries(T)) {
        const errs = [];
        let i = 0;
        try { await f((c, info) => { i++; if (!c) errs.push('#' + i + ' ' + JSON.stringify(info).slice(0, 500)); }); }
        catch (e) { errs.push(String(e.stack)); }
        if (errs.length) bad++;
        out.push((errs.length ? 'FAIL ' : 'ok   ') + name + (errs.length ? ' :: ' + errs.join(' | ') : ''));
    }
    document.getElementById('out').textContent = out.join('\n') + '\nDONE ' + bad + ' failed';
})();
