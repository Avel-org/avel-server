ALTER TABLE "intake" ADD COLUMN "consent_file_id" uuid;--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_consent_file_fk" FOREIGN KEY ("id","consent_file_id") REFERENCES "public"."intake_files"("intake_id","file_id") ON DELETE no action ON UPDATE no action;
