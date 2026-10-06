CREATE TYPE "public"."export_target_kind" AS ENUM('zip', 'github_pr', 'github_push');--> statement-breakpoint
CREATE TYPE "public"."connection_scope_type" AS ENUM('owner', 'repo');--> statement-breakpoint
CREATE TYPE "public"."connection_service" AS ENUM('github');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."skill_source_kind" AS ENUM('internal', 'vendor', 'community');--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service" "connection_service" NOT NULL,
	"label" text NOT NULL,
	"scope_type" "connection_scope_type" NOT NULL,
	"scope_value" text NOT NULL,
	"credential_ref" text NOT NULL,
	"status" "connection_status" NOT NULL,
	"engagement_id" uuid,
	"expires_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_url" text NOT NULL,
	"label" text,
	"allow_direct_push_to_default" boolean DEFAULT false NOT NULL,
	"default_target" "export_target_kind",
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "skill_source_kind" NOT NULL,
	"url" text,
	"license" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_engagement_id_idx" ON "connection" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_policy_repo_url_live_uq" ON "repo_policy" USING btree ("repo_url") WHERE "repo_policy"."deleted_at" is null;