ALTER TABLE "fission_avatar_asset_grants"
    ADD COLUMN "seedanceSourceTaskId" VARCHAR(160),
    ADD CONSTRAINT "avatar_asset_grant_seedance_source_shape"
        CHECK ("seedanceSourceTaskId" IS NULL OR "seedanceSourceTaskId" ~ '^cgt-[A-Za-z0-9_-]{1,120}$');

ALTER TABLE "fission_avatar_sync_tasks"
    ADD COLUMN "continuityPlan" JSONB,
    ADD CONSTRAINT "avatar_sync_continuity_is_segmented"
        CHECK ("continuityPlan" IS NULL OR "executionKind" = 'SEGMENTED');

ALTER TABLE "fission_avatar_sync_segments"
    ADD COLUMN "pictureStarted" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "pictureTaskId" VARCHAR(160),
    ADD CONSTRAINT "avatar_sync_segment_picture_receipt_check"
        CHECK ("pictureTaskId" IS NULL OR ("pictureStarted" AND "pictureTaskId" ~ '^cgt-[A-Za-z0-9_-]{1,120}$'));

CREATE UNIQUE INDEX "avatar_sync_segment_picture_key" ON "fission_avatar_sync_segments"("pictureTaskId");
