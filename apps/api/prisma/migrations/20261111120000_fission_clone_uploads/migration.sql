CREATE TABLE "fission_clone_uploads" (
    "id" UUID NOT NULL,
    "attemptToken" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "fileObjectId" UUID,
    "role" VARCHAR(16),
    "status" VARCHAR(16) NOT NULL DEFAULT 'UPLOADING',
    "media" JSONB,
    "clientUploadKey" VARCHAR(160) NOT NULL,
    "sourceAssetId" UUID,
    "sourceAssetVersion" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fission_clone_uploads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "clone_uploads_status_check" CHECK ("status" IN ('UPLOADING', 'AVAILABLE', 'REMOVED', 'FAILED')),
    CONSTRAINT "clone_uploads_role_check" CHECK ("role" IS NULL OR "role" IN ('REFERENCE', 'PRODUCT')),
    CONSTRAINT "clone_uploads_available_file_check" CHECK ("status" <> 'AVAILABLE' OR ("fileObjectId" IS NOT NULL AND "role" IS NOT NULL)),
    CONSTRAINT "clone_uploads_source_version_check" CHECK (("sourceAssetId" IS NULL AND "sourceAssetVersion" IS NULL) OR ("sourceAssetId" IS NOT NULL AND "sourceAssetVersion" IS NOT NULL AND "sourceAssetVersion" > 0))
);

CREATE UNIQUE INDEX "clone_uploads_client_key" ON "fission_clone_uploads"("projectId", "workflowRunId", "clientUploadKey");
CREATE INDEX "clone_uploads_scope_status_idx" ON "fission_clone_uploads"("projectId", "workflowRunId", "status");
CREATE INDEX "clone_uploads_file_idx" ON "fission_clone_uploads"("projectId", "fileObjectId");
CREATE INDEX "clone_uploads_expiration_idx" ON "fission_clone_uploads"("status", "expiresAt");

ALTER TABLE "fission_clone_uploads" ADD CONSTRAINT "fission_clone_uploads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fission_clone_uploads" ADD CONSTRAINT "fission_clone_uploads_projectId_workflowRunId_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fission_clone_uploads" ADD CONSTRAINT "fission_clone_uploads_file_fkey" FOREIGN KEY ("projectId", "workflowRunId", "fileObjectId") REFERENCES "file_objects"("projectId", "workflowRunId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
