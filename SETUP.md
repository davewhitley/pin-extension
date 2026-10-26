# Setting Pin up for a team

Two jobs: someone creates a GitHub App **once**, then each teammate installs the extension and
signs in. No server is involved at any point.

If you can't get a GitHub App approved in your org, skip to [Without a GitHub App](#without-a-github-app)
— Pin still works, just with less pleasant setup per person.

---

## Part 1 — Create the GitHub App (once)

At **Settings → Developer settings → GitHub Apps → New GitHub App** (org-level if you can; personal
works for trying it out).

**Basics**

| Field | Value |
| --- | --- |
| Name | `Pin` (must be globally unique — prefix with your org if taken) |
| Homepage URL | Anything; your repo is fine |
| Webhook | **Uncheck Active.** Pin has no server to receive one |

**Two settings that will silently ruin this if missed**

1. ☑ **Enable Device Flow** — without it sign-in returns a bare `Not Found` and nothing explains why.
2. ☐ **Expire user authorization tokens** — leave this **unchecked**.

   The second one matters more than it looks. GitHub App user tokens expire after 8 hours by default,
   and refreshing one requires the client secret. An extension cannot hold a secret — that is the
   whole reason the device flow works without a server — so with expiry on, everybody would
   re-authenticate roughly twice a day, forever.

**Permissions** (Repository permissions)

| Permission | Access | Why |
| --- | --- | --- |
| Issues | Read and write | Filing issues, reading them for the duplicate check |
| Metadata | Read-only | Mandatory; GitHub adds it automatically |
| Contents | Read-only | Only needs **write** if you fall back to committing screenshots (see below) |

Set **Where can this app be installed** to *Any account* if teammates are in other orgs.

**Then:** create it, and from the App's page click **Install App** → choose the org → pick the
repositories people should be able to file into. That list is what the repo picker shows, which is
why it is worth being deliberate here rather than granting all repositories.

---

## Part 2 — Put the client ID in the extension

From the App's settings page, copy the **Client ID** (looks like `Iv23li...`) into
[`src/config.js`](src/config.js):

```js
export const GITHUB_CLIENT_ID = 'Iv23liYOURIDHERE';
```

A client ID is **not** a secret. It is safe in source, safe in git, and safe to publish — the device
flow is designed around having no secret at all.

---

## Part 3 — Each teammate

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → pick the folder
2. Pin the icon (puzzle-piece menu → pin)
3. Click the icon → **Sign in with GitHub** → a code appears and GitHub opens → paste it → approve
4. **Add from GitHub…** → tick the repositories they file into
5. **Test all** → every row should say *ready*

They never see or handle a token.

### Shortcuts

`Alt+Shift+B` captures, `Alt+Shift+V` opens the paste view. Chrome assigns these only if free; check
`chrome://extensions/shortcuts` if nothing happens.

**Non-QWERTY layouts:** Chrome matches shortcuts by *physical key position*, so on Dvorak the
manifest's `B` is the key that types `X`. Re-record the shortcut in Chrome's dialog and it will be
self-consistent — the label keeps showing the QWERTY name for that position, which is cosmetic.

---

## Without a GitHub App

Leave `GITHUB_CLIENT_ID` empty. Settings then opens the token fallback on its own, and each person:

1. Creates a **classic** token with `repo` scope at
   [github.com/settings/tokens/new](https://github.com/settings/tokens/new)
2. If the org uses SAML SSO, clicks **Configure SSO → Authorize** next to that token — a valid token
   is rejected until this is done, and the error says so
3. Pastes it under *Organisation hasn't installed the app?* → **Use this token**

The cost of this route: `repo` scope grants access to **every** repository that person can reach, and
the token sits in `chrome.storage.local` in plain text. That is the trade the GitHub App removes.

---

## Known risk: screenshot uploads

Pin puts screenshots in GitHub's own attachment store via `uploads.github.com/user-attachments/assets`,
an **undocumented** endpoint. It is confirmed working with a classic token; whether it accepts GitHub
App user tokens is **untested**.

If uploads fail after sign-in while everything else works, that is this. The documented fallback is
already written — `uploadAssetViaRepoCommit()` in [`src/github.js`](src/github.js) commits the PNG to
the repo and links it — and switching costs one call site in `src/background.js`. Grant Contents
**write** if you take that route.

## A note on what gets shared

Screenshots attached to a **private** repo require sign-in to view, as of
[GitHub's May 2023 change](https://github.blog/changelog/2023-05-09-more-secure-private-attachments/).
Attachments on a **public** repo are public. Worth saying out loud before pointing people at internal
tools.

---

# Linear

Pin files to GitHub repositories and Linear teams side by side — you pick the destination in the
dropdown as you write the report. A Linear destination can file **sub-issues under a parent issue**,
which is the usual shape for a QA pass: one parent epic, every bug a child of it.

## Connect

1. In Linear: **Settings → Security & access → New API key**
2. In Pin's settings: expand **Linear**, paste the key, **Connect Linear**

The key is stored locally in plain text, like the GitHub token fallback, and grants whatever your
Linear account can reach. Linear also supports OAuth with PKCE, which would scope and revoke access
properly — worth moving to if this goes beyond a few people.

## Add a destination

**Add from Linear…** → pick a team. Then, on that row:

- **Choose parent issue…** — filters your team's 250 most recent issues by ID or title. For an older
  parent, paste its ID (`ENG-123`) or its Linear URL and press Enter.
- **Choose labels** — the team's labels plus workspace-wide ones.

Setting a parent does two things: new reports are created as **sub-issues** of it, and they inherit
the parent's **project**, so they land beside it rather than loose in the team. Clearing the parent
clears the project too, and reports go into the team directly.

Add the same team twice with different parents if you want to file into more than one epic — the
dropdown shows them as `ENG → ENG-123`.

## Opening status

Reports open in the team's first **unstarted** status — Todo on a standard team — matching what the
UI does when you add a sub-issue by hand.

This is deliberate rather than incidental. A `issueCreate` that omits `stateId` lands in the team's
first backlog state, or in **Triage** if the team has Triage enabled, which notifies whoever watches
triage on every single report. Pin looks the status up per team and sends it explicitly.

The lookup matches on status *type* and position, not on the name, so a team that renamed Todo to
something else still works. A team with no unstarted status falls back to its first backlog status.

**Test all** checks each destination, and for Linear it uploads a real 1×1 PNG, because that is the
step most likely to fail (see below).

## Known risk: screenshot uploads

Linear's own docs say client-side uploads are blocked by their CSP and "must be executed on the
server". That guidance is about web pages: Pin's upload runs in the extension's service worker, which
is not a page and holds host permissions for the upload origin, so it should be unaffected.

**This is untested against a live workspace.** If **Test all** fails on the upload step, that is
this. The likely fixes, in order: confirm the `uploadUrl` host is covered by `host_permissions` in
`manifest.json` (currently `uploads.linear.app` and `*.storage.googleapis.com`), then check for a
dropped signed header — every header Linear returns has to be copied onto the PUT verbatim, and a
403 usually means one was lost.

## What this does not do

Status changes in Linear do not flow back anywhere — that would need a server to receive webhooks,
and Pin deliberately has none. Everything here is one-way: Pin → Linear.
