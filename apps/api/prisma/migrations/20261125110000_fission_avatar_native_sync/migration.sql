ALTER TABLE "fission_avatar_sync_tasks"
    DROP CONSTRAINT "avatar_sync_tasks_execution_kind_check",
    ADD CONSTRAINT "avatar_sync_tasks_execution_kind_check"
        CHECK ("executionKind" IN ('SHORT', 'SEGMENTED', 'NATIVE')),
    ADD COLUMN "nativeStarted" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "nativeTaskId" VARCHAR(160),
    ADD CONSTRAINT "avatar_sync_native_receipt_shape"
        CHECK (
            (NOT "nativeStarted" OR "executionKind" = 'NATIVE') AND
            ("nativeTaskId" IS NULL OR ("nativeStarted" AND "nativeTaskId" ~ '^cgt-[A-Za-z0-9_-]{1,120}$'))
        );

CREATE UNIQUE INDEX "avatar_sync_native_provider_key"
    ON "fission_avatar_sync_tasks" ("nativeTaskId");

ALTER TABLE "fission_avatar_asset_grants"
    ADD COLUMN "seedancePortraitAssetId" VARCHAR(160),
    ADD CONSTRAINT "avatar_asset_grant_seedance_portrait_shape"
        CHECK ("seedancePortraitAssetId" IS NULL OR "seedancePortraitAssetId" ~ '^asset-[A-Za-z0-9_-]{1,120}$');
