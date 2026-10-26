// Linear's GraphQL API. Mirrors the surface github.js exposes so background.js can
// dispatch on provider without caring which one it is talking to.
//
// Auth: a personal API key goes in Authorization *raw*, with no "Bearer" prefix —
// unlike every other API in this extension. Getting that wrong returns a bare
// "Authentication required" that explains nothing.

const ENDPOINT = 'https://api.linear.app/graphql';

class LinearError extends Error {
  constructor(message, status) { super(message); this.name = 'LinearError'; this.status = status; }
}

async function gql(token, query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* fall through to the status message */ }

  if (!res.ok) {
    const detail = json?.errors?.[0]?.message || text.slice(0, 200) || res.statusText;
    const hint = res.status === 400 || res.status === 401
      ? ' — check the API key (Linear sends it raw, with no "Bearer" prefix)'
      : '';
    throw new LinearError(`Linear: ${detail} (HTTP ${res.status})${hint}`, res.status);
  }
  // GraphQL reports failures in the body with a 200, so this check is not optional.
  if (json?.errors?.length) throw new LinearError(`Linear: ${json.errors[0].message}`, 200);

  return json.data;
}

/** Who the key belongs to, for showing in settings and for validating it. */
export async function getViewer({ token }) {
  const d = await gql(token, `{ viewer { id name email } }`);
  return { id: d.viewer.id, name: d.viewer.name, email: d.viewer.email };
}

export async function listTeams({ token }) {
  const d = await gql(token, `{ teams(first: 250, orderBy: updatedAt) { nodes { id key name } } }`);
  return d.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
}

/** Labels a team can use, workspace-wide ones included. */
export async function listLabels({ token, teamId }) {
  const d = await gql(token, `
    query($teamId: String!) {
      team(id: $teamId) { labels(first: 250) { nodes { id name color } } }
      issueLabels(first: 250) { nodes { id name color team { id } } }
    }`, { teamId });

  // Workspace labels are the ones with no team. Filtered here rather than in the
  // query so a filter-syntax mistake cannot take the team's own labels down with it.
  const workspace = (d.issueLabels?.nodes || []).filter((l) => !l.team);
  const rows = [...(d.team?.labels?.nodes || []), ...workspace];
  const seen = new Set();
  return rows
    .filter((l) => !seen.has(l.name) && seen.add(l.name))
    // Strip the "#" so the shared chip renderer can treat it exactly like GitHub's.
    .map((l) => ({ id: l.id, name: l.name, color: String(l.color || '').replace('#', ''), description: '' }));
}

export async function listProjects({ token, teamId }) {
  const d = await gql(token, `
    query($teamId: String!) {
      team(id: $teamId) { projects(first: 250) { nodes { id name } } }
    }`, { teamId });
  return d.team?.projects?.nodes || [];
}

/**
 * Recent issues in a team, for picking a parent. Fetched once and filtered in the
 * browser — the same shape as the repository picker, and it avoids depending on
 * Linear's filter syntax for a list this small.
 */
export async function listRecentIssues({ token, teamId, limit = 250 }) {
  const d = await gql(token, `
    query($teamId: String!, $limit: Int!) {
      team(id: $teamId) {
        issues(first: $limit, orderBy: updatedAt) {
          nodes { id identifier title project { id name } }
        }
      }
    }`, { teamId, limit });

  return (d.team?.issues?.nodes || []).map((i) => ({
    id: i.id, identifier: i.identifier, title: i.title,
    projectId: i.project?.id || null, projectName: i.project?.name || '',
  }));
}

/**
 * Resolves "ENG-123", or a pasted Linear URL, to an issue. The escape hatch for a
 * parent too old to appear in the recent list.
 */
export async function resolveIssue({ token, ref }) {
  const m = String(ref || '').match(/([A-Za-z][A-Za-z0-9]*-\d+)/);
  if (!m) throw new LinearError('That does not look like a Linear issue ID or URL.');

  const d = await gql(token, `
    query($id: String!) {
      issue(id: $id) { id identifier title project { id name } }
    }`, { id: m[1].toUpperCase() });

  if (!d.issue) throw new LinearError(`No issue ${m[1].toUpperCase()} found.`);
  return {
    id: d.issue.id, identifier: d.issue.identifier, title: d.issue.title,
    projectId: d.issue.project?.id || null, projectName: d.issue.project?.name || '',
  };
}

export async function searchIssues({ token, teamId, text, limit = 3 }) {
  const terms = String(text || '').trim();
  if (terms.length < 4) return [];

  const d = await gql(token, `
    query($term: String!, $limit: Int!) {
      searchIssues(term: $term, first: $limit) {
        nodes { id identifier title url state { type } team { id } }
      }
    }`, { term: terms, limit: limit * 4 });

  return (d.searchIssues?.nodes || [])
    // Scope to this team and drop anything already finished; a closed duplicate is
    // not the warning the reporter needs.
    .filter((i) => (!teamId || i.team?.id === teamId) && !['completed', 'canceled'].includes(i.state?.type))
    .slice(0, limit)
    .map((i) => ({ number: i.identifier, title: i.title, url: i.url }));
}

/**
 * Two steps: ask Linear for a pre-signed URL, then PUT the bytes at it.
 *
 * Every header Linear hands back must be copied onto the PUT verbatim — they are
 * part of the signature, and a missing one fails with an opaque 403. Linear's docs
 * warn this is blocked from a web page by their CSP; an extension service worker
 * is not a page and has host permission for the upload origin.
 */
export async function uploadFile({ token, bytes, name, contentType = 'image/png' }) {
  const d = await gql(token, `
    mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`, { contentType, filename: name, size: bytes.length });

  const file = d.fileUpload?.uploadFile;
  if (!d.fileUpload?.success || !file) throw new LinearError('Linear refused the upload request.');

  const headers = new Headers({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' });
  for (const h of file.headers || []) headers.set(h.key, h.value);

  const put = await fetch(file.uploadUrl, { method: 'PUT', headers, body: bytes });
  if (!put.ok) {
    throw new LinearError(`Uploading the screenshot to Linear failed (HTTP ${put.status}). `
      + 'If this is a 403, a signed header was dropped.', put.status);
  }
  return file.assetUrl;
}

/**
 * The state a new issue should open in.
 *
 * An issueCreate with no stateId lands in the team's first backlog state — or in
 * Triage if the team has Triage enabled, which notifies whoever watches triage on
 * every single report. The UI does not do this when you add a sub-issue: it uses
 * the first unstarted state, normally "Todo". Matching that is the whole point.
 *
 * Ordered by position rather than by name, so a team that renamed Todo still works.
 */
export async function defaultStateId({ token, teamId }) {
  const d = await gql(token, `
    query($teamId: String!) {
      team(id: $teamId) {
        states(first: 100) { nodes { id name type position } }
      }
    }`, { teamId });

  const states = d.team?.states?.nodes || [];
  const firstOfType = (type) => states
    .filter((s) => s.type === type)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];

  // "unstarted" is Todo. Backlog is the sensible second choice for a team that has
  // no unstarted state at all; null means fall back to Linear's own behaviour.
  const chosen = firstOfType('unstarted') || firstOfType('backlog');
  return chosen ? { id: chosen.id, name: chosen.name } : null;
}

export async function createIssue({ token, teamId, title, description, parentId, projectId, labelIds, stateId }) {
  const input = { teamId, title, description };
  if (parentId) input.parentId = parentId;      // this is what makes it a sub-issue
  if (projectId) input.projectId = projectId;
  if (labelIds?.length) input.labelIds = labelIds;
  if (stateId) input.stateId = stateId;         // without this, Triage teams notify on every report

  const d = await gql(token, `
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url } }
    }`, { input });

  if (!d.issueCreate?.success || !d.issueCreate.issue) throw new LinearError('Linear did not create the issue.');
  const issue = d.issueCreate.issue;
  return { number: issue.identifier, url: issue.url };
}

export { LinearError };
