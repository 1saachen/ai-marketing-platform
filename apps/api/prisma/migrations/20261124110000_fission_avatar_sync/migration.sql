ALTER TABLE "fission_avatar_asset_grants"
    ADD COLUMN "doubaoSpeaker" VARCHAR(120),
    ADD CONSTRAINT "avatar_grants_doubao_preset_check"
        CHECK ("doubaoSpeaker" IS NULL OR "doubaoSpeaker" ~ '^zh_[a-z0-9_]+_uranus_bigtts$');

CREATE TABLE "fission_avatar_sync_tasks" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    "phase" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "attemptToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "ttsOperationId" UUID NOT NULL,
    "ttsStarted" BOOLEAN NOT NULL DEFAULT false,
    "lipSyncClientToken" UUID NOT NULL,
    "lipSyncStarted" BOOLEAN NOT NULL DEFAULT false,
    "lipSyncTaskId" VARCHAR(160),
    "errorCode" VARCHAR(48),
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "resultFingerprint" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fission_avatar_sync_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "avatar_sync_tasks_status_check"
        CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    CONSTRAINT "avatar_sync_tasks_phase_check"
        CHECK ("phase" IN ('QUEUED', 'TTS', 'LIP_SYNC', 'VALIDATING', 'COMPLETE')),
    CONSTRAINT "avatar_sync_tasks_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
    CONSTRAINT "avatar_sync_tasks_project_fkey" FOREIGN KEY ("projectId")
        REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "avatar_sync_tasks_run_fkey" FOREIGN KEY ("projectId", "workflowRunId")
        REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "avatar_sync_tasks_idempotency_key"
    ON "fission_avatar_sync_tasks" ("projectId", "workflowRunId", "idempotencyKey");
CREATE UNIQUE INDEX "avatar_sync_tasks_one_active"
    ON "fission_avatar_sync_tasks" ("projectId", "workflowRunId")
    WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE UNIQUE INDEX "avatar_sync_tts_operation_key" ON "fission_avatar_sync_tasks" ("ttsOperationId");
CREATE UNIQUE INDEX "avatar_sync_lip_operation_key" ON "fission_avatar_sync_tasks" ("lipSyncClientToken");
CREATE UNIQUE INDEX "avatar_sync_provider_task_key" ON "fission_avatar_sync_tasks" ("lipSyncTaskId");
CREATE INDEX "avatar_sync_tasks_recent_idx"
    ON "fission_avatar_sync_tasks" ("projectId", "workflowRunId", "createdAt");
CREATE INDEX "avatar_sync_tasks_lease_idx" ON "fission_avatar_sync_tasks" ("status", "leaseExpiresAt");
