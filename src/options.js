import { getRepo, uploadAsset, listLabels } from './github.js';
import { GITHUB_CLIENT_ID } from './config.js';

const $ = (id) => document.getElementById(id);
const status = $('status');

// Smallest valid PNG — proves the attachment endpoint accepts this token for this
// repo before you rely on it. SSO and permissions are per-organization, so this is
// worth checking on every repo rather than just the first.
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function clearStatus() { status.textContent = ''; }

function line(text, kind = '') {
  const el = document.createElement('div');
  el.className = `line ${kind}`.trim();
  el.textContent = text;
  status.append(el);
  return el;
}

// ---------------------------------------------------------------- repo rows

/** Colour helpers; mirrors the same three functions in the overlay. */
function rgbOf(hex) {
  const h = String(hex || '').replace('#', '').padEnd(6, '0');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0).join(', ');
}

/** Pure white and near-black label colours vanish against one theme or the other. */
function ink(rgb, theme) {
  const [r, g, b] = rgb.split(',').map(Number);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (theme === 'light' && lum > 0.82) return [r, g, b].map((v) => Math.round(v * 0.55)).join(', ');
  if (theme === 'dark' && lum < 0.18) return [r, g, b].map((v) => Math.round(v + (255 - v) * 0.5)).join(', ');
  return rgb;
}

function paintColor(el, hex) {
  const rgb = rgbOf(hex);
  el.style.setProperty('--rgb', rgb);
  el.style.setProperty('--ink', ink(rgb, 'light'));
  el.style.setProperty('--ink-d', ink(rgb, 'dark'));
}

function chip(name, color, { on, missing } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `chip${on ? '' : ' off'}${missing ? ' missing' : ''}`;
  paintColor(el, color);
  el.dataset.name = name;
  const dot = document.createElement('i');
  el.append(dot, document.createTextNode(name));
  if (missing) el.title = 'This label does not exist in the repository — it will be ignored.';
  return el;
}

/** Selected default labels for a row, read straight off the rendered chips. */
function chosenIn(row) {
  return [...row.querySelectorAll('.labelbar .chip')]
    .filter((c) => !c.classList.contains('off'))
    .map((c) => c.dataset.name);
}

function paintBar(row, names, known) {
  const bar = row.querySelector('.labelbar');
  // Hold the button before clearing — innerHTML = '' would otherwise destroy it
  // and the re-query below would come back null.
  const btn = row.querySelector('.choose');
  bar.innerHTML = '';
  for (const name of names) {
    const match = known?.find((l) => l.name === name);
    // known === null means we have not fetched yet, so nothing is provably missing.
    const el = chip(name, match?.color, { on: true, missing: known ? !match : false });
    el.addEventListener('click', () => { el.remove(); });
    bar.append(el);
  }
  bar.append(btn);
}

async function openGrid(row) {
  const linearRow = row.dataset.provider === 'linear';
  const btn = row.querySelector('.choose');

  const owner = linearRow ? '' : row.querySelector('.owner').value.trim();
  const repo = linearRow ? '' : row.querySelector('.repo').value.trim();
  const token = linearRow ? await linearToken() : await currentToken();

  if (!token) { line(linearRow ? 'Connect Linear first.' : 'Sign in first.', 'err'); return; }
  if (!linearRow && (!owner || !repo)) { line('Fill in the owner and repository first.', 'err'); return; }

  row.querySelector('.grid')?.remove();
  row.querySelector('.note')?.remove();
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const [labels, info] = linearRow
      ? [await linearLabels({ token, teamId: row.dataset.teamId }), { canPush: true }]
      : await Promise.all([
        listLabels({ token, owner, repo }),
        getRepo({ token, owner, repo }),
      ]);

    paintBar(row, chosenIn(row), labels);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const l of labels) {
      const on = chosenIn(row).includes(l.name);
      const el = chip(l.name, l.color, { on });
      el.addEventListener('click', () => {
        const names = new Set(chosenIn(row));
        if (names.has(l.name)) names.delete(l.name); else names.add(l.name);
        paintBar(row, [...names], labels);
        el.classList.toggle('off', !names.has(l.name));
      });
      grid.append(el);
    }
    row.append(grid);

    if (!info.canPush) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'No push access — GitHub silently drops labels on this repo.';
      row.append(note);
    }
    btn.textContent = 'Hide labels';
    btn.onclick = () => { grid.remove(); row.querySelector('.note')?.remove(); resetChoose(row); };
  } catch (err) {
    line(`${linearRow ? row.dataset.teamKey : `${owner}/${repo}`} — ${err?.message || err}`, 'err');
    resetChoose(row);
  } finally {
    btn.disabled = false;
  }
}

function resetChoose(row) {
  const btn = row.querySelector('.choose');
  btn.textContent = 'Choose labels';
  btn.onclick = () => openGrid(row);
}

function addLinearRow(entry) {
  const row = document.createElement('div');
  row.className = 'repo-row';
  row.dataset.provider = 'linear';
  row.dataset.teamId = entry.teamId;
  row.dataset.teamKey = entry.teamKey;
  row.dataset.teamName = entry.teamName || '';
  if (entry.parentId) {
    row.dataset.parentId = entry.parentId;
    row.dataset.parentIdentifier = entry.parentIdentifier || '';
    row.dataset.parentTitle = entry.parentTitle || '';
  }
  if (entry.projectId) row.dataset.projectId = entry.projectId;

  row.innerHTML = `
    <div class="dest"><span class="badge">Linear</span><span class="team"></span></div>
    <button class="remove" title="Remove">&times;</button>
    <div class="parentbar"><button class="pickparent" type="button">Choose parent issue…</button></div>
    <div class="labelbar"><button class="choose" type="button">Choose labels</button></div>
  `;
  row.querySelector('.team').textContent = `${entry.teamKey} · ${entry.teamName || ''}`.trim();
  row.querySelector('.remove').addEventListener('click', () => { row.remove(); renderEmpty(); });
  row.querySelector('.pickparent').addEventListener('click', () => openParentPicker(row));

  resetChoose(row);
  paintBar(row, entry.labels || [], null);
  paintParent(row);
  $('repos').append(row);
  renderEmpty();
}

function addRow(entry = { owner: '', repo: '', labels: [] }) {
  const row = document.createElement('div');
  row.className = 'repo-row';
  row.innerHTML = `
    <input class="owner" placeholder="owner or org" autocomplete="off" spellcheck="false">
    <input class="repo" placeholder="repository" autocomplete="off" spellcheck="false">
    <button class="remove" title="Remove">&times;</button>
    <div class="labelbar"><button class="choose" type="button">Choose labels</button></div>
  `;
  row.querySelector('.owner').value = entry.owner || '';
  row.querySelector('.repo').value = entry.repo || '';
  resetChoose(row);
  paintBar(row, entry.labels || [], null);
  // Keep the resolved id with the row so saving doesn't force a re-lookup.
  row.dataset.id = entry.id || '';
  row.querySelector('.remove').addEventListener('click', () => { row.remove(); renderEmpty(); });
  $('repos').append(row);
  renderEmpty();
}

function renderEmpty() {
  const existing = $('repos').querySelector('.empty');
  const rows = $('repos').querySelectorAll('.repo-row').length;
  if (rows === 0 && !existing) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No destinations yet — add one below.';
    $('repos').append(p);
  } else if (rows > 0 && existing) {
    existing.remove();
  }
}

/** Reads the rows, dropping blanks and tolerating a pasted "owner/repo". */
function readRepos() {
  return [...$('repos').querySelectorAll('.repo-row')].map((row) => {
    if (row.dataset.provider === 'linear') {
      return {
        provider: 'linear',
        teamId: row.dataset.teamId,
        teamKey: row.dataset.teamKey,
        teamName: row.dataset.teamName,
        parentId: row.dataset.parentId || null,
        parentIdentifier: row.dataset.parentIdentifier || '',
        parentTitle: row.dataset.parentTitle || '',
        projectId: row.dataset.projectId || null,
        labels: chosenIn(row),
        row,
      };
    }

    let owner = row.querySelector('.owner').value.trim();
    let repo = row.querySelector('.repo').value.trim();
    if (!repo && owner.includes('/')) [owner, repo] = owner.split('/');
    if (repo.includes('/')) repo = repo.split('/').pop();
    return {
      owner, repo,
      labels: chosenIn(row),
      id: row.dataset.id ? Number(row.dataset.id) : null,
      row,
    };
  }).filter((d) => (d.provider === 'linear' ? d.teamId : d.owner && d.repo));
}

const isLinear = (d) => d.provider === 'linear';

const strip = (d) => (isLinear(d)
  ? { provider: 'linear', teamId: d.teamId, teamKey: d.teamKey, teamName: d.teamName,
      parentId: d.parentId || null, parentIdentifier: d.parentIdentifier || '',
      parentTitle: d.parentTitle || '', projectId: d.projectId || null, labels: d.labels }
  : { owner: d.owner, repo: d.repo, labels: d.labels, id: d.id });

/** Must match slugOf() in the service worker; the panel dropdown keys off it. */
const slugOf = (d) => (isLinear(d)
  ? `linear:${d.teamKey}${d.parentIdentifier ? `#${d.parentIdentifier}` : ''}`
  : `${d.owner}/${d.repo}`);

/** The token lives in storage, never in a form field, once sign-in is used. */
async function currentToken() {
  const { auth: stored } = await chrome.storage.local.get('auth');
  return stored?.token || '';
}

async function linearToken() {
  const { linearKey } = await chrome.storage.local.get('linearKey');
  return linearKey || '';
}

/** Routed through the worker so the key stays in one place. */
async function linearLabels({ teamId }) {
  const res = await send('PIN_LINEAR_LABELS', { teamId });
  if (!res?.ok) throw new Error(res?.error || 'Could not load Linear labels.');
  return res.labels;
}

// ---------------------------------------------------------------- sign-in

let auth = null;

const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

function renderAuth() {
  const host = $('auth');
  host.innerHTML = '';

  if (auth?.token) {
    const box = document.createElement('div');
    box.className = 'who';
    if (auth.login) {
      const img = document.createElement('img');
      img.src = `https://avatars.githubusercontent.com/${encodeURIComponent(auth.login)}`;
      img.alt = '';
      box.append(img);
    }
    const who = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = auth.login ? `@${auth.login}` : 'Signed in';
    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = auth.kind === 'app' ? 'GitHub App' : 'Personal access token';
    who.append(name, kind);

    const spacer = document.createElement('div');
    spacer.className = 'spacer';

    const out = document.createElement('button');
    out.className = 'ghost';
    out.textContent = 'Sign out';
    out.addEventListener('click', async () => {
      await send('PIN_SIGN_OUT');
      auth = null;
      renderAuth();
      line('Signed out.', 'ok');
    });

    box.append(who, spacer, out);
    host.append(box);
    $('patFallback').open = false;
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'signin';
  btn.textContent = 'Sign in with GitHub';
  btn.disabled = !GITHUB_CLIENT_ID;
  btn.addEventListener('click', () => beginSignIn(host));
  host.append(btn);

  if (!GITHUB_CLIENT_ID) {
    const note = document.createElement('div');
    note.className = 'help';
    note.style.marginTop = '8px';
    note.textContent = 'No GitHub App is configured yet — see SETUP.md, or use a token below.';
    host.append(note);
    $('patFallback').open = true;
  }
}

async function beginSignIn(host) {
  clearStatus();
  let flow;
  try {
    flow = await send('PIN_AUTH_START');
    if (!flow?.ok) throw new Error(flow?.error || 'Could not start sign-in.');
  } catch (err) {
    line(String(err?.message || err), 'err');
    return;
  }

  host.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'code';

  const code = document.createElement('b');
  code.textContent = flow.userCode;

  const go = document.createElement('button');
  go.className = 'ghost';
  go.textContent = 'Copy code and open GitHub';
  go.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(flow.userCode); } catch { /* clipboard may be blocked */ }
    window.open(flow.verificationUri, '_blank', 'noopener');
  });

  const stat = document.createElement('div');
  stat.className = 'stat';
  stat.textContent = 'Waiting for you to approve on GitHub…';

  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', async () => { await send('PIN_AUTH_CANCEL'); renderAuth(); });

  box.append(code, go, stat, cancel);
  host.append(box);

  // Open GitHub straight away; the code is already on screen to type or paste.
  window.open(flow.verificationUri, '_blank', 'noopener');

  const res = await send('PIN_AUTH_AWAIT');
  if (!res?.ok) { line(res?.error || 'Sign-in failed.', 'err'); renderAuth(); return; }

  auth = { kind: 'app', token: 'stored', login: res.login };
  renderAuth();
  line(`Signed in as @${res.login}.`, 'ok');
}

$('usePat').addEventListener('click', async () => {
  clearStatus();
  const token = $('token').value.trim();
  if (!token) { line('Paste a token first.', 'err'); return; }
  await chrome.storage.local.set({ auth: { kind: 'pat', token, login: '' } });
  await chrome.storage.local.remove('token');
  auth = { kind: 'pat', token, login: '' };
  renderAuth();
  line('Token saved.', 'ok');
});

// ---------------------------------------------------------------- Linear

let linearName = '';
let allTeams = null;

function renderLinear() {
  $('linearSummary').textContent = linearName ? `Linear — connected as ${linearName}` : 'Linear — not connected';
  $('linearDisconnect').style.display = linearName ? '' : 'none';
  $('browseLinear').disabled = !linearName;
}

$('linearConnect').addEventListener('click', async () => {
  clearStatus();
  const key = $('linearKey').value.trim();
  if (!key) { line('Paste a Linear API key first.', 'err'); return; }

  $('linearConnect').disabled = true;
  const res = await send('PIN_LINEAR_CONNECT', { key });
  $('linearConnect').disabled = false;

  if (!res?.ok) { line(res?.error || 'Could not connect to Linear.', 'err'); return; }
  linearName = res.name;
  allTeams = null;
  renderLinear();
  line(`Connected to Linear as ${res.name}.`, 'ok');
});

$('linearDisconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['linearKey', 'linearName']);
  linearName = '';
  allTeams = null;
  $('linearKey').value = '';
  renderLinear();
  line('Disconnected from Linear.', 'ok');
});

async function openTeamPicker() {
  const picker = $('teamPicker');
  const list = $('teamList');
  picker.hidden = false;
  list.innerHTML = '<div class="picker-empty">Loading your teams…</div>';

  if (!allTeams) {
    const res = await send('PIN_LINEAR_TEAMS');
    if (!res?.ok) {
      list.innerHTML = '';
      const e = document.createElement('div');
      e.className = 'picker-empty';
      e.textContent = res?.error || 'Could not load teams.';
      list.append(e);
      return;
    }
    allTeams = res.teams;
  }
  paintTeams();
}

function paintTeams() {
  const list = $('teamList');
  const q = $('teamFilter').value.trim().toLowerCase();
  const rows = (allTeams || []).filter((t) => !q || `${t.key} ${t.name}`.toLowerCase().includes(q));
  list.innerHTML = '';

  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'picker-empty';
    e.textContent = allTeams?.length ? 'No teams match.' : 'No teams available.';
    list.append(e);
    return;
  }

  for (const t of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    const slug = document.createElement('span');
    slug.className = 'slug';
    slug.textContent = t.key;
    const nm = document.createElement('span');
    nm.className = 'when';
    nm.textContent = t.name;
    b.append(slug, nm);
    // A team can appear more than once — each row can target a different parent.
    b.addEventListener('click', () => {
      addLinearRow({ teamId: t.id, teamKey: t.key, teamName: t.name, labels: [] });
      $('teamPicker').hidden = true;
    });
    list.append(b);
  }
}

$('browseLinear').addEventListener('click', () => {
  const p = $('teamPicker');
  if (!p.hidden) { p.hidden = true; return; }
  openTeamPicker();
});
$('teamFilter').addEventListener('input', paintTeams);

// ---------------------------------------------------------------- parent issue

function paintParent(row) {
  const bar = row.querySelector('.parentbar');
  const btn = row.querySelector('.pickparent');
  bar.innerHTML = '';

  if (row.dataset.parentId) {
    const chip = document.createElement('span');
    chip.className = 'parent';
    const id = document.createElement('b');
    id.textContent = row.dataset.parentIdentifier;
    const t = document.createElement('span');
    t.textContent = row.dataset.parentTitle || '';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'File into the team directly instead';
    x.addEventListener('click', () => {
      delete row.dataset.parentId;
      delete row.dataset.parentIdentifier;
      delete row.dataset.parentTitle;
      delete row.dataset.projectId;
      paintParent(row);
    });
    chip.append(id, t, x);
    bar.append(chip);
    btn.textContent = 'Change parent';
  } else {
    btn.textContent = 'Choose parent issue…';
  }
  bar.append(btn);
}

function setParent(row, issue) {
  row.dataset.parentId = issue.id;
  row.dataset.parentIdentifier = issue.identifier;
  row.dataset.parentTitle = issue.title || '';
  // Inherit the parent's project so the sub-issue lands beside it rather than loose.
  if (issue.projectId) row.dataset.projectId = issue.projectId;
  else delete row.dataset.projectId;
  paintParent(row);
}

async function openParentPicker(row) {
  row.querySelector('.parent-pick')?.remove();

  const box = document.createElement('div');
  box.className = 'picker parent-pick';
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.placeholder = 'Filter by title, or paste an issue ID or URL…';
  const list = document.createElement('div');
  list.className = 'picker-list';
  list.innerHTML = '<div class="picker-empty">Loading recent issues…</div>';
  box.append(filter, list);
  row.append(box);

  const res = await send('PIN_LINEAR_ISSUES', { teamId: row.dataset.teamId });
  if (!res?.ok) {
    list.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'picker-empty';
    e.textContent = res?.error || 'Could not load issues.';
    list.append(e);
    return;
  }

  const paint = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = res.issues.filter((i) =>
      !q || `${i.identifier} ${i.title}`.toLowerCase().includes(q));
    list.innerHTML = '';

    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'picker-empty';
      // An old parent will not be in the recent list; resolving the ID always works.
      e.textContent = /[A-Za-z]+-\d+/.test(q)
        ? 'Not in recent issues — press Enter to look it up.'
        : 'No recent issues match. Paste an issue ID or URL to look it up.';
      list.append(e);
      return;
    }

    for (const i of rows.slice(0, 200)) {
      const b = document.createElement('button');
      b.type = 'button';
      const id = document.createElement('span');
      id.className = 'slug';
      id.textContent = i.identifier;
      const t = document.createElement('span');
      t.textContent = i.title;
      b.append(id, t);
      if (i.projectName) {
        const p = document.createElement('span');
        p.className = 'when';
        p.textContent = i.projectName;
        b.append(p);
      }
      b.addEventListener('click', () => { setParent(row, i); box.remove(); });
      list.append(b);
    }
  };

  filter.addEventListener('input', paint);
  filter.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const found = await send('PIN_LINEAR_RESOLVE', { ref: filter.value.trim() });
    if (!found?.ok) { line(found?.error || 'Could not find that issue.', 'err'); return; }
    setParent(row, found.issue);
    box.remove();
  });

  paint();
  filter.focus();
}

// ---------------------------------------------------------------- repository picker

let allRepos = null; // fetched once per settings visit

async function openPicker() {
  const picker = $('repoPicker');
  const list = $('repoList');
  picker.hidden = false;
  list.innerHTML = '<div class="picker-empty">Loading your repositories…</div>';

  if (!allRepos) {
    const res = await send('PIN_LIST_REPOS');
    if (!res?.ok) {
      list.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'picker-empty';
      err.textContent = res?.error || 'Could not load repositories.';
      list.append(err);
      return;
    }
    allRepos = res.repos;
  }
  paintPicker();
}

function paintPicker() {
  const list = $('repoList');
  const q = $('repoFilter').value.trim().toLowerCase();
  const already = new Set(readRepos().map(slugOf));

  const rows = (allRepos || []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  list.innerHTML = '';

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = allRepos?.length ? 'No repositories match.' : 'No repositories available.';
    list.append(empty);
    return;
  }

  for (const r of rows.slice(0, 200)) {
    const added = already.has(r.fullName);
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = added;

    const slug = document.createElement('span');
    slug.className = 'slug';
    slug.textContent = r.fullName;
    b.append(slug);

    if (r.private) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'private';
      b.append(tag);
    }

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = added ? 'added' : relative(r.pushedAt);
    b.append(when);

    b.addEventListener('click', () => {
      addRow({ owner: r.owner, repo: r.repo, labels: [] });
      paintPicker();
    });
    list.append(b);
  }
}

/** Rough age; exact dates are noise when you are scanning for a repo name. */
function relative(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

$('browse').addEventListener('click', () => {
  const picker = $('repoPicker');
  if (!picker.hidden) { picker.hidden = true; return; }
  openPicker();
});
$('repoFilter').addEventListener('input', paintPicker);

// ---------------------------------------------------------------- load / save

async function load() {
  const s = await chrome.storage.local.get(
    ['auth', 'token', 'repos', 'owner', 'repo', 'labels', 'linearKey', 'linearName']);

  // Mirrors the worker's migration so opening settings first is safe. This has to
  // persist, not just render: currentToken() reads storage, so a migration that
  // only updated the view would leave the page claiming to be signed in while
  // every request failed for want of a token.
  auth = s.auth || null;
  if (!auth && s.token) {
    auth = { kind: 'pat', token: s.token, login: '' };
    await chrome.storage.local.set({ auth });
    await chrome.storage.local.remove('token');
  }
  renderAuth();

  let repos = Array.isArray(s.repos) ? s.repos : null;
  // Same migration the service worker does, so opening settings first is safe.
  if (!repos && s.owner && s.repo) repos = [{ owner: s.owner, repo: s.repo, labels: s.labels || [] }];

  for (const d of repos || []) (d.provider === 'linear' ? addLinearRow : addRow)(d);
  renderEmpty();

  linearName = s.linearName || '';
  renderLinear();
  if (linearName) $('linearBlock').open = false;
}

async function save(repos) {
  await chrome.storage.local.set({ repos: repos.map(strip) });
  // Old-format keys would otherwise get migrated back over the top of this.
  await chrome.storage.local.remove(['owner', 'repo', 'labels', 'repoId', 'repoIdFor']);
}

$('add').addEventListener('click', () => addRow());

$('save').addEventListener('click', async () => {
  clearStatus();
  const token = await currentToken();
  const repos = readRepos();
  if (!token && repos.some((d) => !isLinear(d))) { line('Sign in to GitHub first.', 'err'); return; }
  if (!repos.length) { line('Add at least one destination.', 'err'); return; }
  await save(repos);
  line(`Saved — ${repos.length} ${repos.length === 1 ? 'destination' : 'destinations'}.`, 'ok');
});

$('test').addEventListener('click', async () => {
  clearStatus();
  const token = await currentToken();
  const repos = readRepos();
  if (!token && repos.some((d) => !isLinear(d))) { line('Sign in to GitHub first.', 'err'); return; }
  if (!repos.length) { line('Add at least one destination.', 'err'); return; }

  $('test').disabled = true;
  $('save').disabled = true;
  let failures = 0;

  for (const entry of repos) {
    const slug = slugOf(entry);
    const el = line(`${slug} — checking…`);
    try {
      if (isLinear(entry)) {
        // The worker holds the Linear key and runs the upload probe.
        el.textContent = `${slug} — checking labels and screenshot upload…`;
        const res = await send('PIN_LINEAR_TEST', { teamId: entry.teamId });
        if (!res?.ok) throw new Error(res?.error || 'Linear check failed.');
      } else {
        const info = await getRepo({ token, owner: entry.owner, repo: entry.repo });
        entry.id = info.id;
        entry.row.dataset.id = String(info.id);

        el.textContent = `${slug} — checking screenshot upload…`;
        const bytes = Uint8Array.from(atob(PROBE_PNG), (c) => c.charCodeAt(0));
        await uploadAsset({ token, repositoryId: info.id, bytes, name: 'pin-connection-test.png' });
      }

      el.className = 'line ok';
      el.textContent = `${slug} — ready.`;
    } catch (err) {
      failures++;
      el.className = 'line err';
      el.textContent = `${slug} — ${err?.message || err}`;
    }
  }

  await save(repos);
  line(failures ? `Saved. ${failures} of ${repos.length} need attention.` : 'All destinations ready. Saved.',
       failures ? 'err' : 'ok');

  $('test').disabled = false;
  $('save').disabled = false;
});

load();
