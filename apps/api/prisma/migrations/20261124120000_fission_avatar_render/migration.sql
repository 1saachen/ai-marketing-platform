CREATE TABLE "fission_avatar_render_tasks" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
    "phase" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "attemptToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "errorCode" VARCHAR(48),
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "resultFingerprint" CHAR(64),
    "candidate" JSONB,
    "review" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fission_avatar_render_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "avatar_render_tasks_project_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "avatar_render_tasks_run_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "avatar_render_task_idempotency_key" ON "fission_avatar_render_tasks"("projectId", "workflowRunId", "idempotencyKey");
CREATE UNIQUE INDEX "avatar_render_tasks_one_active" ON "fission_avatar_render_tasks"("projectId", "workflowRunId") WHERE "status" IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW');
CREATE INDEX "avatar_render_tasks_recent_idx" ON "fission_avatar_render_tasks"("projectId", "workflowRunId", "createdAt");
CREATE INDEX "avatar_render_tasks_lease_idx" ON "fission_avatar_render_tasks"("status", "leaseExpiresAt");
