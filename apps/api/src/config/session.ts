// Session configuration. Keep every duration and limit here so the services,
// controllers and middleware cannot drift apart.

export const SESSION_COOKIE_NAME = "sid";

// 30 days: matches the default inactivity cleanup window in PLAN.md section 9.
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

// `lastSeenAt` is written at most once per hour to avoid a write per request.
export const LAST_SEEN_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

// 32 random bytes = 256 bits of entropy. A single SHA-256 digest is enough
// because the secret is not a low-entropy password (ADR-0008).
export const SESSION_SECRET_BYTES = 32;

// base64url of 32 bytes is always 43 characters.
export const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isSessionSecret(value: string): boolean {
  return SESSION_SECRET_PATTERN.test(value);
}
