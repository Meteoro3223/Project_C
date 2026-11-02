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
probeRouter.get("/boom", () => {
  throw new Error("probe boom");
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

  it("creates a new workspace and a new cookie for a well-formed but unknown secret", async () => {
    const app = createApp({ prisma: testPrisma, clock: () => NOW });
    const presented = "a".repeat(43);

    const res = await request(app)
      .post("/api/v1/workspace/session")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${presented}`)
      .expect(200);

    const issued = findSessionCookie(res);
    if (issued === undefined) {
      throw new Error("Expected the unknown secret to be replaced by a new cookie");
    }

    expect(issued).not.toBe(presented);
    expect(findSessionCookieHeader(res)).toContain(`${SESSION_COOKIE_NAME}=${issued}`);
    expect(await testPrisma.workspace.count()).toBe(1);

    const stored = await testPrisma.workspace.findFirstOrThrow();
    expect(stored.tokenHash).toBe(hashSecret(issued));
    expect(stored.tokenHash).not.toBe(hashSecret(presented));
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

describe("lastSeenAt isolation between workspaces", () => {
  it("touches only the authenticated workspace, in both directions", async () => {
    let now = new Date(NOW);
    const app = createProbeApp({ clock: () => now });
    const a = await createSession(app);
    const b = await createSession(app);

    now = new Date(NOW.getTime() + LAST_SEEN_TOUCH_INTERVAL_MS + 1);

    await request(app)
      .get("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${a.cookie}`)
      .expect(200);

    const afterATouch = await testPrisma.workspace.findUniqueOrThrow({
      where: { id: a.workspaceId },
    });
    const bAfterATouch = await testPrisma.workspace.findUniqueOrThrow({
      where: { id: b.workspaceId },
    });
    expect(afterATouch.lastSeenAt.toISOString()).toBe(now.toISOString());
    expect(bAfterATouch.lastSeenAt.toISOString()).toBe(NOW.toISOString());

    now = new Date(now.getTime() + LAST_SEEN_TOUCH_INTERVAL_MS + 1);

    await request(app)
      .get("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${b.cookie}`)
      .expect(200);

    const aAfterBTouch = await testPrisma.workspace.findUniqueOrThrow({
      where: { id: a.workspaceId },
    });
    const bAfterBTouch = await testPrisma.workspace.findUniqueOrThrow({
      where: { id: b.workspaceId },
    });
    expect(aAfterBTouch.lastSeenAt.toISOString()).toBe(afterATouch.lastSeenAt.toISOString());
    expect(bAfterBTouch.lastSeenAt.toISOString()).toBe(now.toISOString());
  });
});

describe("central error handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps malformed JSON to 400 INVALID_JSON without leaking the parser message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      // Parser failures are expected; they must not be logged.
    });
    const app = createApp({ prisma: testPrisma, clock: () => NOW });

    const res = await request(app)
      .post("/api/v1/workspace/session")
      .set("Content-Type", "application/json")
      .send('{"workspace":')
      .expect(400);

    expect(res.body).toEqual({
      error: { code: "INVALID_JSON", message: "Malformed JSON body" },
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(log).not.toHaveBeenCalled();
    expect(await testPrisma.workspace.count()).toBe(0);
  });

  it("maps a body over 100kb to 413 PAYLOAD_TOO_LARGE", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      // Parser failures are expected; they must not be logged.
    });
    const app = createApp({ prisma: testPrisma, clock: () => NOW });

    const res = await request(app)
      .post("/api/v1/workspace/session")
      .set("Content-Type", "application/json")
      .send({ padding: "x".repeat(101 * 1024) })
      .expect(413);

    expect(res.body).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Payload too large" },
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(log).not.toHaveBeenCalled();
    expect(await testPrisma.workspace.count()).toBe(0);
  });

  it("still returns an opaque 500 for an unexpected plain Error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      // Asserted below; silenced so the test output stays clean.
    });
    const app = createProbeApp();
    const session = await createSession(app);

    const res = await request(app)
      .get("/api/v1/probe/boom")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.cookie}`)
      .expect(500);

    expect(res.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(res.text).not.toContain("probe boom");
    expect(log).toHaveBeenCalledWith("Unhandled API error:", "probe boom");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("Cache-Control", () => {
  it("sets no-store on protected routes, the session endpoint and 401 responses", async () => {
    const app = createProbeApp();
    const session = await createSession(app);

    const protectedRes = await request(app)
      .get("/api/v1/probe")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${session.cookie}`)
      .expect(200);
    expect(protectedRes.headers["cache-control"]).toBe("no-store");

    const sessionRes = await request(app).post("/api/v1/workspace/session").expect(200);
    expect(sessionRes.headers["cache-control"]).toBe("no-store");

    const unauthorized = await request(app).get("/api/v1/probe").expect(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
  });
});

// Express 4 keeps its route table on the router stack. The shapes below are
// typed structurally through `unknown`, so no Express internals leak `any` into
// the test.
interface ExpressLayer {
  name: string;
  regexp: RegExp;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: unknown };
}

function isExpressLayer(value: unknown): value is ExpressLayer {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { name?: unknown; regexp?: unknown; handle?: unknown };
  return (
    typeof candidate.name === "string" &&
    candidate.regexp instanceof RegExp &&
    typeof candidate.handle === "function"
  );
}

function readStack(target: unknown): ExpressLayer[] {
  const appRouter = (target as { _router?: { stack?: unknown } })._router;
  const routerStack = (target as { stack?: unknown }).stack;
  const raw = appRouter?.stack ?? routerStack;

  if (!Array.isArray(raw)) {
    throw new Error("Expected an Express router stack");
  }

  return raw.filter((entry: unknown) => isExpressLayer(entry));
}

function nestedStack(layer: ExpressLayer): ExpressLayer[] | null {
  const stack = layer.handle.stack;
  if (!Array.isArray(stack)) {
    return null;
  }
  return stack.filter((entry: unknown) => isExpressLayer(entry));
}

function findApiMount(app: ReturnType<typeof createApp>): ExpressLayer {
  const apiMount = readStack(app).find(
    (layer) => nestedStack(layer) !== null && layer.regexp.test("/api/v1"),
  );
  if (apiMount === undefined) {
    throw new Error("Expected createApp() to mount the API router at /api/v1");
  }
  return apiMount;
}

// `api.use(path, requireWorkspace, router)` pushes one layer per handler. A
// mount is guarded when a non-router middleware layer shares its path.
function isGuardedByMiddleware(apiStack: ExpressLayer[], mount: ExpressLayer): boolean {
  const index = apiStack.indexOf(mount);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = apiStack[cursor];
    if (candidate === undefined || candidate.regexp.source !== mount.regexp.source) {
      break;
    }
    if (nestedStack(candidate) === null) {
      return true;
    }
  }
  return false;
}

async function callWithoutCookie(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
): Promise<{ status: number; body: unknown }> {
  switch (method) {
    case "get":
      return request(app).get(url);
    case "post":
      return request(app).post(url);
    default:
      throw new Error(`The contract test cannot call ${method} ${url}`);
  }
}

const PUBLIC_MOUNTS = ["/health", "/workspace"] as const;

describe("route protection contract", () => {
  it("keeps every router mount outside the public allowlist behind requireWorkspace", () => {
    const app = createProbeApp();
    const appStack = readStack(app);

    // No route may bypass the API router (and therefore the middleware).
    expect(appStack.filter((layer) => layer.route !== undefined)).toEqual([]);
    expect(appStack.filter((layer) => nestedStack(layer) !== null)).toHaveLength(1);

    const apiStack = readStack(findApiMount(app).handle);

    // Direct routes on the API router would skip the requireWorkspace mount.
    expect(apiStack.filter((layer) => layer.route !== undefined)).toEqual([]);

    const mounts = apiStack.filter((layer) => nestedStack(layer) !== null);
    for (const mount of mounts) {
      const isPublic = PUBLIC_MOUNTS.some((path) => mount.regexp.test(path));
      expect({
        source: mount.regexp.source,
        guarded: isGuardedByMiddleware(apiStack, mount),
      }).toEqual({ source: mount.regexp.source, guarded: !isPublic });
    }

    expect(mounts.filter((mount) => !isGuardedByMiddleware(apiStack, mount))).toHaveLength(
      PUBLIC_MOUNTS.length,
    );
  });

  it("returns 401 without a cookie for every route of every protected router", async () => {
    const app = createProbeApp();
    const apiStack = readStack(findApiMount(app).handle);
    const probeMount = apiStack.find(
      (layer) => nestedStack(layer) !== null && layer.regexp.test("/probe"),
    );
    const probeStack = probeMount === undefined ? null : nestedStack(probeMount);
    if (probeStack === null) {
      throw new Error("Expected the probe router to be mounted at /probe");
    }

    const routes = probeStack.filter((layer) => layer.route !== undefined);
    expect(routes.length).toBeGreaterThan(0);

    for (const layer of routes) {
      const route = layer.route;
      if (route === undefined) {
        continue;
      }

      const url = `/api/v1/probe${route.path === "/" ? "" : route.path}`;
      for (const method of Object.keys(route.methods)) {
        const res = await callWithoutCookie(app, method, url);
        expect({ method, url, status: res.status, body: res.body }).toEqual({
          method,
          url,
          status: 401,
          body: { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
        });
      }
    }
  });
});
