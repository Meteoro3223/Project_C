import { createHash } from "node:crypto";
import { Router } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  LAST_SEEN_TOUCH_INTERVAL_MS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "./config/session.js";
import { getWorkspaceId } from "./middleware/require-workspace.js";
import { WorkspaceRepository } from "./repositories/workspace.repository.js";
import { disconnectTestDatabase, resetDatabase, testPrisma } from "./test/database.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function findSessionCookieHeader(res: {
  get(header: "Set-Cookie"): string[] | undefined;
}): string | undefined {
  for (const header of res.get("Set-Cookie") ?? []) {
    const [pair] = header.split(";");
    if (pair === undefined) {
      continue;
    }

    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) {
      continue;
    }

    return header;
  }

  return undefined;
}

function findSessionCookie(res: {
  get(header: "Set-Cookie"): string[] | undefined;
}): string | undefined {
  const header = findSessionCookieHeader(res);
  if (header === undefined) {
    return undefined;
  }

  const [pair] = header.split(";");
  if (pair === undefined) {
    return undefined;
  }

  const separator = pair.indexOf("=");
  if (separator === -1) {
    return undefined;
  }

  return pair.slice(separator + 1).trim();
}

const probeRouter = Router();
probeRouter.get("/", (req, res) => {
  res.json({ workspaceId: getWorkspaceId(req) });
});
probeRouter.post("/", (req, res) => {
  res.json({ workspaceId: getWorkspaceId(req) });
});

function createProbeApp(
  overrides: { secureCookies?: boolean; clock?: () => Date } = {},
): ReturnType<typeof createApp> {
  return createApp({
    prisma: testPrisma,
    protectedRouters: [{ path: "/probe", router: probeRouter }],
    ...overrides,
  });
}

async function createSession(
  app: ReturnType<typeof createApp>,
): Promise<{ cookie: string; workspaceId: string }> {
  const res = await request(app).post("/api/v1/workspace/session").expect(200);
  const cookie = findSessionCookie(res);
  if (cookie === undefined) {
    throw new Error("Expected POST /workspace/session to set a session cookie");
  }

  const workspace = await testPrisma.workspace.findUniqueOrThrow({
    where: { tokenHash: hashSecret(cookie) },
  });

  return { cookie, workspaceId: workspace.id };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe("POST /api/v1/workspace/session", () => {
  it("creates a workspace and sets a hardened cookie without Secure by default", async () => {
    const app = createApp({ prisma: testPrisma, clock: () => NOW });

    const res = await request(app).post("/api/v1/workspace/session").expect(200);

    expect(res.body).toEqual({ workspace: { timezone: "Europe/Madrid" } });
    expect(res.body).not.toHaveProperty("workspace.id");

    const [header] = res.get("Set-Cookie") ?? [];
    expect(header).toBeDefined();
    if (header === undefined) {
      throw new Error("Expected a Set-Cookie header");
    }

    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    expect(header).not.toContain("Secure");
    expect(await testPrisma.workspace.count()).toBe(1);
  });

  it("adds Secure only when secureCookies is true", async () => {
    const app = createApp({ prisma: testPrisma, secureCookies: true, clock: () => NOW });

    const res = await request(app).post("/api/v1/workspace/session").expect(200);

    const [header] = res.get("Set-Cookie") ?? [];
    expect(header).toBeDefined();
    if (header === undefined) {
      throw new Error("Expected a Set-Cookie header");
    }
    expect(header).toContain("Secure");
  });

  it("stores sha256(cookieValue) in tokenHash and never stores the raw secret", async () => {
    const app = createApp({ prisma: testPrisma, clock: () => NOW });

    const res = await request(app).post("/api/v1/workspace/session").expect(200);
    const cookie = findSessionCookie(res);
    if (cookie === undefined) {
      throw new Error("Expected a session cookie");
    }

    const workspace = await testPrisma.workspace.findFirstOrThrow();
    expect(workspace.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(workspace.tokenHash).toBe(hashSecret(cookie));
    expect(workspace.tokenHash).not.toBe(cookie);

    const allRows = await testPrisma.workspace.findMany();
    expect(JSON.stringify(allRows)).not.toContain(cookie);
  });

  it("resumes the same workspace with a valid cookie and does not create another", async () => {
    const app = createApp({ prisma: testPrisma, clock: () => NOW });
    const session = await createSession(app);

    const res = await request(app)
      .post("/api/v1/workspace/session")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.cookie}`)
      .expect(200);

    expect(res.body).toEqual({ workspace: { timezone: "Europe/Madrid" } });
    expect(res.get("Set-Cookie")).toBeUndefined();
    expect(await testPrisma.workspace.count()).toBe(1);

    const workspace = await testPrisma.workspace.findFirstOrThrow();
    expect(workspace.id).toBe(session.workspaceId);
  });

  it("creates distinct workspaces for two concurrent first visits", async () => {
    const app = createApp({ prisma: testPrisma, clock: () => NOW });

    const [first, second] = await Promise.all([
      request(app).post("/api/v1/workspace/session").expect(200),
      request(app).post("/api/v1/workspace/session").expect(200),
    ]);

    const firstCookie = findSessionCookie(first);
    const secondCookie = findSessionCookie(second);
    if (firstCookie === undefined || secondCookie === undefined) {
      throw new Error("Expected both visits to set a session cookie");
    }

    expect(firstCookie).not.toBe(secondCookie);
    expect(await testPrisma.workspace.count()).toBe(2);
  });
});

describe("requireWorkspace middleware", () => {
  it("resolves workspace A's cookie to A and workspace B's cookie to B", async () => {
    const app = createProbeApp();
    const a = await createSession(app);
    const b = await createSession(app);

    await request(app)
      .get("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${a.cookie}`)
      .expect(200)
      .expect({ workspaceId: a.workspaceId });

    await request(app)
      .get("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${b.cookie}`)
      .expect(200)
      .expect({ workspaceId: b.workspaceId });
  });

  it.each([
    ["no cookie", undefined],
    ["a garbage cookie", `${SESSION_COOKIE_NAME}=garbage`],
    ["an empty cookie", `${SESSION_COOKIE_NAME}=`],
    ["a well-formed but unknown secret", `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`],
    ["a malformed percent-encoded value", `${SESSION_COOKIE_NAME}=%E0%A4%A`],
    ["duplicate cookies", `${SESSION_COOKIE_NAME}=garbage; ${SESSION_COOKIE_NAME}=garbage`],
  ])("returns 401 with the standard error shape for %s", async (_label, cookieHeader) => {
    const app = createProbeApp();

    const probe = request(app).get("/api/v1/probe");
    if (cookieHeader !== undefined) {
      probe.set("Cookie", cookieHeader);
    }

    const res = await probe;

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    // The middleware must never create a workspace as a side effect.
    expect(await testPrisma.workspace.count()).toBe(0);
  });

  it("ignores workspaceId supplied in the body, query string and a custom header", async () => {
    const app = createProbeApp();
    const a = await createSession(app);
    const b = await createSession(app);

    const res = await request(app)
      .post("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${a.cookie}`)
      .set("x-workspace-id", b.workspaceId)
      .query({ workspaceId: b.workspaceId })
      .send({ workspaceId: b.workspaceId })
      .expect(200);

    expect(res.body).toEqual({ workspaceId: a.workspaceId });
  });
});

describe("lastSeenAt touch rule", () => {
  it("does not touch under one hour and touches once older, re-issuing the cookie", async () => {
    let now = new Date(NOW);
    const app = createApp({ prisma: testPrisma, clock: () => now });
    const session = await createSession(app);

    let stored = await testPrisma.workspace.findFirstOrThrow();
    expect(stored.lastSeenAt.toISOString()).toBe(NOW.toISOString());

    now = new Date(NOW.getTime() + 30 * 60 * 1000);
    const fresh = await request(app)
      .post("/api/v1/workspace/session")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.cookie}`)
      .expect(200);

    expect(fresh.get("Set-Cookie")).toBeUndefined();
    stored = await testPrisma.workspace.findFirstOrThrow();
    expect(stored.lastSeenAt.toISOString()).toBe(NOW.toISOString());

    now = new Date(NOW.getTime() + 61 * 60 * 1000);
    const stale = await request(app)
      .post("/api/v1/workspace/session")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.cookie}`)
      .expect(200);

    expect(findSessionCookie(stale)).toBe(session.cookie);
    stored = await testPrisma.workspace.findFirstOrThrow();
    expect(stored.lastSeenAt.toISOString()).toBe(now.toISOString());
  });
});

interface SlidingCookieResult {
  header: string;
  cookie: string;
  workspaceId: string;
  advancedNow: Date;
}

// Creates a session at NOW, then makes one authenticated request just past the
// throttle window so the middleware re-issues the cookie. The clock is injected,
// so the test never sleeps.
async function reissueSessionCookie(
  overrides: { secureCookies?: boolean } = {},
): Promise<SlidingCookieResult> {
  let now = new Date(NOW);
  const app = createProbeApp({ ...overrides, clock: () => now });
  const session = await createSession(app);

  now = new Date(NOW.getTime() + LAST_SEEN_TOUCH_INTERVAL_MS + 1);

  const res = await request(app)
    .get("/api/v1/probe")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${session.cookie}`)
    .expect(200);

  const header = findSessionCookieHeader(res);
  if (header === undefined) {
    throw new Error("Expected the middleware to re-issue the session cookie");
  }

  return {
    header,
    cookie: session.cookie,
    workspaceId: session.workspaceId,
    advancedNow: now,
  };
}

describe("sliding session cookie re-issue", () => {
  it("does not set a new cookie within the lastSeenAt throttle window", async () => {
    let now = new Date(NOW);
    const app = createProbeApp({ clock: () => now });
    const session = await createSession(app);

    now = new Date(NOW.getTime() + LAST_SEEN_TOUCH_INTERVAL_MS - 1);

    const res = await request(app)
      .get("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.cookie}`)
      .expect(200)
      .expect({ workspaceId: session.workspaceId });

    expect(findSessionCookieHeader(res)).toBeUndefined();

    const stored = await testPrisma.workspace.findUniqueOrThrow({
      where: { id: session.workspaceId },
    });
    expect(stored.lastSeenAt.toISOString()).toBe(NOW.toISOString());
  });

  it("re-issues the same secret with a fresh Max-Age past the window and updates lastSeenAt", async () => {
    const { header, cookie, workspaceId, advancedNow } = await reissueSessionCookie();

    const [pair] = header.split(";");
    expect(pair).toBe(`${SESSION_COOKIE_NAME}=${cookie}`);
    expect(header).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);

    const stored = await testPrisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(stored.lastSeenAt.toISOString()).toBe(advancedNow.toISOString());
  });
});

describe("malformed session secrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["a secret that is too short", "a".repeat(42)],
    ["a secret that is too long", "a".repeat(44)],
    ["a secret with base64 padding", `${"a".repeat(21)}=${"a".repeat(21)}`],
    ["a secret with a standard-base64 plus sign", `${"a".repeat(21)}+${"a".repeat(21)}`],
    ["a secret with a standard-base64 slash", `${"a".repeat(21)}/${"a".repeat(21)}`],
  ])("rejects %s with 401 before any tokenHash lookup", async (_label, secret) => {
    const app = createProbeApp();
    const lookup = vi.spyOn(WorkspaceRepository.prototype, "findByTokenHash");

    const res = await request(app)
      .get("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${secret}`)
      .expect(401);

    expect(res.body).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("session cookie attributes", () => {
  it("adds Secure to the re-issued cookie when secureCookies is true", async () => {
    const { header } = await reissueSessionCookie({ secureCookies: true });
    const attributes = header.split(";").map((attribute) => attribute.trim());

    expect(attributes).toContain("Secure");
  });

  it("sets Path=/ and the 30-day Max-Age on the re-issued cookie", async () => {
    const { header } = await reissueSessionCookie();
    const attributes = header.split(";").map((attribute) => attribute.trim());

    // Exact attribute match: `toContain("Path=/")` would also accept
    // `Path=/api`, which is a different cookie scope.
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  });
});
