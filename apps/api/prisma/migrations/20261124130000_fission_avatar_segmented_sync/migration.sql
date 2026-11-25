ALTER TABLE "fission_avatar_sync_tasks"
    ADD COLUMN "executionKind" VARCHAR(16) NOT NULL DEFAULT 'SHORT',
    ADD CONSTRAINT "avatar_sync_tasks_execution_kind_check" CHECK ("executionKind" IN ('SHORT', 'SEGMENTED'));
CREATE UNIQUE INDEX "avatar_sync_tasks_scope_key" ON "fission_avatar_sync_tasks"("projectId", "workflowRunId", "id");

CREATE TABLE "fission_avatar_sync_segments" (
    "taskId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "scriptText" VARCHAR(240) NOT NULL,
    "ttsOperationId" UUID NOT NULL,
    "ttsStarted" BOOLEAN NOT NULL DEFAULT false,
    "lipSyncClientToken" UUID NOT NULL,
    "lipSyncStarted" BOOLEAN NOT NULL DEFAULT false,
    "lipSyncTaskId" VARCHAR(160),
    "resultFingerprint" CHAR(64),
    "audioFileObjectId" UUID,
    "videoFileObjectId" UUID,
    "media" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fission_avatar_sync_segments_pkey" PRIMARY KEY ("taskId", "ordinal"),
    CONSTRAINT "avatar_sync_segments_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 12),
    CONSTRAINT "avatar_sync_segments_task_fkey" FOREIGN KEY ("projectId", "workflowRunId", "taskId") REFERENCES "fission_avatar_sync_tasks"("projectId", "workflowRunId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "avatar_sync_segments_scope_idx" ON "fission_avatar_sync_segments"("projectId", "workflowRunId", "taskId");
CREATE UNIQUE INDEX "avatar_sync_segment_tts_key" ON "fission_avatar_sync_segments"("ttsOperationId");
CREATE UNIQUE INDEX "avatar_sync_segment_lip_key" ON "fission_avatar_sync_segments"("lipSyncClientToken");
CREATE UNIQUE INDEX "avatar_sync_segment_provider_key" ON "fission_avatar_sync_segments"("lipSyncTaskId");
