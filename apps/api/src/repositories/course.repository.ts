import type { Prisma, PrismaClient } from "@prisma/client";

export interface CourseRecord {
  id: string;
  workspaceId: string;
  name: string;
  code: string | null;
  color: string;
  archivedAt: Date | null;
}

// Input types deliberately have no `workspaceId`: it always comes from the
// authenticated parameter, never from the caller's payload.
export interface CreateCourseInput {
  name: string;
  code?: string | null;
  color: string;
}

export interface UpdateCourseInput {
  name?: string;
  code?: string | null;
  color?: string;
  archivedAt?: Date | null;
}

const COURSE_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  code: true,
  color: true,
  archivedAt: true,
} as const;

// Pattern for every workspace-owned repository:
// - `workspaceId` is the mandatory first parameter;
// - every query includes it in `where`, including update and delete;
// - a row from another workspace is indistinguishable from a missing row.
export class CourseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(workspaceId: string): Promise<CourseRecord[]> {
    return this.prisma.course.findMany({
      where: { workspaceId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: COURSE_SELECT,
    });
  }

  async findById(workspaceId: string, id: string): Promise<CourseRecord | null> {
    return this.prisma.course.findFirst({
      where: { id, workspaceId },
      select: COURSE_SELECT,
    });
  }

  async create(workspaceId: string, input: CreateCourseInput): Promise<CourseRecord> {
    return this.prisma.course.create({
      // `workspaceId` comes only from the parameter. Any extra runtime
      // property in `input` is ignored because the data object is explicit.
      data: {
        workspaceId,
        name: input.name,
        code: input.code ?? null,
        color: input.color,
      },
      select: COURSE_SELECT,
    });
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateCourseInput,
  ): Promise<CourseRecord | null> {
    const data: Prisma.CourseUpdateManyMutationInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.code !== undefined) {
      data.code = input.code;
    }
    if (input.color !== undefined) {
      data.color = input.color;
    }
    if (input.archivedAt !== undefined) {
      data.archivedAt = input.archivedAt;
    }

    // Atomic workspace-scoped write. No read-then-write by id alone.
    const { count } = await this.prisma.course.updateMany({
      where: { id, workspaceId },
      data,
    });

    if (count === 0) {
      return null;
    }

    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.course.deleteMany({
      where: { id, workspaceId },
    });

    return count > 0;
  }
}
