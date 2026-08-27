-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AuthUserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "LoginOutcome" AS ENUM ('SUCCESS', 'INVALID_CREDENTIALS', 'UNKNOWN_EMAIL', 'NOT_VERIFIED', 'ACCOUNT_LOCKED', 'ACCOUNT_INACTIVE');

-- CreateEnum
CREATE TYPE "RevokeReason" AS ENUM ('ROTATED', 'LOGOUT', 'LOGOUT_ALL', 'PASSWORD_CHANGED', 'REUSE_DETECTED');

-- CreateTable
CREATE TABLE "auth_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "AuthUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "user_id" TEXT,
    "pending_profile" JSONB,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "auth_user_id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "type" "VerificationType" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "new_email" VARCHAR(320),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "email_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_history" (
    "id" UUID NOT NULL,
    "auth_user_id" UUID,
    "email" VARCHAR(320) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "outcome" "LoginOutcome" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "auth_user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" "RevokeReason",
    "replaced_by_id" UUID,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_users_email_key" ON "auth_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_users_username_key" ON "auth_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "auth_users_user_id_key" ON "auth_users"("user_id");

-- CreateIndex
CREATE INDEX "auth_users_created_at_idx" ON "auth_users"("created_at");

-- CreateIndex
CREATE INDEX "auth_users_status_idx" ON "auth_users"("status");

-- CreateIndex
CREATE INDEX "verifications_auth_user_id_type_status_idx" ON "verifications"("auth_user_id", "type", "status");

-- CreateIndex
CREATE INDEX "verifications_status_expires_at_idx" ON "verifications"("status", "expires_at");

-- CreateIndex
CREATE INDEX "login_history_auth_user_id_login_at_idx" ON "login_history"("auth_user_id", "login_at");

-- CreateIndex
CREATE INDEX "login_history_email_login_at_idx" ON "login_history"("email", "login_at");

-- CreateIndex
CREATE INDEX "login_history_ip_login_at_idx" ON "login_history"("ip", "login_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_auth_user_id_revoked_at_idx" ON "refresh_tokens"("auth_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
