-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('ASSIGNMENT', 'PROJECT', 'EXAM', 'STUDY', 'OTHER');

-- CreateEnum
CREATE TYPE "Importance" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "color" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "TaskType" NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "importance" "Importance" NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,
    "remainingMinutes" INTEGER NOT NULL,
    "status" "TaskStatus" NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_tokenHash_key" ON "Workspace"("tokenHash");

-- CreateIndex
CREATE INDEX "Course_workspaceId_idx" ON "Course"("workspaceId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_dueAt_idx" ON "Task"("workspaceId", "dueAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_status_idx" ON "Task"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Availability_workspaceId_weekday_key" ON "Availability"("workspaceId", "weekday");

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written CHECK constraints. Prisma cannot express CHECKs in schema.prisma,
-- so they are appended to this migration and named for greppable assertions.
ALTER TABLE "Task"
    ADD CONSTRAINT "task_estimated_minutes_nonneg" CHECK ("estimatedMinutes" >= 0),
    ADD CONSTRAINT "task_remaining_minutes_nonneg" CHECK ("remainingMinutes" >= 0);

ALTER TABLE "Availability"
    ADD CONSTRAINT "availability_weekday_range" CHECK ("weekday" BETWEEN 1 AND 7),
    ADD CONSTRAINT "availability_minutes_range" CHECK ("minutes" BETWEEN 0 AND 1440);
