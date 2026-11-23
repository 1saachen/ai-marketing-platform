CREATE TABLE "fission_local_replace_tasks" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "planArtifactId" UUID NOT NULL,
    "planRevision" INTEGER NOT NULL,
    "planContentHash" CHAR(64) NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "attemptToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "providerCreationPending" BOOLEAN NOT NULL DEFAULT false,
    "providerTaskId" VARCHAR(180),
    "sourceProbe" JSONB,
    "errorCode" VARCHAR(80),
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "resultSha256" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fission_local_replace_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "local_replace_tasks_status_check" CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    CONSTRAINT "local_replace_tasks_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
    CONSTRAINT "local_replace_tasks_project_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "local_replace_tasks_run_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "local_replace_tasks_idempotency_key"
    ON "fission_local_replace_tasks" ("projectId", "workflowRunId", "idempotencyKey");
CREATE INDEX "local_replace_tasks_scope_status_idx"
    ON "fission_local_replace_tasks" ("projectId", "workflowRunId", "status");
CREATE INDEX "local_replace_tasks_lease_idx"
    ON "fission_local_replace_tasks" ("status", "leaseExpiresAt");
