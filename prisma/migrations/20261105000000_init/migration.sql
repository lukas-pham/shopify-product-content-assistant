-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_settings" (
    "shop_id" TEXT NOT NULL,
    "voice" TEXT NOT NULL DEFAULT 'Friendly, clear and concrete. Short sentences.',
    "audience" TEXT NOT NULL DEFAULT '',
    "bannedWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "language" TEXT NOT NULL DEFAULT 'en',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_gid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "vendor" TEXT NOT NULL DEFAULT '',
    "product_type" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "options" JSONB NOT NULL DEFAULT '[]',
    "description_html" TEXT NOT NULL DEFAULT '',
    "seo_title" TEXT,
    "seo_description" TEXT,
    "images" JSONB NOT NULL DEFAULT '[]',
    "score" INTEGER NOT NULL DEFAULT 0,
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scanned_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_jobs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "bulk_operation_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "object_count" INTEGER NOT NULL DEFAULT 0,
    "product_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "scan_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggestions" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_gid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fields" JSONB NOT NULL,
    "missing_info" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "prompt_version" TEXT NOT NULL,
    "error" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "batch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_versions" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_gid" TEXT NOT NULL,
    "suggestion_id" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" TIMESTAMP(3),

    CONSTRAINT "product_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_calls" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "prompt_id" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_shop_id_score_idx" ON "products"("shop_id", "score");

-- CreateIndex
CREATE UNIQUE INDEX "products_shop_id_product_gid_key" ON "products"("shop_id", "product_gid");

-- CreateIndex
CREATE INDEX "scan_jobs_shop_id_started_at_idx" ON "scan_jobs"("shop_id", "started_at");

-- CreateIndex
CREATE INDEX "suggestions_shop_id_status_idx" ON "suggestions"("shop_id", "status");

-- CreateIndex
CREATE INDEX "jobs_status_next_run_at_idx" ON "jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "jobs_shop_id_batch_id_idx" ON "jobs"("shop_id", "batch_id");

-- CreateIndex
CREATE INDEX "product_versions_shop_id_product_gid_idx" ON "product_versions"("shop_id", "product_gid");

-- CreateIndex
CREATE INDEX "ai_calls_shop_id_created_at_idx" ON "ai_calls"("shop_id", "created_at");

