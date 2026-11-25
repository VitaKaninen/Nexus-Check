// ==UserScript==
// @name        Nexus Check
// @namespace   https://github.com/VitaKaninen
// @version     0.3.0
// @author      VitaKaninen
// @description Once a day, checks your Nexus Mods pages for new posts and bug reports and alerts you.
// @match       *://*/*
// @run-at      document-idle
// @inject-into content
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_addValueChangeListener
// @grant       GM_xmlhttpRequest
// @grant       GM_notification
// @grant       GM_openInTab
// @grant       GM_registerMenuCommand
// @grant       GM_unregisterMenuCommand
// @connect     nexusmods.com
// @connect     www.nexusmods.com
// @connect     api.nexusmods.com
// @updateURL   https://raw.githubusercontent.com/VitaKaninen/Nexus-Check/main/Nexus-Check.user.js
// @downloadURL https://raw.githubusercontent.com/VitaKaninen/Nexus-Check/main/Nexus-Check.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Not @noframes: that makes Violentmonkey's menu throw on pages with iframes (CLAUDE.md).
    if (window !== window.top) return;

    // ==== us-log begin ====
    // Shared verbatim by Forum Stumbler and Hover Zoom. Edit HoverZoom/shared/us-log.js, then run
    // `node shared/sync-shared.js` from HoverZoom. The design is HoverZoom/docs/REQUEST-LOG.md.
    //
    // Records nothing but counts, timings and status codes. No URL, path, query or title ever
    // reaches it — the only identifying field is the hostname, and the export replaces that too.
    const usLog = (function () {
        const V = 1;
        const MAX_ROWS = 400;        // reads kept; the per-host summary outlives their eviction
        const MAX_EV = 12;           // limit events kept per read
        const PACE_MAX = 40;         // chars of the caller's pace label

        let store = null;            // { load(), save(str) } — the host script owns the key
        let max = MAX_ROWS, evMax = MAX_EV;
        let clock = () => Date.now();
        let on = true;
        const inst = Math.random().toString(36).slice(2, 7);
        const open = new Set();

        // The host script supplies storage and may override the caps; nothing here touches GM_*.
        function init(o) {
            o = o || {};
            if (o.load && o.save) store = { load: o.load, save: o.save };
            if (o.max) max = Math.max(10, o.max | 0);
            if (o.evMax) evMax = Math.max(1, o.evMax | 0);
            if (o.now) clock = o.now;
            if (o.on != null) on = !!o.on;
            return usLog;
        }

        const enable = (v) => { on = !!v; };
        const enabled = () => on && !!store;
        const blank = () => ({ v: V, hosts: {}, rows: [] });

        function read() {
            if (!store) return blank();
            try {
                const d = JSON.parse(store.load() || '');
                return (d && d.v === V && Array.isArray(d.rows) && d.hosts) ? d : blank();
            } catch (_) { return blank(); }
        }

        function write(d) {
            if (!store) return;
            try { store.save(JSON.stringify(d)); } catch (_) {}
        }

        // Codes and short labels only. Cut at the first / ? # so a URL handed in by mistake keeps none of its path.
        const clean = (s, n) => String(s == null ? '' : s).split(/[/?#]/)[0].replace(/[^\w .+-]/g, '').slice(0, n || 24);

        // The bare hostname, even from a whole URL — a path must never survive into the log.
        function hostName(h) {
            let s = String(h || '').toLowerCase().trim();
            const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/.exec(s);
            if (m) s = m[1];
            s = s.split(/[/?#]/)[0].replace(/^[^@]*@/, '');
            return s.replace(/[^a-z0-9.:-]/g, '').slice(0, 80);
        }

        // Seconds from a Retry-After header value, which is legally either a count or an HTTP date.
        function retryAfterSecs(v) {
            if (v == null || v === '') return null;
            const s = String(v).trim();
            if (/^\d+$/.test(s)) return Math.min(999999, parseInt(s, 10));
            const t = Date.parse(s);
            return isNaN(t) ? null : Math.max(0, Math.round((t - clock()) / 1000));
        }

        // Pull Retry-After out of the newline-delimited header blob both fetch paths produce.
        function retryAfterOf(headers) {
            const m = /^[ \t]*retry-after[ \t]*:[ \t]*(.*)$/im.exec(String(headers || ''));
            return m ? retryAfterSecs(m[1]) : null;
        }

        // One background read — a run of requests the caller is about to make at one pace.
        // Returns null when logging is off, so every call site is `const lg = usLog.start(...)`
        // followed by `lg && lg.something()`.
        function start(kind, opts) {
            if (!enabled()) return null;
            opts = opts || {};
            const row = {
                t: clock(), h: hostName(opts.host), i: inst, k: clean(kind, 12),
                p: clean(opts.pace, PACE_MAX), n: 0, ok: 0, pg: 0, ms: 0,
                sp: null, out: 'open', nr: opts.slowed ? 1 : 0, ev: []
            };
            const starts = [];
            let ended = false;

            // Each request stamps its own start, so the spacing the forum actually saw is
            // measured rather than assumed from the configured gap.
            function req() {
                starts.push(clock() - row.t);
                row.n++;
                let settled = false;
                return {
                    done(info) {
                        if (settled) return;
                        settled = true;
                        info = info || {};
                        const st = info.status | 0;
                        if (info.limited) {
                            if (row.ev.length < evMax) {
                                row.ev.push({
                                    a: row.n, s: st, w: clean(info.signal, 6) || 'hard',
                                    ra: info.retryAfter == null ? null : info.retryAfter | 0,
                                    dt: clock() - row.t
                                });
                            }
                        } else if (st >= 200 && st < 400) {
                            row.ok++;
                            if (info.topics > 0) row.pg++;
                        }
                    }
                };
            }

            function spacing() {
                if (starts.length < 2) return null;
                const gaps = [];
                for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
                gaps.sort((a, b) => a - b);
                return [gaps[0], gaps[(gaps.length - 1) >> 1], gaps[gaps.length - 1]].map(x => Math.round(x));
            }

            // Append this read and update its host's running totals. The store is RE-READ here
            // rather than trusted from when the read began: another tab may have written since,
            // and this saves the whole list back.
            function end(outcome, bytes) {
                if (ended) return;
                if (bytes > 0) row.b = Math.round(bytes);
                ended = true;
                open.delete(handle);
                row.ms = clock() - row.t;
                row.sp = spacing();
                row.out = clean(outcome, 10) || 'done';
                const d = read();
                const hs = d.hosts[row.h] || (d.hosts[row.h] = { reads: 0, reqs: 0, limits: 0, first: row.t, last: 0 });
                row.since = hs.last ? row.t - hs.last : null;
                hs.reads++;
                hs.reqs += row.n;
                hs.limits += row.ev.length;
                hs.last = row.t + row.ms;
                d.rows.push(row);
                if (d.rows.length > max) d.rows.splice(0, d.rows.length - max);
                write(d);
            }

            const handle = { req, end };
            open.add(handle);
            return handle;
        }

        // A read the page never got to finish — a navigation or a refresh in the middle of it.
        // Exactly the case a per-read flush at the end would lose, and the one most worth having.
        function cutOpen() {
            for (const h of Array.from(open)) h.end('cut');
        }

        // A one-off worth a row of its own: a host demoted, or put back. Codes only, no prose.
        function note(kind, opts) {
            if (!enabled()) return;
            opts = opts || {};
            const d = read();
            const h = hostName(opts.host);
            const row = {
                t: clock(), h, i: inst, k: clean(kind, 12), p: clean(opts.pace, PACE_MAX),
                n: 0, ok: 0, pg: 0, ms: 0, sp: null, out: clean(opts.out, 10) || 'note', nr: 0, ev: []
            };
            if (opts.status || opts.signal || opts.retryAfter != null) {
                row.ev.push({
                    a: 0, s: opts.status | 0, w: clean(opts.signal, 6) || 'hard',
                    ra: opts.retryAfter == null ? null : opts.retryAfter | 0, dt: 0
                });
            }
            const hs = d.hosts[h] || (d.hosts[h] = { reads: 0, reqs: 0, limits: 0, first: row.t, last: 0 });
            if (row.ev.length) hs.limits++;
            d.rows.push(row);
            if (d.rows.length > max) d.rows.splice(0, d.rows.length - max);
            write(d);
        }

        // UTC always: a fingerprinting-resistant browser may report UTC as local time, so local would be ambiguous.
        const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
        const day = (ms) => stamp(ms).slice(0, 10);

        // Coarse but readable: the field exists to tell "an hour later" from "one minute later".
        function dur(ms) {
            if (ms == null) return '-';
            const s = Math.round(ms / 1000);
            if (s < 90) return s + 's';
            const m = Math.round(s / 60);
            if (m < 90) return m + 'm';
            const h = Math.round(m / 6) / 10;
            return (h < 48 ? h + 'h' : Math.round(h / 24) + 'd');
        }

        const secs = (ms) => (ms >= 10000 ? Math.round(ms / 1000) + 's' : (Math.round(ms / 100) / 10) + 's');

        function evText(ev) {
            return ev.map(e => '@' + e.a + ' ' + (e.s || '-') + ' ' + e.w
                + (e.ra == null ? '' : ' ra' + e.ra) + ' +' + secs(e.dt)).join('  ');
        }

        // One line per read, readable by eye and parseable by column. `anon` replaces each
        // hostname with siteN, numbered by first appearance, which is the only field that
        // identifies anything.
        function text(opts) {
            opts = opts || {};
            const d = read();
            const names = {};
            let next = 1;
            const nm = (h) => {
                if (!opts.anon) return h || '-';
                if (!names[h]) names[h] = 'site' + next++;
                return names[h];
            };
            for (const r of d.rows) nm(r.h);

            const limits = d.rows.reduce((n, r) => n + r.ev.length, 0);
            const out = [
                '# us-log v' + V + ' — ' + stamp(clock()) + ' — ' + d.rows.length + ' rows, ' + limits + ' limit events',
                '# No URL, path, query or page title is ever recorded.'
                + (opts.anon ? ' Hostnames are replaced with siteN.' : ' Hostnames are real in this copy.'),
                '# cols: when (UTC) | site | kind | pace | ok/req | pages | elapsed | spacing min/med/max'
                + ' | since prev read | slowed | outcome | bytes | limit events',
                ''
            ];
            const hosts = Object.keys(d.hosts).sort();
            for (const h of hosts) {
                const s = d.hosts[h];
                out.push('# ' + nm(h) + '  reads ' + s.reads + '  requests ' + s.reqs + '  limits ' + s.limits
                    + '  first ' + day(s.first) + '  last ' + (s.last ? day(s.last) : '-'));
            }
            out.push('');
            for (const r of d.rows) {
                out.push([
                    stamp(r.t), nm(r.h), r.k, r.p || '-',
                    r.ok + '/' + r.n, 'pg' + r.pg, secs(r.ms),
                    r.sp ? 'sp ' + r.sp.join('/') : 'sp -',
                    'prev ' + dur(r.since),
                    r.nr ? 'SLOWED' : '-',
                    r.out, r.b ? (r.b / 1048576).toFixed(1) + 'MB' : '-', evText(r.ev)
                ].join('  ').trimEnd());
            }
            return out.join('\n') + '\n';
        }

        const count = () => read().rows.length;
        // Rows kept, and limit events among them — enough for a settings line to say "it happened".
        function stats() {
            const d = read();
            return { rows: d.rows.length, limits: d.rows.reduce((n, r) => n + r.ev.length, 0) };
        }
        const clear = () => write(blank());

        return { init, enable, enabled, start, cutOpen, note, text, count, stats, clear,
            retryAfterOf, retryAfterSecs };
    })();
    // ==== us-log end ====

    // ---- constants
    const ME = 'vitakaninen';
    const MY_ID = '291742193';
    const SITE = 'https://www.nexusmods.com';
    const API = 'https://api.nexusmods.com/v2/graphql';
    const WIDGETS = SITE + '/Core/Libs/Common/Widgets/';
    const FALLBACK_MODS = [{ game: 'vein', id: 207, name: 'Startup Settings Manager' }];
    const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    const LOCK_MS = 90000;        // longer than one request can take
    const BEAT_MS = 3 * MIN;      // a challenge tab silent this long counts as closed
    const MAX_PAGES = 30;
    const MAX_DETAILS = 10;
    const MAX_OPENS = 2;          // challenge tabs per target per run
    const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';

    const K = {
        seen: 'nc_seen', deep: 'nc_deep', alerts: 'nc_alerts', lastOk: 'nc_lastOk', lastTry: 'nc_lastTry',
        failUntil: 'nc_failUntil', lock: 'nc_lock', run: 'nc_run', cf: 'nc_cf', mods: 'nc_mods',
        gen: 'nc_gen', report: 'nc_report', log: 'nc_log'
    };

    // ---- storage
    const get = (k, d) => { const v = GM_getValue(k); return v === undefined || v === null ? d : v; };
    const put = (k, v) => GM_setValue(k, v);
    const del = (k) => GM_deleteValue(k);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const me = Math.random().toString(36).slice(2);

    usLog.init({ load: () => get(K.log, ''), save: (s) => put(K.log, s) });

    // Thrown when another tab took over or the state was reset mid-run.
    class Aborted extends Error {}
    class Blocked extends Error {}

    // ---- lock
    async function takeLock() {
        const l = get(K.lock);
        if (l && Date.now() - l.t < LOCK_MS) return false;
        put(K.lock, { id: me, t: Date.now() });
        await sleep(500 + Math.random() * 400);
        const now = get(K.lock);
        return !!now && now.id === me;
    }

    function keepLock(gen) {
        const l = get(K.lock);
        if (!l || l.id !== me || get(K.gen, 0) !== gen) throw new Aborted('interrupted');
        put(K.lock, { id: me, t: Date.now() });
    }

    function dropLock() {
        const l = get(K.lock);
        if (l && l.id === me) del(K.lock);
    }

    // ---- page recognition
    const squash = (s) => String(s || '').replace(/[\s ]+/g, ' ').trim();
    const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

    // True when a document is Cloudflare's check rather than a Nexus page.
    function isChallengeDoc(doc) {
        if (doc.querySelector('.modtabs, #comment-container, #tab-modbugs')) return false;
        if (/^Just a moment/i.test(squash(doc.title))) return true;
        if (Array.from(doc.scripts).some(s => /_cf_chl_opt/.test(s.textContent))) return true;
        return /Performing security verification|Verifying you are human/i.test(doc.body ? doc.body.textContent.slice(0, 3000) : '');
    }

    const isChallenge = (r) => /^cf-mitigated:\s*challenge/im.test(r.headers) || isChallengeDoc(r.doc);

    // A mod tab's link and the count in it; null when the mod has that tab disabled.
    function navTab(doc, tab) {
        const a = doc.querySelector('.modtabs a[href*="tab=' + tab + '"]');
        if (!a) return null;
        const m = /([\d,.]+)\s*$/.exec(squash(a.textContent));
        return { count: m && /^[\d,.]+$/.test(m[1]) ? parseInt(m[1].replace(/\D/g, ''), 10) : null };
    }

    const hasNav = (doc) => !!doc.querySelector('.modtabs a');

    // Element text with line breaks kept as spaces.
    function textOf(el) {
        if (!el) return '';
        const c = el.cloneNode(true);
        c.querySelectorAll('script, style').forEach(e => e.remove());
        c.querySelectorAll('br').forEach(e => e.replaceWith(' '));
        return squash(c.textContent);
    }

    function lastPage(doc) {
        let n = 1;
        for (const a of doc.querySelectorAll('.pagination a[onclick]')) {
            const m = /'page',\s*'(\d+)'/.exec(a.getAttribute('onclick'));
            if (m) n = Math.max(n, +m[1]);
        }
        return n;
    }

    function currentPage(doc) {
        const s = doc.querySelector('.pagination .page-selected');
        return s ? parseInt(squash(s.textContent), 10) || 1 : 1;
    }

    // Every comment on a posts page, replies included.
    function parsePosts(doc) {
        const out = [];
        for (const li of doc.querySelectorAll('li.comment[id^="comment-"]')) {
            const m = /^comment-(\d+)$/.exec(li.id);
            if (!m) continue;
            const body = Array.from(li.children).find(c => c.classList.contains('comment-content'));
            out.push({
                id: m[1],
                who: squash((li.querySelector(':scope > .comment-head .comment-name a') || {}).textContent),
                text: textOf(body && body.querySelector('.comment-content-text'))
            });
        }
        const c = doc.querySelector('#comment-count');
        const n = c ? parseInt(c.getAttribute('data-comment-count'), 10) : NaN;
        return { items: out, count: isNaN(n) ? null : n, pages: lastPage(doc), page: currentPage(doc) };
    }

    // Every bug row on a bugs page. The table has no reporter names.
    function parseBugs(doc) {
        const out = [];
        for (const tr of doc.querySelectorAll('tr[data-issue-id]')) {
            const r = parseInt(squash((tr.querySelector('.table-bug-replies') || {}).textContent), 10);
            out.push({
                id: tr.getAttribute('data-issue-id'),
                title: textOf(tr.querySelector('a.issue-title')),
                replies: isNaN(r) ? 0 : r
            });
        }
        const st = doc.querySelector('#tab-modbugs select#status');
        return { items: out, pages: lastPage(doc), page: currentPage(doc), filtered: !!st && st.value !== '-1' && st.value !== '' };
    }

    // The address behind a tab's own "page N" button, from the page's inline script.
    function pageUrl(doc, widget, n) {
        const s = Array.from(doc.scripts).map(x => x.textContent).find(t => t.includes("RH.id = '" + widget + "'"));
        if (!s) return null;
        const grab = (name) => {
            const m = new RegExp('RH\\.' + name + '\\s*=\\s*JSON\\.parse\\(("(?:[^"\\\\]|\\\\.)*")\\)').exec(s);
            try { return m ? JSON.parse(JSON.parse(m[1])) : {}; } catch (_) { return {}; }
        };
        const all = Object.assign({}, grab('in_items'), grab('out_items'), { page: n });
        const q = Object.keys(all).filter(k => all[k] !== '').map(k => k + ':' + encodeURIComponent(all[k])).join(',');
        return WIDGETS + widget + '?RH_' + widget + '=' + q;
    }

    // ---- requests
    function request(opts) {
        return new Promise((res, rej) => {
            GM_xmlhttpRequest({
                method: opts.method || 'GET', url: opts.url, data: opts.data, headers: opts.headers || {},
                timeout: 30000,
                onload: (r) => res({ status: r.status, text: r.responseText || '', headers: r.responseHeaders || '' }),
                onerror: () => rej(new Error('network error')),
                ontimeout: () => rej(new Error('timed out'))
            });
        });
    }

    let lastReq = 0;

    // One logged request, paced, with the lock kept alive; throws Blocked on a Cloudflare check.
    async function send(ctx, opts) {
        keepLock(ctx.gen);
        const wait = lastReq + 1500 - Date.now();
        if (wait > 0) await sleep(wait);
        lastReq = Date.now();
        const lg = usLog.start('check', { host: opts.url, pace: 'v' + VERSION + ' g1500' });
        const q = lg && lg.req();
        let out = 'error';
        try {
            const r = await request(opts);
            r.doc = opts.json ? null : parse(r.text);
            const blocked = opts.json
                ? /^cf-mitigated:\s*challenge/im.test(r.headers) || /<title>Just a moment/i.test(r.text)
                : isChallenge(r);
            if (q) q.done({ status: r.status, limited: blocked || r.status === 429, signal: blocked ? 'soft' : 'hard', retryAfter: usLog.retryAfterOf(r.headers) });
            out = blocked || r.status === 429 ? 'limited' : 'done';
            if (blocked) throw new Blocked('Cloudflare check');
            if (r.status !== 200) throw new Error('HTTP ' + r.status);
            return r;
        } finally {
            if (lg) lg.end(out);
            if (get(K.gen, 0) !== ctx.gen) throw new Aborted('reset');
        }
    }

    // ---- my mods
    async function findMods(ctx) {
        const mods = [];
        for (let offset = 0; offset < 500; offset += 50) {
            const query = '{ mods(filter:{uploaderId:[{value:"' + MY_ID + '",op:EQUALS}]}, offset:' + offset
                + ', count:50){ totalCount nodes { modId name status game { domainName } } } }';
            const r = await send(ctx, {
                method: 'POST', url: API, json: true, data: JSON.stringify({ query }),
                headers: { 'Content-Type': 'application/json' }
            });
            const d = JSON.parse(r.text).data.mods;
            for (const n of d.nodes) {
                if (n.status === 'published') mods.push({ game: n.game.domainName, id: n.modId, name: n.name });
            }
            if (!d.nodes.length || offset + 50 >= d.totalCount) break;
        }
        if (!mods.length) throw new Error('no mods listed');
        return mods;
    }

    async function modList(ctx) {
        try {
            const mods = await findMods(ctx);
            put(K.mods, mods);
            say(ctx, 'Mod list: ' + mods.length + ' found automatically');
            return mods;
        } catch (e) {
            if (e instanceof Aborted) throw e;
            const saved = get(K.mods);
            say(ctx, 'Mod list: failed (' + e.message + '), using the ' + (saved ? 'last known list' : 'built-in list'));
            return saved || FALLBACK_MODS;
        }
    }

    // ---- state
    const keyOf = (t) => t.mod.game + '/' + t.mod.id;
    const urlOf = (t) => SITE + '/' + t.mod.game + '/mods/' + t.mod.id + '?tab=' + t.tab;
    const tabName = (tab) => (tab === 'bugs' ? 'Bugs' : 'Posts');

    function seenOf(t) {
        const s = get(K.seen, {})[keyOf(t)];
        return (s && s[t.tab]) || {};
    }

    // Alerts are queued before items are marked seen, so a crash between repeats an alert rather than losing it.
    function commit(ctx, t, seen, alerts) {
        keepLock(ctx.gen);
        if (alerts.length) addAlerts(alerts);
        const all = get(K.seen, {});
        const k = keyOf(t);
        all[k] = Object.assign({}, all[k], { [t.tab]: seen });
        put(K.seen, all);
        ctx.fresh.push(...alerts);
    }

    function addAlerts(list) {
        const cur = get(K.alerts, []);
        const have = new Set(cur.map(a => a.k));
        put(K.alerts, cur.concat(list.filter(a => !have.has(a.k))));
    }

    function setDeep(t, on) {
        const d = get(K.deep, {});
        const k = keyOf(t) + '/' + t.tab;
        if (on) d[k] = 1; else delete d[k];
        put(K.deep, d);
    }

    function say(ctx, line) { ctx.lines.push(line); }

    // A problem worth showing in the banner, once while undismissed.
    function warn(ctx, t, what) {
        say(ctx, label(t) + ': ' + what);
        addAlerts([{ k: 'warn/' + keyOf(t) + '/' + t.tab, mod: t.mod.name, tab: tabName(t.tab), who: '', text: 'Nexus Check: ' + what, url: urlOf(t), warn: true }]);
    }

    const label = (t) => t.mod.name + ' / ' + tabName(t.tab);
    const snip = (s) => { const x = squash(s); return x.length > 140 ? x.slice(0, 140) + '…' : x; };
    const isMe = (who) => squash(who).toLowerCase() === ME;

    // ---- reading one tab
    // Walks pages until one holds nothing new; an interrupted walk is resumed in full next time.
    async function walk(ctx, t, first, parser, widget, isNew) {
        const pages = [first.parsed];
        const deep = !!get(K.deep, {})[keyOf(t) + '/' + t.tab];
        const total = first.parsed.pages;
        let complete = true;
        for (let n = 2; n <= total; n++) {
            if (!deep && !pages[pages.length - 1].items.some(isNew)) break;
            if (n > MAX_PAGES) { warn(ctx, t, 'only the first ' + MAX_PAGES + ' of ' + total + ' pages were read'); break; }
            try {
                const url = pageUrl(first.doc, widget, n);
                if (!url) throw new Error('page address not found');
                const p = parser((await send(ctx, { url, headers: { 'X-Requested-With': 'XMLHttpRequest' } })).doc);
                if (!p.items.length || p.page !== n) throw new Error('unexpected content');
                pages.push(p);
            } catch (e) {
                if (e instanceof Aborted) throw e;
                complete = false;
                warn(ctx, t, 'page ' + n + ' of ' + total + ' could not be read (' + e.message + '); will retry next check');
                break;
            }
        }
        setDeep(t, !complete);
        const by = new Map();
        for (const p of pages) for (const i of p.items) by.set(i.id, i);
        return { items: Array.from(by.values()), all: complete && pages.length === total };
    }

    async function readPosts(ctx, t, doc) {
        const nav = navTab(doc, 'posts');
        const parsed = parsePosts(doc);
        if (!parsed.items.length) {
            if (hasNav(doc) && !nav) { say(ctx, label(t) + ': tab is disabled'); return; }
            const n = parsed.count != null ? parsed.count : nav && nav.count;
            if (n !== 0) throw new Error('no comments recognised (layout changed?)');
        }
        const seen = Object.assign({}, seenOf(t));
        const got = await walk(ctx, t, { doc, parsed }, parsePosts, 'CommentContainer', i => !seen[i.id]);
        const alerts = [];
        for (const i of got.items) {
            if (seen[i.id]) continue;
            seen[i.id] = 1;
            if (isMe(i.who)) continue;
            alerts.push({ k: keyOf(t) + '/posts/' + i.id, mod: t.mod.name, tab: 'Posts', who: i.who, text: snip(i.text), url: urlOf(t) });
        }
        commit(ctx, t, seen, alerts);
        say(ctx, label(t) + ': ' + got.items.length + ' read, ' + alerts.length + ' new');
        if (got.all && parsed.count != null && got.items.length !== parsed.count) {
            warn(ctx, t, 'Nexus says ' + parsed.count + ' comments but ' + got.items.length + ' were recognised');
        }
        const bugs = navTab(doc, 'bugs');
        if (hasNav(doc)) ctx.bugs[keyOf(t)] = bugs ? bugs.count : 0;
    }

    // Names and text inside one bug; null when Nexus would not say.
    async function bugDetail(ctx, id) {
        if (ctx.noDetail || ctx.details >= MAX_DETAILS) return null;
        ctx.details++;
        try {
            const r = await send(ctx, {
                method: 'POST', url: WIDGETS + 'ModBugReplyList', data: 'issue_id=' + encodeURIComponent(id),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }
            });
            let links = r.doc.querySelectorAll('.comment-name a');
            if (!links.length) links = r.doc.querySelectorAll('a[href*="/profile/"], a[href*="/users/"]');
            const names = Array.from(new Set(Array.from(links).map(a => squash(a.textContent)).filter(Boolean)));
            return { names, text: textOf(r.doc.querySelector('.comment-content-text')) };
        } catch (e) {
            if (e instanceof Aborted) throw e;
            ctx.noDetail = true;
            say(ctx, 'Bug details: not available (' + e.message + ')');
            return null;
        }
    }

    async function readBugs(ctx, t, doc) {
        const nav = navTab(doc, 'bugs');
        if (hasNav(doc) && !nav) { say(ctx, label(t) + ': tab is disabled'); return; }
        if (!doc.querySelector('#tab-modbugs')) throw new Error('bug list not found (layout changed?)');
        const parsed = parseBugs(doc);
        if (parsed.filtered) throw new Error('the bug list on that page is filtered');
        if (!parsed.items.length && !/No issues reported/i.test(doc.querySelector('#tab-modbugs').textContent) && !(nav && nav.count === 0)) {
            throw new Error('no bugs recognised (layout changed?)');
        }
        const seen = Object.assign({}, seenOf(t));
        const changed = (i) => !(i.id in seen) || i.replies > seen[i.id];
        const got = await walk(ctx, t, { doc, parsed }, parseBugs, 'ModBugsTab', changed);
        const alerts = [];
        for (const i of got.items) {
            if (!changed(i)) { seen[i.id] = i.replies; continue; }
            const fresh = !(i.id in seen);
            const d = await bugDetail(ctx, i.id);
            const names = (d && d.names) || [];
            seen[i.id] = i.replies;
            if (names.length && names.every(isMe)) continue;
            alerts.push({
                k: keyOf(t) + '/bugs/' + i.id + '/' + i.replies, mod: t.mod.name, tab: 'Bugs',
                who: fresh ? names[0] || '' : names.length ? 'New reply (thread: ' + names.join(', ') + ')' : 'New reply',
                text: snip(i.title + (fresh && d && d.text ? ': ' + d.text : '')), url: urlOf(t)
            });
        }
        commit(ctx, t, seen, alerts);
        say(ctx, label(t) + ': ' + got.items.length + ' read, ' + alerts.length + ' new');
    }

    // ---- Cloudflare
    const cfFresh = () => { const c = get(K.cf); return !!c && Date.now() - c.beat < BEAT_MS; };
    const cfCooling = () => { const c = get(K.cf); return !!c && (cfFresh() || Date.now() < c.opened + HOUR); };

    function openChallenge(t) {
        const url = urlOf(t);
        put(K.cf, { url, opened: Date.now(), beat: Date.now() });
        const tab = GM_openInTab(url, { active: true });
        if (tab) tab.onclose = () => {
            const c = get(K.cf);
            if (c && c.url === url) put(K.cf, Object.assign({}, c, { beat: 0 }));
        };
    }

    // Runs on the check page itself: tells every other tab it is still open.
    function heartbeat() {
        const beat = () => {
            const c = get(K.cf);
            if (!c || new URL(c.url).pathname !== location.pathname || !isChallengeDoc(document)) return;
            put(K.cf, Object.assign({}, c, { beat: Date.now() }));
            setTimeout(beat, 15000);
        };
        beat();
    }

    // ---- the check
    const matchesHere = (t) => {
        const u = new URL(urlOf(t));
        return location.hostname === u.hostname && location.pathname === u.pathname
            && new URLSearchParams(location.search).get('tab') === t.tab;
    };

    // Reads every remaining tab; opts.live lets the loaded page stand in for its own request.
    async function runCheck(opts) {
        if (!await takeLock()) return 'busy';
        const ctx = { gen: get(K.gen, 0), lines: [], fresh: [], bugs: {}, details: 0, noDetail: false };
        let status = 'ok';
        put(K.lastTry, Date.now());
        try {
            let run = get(K.run);
            if (!run || (opts.manual && !opts.live) || Date.now() - run.started > DAY) {
                const mods = await modList(ctx);
                run = { started: Date.now(), todo: [], bugs: {}, lines: [] };
                for (const mod of mods) for (const tab of ['posts', 'bugs']) run.todo.push({ mod, tab, opens: 0 });
            }
            ctx.lines = (run.lines || []).concat(ctx.lines);
            ctx.bugs = run.bugs || {};
            const saveRun = () => { keepLock(ctx.gen); run.bugs = ctx.bugs; run.lines = ctx.lines; put(K.run, run); };
            saveRun();

            const order = run.todo.slice();
            if (opts.live) order.sort((a, b) => matchesHere(b) - matchesHere(a));
            let blocked = null, failed = false;
            for (const t of order) {
                const live = opts.live && matchesHere(t) && !isChallengeDoc(document);
                try {
                    if (t.tab === 'bugs' && !live && ctx.bugs[keyOf(t)] === 0) {
                        say(ctx, label(t) + ': 0 bugs listed, no request needed');
                    } else {
                        const doc = live ? document : (await send(ctx, { url: urlOf(t) })).doc;
                        say(ctx, label(t) + ': ' + (live ? 'reading the loaded page' : 'background request worked'));
                        if (live && currentPage(doc) !== 1) throw new Error('the loaded page is not on page 1');
                        await (t.tab === 'posts' ? readPosts : readBugs)(ctx, t, doc);
                    }
                    run.todo = run.todo.filter(x => x !== t);
                    saveRun();
                } catch (e) {
                    if (e instanceof Aborted) throw e;
                    if (e instanceof Blocked) {
                        say(ctx, label(t) + ': background request blocked by Cloudflare');
                        blocked = t;
                        break;
                    }
                    failed = true;
                    const why = 'could not be read (' + e.message + ')';
                    if (/^(network error|timed out)$/.test(e.message)) say(ctx, label(t) + ': ' + why);
                    else warn(ctx, t, why);
                }
            }

            if (blocked && blocked.opens < MAX_OPENS) {
                blocked.opens++;
                status = 'blocked';
                saveRun();
                openChallenge(blocked);
            } else if (blocked || failed) {
                status = 'failed';
                for (const t of run.todo) t.opens = 0;
                saveRun();
                put(K.failUntil, Date.now() + HOUR);
                if (blocked) warn(ctx, blocked, 'still blocked by Cloudflare; will try again in an hour');
            } else {
                keepLock(ctx.gen);
                del(K.run);
                del(K.failUntil);
                put(K.lastOk, Date.now());
            }
        } catch (e) {
            status = e instanceof Aborted ? 'aborted' : 'failed';
            say(ctx, 'Stopped: ' + e.message);
            if (status === 'failed') put(K.failUntil, Date.now() + HOUR);
        } finally {
            if (status !== 'aborted') {
                const n = notify(ctx.fresh);
                if (n) say(ctx, n);
                put(K.report, { t: Date.now(), status, lines: ctx.lines });
            }
            dropLock();
            render();
        }
        return status;
    }

    // ---- alerts: desktop
    function notify(list) {
        if (!list.length) return '';
        const one = (title, text, url) => GM_notification({
            title, text, onclick: () => GM_openInTab(url, { active: true })
        });
        try {
            if (list.length <= 3) {
                for (const a of list) one(a.mod + ' – ' + a.tab, (a.who ? a.who + ': ' : '') + a.text, a.url);
            } else {
                one('Nexus: ' + list.length + ' new', list.slice(0, 3).map(a => a.tab + ' – ' + (a.who ? a.who + ': ' : '') + a.text.slice(0, 50)).join('\n'), list[0].url);
            }
            return 'Desktop notification: requested without error (the script cannot tell if it was shown)';
        } catch (e) {
            return 'Desktop notification: failed (' + e.message + ')';
        }
    }

    // ---- alerts: banner
    function el(tag, css, text) {
        const e = document.createElement(tag);
        e.style.cssText = css;
        if (text != null) e.textContent = text;
        return e;
    }

    const FONT = 'font:13px/1.4 system-ui,sans-serif;';
    const BTN = FONT + 'background:#45475a;color:#cdd6f4;border:0;border-radius:4px;padding:3px 9px;cursor:pointer;';
    let bannerHost = null, panelHost = null;

    function mount(css) {
        const host = el('div', 'all:initial;position:fixed;z-index:2147483647;' + css);
        const root = host.attachShadow({ mode: 'closed' });
        document.documentElement.appendChild(host);
        return { host, root };
    }

    const dismiss = (k) => { put(K.alerts, k ? get(K.alerts, []).filter(a => a.k !== k) : []); render(); };

    // Redraws the banner from the stored queue.
    function render() {
        buildMenu();
        if (!isHtml) return;
        const list = get(K.alerts, []);
        if (bannerHost) { bannerHost.remove(); bannerHost = null; }
        if (!list.length || isChallengeHere()) return;
        const { host, root } = mount('top:12px;right:12px;width:min(400px,calc(100vw - 24px));');
        bannerHost = host;
        const box = el('div', FONT + 'background:#1e1e2e;color:#cdd6f4;border:1px solid #89b4fa;border-radius:8px;box-shadow:0 4px 18px #0009;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;text-align:left;');
        const head = el('div', 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:#313244;');
        head.appendChild(el('b', 'flex:1;color:#89b4fa;', 'Nexus: ' + list.length + (list.length === 1 ? ' alert' : ' alerts')));
        const all = el('button', BTN, 'Dismiss all');
        all.addEventListener('click', () => dismiss());
        head.appendChild(all);
        box.appendChild(head);
        const body = el('div', 'overflow:auto;');
        for (const a of list) {
            const row = el('div', 'display:flex;gap:8px;padding:8px 10px;border-top:1px solid #313244;');
            const main = el('div', 'flex:1;min-width:0;cursor:pointer;overflow-wrap:anywhere;');
            main.appendChild(el('div', 'font-weight:600;color:' + (a.warn ? '#f9e2af' : '#a6e3a1') + ';', a.mod + ' – ' + a.tab));
            if (a.who) main.appendChild(el('div', 'color:#89b4fa;', a.who));
            main.appendChild(el('div', '', a.text));
            main.addEventListener('click', () => GM_openInTab(a.url, { active: true }));
            const x = el('button', BTN + 'align-self:flex-start;', '×');
            x.addEventListener('click', () => dismiss(a.k));
            row.append(main, x);
            body.appendChild(row);
        }
        box.appendChild(body);
        root.appendChild(box);
    }

    function toast(text) {
        if (!isHtml) return;
        const { host, root } = mount('bottom:24px;left:50%;transform:translateX(-50%);');
        root.appendChild(el('div', FONT + 'background:#1e1e2e;color:#cdd6f4;border:1px solid #89b4fa;border-radius:8px;padding:10px 16px;box-shadow:0 4px 18px #0009;', text));
        setTimeout(() => host.remove(), 3000);
    }

    // The last check's outcome and the request log, selectable for copying.
    function showReport() {
        if (panelHost) panelHost.remove();
        const r = get(K.report);
        const { host, root } = mount('inset:8vh 10vw;');
        panelHost = host;
        const box = el('div', FONT + 'background:#1e1e2e;color:#cdd6f4;border:1px solid #89b4fa;border-radius:8px;padding:12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;');
        const ta = el('textarea', 'flex:1;background:#313244;color:#cdd6f4;border:0;border-radius:4px;padding:8px;font:12px/1.5 monospace;resize:none;');
        ta.readOnly = true;
        const ok = get(K.lastOk, 0);
        ta.value = 'Last complete check: ' + (ok ? new Date(ok).toISOString() : 'never') + '\n'
            + (r ? 'Last run: ' + new Date(r.t).toISOString() + '  ' + r.status + '\n\n' + r.lines.join('\n') : 'No run yet') + '\n\n' + usLog.text();
        const close = el('button', BTN + 'align-self:flex-start;', 'Close');
        close.addEventListener('click', () => host.remove());
        box.append(ta, close, el('div', 'color:#6c7086;font-size:11px;text-align:right;', 'v' + VERSION));
        root.appendChild(box);
    }

    // ---- menu
    const SAID = {
        ok: 'Nexus check finished', busy: 'A Nexus check is already running', aborted: 'Nexus check interrupted',
        failed: 'Nexus check incomplete – see Show last report', blocked: 'Cloudflare check opened – complete it there'
    };

    async function checkNow() {
        if (cfFresh()) return toast('A Cloudflare tab is already open – complete it there');
        toast('Checking Nexus…');
        toast(SAID[await runCheck({ manual: true })]);
    }

    function resetState() {
        if (!confirm('Nexus Check: forget all seen comments and alerts? The next check will alert about everything again.')) return;
        put(K.gen, get(K.gen, 0) + 1);
        for (const k of ['seen', 'deep', 'alerts', 'lastOk', 'lastTry', 'failUntil', 'lock', 'run', 'cf', 'mods', 'report']) del(K[k]);
        render();
        toast('Nexus Check state cleared');
    }

    let menuIds = [], menuCount = -1;

    // Rebuilt only when a label changed.
    function buildMenu() {
        const n = get(K.alerts, []).length;
        if (n === menuCount) return;
        menuCount = n;
        for (const id of menuIds) GM_unregisterMenuCommand(id);
        menuIds = [
            GM_registerMenuCommand('Check now', checkNow),
            GM_registerMenuCommand('Unread alerts: ' + n, () => { render(); toast(n ? n + ' shown at top right' : 'No unread alerts'); }),
            GM_registerMenuCommand('Show last report', showReport),
            GM_registerMenuCommand('Reset saved state', resetState)
        ];
    }

    // ---- start
    const isHtml = document.documentElement instanceof HTMLElement && !!document.body;
    const onNexus = /(^|\.)nexusmods\.com$/.test(location.hostname);
    const isChallengeHere = () => onNexus && isChallengeDoc(document);

    const due = () => Date.now() - get(K.lastOk, 0) > DAY;

    async function start() {
        if (isChallengeHere()) { heartbeat(); buildMenu(); return; }
        render();
        GM_addValueChangeListener(K.alerts, (n, a, b, remote) => { if (remote) render(); });

        const run = get(K.run);
        const cf = get(K.cf);
        if (onNexus && run && location.hostname === 'www.nexusmods.com') {
            const here = run.todo.some(matchesHere);
            if (cf) del(K.cf);
            if (here || cf) {
                for (let i = 0; i < 10; i++) {
                    if (await runCheck({ live: true }) !== 'busy') return;
                    await sleep(2000);
                }
                return;
            }
        }
        if (!due() || cfCooling() || Date.now() < get(K.failUntil, 0)) return;
        if (Date.now() - get(K.lastTry, 0) < 5 * MIN) return;
        await sleep(2000);
        if (due() && !cfCooling()) await runCheck({});
    }

    start();
})();
