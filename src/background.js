import { getRepo, uploadAsset, createIssue, listLabels, listRepos, searchIssues } from './github.js';
import { startDeviceFlow, pollForToken, getViewer } from './auth.js';
import * as linear from './linear.js';
import { GITHUB_CLIENT_ID } from './config.js';

// Pages Chrome refuses to screenshot or inject into. Detected up front so the
// failure is a clear message instead of a silent no-op.
const BLOCKED = [
  /^chrome:/i, /^chrome-extension:/i, /^edge:/i, /^about:/i, /^devtools:/i,
  /^view-source:/i, /^file:\/\/.*\.pdf$/i,
  /^https:\/\/chromewebstore\.google\.com/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
];

const capKey = (tabId) => `capture_${tabId}`;

// tabId -> full-viewport screenshot data URL. In memory only: it is large, and it
// is needed just long enough for the user to finish dragging. The cropped result
// goes to storage.session instead, because composing a comment can outlive the
// service worker.
const pending = new Map();

// ---------------------------------------------------------------- utilities

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isLinear = (d) => d.provider === 'linear';

/**
 * Stable identifier for a destination, used by the panel dropdown and `lastRepo`.
 * GitHub keys keep their original owner/repo form so existing settings still match.
 */
const slugOf = (d) => (isLinear(d)
  ? `linear:${d.teamKey}${d.parentIdentifier ? `#${d.parentIdentifier}` : ''}`
  : `${d.owner}/${d.repo}`);

/**
 * Reads settings, migrating the original single-repo shape into the repo list on
 * the way so an existing setup keeps working without being reconfigured.
 */
async function getSettings() {
  const s = await chrome.storage.local.get(
    ['auth', 'token', 'repos', 'lastRepo', 'owner', 'repo', 'labels', 'repoId', 'linearKey']);

  // A pasted token from before sign-in existed is still a perfectly good credential;
  // lift it into the new shape rather than making anyone reconfigure.
  let auth = s.auth;
  if (!auth && s.token) {
    auth = { kind: 'pat', token: s.token, login: '' };
    await chrome.storage.local.set({ auth });
    await chrome.storage.local.remove('token');
  }

  let repos = Array.isArray(s.repos) ? s.repos : null;
  if (!repos && s.owner && s.repo) {
    repos = [{ owner: s.owner, repo: s.repo, labels: s.labels || [], id: s.repoId || null }];
    await chrome.storage.local.set({ repos });
    await chrome.storage.local.remove(['owner', 'repo', 'labels', 'repoId', 'repoIdFor']);
  }

  return {
    auth: auth || null,
    token: auth?.token || '',
    kind: auth?.kind || 'pat',
    // `repos` predates Linear support; entries now carry a `provider` and an
    // absent one means GitHub, so no migration is needed for existing setups.
    repos: repos || [],
    lastRepo: s.lastRepo || '',
    linearKey: s.linearKey || '',
  };
}

/** Repo ids never change, so resolve once and cache on the entry itself. */
async function resolveRepoId(token, entry, repos) {
  if (isLinear(entry)) return null;
  if (entry.id) return entry.id;
  const info = await getRepo({ token, owner: entry.owner, repo: entry.repo });
  entry.id = info.id;
  await chrome.storage.local.set({ repos });
  // Same call already tells us whether labels will survive — keep it.
  await cacheLabels(token, entry, { canPushOnly: info.canPush });
  return info.id;
}

// ---------------------------------------------------------------- label cache

const REVALIDATE_MS = 60 * 60 * 1000;
const inFlight = new Set(); // slugs currently refreshing, so we ask GitHub once

async function readLabelCache() {
  const { labelCache } = await chrome.storage.local.get('labelCache');
  return labelCache && typeof labelCache === 'object' ? labelCache : {};
}

/**
 * Fetches labels (and push access) for one repo and writes them to the cache.
 * Failures are swallowed on purpose: a background refresh that cannot reach
 * GitHub should leave the last known good list in place, not blank the picker.
 */
async function cacheLabels(token, entry, { canPushOnly } = {}) {
  const slug = slugOf(entry);
  if (inFlight.has(slug)) return null;
  inFlight.add(slug);

  try {
    const cache = await readLabelCache();
    const prev = cache[slug] || {};

    // Linear has no equivalent of GitHub's "labels are dropped without push
    // access", so there is nothing to warn about there.
    const canPush = isLinear(entry)
      ? true
      : (canPushOnly !== undefined
        ? canPushOnly
        : (await getRepo({ token, owner: entry.owner, repo: entry.repo })).canPush);

    const labels = isLinear(entry)
      ? await linear.listLabels({ token, teamId: entry.teamId })
      : (canPushOnly !== undefined && prev.labels
        ? prev.labels
        : await listLabels({ token, owner: entry.owner, repo: entry.repo }));

    // Which state a new issue opens in — see defaultStateId() for why this matters.
    const defaultState = isLinear(entry)
      ? await linear.defaultStateId({ token, teamId: entry.teamId })
      : null;

    const fresh = { labels, canPush, defaultState, fetchedAt: Date.now() };
    cache[slug] = fresh;
    await chrome.storage.local.set({ labelCache: cache });
    return fresh;
  } catch (err) {
    console.warn(`Pin: could not refresh labels for ${slug}:`, err?.message || err);
    return null;
  } finally {
    inFlight.delete(slug);
  }
}

/**
 * Stale-while-revalidate. A cached list is returned immediately and refreshed in
 * the background, so opening the panel never waits on the network. Only the very
 * first use of a repo blocks.
 */
async function handleLabels({ repoSlug }) {
  const settings = await getSettings();
  const entry = settings.repos.find((r) => slugOf(r) === repoSlug);
  if (!entry) throw new Error('That destination is not configured.');
  const token = tokenFor(entry, settings);
  if (!token) throw new Error(isLinear(entry) ? 'Add a Linear API key first.' : 'Sign in first.');

  const cache = await readLabelCache();
  const hit = cache[repoSlug];

  if (hit?.labels) {
    if (Date.now() - (hit.fetchedAt || 0) > REVALIDATE_MS) {
      cacheLabels(token, entry); // deliberately not awaited
    }
    return { ok: true, labels: hit.labels, canPush: hit.canPush !== false, defaults: entry.labels || [] };
  }

  const fresh = await cacheLabels(token, entry);
  if (!fresh) throw new Error('Could not load labels for this repository.');
  return { ok: true, labels: fresh.labels, canPush: fresh.canPush !== false, defaults: entry.labels || [] };
}

// ---------------------------------------------------------------- capture

async function startCapture(tab, via = 'click') {
  if (!tab?.id || !tab.url) return;

  if (BLOCKED.some((re) => re.test(tab.url))) {
    // A dead end otherwise — hand the user the path that does work here.
    notify('Chrome can’t screenshot this page', 'Opening Pin’s paste view — take a screenshot yourself and paste it in.');
    openPasteView();
    return;
  }

  const settings = await getSettings();
  if (!usableDestinations(settings)) {
    notify('Finish setup first', 'Connect GitHub or Linear and add at least one destination, then try again.');
    chrome.runtime.openOptionsPage();
    return;
  }

  let dataUrl;
  try {
    // Capture BEFORE the overlay is drawn, or the overlay lands in the screenshot.
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    notify('Screenshot failed', String(e?.message || e));
    return;
  }

  pending.set(tab.id, dataUrl);

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/overlay.js'] });
    // The tip is only useful to someone who reached for the mouse; anyone already
    // using the shortcut does not need telling.
    await sendStart(tab.id, {
      shot: dataUrl,
      mode: 'tab',
      tip: via === 'click' ? { shortcut: await captureShortcut() } : null,
    });
  } catch (e) {
    pending.delete(tab.id);
    notify('Couldn’t open the selector', String(e?.message || e));
  }
}

/** Whatever Chrome currently has bound, which may be nothing at all. */
async function captureShortcut() {
  try {
    const all = await chrome.commands.getAll();
    return all.find((c) => c.name === 'capture')?.shortcut || '';
  } catch {
    return '';
  }
}

/** Each destination authenticates with its own provider's credential. */
function tokenFor(entry, settings) {
  return isLinear(entry) ? settings.linearKey : settings.token;
}

/** At least one destination whose provider is actually signed in. A Linear-only setup counts. */
function usableDestinations(settings) {
  return settings.repos.some((d) => !!tokenFor(d, settings));
}

const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------- auth

let signIn = null; // the device flow in progress, if any

async function handleAuthStart() {
  const flow = await startDeviceFlow(GITHUB_CLIENT_ID);
  // `current` is what the poll closes over. handleAuthCancel nulls the module-level
  // `signIn`, so reading that from inside the poll would see undefined and keep going.
  const current = { cancelled: false, ...flow };
  signIn = current;

  // Poll in the background; the options page asks for the result separately, so
  // closing and reopening settings mid-flow does not strand the sign-in.
  current.promise = pollForToken({
    clientId: GITHUB_CLIENT_ID,
    deviceCode: flow.deviceCode,
    interval: flow.interval,
    expiresAt: flow.expiresAt,
    isCancelled: () => current.cancelled,
  }).then(async (token) => {
    if (current.cancelled) throw new Error('Sign-in cancelled.');
    const viewer = await getViewer(token);
    await chrome.storage.local.set({ auth: { kind: 'app', token, login: viewer.login } });
    return viewer;
  });
  current.promise.catch(() => {}); // handled when awaited below

  return { ok: true, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: flow.expiresAt };
}

async function handleAuthAwait() {
  if (!signIn) throw new Error('No sign-in is in progress.');
  const viewer = await signIn.promise;
  signIn = null;
  return { ok: true, ...viewer };
}

async function handleAuthCancel() {
  if (signIn) signIn.cancelled = true;
  signIn = null;
  return { ok: true };
}

async function handleSignOut() {
  await chrome.storage.local.remove(['auth', 'labelCache']);
  return { ok: true };
}

async function handleLinearTeams() {
  const { linearKey } = await getSettings();
  if (!linearKey) throw new Error('Add a Linear API key first.');
  return { ok: true, teams: await linear.listTeams({ token: linearKey }) };
}

async function handleLinearIssues({ teamId }) {
  const { linearKey } = await getSettings();
  if (!linearKey) throw new Error('Add a Linear API key first.');
  return { ok: true, issues: await linear.listRecentIssues({ token: linearKey, teamId }) };
}

async function handleLinearResolve({ ref }) {
  const { linearKey } = await getSettings();
  if (!linearKey) throw new Error('Add a Linear API key first.');
  return { ok: true, issue: await linear.resolveIssue({ token: linearKey, ref }) };
}

async function handleLinearLabels({ teamId }) {
  const { linearKey } = await getSettings();
  if (!linearKey) throw new Error('Connect Linear first.');
  return { ok: true, labels: await linear.listLabels({ token: linearKey, teamId }) };
}

/**
 * Proves a Linear destination end to end, upload included. The upload is the part
 * worth testing: Linear's docs say client-side uploads are blocked by their CSP,
 * and whether a service worker escapes that is exactly what this answers.
 */
async function handleLinearTest({ teamId }) {
  const { linearKey } = await getSettings();
  if (!linearKey) throw new Error('Connect Linear first.');

  await linear.listLabels({ token: linearKey, teamId });
  const bytes = base64ToBytes(PROBE_PNG);
  await linear.uploadFile({ token: linearKey, bytes, name: 'pin-connection-test.png' });
  return { ok: true };
}

async function handleLinearConnect({ key }) {
  const viewer = await linear.getViewer({ token: key });
  await chrome.storage.local.set({ linearKey: key, linearName: viewer.name });
  return { ok: true, name: viewer.name };
}

async function handleListRepos() {
  const { token, kind } = await getSettings();
  if (!token) throw new Error('Sign in first.');
  return { ok: true, repos: await listRepos({ token, kind }) };
}

async function handleSearch({ repoSlug, text }) {
  const settings = await getSettings();
  const entry = settings.repos.find((r) => slugOf(r) === repoSlug);
  const token = entry ? tokenFor(entry, settings) : '';
  if (!token || !entry) return { ok: true, issues: [] };

  try {
    const issues = isLinear(entry)
      ? await linear.searchIssues({ token, teamId: entry.teamId, text })
      : await searchIssues({ token, owner: entry.owner, repo: entry.repo, text });
    return { ok: true, issues };
  } catch {
    return { ok: true, issues: [] }; // a duplicate hint is never worth an error
  }
}

function openPasteView() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('src/paste.html') });
}

chrome.action.onClicked.addListener((tab) => startCapture(tab, 'click'));

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'paste') { openPasteView(); return; }
  if (command !== 'capture') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) startCapture(tab, 'shortcut');
});

// Don't leave screenshots of closed tabs sitting in memory.
chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
  chrome.storage.session.remove(capKey(tabId));
});

/** Both entry points hand the overlay the same payload. */
/** What the dropdown shows. The key is machine-readable; this is for a human. */
const labelOf = (d) => (isLinear(d)
  ? `${d.teamKey}${d.parentIdentifier ? ` → ${d.parentIdentifier}` : ''}`
  : `${d.owner}/${d.repo}`);

async function sendStart(tabId, extra) {
  const { repos, lastRepo } = await getSettings();
  const options = repos.map((d) => ({ key: slugOf(d), label: labelOf(d) }));
  const keys = options.map((o) => o.key);
  await chrome.tabs.sendMessage(tabId, {
    type: 'PIN_START',
    repos: options,
    current: keys.includes(lastRepo) ? lastRepo : keys[0],
    ...extra,
  });
}

/** Takes an image the user supplied instead of one Chrome captured. */
async function handlePaste(tabId, { dataUrl }) {
  if (!dataUrl?.startsWith('data:image/')) throw new Error('That did not look like an image.');

  if (!usableDestinations(await getSettings())) {
    chrome.runtime.openOptionsPage();
    throw new Error('Connect GitHub or Linear and add at least one destination first.');
  }

  pending.set(tabId, dataUrl);
  await sendStart(tabId, { shot: dataUrl, mode: 'image' });
  return { ok: true };
}

// ---------------------------------------------------------------- crop

/**
 * Crops the stored image to the selected region and replaces the full capture
 * with the much smaller crop.
 *
 * `imageBox` is the CSS-pixel rectangle the source image occupies on screen. For a
 * tab capture that is the whole viewport at the origin; for a pasted image it is a
 * letterboxed rect, which is why the offset terms are needed. Scale comes from the
 * real bitmap size over that box rather than assuming devicePixelRatio — the two
 * disagree under page zoom.
 */
async function handleCrop(tabId, { rect, imageBox }) {
  const dataUrl = pending.get(tabId);
  if (!dataUrl) throw new Error('The screenshot expired. Press the button again.');
  if (!imageBox?.w || !imageBox?.h) throw new Error('The screenshot was still loading. Try the selection again.');

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const scaleX = bitmap.width / imageBox.w;
  const scaleY = bitmap.height / imageBox.h;

  const sx = Math.max(0, Math.round((rect.x - imageBox.x) * scaleX));
  const sy = Math.max(0, Math.round((rect.y - imageBox.y) * scaleY));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.w * scaleX));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.h * scaleY));

  if (sw < 1 || sh < 1) throw new Error('That selection was too small.');

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const cropped = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await cropped.arrayBuffer());

  await chrome.storage.session.set({
    [capKey(tabId)]: { png: bytesToBase64(bytes), w: sw, h: sh },
  });
  pending.delete(tabId); // the crop is all we need from here on

  return { ok: true, width: sw, height: sh };
}

// ---------------------------------------------------------------- issue body

/**
 * An explicit title wins. Otherwise fall back to the first line of the description
 * — the overlay previews this same derivation in the title placeholder, so the two
 * need to stay in step.
 */
function titleFrom(title, comment, meta) {
  const explicit = (title || '').trim();
  if (explicit) return explicit.slice(0, 256);

  const first = (comment || '').trim().split('\n')[0].trim();
  if (first) return first.length > 70 ? `${first.slice(0, 69)}…` : first;

  return `Bug: ${meta.title || meta.url || 'untitled page'}`.slice(0, 70);
}

function environmentTable(meta) {
  const rows = [
    ['URL', meta.url ? `[${meta.url}](${meta.url})` : ''],
    ['Page title', meta.title],
    // Free text for pasted images — only linkify when it really is a link.
    ['Source', /^https?:\/\//i.test(meta.source || '') ? `[${meta.source}](${meta.source})` : (meta.source || '')],
    ['Browser', meta.browser],
    ['Operating system', meta.os],
    ['Viewport', meta.viewport],
    ['Screen', meta.screen],
    ['Language', meta.language],
    ['Time zone', meta.timeZone],
    ['Reported', meta.reportedAt],
  ].filter(([, v]) => v);

  return [
    '<details><summary>Environment</summary>',
    '',
    '| | |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '</details>',
  ].join('\n');
}

function issueBody(comment, imageUrl, meta) {
  const parts = [];
  const text = (comment || '').trim();
  if (text) parts.push(text, ''); // omitted entirely when the title says it all
  parts.push(`![Screenshot](${imageUrl})`, '', environmentTable(meta), '', '<sub>Filed with Pin</sub>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- submit

/**
 * Redraws the overlay's pencil strokes onto the stored crop.
 *
 * Strokes arrive in selection-relative CSS pixels; the crop is at capture
 * resolution, so everything scales by the ratio between them. Mirrors strokePath()
 * in the overlay — the two must stay in step or the markup will not land where it
 * was drawn.
 */
async function applyMarkup(png, markup) {
  if (!markup?.strokes?.length) return png;

  const blob = new Blob([base64ToBytes(png)], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);

  const scale = bitmap.width / markup.width;
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const s of markup.strokes) {
    if (!s.points?.length) continue;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;

    if (s.points.length === 1) {
      ctx.beginPath();
      ctx.arc(s.points[0].x, s.points[0].y, s.width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length - 1; i++) {
      const mx = (s.points[i].x + s.points[i + 1].x) / 2;
      const my = (s.points[i].y + s.points[i + 1].y) / 2;
      ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, mx, my);
    }
    const last = s.points[s.points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return bytesToBase64(new Uint8Array(await out.arrayBuffer()));
}

async function handleSubmit(tabId, { title, comment, meta, repoSlug, labels, markup }) {
  const stored = (await chrome.storage.session.get(capKey(tabId)))[capKey(tabId)];
  if (!stored?.png) throw new Error('The screenshot expired. Press the button again.');

  const settings = await getSettings();
  const { repos } = settings;
  // No fallback to repos[0]: a stale key must fail loudly, not file somewhere else.
  const entry = repos.find((r) => slugOf(r) === repoSlug);
  if (!entry) throw new Error('That destination is no longer configured. Pick another and try again.');

  const token = tokenFor(entry, settings);
  if (!token) throw new Error(isLinear(entry) ? 'Add a Linear API key first.' : 'Sign in first.');

  const png = await applyMarkup(stored.png, markup);
  const bytes = base64ToBytes(png);
  const stamp = meta.reportedAt.replace(/[:.]/g, '-');
  const name = `screenshot-${stamp}.png`;

  // Chosen in the panel; the settings value is only ever the starting point.
  const chosen = Array.isArray(labels) ? labels : (entry.labels || []);
  const issueTitle = titleFrom(title, comment, meta);

  let issue;
  if (isLinear(entry)) {
    const imageUrl = await linear.uploadFile({ token, bytes, name });

    // The panel works in label names; Linear needs ids, which the label cache
    // already holds from when the picker was populated.
    const cacheEntry = (await readLabelCache())[slugOf(entry)] || {};
    const cached = cacheEntry.labels || [];
    const labelIds = chosen
      .map((n) => cached.find((l) => l.name === n)?.id)
      .filter(Boolean);

    // Normally warm from opening the panel; resolve it now if the cache missed,
    // because omitting it drops the issue into Triage.
    let stateId = cacheEntry.defaultState?.id;
    if (!stateId) {
      stateId = (await linear.defaultStateId({ token, teamId: entry.teamId }).catch(() => null))?.id;
    }

    issue = await linear.createIssue({
      token,
      teamId: entry.teamId,
      title: issueTitle,
      description: issueBody(comment, imageUrl, meta),
      parentId: entry.parentId || null,   // present => filed as a sub-issue
      projectId: entry.projectId || null,
      labelIds,
      stateId,
    });
  } else {
    const repositoryId = await resolveRepoId(token, entry, repos);
    const imageUrl = await uploadAsset({ token, repositoryId, bytes, name });

    issue = await createIssue({
      token,
      owner: entry.owner,
      repo: entry.repo,
      title: issueTitle,
      body: issueBody(comment, imageUrl, meta),
      labels: chosen,
    });
  }

  // Remember the choice so the next report defaults to the same place.
  await chrome.storage.local.set({ lastRepo: slugOf(entry) });
  await chrome.storage.session.remove(capKey(tabId));
  return { ok: true, url: issue.url, number: issue.number };
}

// ---------------------------------------------------------------- messaging

async function route(msg, sender) {
  // Settings-page messages have no capture behind them, so they must be handled
  // before the tab check. Sign-in in particular runs in the worker so that closing
  // the options tab mid-flow does not abandon it.
  switch (msg.type) {
    case 'PIN_AUTH_START':  return handleAuthStart();
    case 'PIN_AUTH_AWAIT':  return handleAuthAwait();
    case 'PIN_AUTH_CANCEL': return handleAuthCancel();
    case 'PIN_SIGN_OUT':    return handleSignOut();
    case 'PIN_LIST_REPOS':  return handleListRepos();
    case 'PIN_LINEAR_CONNECT': return handleLinearConnect(msg);
    case 'PIN_LINEAR_TEAMS':   return handleLinearTeams();
    case 'PIN_LINEAR_LABELS':  return handleLinearLabels(msg);
    case 'PIN_LINEAR_TEST':    return handleLinearTest(msg);
    case 'PIN_LINEAR_ISSUES':  return handleLinearIssues(msg);
    case 'PIN_LINEAR_RESOLVE': return handleLinearResolve(msg);
    default: break;
  }

  const tabId = sender.tab?.id;
  if (!tabId) throw new Error('Missing tab context.');

  switch (msg.type) {
    case 'PIN_CROP':   return handleCrop(tabId, msg);
    case 'PIN_PASTE':  return handlePaste(tabId, msg);
    case 'PIN_PASTE_VIEW':
      openPasteView();
      return { ok: true };
    case 'PIN_SHORTCUTS':
      // Only an extension can open this page; a link from the overlay would be blocked.
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return { ok: true };
    case 'PIN_LABELS': return handleLabels(msg);
    case 'PIN_SEARCH': return handleSearch(msg);
    case 'PIN_SUBMIT': return handleSubmit(tabId, msg);
    case 'PIN_CANCEL':
      pending.delete(tabId);
      await chrome.storage.session.remove(capKey(tabId));
      return { ok: true };
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  route(msg, sender).then(
    sendResponse,
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // keep the channel open for the async reply
});
