import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectTestDatabase, resetDatabase, testPrisma } from "./database.js";

const DUE_AT = new Date("2030-01-15T10:00:00.000Z");

async function createWorkspace(tokenHash: string): Promise<string> {
  const workspace = await testPrisma.workspace.create({ data: { tokenHash } });
  return workspace.id;
}

async function createTask(workspaceId: string, estimatedMinutes: number, remainingMinutes: number) {
  return testPrisma.task.create({
    data: {
      workspaceId,
      title: "Problem set",
      type: "ASSIGNMENT",
      dueAt: DUE_AT,
      importance: "MEDIUM",
      estimatedMinutes,
      remainingMinutes,
      status: "TODO",
    },
  });
}

async function createWorkspaceFixture(tokenHash: string) {
  const workspaceId = await createWorkspace(tokenHash);
  const course = await testPrisma.course.create({
    data: { workspaceId, name: "Algorithms", color: "#336699" },
  });
  const task = await testPrisma.task.create({
    data: {
      workspaceId,
      courseId: course.id,
      title: "Problem set",
      type: "ASSIGNMENT",
      dueAt: DUE_AT,
      importance: "HIGH",
      estimatedMinutes: 120,
      remainingMinutes: 60,
      status: "TODO",
    },
  });
  const availability = await testPrisma.availability.create({
    data: { workspaceId, weekday: 1, minutes: 180 },
  });

  return { workspaceId, courseId: course.id, taskId: task.id, availabilityId: availability.id };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe("foreign key actions", () => {
  it("deletes courses, tasks and availability when a workspace is deleted", async () => {
    const fixture = await createWorkspaceFixture("workspace-delete");

    await testPrisma.workspace.delete({ where: { id: fixture.workspaceId } });

    expect(await testPrisma.course.count()).toBe(0);
    expect(await testPrisma.task.count()).toBe(0);
    expect(await testPrisma.availability.count()).toBe(0);
  });

  it("keeps tasks and nulls courseId when a course is deleted", async () => {
    const fixture = await createWorkspaceFixture("course-delete");

    await testPrisma.course.delete({ where: { id: fixture.courseId } });

    const task = await testPrisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } });
    expect(task.courseId).toBeNull();
    expect(await testPrisma.task.count()).toBe(1);
    expect(await testPrisma.course.count()).toBe(0);
  });
});

describe("CHECK constraints", () => {
  it("rejects negative estimatedMinutes and names the constraint", async () => {
    const workspaceId = await createWorkspace("check-estimated");

    await expect(createTask(workspaceId, -1, 0)).rejects.toThrow("task_estimated_minutes_nonneg");
  });

  it("accepts estimatedMinutes = 0", async () => {
    const workspaceId = await createWorkspace("check-estimated-zero");

    const task = await createTask(workspaceId, 0, 0);

    expect(task.estimatedMinutes).toBe(0);
  });

  it("rejects negative remainingMinutes and names the constraint", async () => {
    const workspaceId = await createWorkspace("check-remaining");

    await expect(createTask(workspaceId, 0, -1)).rejects.toThrow("task_remaining_minutes_nonneg");
  });

  it("accepts remainingMinutes = 0", async () => {
    const workspaceId = await createWorkspace("check-remaining-zero");

    const task = await createTask(workspaceId, 0, 0);

    expect(task.remainingMinutes).toBe(0);
  });

  it.each([0, 8])("rejects weekday %i and names the constraint", async (weekday) => {
    const workspaceId = await createWorkspace(`check-weekday-${String(weekday)}`);

    await expect(
      testPrisma.availability.create({ data: { workspaceId, weekday, minutes: 180 } }),
    ).rejects.toThrow("availability_weekday_range");
  });

  it.each([1, 7])("accepts weekday %i", async (weekday) => {
    const workspaceId = await createWorkspace(`accept-weekday-${String(weekday)}`);

    const availability = await testPrisma.availability.create({
      data: { workspaceId, weekday, minutes: 180 },
    });

    expect(availability.weekday).toBe(weekday);
  });

  it.each([-1, 1441])("rejects minutes = %i and names the constraint", async (minutes) => {
    const workspaceId = await createWorkspace(`check-minutes-${String(minutes)}`);

    await expect(
      testPrisma.availability.create({ data: { workspaceId, weekday: 1, minutes } }),
    ).rejects.toThrow("availability_minutes_range");
  });

  it.each([0, 1440])("accepts minutes = %i", async (minutes) => {
    const workspaceId = await createWorkspace(`accept-minutes-${String(minutes)}`);

    const availability = await testPrisma.availability.create({
      data: { workspaceId, weekday: 1, minutes },
    });

    expect(availability.minutes).toBe(minutes);
  });
});

describe("unique constraints", () => {
  it("rejects the same weekday twice in one workspace", async () => {
    const workspaceId = await createWorkspace("availability-unique");

    await testPrisma.availability.create({ data: { workspaceId, weekday: 3, minutes: 120 } });

    await expect(
      testPrisma.availability.create({ data: { workspaceId, weekday: 3, minutes: 60 } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same weekday in a different workspace", async () => {
    const firstWorkspaceId = await createWorkspace("availability-workspace-a");
    const secondWorkspaceId = await createWorkspace("availability-workspace-b");

    await testPrisma.availability.create({
      data: { workspaceId: firstWorkspaceId, weekday: 3, minutes: 120 },
    });
    const second = await testPrisma.availability.create({
      data: { workspaceId: secondWorkspaceId, weekday: 3, minutes: 60 },
    });

    expect(second.workspaceId).toBe(secondWorkspaceId);
  });

  it("rejects a duplicate tokenHash", async () => {
    await createWorkspace("shared-token-hash");

    await expect(
      testPrisma.workspace.create({ data: { tokenHash: "shared-token-hash" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("timestamp columns", () => {
  it("uses timestamp with time zone and precision 3 for every DateTime", async () => {
    const columns = await testPrisma.$queryRaw<
      {
        table_name: string;
        column_name: string;
        data_type: string;
        datetime_precision: number | null;
      }[]
    >`
      SELECT table_name, column_name, data_type, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name <> '_prisma_migrations'
        AND data_type LIKE 'timestamp%'
      ORDER BY table_name, column_name
    `;

    expect(columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`)).toEqual([
      "Course.archivedAt",
      "Task.completedAt",
      "Task.createdAt",
      "Task.dueAt",
      "Workspace.createdAt",
      "Workspace.lastSeenAt",
    ]);

    for (const column of columns) {
      expect(column.data_type).toBe("timestamp with time zone");
      expect(column.datetime_precision).toBe(3);
    }
  });
});
