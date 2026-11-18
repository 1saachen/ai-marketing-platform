BEGIN;

ALTER TABLE "fission_clone_tasks"
  ADD COLUMN "generationParentId" UUID,
  ADD COLUMN "generationSlot" INTEGER,
  DROP CONSTRAINT "clone_tasks_operation_check",
  ADD CONSTRAINT "clone_tasks_operation_check" CHECK (
    ("operation" IN ('ANALYZE', 'GENERATE', 'GENERATE_BATCH') AND "purpose" IS NULL)
    OR ("operation" = 'MAP_SUGGEST' AND "purpose" IN ('SMART_MATCH', 'VALIDATE_KEEP_TEXT'))
  ),
  ADD CONSTRAINT "clone_tasks_generation_slot_check" CHECK (
    ("generationParentId" IS NULL AND "generationSlot" IS NULL)
    OR ("operation" = 'GENERATE' AND "generationParentId" IS NOT NULL
      AND "generationSlot" IS NOT NULL AND "generationSlot" IN (1, 2))
  ),
  ADD CONSTRAINT "clone_tasks_generation_parent_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "generationParentId")
    REFERENCES "fission_clone_tasks"("projectId", "workflowRunId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "clone_tasks_generation_slot_key"
  ON "fission_clone_tasks" ("projectId", "workflowRunId", "generationParentId", "generationSlot");

COMMIT;
