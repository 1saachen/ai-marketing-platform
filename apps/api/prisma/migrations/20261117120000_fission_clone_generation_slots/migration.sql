BEGIN;

ALTER TABLE "fission_clone_tasks"
  DROP CONSTRAINT "clone_tasks_generation_slot_check",
  ADD CONSTRAINT "clone_tasks_generation_slot_check" CHECK (
    ("generationParentId" IS NULL AND "generationSlot" IS NULL)
    OR ("operation" = 'GENERATE' AND "generationParentId" IS NOT NULL
      AND "generationSlot" IS NOT NULL AND "generationSlot" BETWEEN 1 AND 20)
  );

COMMIT;
