BEGIN;

ALTER TABLE "fission_clone_tasks"
  DROP CONSTRAINT "clone_tasks_operation_check",
  ADD CONSTRAINT "clone_tasks_operation_check" CHECK (
    ("operation" IN ('ANALYZE', 'GENERATE') AND "purpose" IS NULL)
    OR ("operation" = 'MAP_SUGGEST' AND "purpose" IN ('SMART_MATCH', 'VALIDATE_KEEP_TEXT'))
  );

COMMIT;
