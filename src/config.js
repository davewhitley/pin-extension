// The GitHub App this extension signs in against.
//
// A client_id is NOT a secret — it is safe in source and safe to publish. The
// device flow deliberately has no client_secret, which is what lets Pin sign
// people in with no backend of any kind. See SETUP.md.
//
// Leave this empty and Pin falls back to personal access tokens, so an
// unconfigured copy still works.
export const GITHUB_CLIENT_ID = '';
