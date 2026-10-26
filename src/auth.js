// GitHub's device flow: the browser asks for a short code, the person types it
// into github.com, and we poll until they approve. No client_secret, therefore no
// server — which is the whole reason this is viable for a team.
//
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

class AuthError extends Error {}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* GitHub answers HTML on some failures */ }

  if (!json) throw new AuthError(`GitHub returned ${res.status} without JSON. Check the client ID.`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Asks GitHub for a code pair. The user code is what the person types. */
export async function startDeviceFlow(clientId) {
  if (!clientId) throw new AuthError('No GitHub App is configured. See SETUP.md.');

  const json = await post(DEVICE_CODE_URL, { client_id: clientId });
  if (json.error) {
    // 404 here almost always means the client ID is wrong or device flow is off.
    throw new AuthError(json.error === 'Not Found'
      ? 'GitHub did not recognise that client ID, or the app does not have device flow enabled.'
      : (json.error_description || json.error));
  }

  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    interval: Math.max(1, json.interval || 5),
    expiresAt: Date.now() + (json.expires_in || 900) * 1000,
  };
}

/**
 * Polls until the person approves, refuses, or the code expires.
 *
 * `slow_down` must widen the interval — GitHub adds five seconds each time and
 * will rate limit an app that keeps polling at the original rate.
 */
export async function pollForToken({ clientId, deviceCode, interval, expiresAt, isCancelled }) {
  let wait = interval;

  for (;;) {
    if (isCancelled?.()) throw new AuthError('Sign-in cancelled.');
    if (Date.now() > expiresAt) throw new AuthError('That code expired. Start again.');

    await sleep(wait * 1000);
    if (isCancelled?.()) throw new AuthError('Sign-in cancelled.');

    const json = await post(TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: GRANT_TYPE,
    });

    if (json.access_token) return json.access_token;

    switch (json.error) {
      case 'authorization_pending': break;            // they have not finished yet
      case 'slow_down': wait = (json.interval || wait) + 5; break;
      case 'expired_token': throw new AuthError('That code expired. Start again.');
      case 'access_denied': throw new AuthError('Sign-in was refused on GitHub.');
      default: throw new AuthError(json.error_description || json.error || 'Sign-in failed.');
    }
  }
}

/** Who the token belongs to, for showing in settings. */
export async function getViewer(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new AuthError(`Could not read your GitHub account (HTTP ${res.status}).`);
  const u = await res.json();
  return { login: u.login, avatarUrl: u.avatar_url };
}

export { AuthError };
