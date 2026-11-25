CREATE TABLE "fission_avatar_asset_grants" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "assetVersion" INTEGER NOT NULL,
    "evidenceReference" VARCHAR(240) NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "fission_avatar_asset_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fission_avatar_asset_grants_dates_check"
        CHECK (("expiresAt" IS NULL OR "expiresAt" > "grantedAt")
            AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")),
    CONSTRAINT "fission_avatar_asset_grants_evidence_check"
        CHECK (length(trim("evidenceReference")) > 0),
    CONSTRAINT "fission_avatar_asset_grants_version_fkey"
        FOREIGN KEY ("projectId", "assetId", "assetVersion")
        REFERENCES "asset_versions"("projectId", "assetId", "version")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "fission_avatar_asset_grants_project_version_idx"
    ON "fission_avatar_asset_grants"("projectId", "assetId", "assetVersion");

CREATE UNIQUE INDEX "fission_avatar_asset_grants_active_version_key"
    ON "fission_avatar_asset_grants"("projectId", "assetId", "assetVersion")
    WHERE "revokedAt" IS NULL;
