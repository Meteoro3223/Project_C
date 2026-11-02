import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CourseRepository } from "./course.repository.js";
import { WorkspaceRepository } from "./workspace.repository.js";
import { disconnectTestDatabase, resetDatabase, testPrisma } from "../test/database.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const courses = new CourseRepository(testPrisma);
const workspaces = new WorkspaceRepository(testPrisma);

async function createWorkspace(tokenHash: string): Promise<string> {
  const workspace = await workspaces.create(tokenHash, NOW);
  return workspace.id;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe("CourseRepository workspace isolation", () => {
  it("lists only the requested workspace's courses", async () => {
    const workspaceA = await createWorkspace("hash-a");
    const workspaceB = await createWorkspace("hash-b");
    const courseA = await courses.create(workspaceA, { name: "A course", color: "#111111" });
    const courseB = await courses.create(workspaceB, { name: "B course", color: "#222222" });

    const listedForA = await courses.list(workspaceA);
    const listedForB = await courses.list(workspaceB);

    // Positive control: A sees its own row.
    expect(listedForA.map((course) => course.id)).toEqual([courseA.id]);
    expect(listedForA.every((course) => course.workspaceId === workspaceA)).toBe(true);
    // Negative: B never sees A's row.
    expect(listedForB.map((course) => course.id)).toEqual([courseB.id]);
    expect(listedForB.every((course) => course.workspaceId === workspaceB)).toBe(true);
  });

  it("findById(B, courseOfA) returns null; the positive control succeeds", async () => {
    const workspaceA = await createWorkspace("hash-a");
    const workspaceB = await createWorkspace("hash-b");
    const courseA = await courses.create(workspaceA, { name: "A course", color: "#111111" });

    expect(await courses.findById(workspaceB, courseA.id)).toBeNull();
    expect(await courses.findById(workspaceA, courseA.id)).toEqual(courseA);
  });

  it("update(B, courseOfA, ...) returns null and leaves A's course unchanged", async () => {
    const workspaceA = await createWorkspace("hash-a");
    const workspaceB = await createWorkspace("hash-b");
    const courseA = await courses.create(workspaceA, {
      name: "A course",
      code: "A-101",
      color: "#111111",
    });

    const result = await courses.update(workspaceB, courseA.id, { name: "Hijacked" });

    expect(result).toBeNull();
    const stored = await testPrisma.course.findUniqueOrThrow({ where: { id: courseA.id } });
    expect(stored.name).toBe("A course");
    expect(stored.code).toBe("A-101");
    expect(stored.workspaceId).toBe(workspaceA);

    // Positive control: A can update its own row.
    const updated = await courses.update(workspaceA, courseA.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
  });

  it("delete(B, courseOfA) returns false and A's course still exists", async () => {
    const workspaceA = await createWorkspace("hash-a");
    const workspaceB = await createWorkspace("hash-b");
    const courseA = await courses.create(workspaceA, { name: "A course", color: "#111111" });

    expect(await courses.delete(workspaceB, courseA.id)).toBe(false);
    expect(await testPrisma.course.count({ where: { id: courseA.id } })).toBe(1);

    // Positive control: A can delete its own row.
    expect(await courses.delete(workspaceA, courseA.id)).toBe(true);
    expect(await testPrisma.course.count({ where: { id: courseA.id } })).toBe(0);
  });

  it("create(B, ...) persists with B's workspaceId even if the input carries another one", async () => {
    const workspaceA = await createWorkspace("hash-a");
    const workspaceB = await createWorkspace("hash-b");

    // Extra property on a variable: structurally assignable, but the
    // repository must ignore it and use the parameter instead.
    const inputWithSpoofedWorkspace = {
      name: "B course",
      color: "#222222",
      workspaceId: workspaceA,
    };

    const created = await courses.create(workspaceB, inputWithSpoofedWorkspace);

    expect(created.workspaceId).toBe(workspaceB);
    const stored = await testPrisma.course.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.workspaceId).toBe(workspaceB);
    expect(await testPrisma.course.count({ where: { workspaceId: workspaceA } })).toBe(0);
  });

  it("treats another workspace's row and a missing row identically", async () => {
    const workspaceA = await createWorkspace("hash-a");
    const workspaceB = await createWorkspace("hash-b");
    const courseA = await courses.create(workspaceA, { name: "A course", color: "#111111" });
    const missingId = randomUUID();

    // Same observable result: future controllers answer 404 in both cases,
    // never 403, so they never confirm that another workspace's row exists.
    expect(await courses.findById(workspaceB, courseA.id)).toBeNull();
    expect(await courses.findById(workspaceB, missingId)).toBeNull();
    expect(await courses.update(workspaceB, courseA.id, { name: "Nope" })).toBeNull();
    expect(await courses.update(workspaceB, missingId, { name: "Nope" })).toBeNull();
    expect(await courses.delete(workspaceB, courseA.id)).toBe(false);
    expect(await courses.delete(workspaceB, missingId)).toBe(false);
  });
});
