// All GitHub network access lives here.
//
// uploadAsset() talks to an UNDOCUMENTED endpoint (uploads.github.com). If GitHub
// ever removes it, this is the only function that needs to change — see
// uploadAssetViaRepoCommit() at the bottom for a drop-in, fully-documented fallback.

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...authHeaders(token),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const detail = json?.message || text.slice(0, 200) || res.statusText;
    throw new GitHubError(`${detail} (HTTP ${res.status})`, res.status);
  }
  return json;
}

/** Verifies the token and resolves the numeric repository id the uploader needs. */
export async function getRepo({ token, owner, repo }) {
  const data = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
  return { id: data.id, fullName: data.full_name, canPush: !!data.permissions?.push };
}

/**
 * A 401/403 from the attachment endpoint has two very different causes, and the
 * wrong guess sends you off rotating tokens for no reason. SAML enforcement says
 * so in the message; anything else is most likely the token type.
 */
function uploadHint(status, detail) {
  if (status !== 401 && status !== 403) return '';
  if (/SAML|SSO|single sign-on/i.test(detail)) {
    return ' — authorize this token for the organization at github.com/settings/tokens (Configure SSO)';
  }
  return ' — the attachment endpoint may require a classic PAT with `repo` scope';
}

/**
 * Uploads binary image data to GitHub's own attachment store — the same place a
 * drag-and-drop into an issue lands. Returns a URL safe to embed in markdown.
 *
 * Undocumented: single POST, params in the query string, raw bytes as the body.
 */
export async function uploadAsset({ token, repositoryId, bytes, name, contentType = 'image/png' }) {
  const url = new URL(`${UPLOADS}/user-attachments/assets`);
  url.searchParams.set('name', name);
  url.searchParams.set('content_type', contentType);
  url.searchParams.set('repository_id', String(repositoryId));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': contentType,
    },
    body: bytes,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    const detail = json?.message || text.slice(0, 200) || res.statusText;
    throw new GitHubError(`Screenshot upload failed: ${detail} (HTTP ${res.status})${uploadHint(res.status, detail)}`, res.status);
  }

  const href = json?.href || json?.url || json?.asset?.href;
  if (!href) throw new GitHubError('Upload succeeded but no asset URL came back.', res.status);
  return href;
}

/**
 * Every label in the repo. GitHub caps a page at 100, so page until a short one
 * comes back. The 5-page ceiling is a runaway guard, not an expected limit — say
 * so out loud if it is ever hit, because silently returning 500 of 600 labels
 * would look like the repo simply has 500.
 */
export async function listLabels({ token, owner, repo }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`;
  const out = [];

  for (let page = 1; page <= 5; page++) {
    const batch = await api(`${base}?per_page=100&page=${page}`, { token });
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const l of batch) out.push({ name: l.name, color: l.color, description: l.description || '' });

    if (batch.length < 100) return out;
    if (page === 5) console.warn(`Pin: ${owner}/${repo} has more than 500 labels; the list is truncated.`);
  }
  return out;
}

/** Shared paging shape: stop on a short page, cap the total, never truncate silently. */
async function paged(token, path, pick, what) {
  const out = [];
  const join = path.includes('?') ? '&' : '?';

  for (let page = 1; page <= 5; page++) {
    const batch = await api(`${path}${join}per_page=100&page=${page}`, { token });
    const items = pick(batch);
    if (!items?.length) break;

    out.push(...items);
    if (items.length < 100) return out;
    if (page === 5) console.warn(`Pin: more than 500 ${what}; the list is truncated.`);
  }
  return out;
}

const asRepo = (r) => ({
  owner: r.owner?.login || '',
  repo: r.name,
  fullName: r.full_name,
  private: !!r.private,
  pushedAt: r.pushed_at || '',
});

/**
 * Every repository this credential can file into.
 *
 * A GitHub App sees only what it was installed on, which is usually a short,
 * deliberate list. A personal access token sees everything the person can reach,
 * which in a large org is hundreds — hence the filter box in the picker.
 */
export async function listRepos({ token, kind }) {
  if (kind === 'app') {
    const installs = await paged(token, '/user/installations', (b) => b.installations, 'installations');
    const out = [];
    for (const inst of installs) {
      const repos = await paged(token, `/user/installations/${inst.id}/repositories`,
        (b) => b.repositories, 'repositories');
      out.push(...repos.map(asRepo));
    }
    return dedupeRepos(out);
  }

  const mine = await paged(token,
    '/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member',
    (b) => b, 'repositories');
  return dedupeRepos(mine.map(asRepo));
}

function dedupeRepos(list) {
  const seen = new Set();
  return list
    .filter((r) => r.owner && r.repo && !seen.has(r.fullName) && seen.add(r.fullName))
    .sort((a, b) => (b.pushedAt || '').localeCompare(a.pushedAt || ''));
}

/**
 * Open issues that look like this one. Quoting is deliberately loose — GitHub's
 * search already stems and ranks, and an exact-phrase query would miss the
 * near-duplicates this is meant to catch.
 */
export async function searchIssues({ token, owner, repo, text, limit = 3 }) {
  const terms = String(text || '').replace(/[^\w\s-]/g, ' ').trim();
  if (terms.length < 4) return [];

  const q = `repo:${owner}/${repo} is:issue is:open ${terms}`;
  const json = await api(`/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`, { token });

  return (json.items || []).slice(0, limit).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
  }));
}

export async function createIssue({ token, owner, repo, title, body, labels }) {
  const payload = { title, body };
  if (labels?.length) payload.labels = labels;
  const data = await api(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    { token, method: 'POST', body: payload }
  );
  return { url: data.html_url, number: data.number };
}

/**
 * Documented fallback, unused by default. Commits the PNG into the repo and returns
 * a raw URL. Swap the uploadAsset() call in background.js to this if the endpoint
 * above ever stops working. Costs you a commit and a file per screenshot.
 */
export async function uploadAssetViaRepoCommit({ token, owner, repo, base64, name }) {
  const path = `bug-screenshots/${name}`;
  const data = await api(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`,
    { token, method: 'PUT', body: { message: `Add screenshot ${name}`, content: base64 } }
  );
  return data.content.download_url;
}

export { GitHubError };
