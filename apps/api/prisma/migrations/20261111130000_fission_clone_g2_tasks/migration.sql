CREATE TABLE "fission_clone_mapping_files" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "sourceVersionId" UUID NOT NULL,
  "fileObjectId" UUID NOT NULL,
  "media" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fission_clone_mapping_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clone_mapping_file_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "clone_mapping_files_version_key" ON "fission_clone_mapping_files" ("projectId","workflowRunId","assetId","version");
CREATE INDEX "clone_mapping_files_file_idx" ON "fission_clone_mapping_files" ("projectId","fileObjectId");
ALTER TABLE "fission_clone_mapping_files" ADD CONSTRAINT "fission_clone_mapping_files_projectId_workflowRunId_fkey" FOREIGN KEY ("projectId","workflowRunId") REFERENCES "workflow_runs"("projectId","id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fission_clone_mapping_files" ADD CONSTRAINT "fission_clone_mapping_files_projectId_workflowRunId_fileObjectId_fkey" FOREIGN KEY ("projectId","workflowRunId","fileObjectId") REFERENCES "file_objects"("projectId","workflowRunId","id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "fission_clone_tasks" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "operation" VARCHAR(24) NOT NULL,
  "purpose" VARCHAR(32),
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "inputSnapshot" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "currentStage" VARCHAR(80) NOT NULL DEFAULT 'QUEUED',
  "result" JSONB,
  "resultHash" CHAR(64),
  "appliedToDraft" BOOLEAN NOT NULL DEFAULT false,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "attemptToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "errorCode" VARCHAR(80),
  "errorMessage" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "fission_clone_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clone_tasks_status_check" CHECK ("status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  CONSTRAINT "clone_tasks_operation_check" CHECK (("operation" = 'ANALYZE' AND "purpose" IS NULL) OR ("operation" = 'MAP_SUGGEST' AND "purpose" IN ('SMART_MATCH','VALIDATE_KEEP_TEXT'))),
  CONSTRAINT "clone_tasks_progress_check" CHECK ("progress" BETWEEN 0 AND 100 AND "attemptCount" >= 0)
);
CREATE UNIQUE INDEX "clone_tasks_idempotency_key" ON "fission_clone_tasks" ("projectId","workflowRunId","operation","idempotencyKey");
CREATE UNIQUE INDEX "clone_tasks_scope_key" ON "fission_clone_tasks" ("projectId","workflowRunId","id");
CREATE INDEX "clone_tasks_scope_status_idx" ON "fission_clone_tasks" ("projectId","workflowRunId","status");
CREATE INDEX "clone_tasks_lease_idx" ON "fission_clone_tasks" ("status","leaseExpiresAt");
ALTER TABLE "fission_clone_tasks" ADD CONSTRAINT "fission_clone_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fission_clone_tasks" ADD CONSTRAINT "fission_clone_tasks_projectId_workflowRunId_fkey" FOREIGN KEY ("projectId","workflowRunId") REFERENCES "workflow_runs"("projectId","id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "fission_clone_task_steps" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "stepKey" VARCHAR(80) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "outputHash" CHAR(64) NOT NULL,
  "output" JSONB NOT NULL,
  "attemptToken" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fission_clone_task_steps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clone_steps_task_key" ON "fission_clone_task_steps" ("projectId","workflowRunId","taskId","stepKey");
ALTER TABLE "fission_clone_task_steps" ADD CONSTRAINT "fission_clone_task_steps_projectId_workflowRunId_taskId_fkey" FOREIGN KEY ("projectId","workflowRunId","taskId") REFERENCES "fission_clone_tasks"("projectId","workflowRunId","id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "fission_clone_file_holds" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "fileObjectId" UUID NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fission_clone_file_holds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clone_holds_task_file_key" ON "fission_clone_file_holds" ("projectId","workflowRunId","taskId","fileObjectId");
CREATE INDEX "clone_holds_file_idx" ON "fission_clone_file_holds" ("projectId","fileObjectId");
ALTER TABLE "fission_clone_file_holds" ADD CONSTRAINT "fission_clone_file_holds_projectId_workflowRunId_taskId_fkey" FOREIGN KEY ("projectId","workflowRunId","taskId") REFERENCES "fission_clone_tasks"("projectId","workflowRunId","id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fission_clone_file_holds" ADD CONSTRAINT "fission_clone_file_holds_projectId_workflowRunId_fileObjectId_fkey" FOREIGN KEY ("projectId","workflowRunId","fileObjectId") REFERENCES "file_objects"("projectId","workflowRunId","id") ON DELETE RESTRICT ON UPDATE CASCADE;
