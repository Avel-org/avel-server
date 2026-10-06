CREATE TYPE "public"."activity_action" AS ENUM('client.created', 'client.updated', 'engagement.created', 'engagement.updated', 'engagement.closed', 'auth.signed_in');--> statement-breakpoint
CREATE TYPE "public"."activity_entity_type" AS ENUM('client', 'engagement', 'user');--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('operator', 'system', 'agent');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_user_id" uuid,
	"actor_roster_entry_id" uuid,
	"action" "activity_action" NOT NULL,
	"entity_type" "activity_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"mission_id" uuid,
	"engagement_id" uuid,
	"request_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "activity_log_operator_has_user" CHECK (("activity_log"."actor_kind" = 'operator') = ("activity_log"."actor_user_id" is not null)),
	CONSTRAINT "activity_log_agent_has_roster_entry" CHECK (("activity_log"."actor_kind" = 'agent') = ("activity_log"."actor_roster_entry_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_roster_entry_id_roster_entry_id_fk" FOREIGN KEY ("actor_roster_entry_id") REFERENCES "public"."roster_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_mission_id_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."mission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_entity_idx" ON "activity_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_log_mission_id_idx" ON "activity_log" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "activity_log_engagement_id_idx" ON "activity_log" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "activity_log_at_idx" ON "activity_log" USING btree ("at");