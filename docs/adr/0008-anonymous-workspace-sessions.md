# ADR-0008: Anonymous workspace sessions and workspace-scoped repositories

## Status

Accepted.

## Context

The public demo has no accounts (PLAN section 9). A browser must get a durable,
unforgeable handle to one anonymous workspace, and every query for user data
must be scoped to that workspace on the server. Isolation bugs are the most
damaging class of bug in this project, so the mechanism has to be simple,
explicit and testable.

Options considered for the cookie secret:

1. **A random 256-bit secret, stored as a SHA-256 digest.** The secret already
   has full entropy, so a fast digest is enough. A database leak does not expose
   usable cookie values.
2. **A password-style hash (bcrypt/argon2).** Deliberately slow, which is useful
   for low-entropy passwords but only adds latency here because the input cannot
   be guessed.
3. **A signed token containing the workspace id.** It would avoid a lookup but
   needs a signing key, rotation and careful expiry handling, and it puts the
   workspace id in the client's hands rather than deriving it from server state.

Options considered for session lifetime:

1. **Fixed expiry from creation.** Simple, but an active demo visitor is logged
   out after 30 days even while using the app.
2. **Sliding expiry refreshed on every request.** Keeps active sessions alive
   but costs one write per request.
3. **Sliding expiry refreshed at most once per hour.** Keeps active sessions
   alive with a bounded write rate.

## Decision

- Generate the secret with `crypto.randomBytes(32)` and encode it as base64url
  (43 characters, 256 bits). Store only its SHA-256 hex digest in
  `Workspace.tokenHash`; the raw value exists only in the response cookie.
- Use the cookie `sid` with `HttpOnly`, `SameSite=Lax`, `Path=/` and a 30-day
  `Max-Age`. `Secure` is enabled through a `secureCookies` option injected into
  `createApp()` at the composition root; middleware never reads `process.env`.
  The 30-day value matches the default inactivity cleanup window in PLAN
  section 9 and lives in one config module.
- `POST /api/v1/workspace/session` resumes a valid cookie or creates a new
  workspace. The `requireWorkspace` middleware never creates a workspace: no
  cookie, a malformed value or an unknown secret is a `401` with code
  `UNAUTHENTICATED`.
- `lastSeenAt` is updated with a single conditional `updateMany` (`id` plus
  `lastSeenAt < now - 1 hour`). When the write happens, the same cookie value is
  re-issued with a fresh `Max-Age`. This keeps the sliding expiry without a read
  followed by a write and without a write per request.
- `req.workspaceId` is set only by `requireWorkspace`, from the resolved
  workspace. Controllers read it through `getWorkspaceId(req)`; no body, query
  string, route parameter or header is ever consulted for it.
- `WorkspaceRepository` is the single repository without a `workspaceId`
  parameter because the workspace is the root entity. Every repository for
  workspace-owned data takes `workspaceId` as the mandatory first parameter and
  includes it in every `where`, including update and delete.
- `update` and `delete` use `updateMany` / `deleteMany` with `{ id, workspaceId }`
  instead of reading by id and then acting on that id. They return `null` /
  `false` when nothing matched, so a row from another workspace and a missing
  row are indistinguishable: future controllers answer `404`, never `403`.

## Consequences

- Losing the cookie means losing the workspace. This is accepted for v1 (PLAN
  section 9); there is no account recovery.
- A 256-bit secret with SHA-256 avoids password-hashing cost. If the token ever
  becomes user-chosen or low-entropy, this decision must be revisited.
- The one-hour touch interval means `lastSeenAt` can lag real activity by up to
  an hour. Cleanup of inactive workspaces (P3-T3) must account for that
  granularity.
- Re-issuing the cookie on authenticated requests means every response can carry
  a `Set-Cookie` header at most once per hour. That is intentional sliding
  expiry, not a cacheable response.
- `Secure` is set from the injected `secureCookies` value, so it is testable
  and does not depend on `req.secure`. At deployment behind a TLS-terminating
  reverse proxy, Express still needs `trust proxy` configured so
  protocol-dependent behaviour is correct (P3-T4).
- Cross-workspace access is intentionally reported as "not found", not
  "forbidden", so the API does not confirm that another workspace's row exists.
- The middleware is only mounted on protected routers. Public routes (health and
  the session endpoint) are mounted explicitly, so a new resource route must go
  through the protected-router registry to be reachable.
