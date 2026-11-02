import type { Request, Response } from "express";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "../config/session.js";

// Minimal cookie reader: only the single cookie the API needs. A full
// cookie-parsing dependency would add no value here.
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) {
    return undefined;
  }

  const values: string[] = [];

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }

    let value = part.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding: treat the cookie as absent.
      return undefined;
    }
    values.push(value);
  }

  // Duplicate cookies are ambiguous. Never pick one silently.
  if (values.length !== 1) {
    return undefined;
  }

  const [only] = values;
  return only;
}

export interface SessionCookieOptions {
  secure: boolean;
}

export function setSessionCookie(
  res: Response,
  secret: string,
  options: SessionCookieOptions,
): void {
  res.cookie(SESSION_COOKIE_NAME, secret, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: options.secure,
    maxAge: SESSION_MAX_AGE_MS,
  });
}
