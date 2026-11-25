# Nexus-Check

Userscript (LibreWolf + Violentmonkey): daily check of VitaKaninen's Nexus mods for new posts and bug
reports. v0.1.0 written 2026-11-25; tests pass, **never yet run in LibreWolf** (unknown there: whether
GM_xmlhttpRequest passes Cloudflare, whether GM_notification shows; ask for `Show last report`).

Tests: serve this folder (`.claude/launch.json` "tests"), open `/tests/run.html`, expect `DONE 0 failed`.
`us-log` is synced from HoverZoom: never edit it here.

## Rules that prevent regressions
- Alerts are stored before items are marked seen; a tab is committed only after its pages are walked.
- A pages walk cut short sets `nc_deep`, so the next check ignores the "nothing new, stop" rule.
- A page without the expected elements is an error, never "no comments".
- Selectors are ID-based by user approval (not learned); the comment count is the cross-check.
- Own comments are marked seen while the toggle is off, so turning it on does not replay them.
- A bug's author is known only from ModBugReplyList; unknown author = alert, never ignore. With the toggle
  off, an own reply in someone else's bug still alerts (order of names in that response is unverified).
- `MAX_OPENS` stops a pass-but-still-blocked loop of challenge tabs.
- Never fetch from a challenge page to get around it; the user completes the check, then the live DOM is read.

## Verified 2026-11-25 (built-in pane, logged out)

**Mod list:** `POST https://api.nexusmods.com/v2/graphql` (no login, no Cloudflare challenge via curl):
`{ mods(filter:{uploaderId:[{value:"291742193",op:EQUALS}]}, count:50){ totalCount nodes { modId name
status adultContent game { domainName id } } } }` returns mod 207 / vein / game 8175. Id comes from
`userByName(name:"VitaKaninen"){memberId}`. The schema has no mod-page comments or bugs (`comment(179693565)`
= not found; only collection bug reports), so those need the HTML pages.

**Posts** (`?tab=posts`): `li.comment#comment-N`, name `.comment-name a`, body `#comment-content-N`
(`.comment-content-text`), date `time[data-date]` (epoch s). Replies are `li.comment` nested in
`ol.comment-kids`, so use each comment's own head (`:scope >`), not a deep query.
`#comment-count[data-comment-count]` includes replies (2 = 1 + 1 reply). 10 threads a page; sticky first,
rest ordered by latest activity. Pages: `RH_CommentContainer.Send('page', N)`.

**Bugs** (`?tab=bugs`): `#tab-modbugs`; empty text "No issues reported at this time."; rows
`tr.mod-issue-row#issue_N[data-issue-id]`, title `a.issue-title`, `.table-bug-replies`, last post
`.table-bug-post time[data-date]`. No `li.comment`, **no reporter name**. Sorted by last post.
Reporter/replies: `POST /Core/Libs/Common/Widgets/ModBugReplyList`, body `issue_id=N` (response not seen;
`#mainissue_N`, `.repliesto_N` are referenced by the page's JS).
Page 2: `GET /Core/Libs/Common/Widgets/ModBugsTab?RH_ModBugsTab=id:M,game_id:G,page_size:10,page:2`.
Posts page 2 is presumably the same shape on `CommentContainer` (untested; items are in the page's inline script).

**Trap:** a mod with Bugs disabled (SkyUI 12604) serves the *Description* tab with 200 for `?tab=bugs`.
Check `.modtabs a[href*="tab=bugs"]` exists; its text carries the count (`Bugs 0`).

**Cloudflare:** pane challenged most navigations (title "Just a moment...", 403, text "Performing security
verification" or "Verifying you are human"). Even on a loaded page, `fetch` of the tabs and the site's own
widget XHRs got 403 challenges; one follow-up navigation passed. The user's earlier same-page fetch got 200
while the page was challenged. So passing a check does not guarantee background requests work: read the
**loaded tab's live DOM** too. Unknown for LibreWolf + `GM_xmlhttpRequest`.
Sample with bugs (not adult): skyrimspecialedition/mods/51614. Avoid adult mods (login).

**Violentmonkey:** no documented toolbar badge API. `GM_openInTab` handle has `onclose`/`closed`, `onclose` is lost if the
opening page goes away. `@connect` is not in its docs.

**Menu shows red "undefined is not a function", command still works** (user report, not reproduced):
likely VM 2.50.1, not this script. The popup sends `Command` to every frame; a `@noframes` script is absent from a
subframe's `bridge.ids`, so its realm is undefined and `setupContentInvoker`'s `postViaBridge` (undefined when the
frame has only content-mode scripts) is called. The rejection also skips the popup's auto-close. Untested fix:
drop `@noframes`, keep `@inject-into content`, and return at the top if `window !== window.top`.
Test: no error expected on a page without iframes.
