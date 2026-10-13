-- J raised the identity token cap from 800 to 1200 for both files
-- (2026-10-13). src/lib/identity.ts IDENTITY_TOKEN_CAP is the same number,
-- and tests/db/agent-identity-version.test.ts checks the two agree.
ALTER TABLE "agent_identity_version" DROP CONSTRAINT "agent_identity_version_identity_tokens_range";--> statement-breakpoint
ALTER TABLE "agent_identity_version" DROP CONSTRAINT "agent_identity_version_depth_tokens_range";--> statement-breakpoint
ALTER TABLE "agent_identity_version" ADD CONSTRAINT "agent_identity_version_identity_tokens_range" CHECK ("agent_identity_version"."identity_tokens" between 0 and 1200);--> statement-breakpoint
ALTER TABLE "agent_identity_version" ADD CONSTRAINT "agent_identity_version_depth_tokens_range" CHECK ("agent_identity_version"."depth_tokens" between 0 and 1200);