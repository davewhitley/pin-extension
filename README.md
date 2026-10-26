# Pin

A small Chrome extension: crop any part of a page, mark it up, type a comment, and it files a
GitHub or Linear issue with the screenshot and your device details attached. No server behind it.

```
Click the toolbar icon  →  drag a box  →  title + description + labels  →  Create issue
```

The title field is optional. Leave it blank and the first line of the description becomes the
title — the placeholder previews exactly what will be used, so the fallback is never a surprise.
A title on its own is fine too; the description is then omitted from the issue body entirely.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → choose this folder
4. Click the Pin icon → the options page opens → **Sign in with GitHub**, or use a token
5. **Add from GitHub…** → tick the repositories you file into
6. Press **Test all**

For a team, see **[SETUP.md](SETUP.md)** — one person creates a GitHub App, everyone else just signs
in. Nobody handles a token.

Shortcuts (rebind at `chrome://extensions/shortcuts`):

| | |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> | Capture the current tab |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | Open the paste view |

## Capturing hover states and open menus

**Use the keyboard shortcut, not the toolbar icon.** Clicking the icon moves the mouse (ending
`:hover`) and focuses browser chrome (firing `blur`, which closes most popovers). The shortcut does
neither, and the screenshot is taken *before* the overlay is drawn — so hover styles, tooltips, and
open menus are captured intact.

While you crop, the overlay shows the **frozen screenshot**, not the live page. Your popover has
almost certainly closed by then; it doesn't matter, because you're selecting against the captured
pixels. What you crop is what you get.

### Discovering the shortcut

Clicking the toolbar icon is the gesture that destroys hover states, so that is exactly when Pin
mentions the alternative: a second line under the capture bar reads *"Next time press ⌥⇧B to keep
hover states and open menus"*. It appears **only** when the capture began with a click — using the
shortcut never nags you — and it names whatever key Chrome currently has bound, read live via
`chrome.commands.getAll()`.

With no shortcut assigned it offers to fix that instead, opening `chrome://extensions/shortcuts`
directly, which a normal link on a page cannot do.

**On a non-QWERTY layout the label names the physical key in QWERTY terms.** Chrome matches
shortcuts by key position, so a Dvorak user reading "⌥⇧B" presses the key that types X. Re-record
the shortcut in Chrome's own dialog and it will be self-consistent — the displayed letter stays
QWERTY-named, but the key you press is the one you recorded.

## Signing in

**Sign in with GitHub** uses the [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps):
a short code, typed into github.com, polled until approved. It needs no client secret, so Pin has no
backend and nobody pastes a token. The client ID in [`src/config.js`](src/config.js) is not a secret.

A GitHub App also fixes the two things that made tokens painful: SAML orgs authorise the App once
centrally instead of per-token, and access is limited to the repositories the App was installed on
rather than every repo you can reach.

Personal access tokens still work and are still a first-class path — settings opens that section on
its own when no App is configured.

## Destinations: GitHub and Linear

Pin files to GitHub repositories and Linear teams from the same dropdown, chosen per report. A Linear
destination can carry a **parent issue**, in which case reports are created as sub-issues of it and
inherit the parent's project — the shape you want for a QA pass hanging off one epic.

GitHub authenticates with the App sign-in above; Linear with a personal API key (its `Authorization`
header takes the key raw, with no `Bearer` prefix). See [SETUP.md](SETUP.md).

## Choosing repositories

**Add from GitHub…** lists what your credential can actually reach, newest activity first, with a
filter box. A GitHub App shows the repos it was installed on, which is usually a short deliberate
list; a token shows everything, which in a large org can be hundreds — hence the filter. Repositories
already added are shown greyed out rather than hidden, so the list doesn't shuffle as you pick.

**Add manually** stays, for a repo outside the App's installation.

## Duplicate check

As you type a title, Pin looks for open issues that already say it and shows a quiet
*"3 similar open issues"* line, expanding to titles you can open in a new tab.

Debounced at 600ms — GitHub's search API allows 30 requests a minute and a title is typed one
character at a time — and skipped entirely below six characters. It never blocks filing: the moment
worth catching a duplicate is while the title is still being written, not in a dialog after you have
already decided.

## Markup

Once you have cropped, drawing is live inside the selection — there is nothing else to do in that
area, so no tool needs arming first. A toolbar sits just above it: four ink colours, Undo, Clear.
Red is the default; white is there for dark UI, where the others disappear.

The toolbar attaches above the selection, or below it when there is no room above. For a selection
too tall for either — a near-fullscreen capture — it floats just inside the top-left corner instead.
Clamping to the viewport in that case used to pin it to the very bottom of the screen: technically
on-screen, visually clipped, and nowhere near what was being drawn.

The cursor is a pencil tinted with the current ink, so it names both the tool and the colour —
crosshair is the crop cursor and said nothing about drawing. It carries a white outline over a dark
one, because a cursor has to stay legible against an arbitrary screenshot: white keeps it visible on
dark UI, dark keeps white ink visible on light.

Strokes are kept as points in selection-relative CSS pixels and only burned into the image at submit
time, so Undo and Clear stay cheap and lossless. The service worker redraws them onto the
full-resolution crop, scaled by the ratio between the two — markup on a Retina capture is drawn at
capture resolution, not upscaled from screen pixels.

The report panel places itself clear of the selection whenever the viewport allows, trying below,
above, right, then left. It is above the canvas in z-order, so anywhere it covers cannot be drawn
on. When a selection is too large for any clear placement, it takes the position that hides the
least of it.

## Paste view

Some things no extension can screenshot: native `<select>` dropdowns, autofill, date pickers —
Chromium renders those outside the page's paint tree
([open since M21](https://groups.google.com/a/chromium.org/d/topic/chromium-bugs/MfYoOgd6w6Y)).
Anything outside the browser is out of reach too.

The capture bar carries an **Upload an image instead** link, so the paste view is findable at the
moment you discover Pin cannot capture what you are looking at — rather than only from a shortcut
you would have to already know about.

So take the screenshot yourself and paste it in. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> opens
a Pin tab that accepts <kbd>⌘</kbd><kbd>V</kbd>, a dropped file, or a file picker; from there it's
the same crop, comment, label, and file flow. On a Mac,
<kbd>⌘</kbd><kbd>⌃</kbd><kbd>⇧</kbd><kbd>4</kbd> copies a region straight to the clipboard.

Pressing the icon on a page Chrome refuses to capture — `chrome://`, the Web Store, the PDF viewer —
now opens this view instead of dead-ending.

Because a pasted image may not come from a web page at all, no URL is invented. The panel offers an
optional **URL or context** field, and the environment table keeps only what's still true of your
machine: browser, OS, screen, language, time zone.

## Which token

Two different things need authorization, and they may not accept the same token type:

| Operation | Endpoint | Status |
| --- | --- | --- |
| Create issue | `api.github.com` | Documented. Fine-grained token with Issues: read & write works. |
| Upload screenshot | `uploads.github.com/user-attachments/assets` | **Undocumented.** May require a *classic* token with `repo` scope. |

**Test all** exercises both — including a real 1×1 PNG upload — against *every* configured repo, so
you find out immediately rather than halfway through your first bug report. It checks each repo
separately because SSO and permissions are granted per organization.

### Verifying the upload endpoint by hand

If you'd rather confirm it outside the extension first:

```bash
TOKEN=your_token_here; OWNER=your-username; REPO=your-repo
REPO_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "repository_id = $REPO_ID"
```

Then upload any PNG and see whether a URL comes back:

```bash
curl -sS -X POST "https://uploads.github.com/user-attachments/assets?name=test.png&content_type=image/png&repository_id=$REPO_ID" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: image/png" --data-binary @/path/to/some.png
```

A JSON response containing `href` means it works. A 401 or 403 means try a classic token instead.

### If GitHub ever kills that endpoint

`src/github.js` already contains `uploadAssetViaRepoCommit()` — a documented fallback that commits
the PNG into a `bug-screenshots/` folder and links the raw URL. Swapping to it is a one-line change
in `src/background.js`. Nothing else in the extension knows where images live.

## Multiple repositories

Add as many as you like in settings, each with its own labels. When you write a report, a dropdown
in the panel picks where it goes — defaulting to whichever you used last. Repo ids are resolved
once and cached per entry.

### Labels

Labels are fetched from GitHub and picked per issue. Hit **+ Label** in the panel for a searchable
list showing each label's real color and description; selected ones appear as chips you can remove.

Per-repo **default labels** live in settings — choose them from the same fetched list rather than
typing them — and arrive pre-selected on every capture, removable per issue. A default that no
longer exists in the repo is flagged in settings and quietly skipped when filing, so a renamed
label can't silently do nothing.

The list is cached and refreshed in the background, so the panel never waits on the network. Only
the first capture against a new repo blocks.

### Organization repos

Point **Owner** at the organization login and it works the same way. Two things gate it:

- **SAML SSO.** A valid token is rejected until you authorize it for that org:
  [github.com/settings/tokens](https://github.com/settings/tokens) → **Configure SSO** → Authorize.
  Test all names the org when this is the cause rather than blaming the token type.
- **Org token policy.** Some orgs block classic PATs, or require admin approval for fine-grained
  ones whose resource owner is the org.

You need at least Triage to file issues, and Issues must be enabled. **Labels are different:**
GitHub applies them only if you have **push access** — otherwise they are silently dropped. Pin
detects this and disables the picker with an explanation, rather than letting labels vanish.

### A note on private screenshots

Since [May 2023](https://github.blog/changelog/2023-05-09-more-secure-private-attachments/),
attachments uploaded to a **private** repo require sign-in to view — so a screenshot of an internal
tool is genuinely access-controlled, not just sitting behind an unguessable URL. Attachments on
**public** repos are public. Email notifications from private repos replace images with links.

## How it works

| File | Role |
| --- | --- |
| `src/background.js` | Service worker. Captures the tab, crops, talks to GitHub. |
| `src/github.js` | Every network call to GitHub, isolated so the upload strategy is swappable. |
| `src/overlay.js` | Injected on demand. Crop selector, comment panel, device-info collection. |
| `src/options.html/js` | Repository list and per-repo connection test. |
| `src/paste.html/js` | Paste, drop, or pick an image Pin can't capture itself. |
| `src/auth.js` | GitHub device flow — no client secret, no backend. |
| `src/linear.js` | Linear GraphQL: teams, labels, parent lookup, uploads, issues. |
| `src/config.js` | The GitHub App's client ID. Not a secret. |

Two deliberate choices:

- **The screenshot is taken before the overlay is drawn**, so the selector never appears in the image.
- **The token never enters the page.** The overlay reports a rectangle and some metadata; the
  service worker holds the credential and makes every authenticated request.

Crop scale is derived from the captured bitmap width divided by the reported viewport width, rather
than assuming `devicePixelRatio` — the two disagree under page zoom, and assuming would put the crop
in the wrong place.

## Keystrokes stay in the panel

Sites with single-letter shortcuts (GitHub, Linear, Notion, Gmail) bind keys like `n`, `/`, and `g`
on `document`, guarded by "ignore this if the user is typing in a field". That guard fails against a
shadow DOM overlay: the browser retargets the event, so the page sees `event.target` as Pin's host
`<div>`, not an `<input>`, concludes nobody is typing, and fires the shortcut — stealing focus
mid-word.

Pin stops key and pointer events at its host so the page never sees them. Escape and
<kbd>Cmd</kbd>+<kbd>Enter</kbd> still work, because those are handled on `window` during the capture
phase, before an event could reach the host.

The wheel is treated separately: the page must not scroll while the frozen screenshot is up, but the
panel's own scroll regions must still work. Pin cancels a wheel only when nothing under the pointer
can actually scroll, and `overscroll-behavior: contain` keeps a list that has hit its end from
chaining through to the page.

## Limitations

- **Viewport only.** No full-page scroll-and-stitch capture.
- **Native UI is never captured** by a tab screenshot — use the paste view for it.
- **Some pages can't be captured:** `chrome://` pages, the Chrome Web Store, other extensions'
  pages, the built-in PDF viewer. Pin now opens the paste view for these instead of erroring.
- **Designs outside the browser** — the Figma desktop app, a native window — go through the paste
  view rather than a tab capture.
- **The token sits in `chrome.storage.local` in plain text**, readable by anything with access to
  this Chrome profile. Scope it to one repo.
- **Label colors are nudged at the extremes.** Pure white and near-black labels would vanish
  against one theme, so the dot and border are darkened or lightened just enough to stay visible.
- **One token for all repos.** If personal and work repos need different tokens, that's not supported yet.

## License

GPL-2.0-or-later, the same terms as WordPress. See [LICENSE](LICENSE).
