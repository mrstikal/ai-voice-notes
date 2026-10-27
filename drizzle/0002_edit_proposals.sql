CREATE TABLE "edit_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"note_title" text NOT NULL,
	"expected_version" integer NOT NULL,
	"original_hash" text NOT NULL,
	"operation" jsonb NOT NULL,
	"before_md" text NOT NULL,
	"after_md" text NOT NULL,
	"selected_candidate" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmation_nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_proposals_expected_version_positive" CHECK ("edit_proposals"."expected_version" >= 1),
	CONSTRAINT "edit_proposals_original_hash_hex" CHECK ("edit_proposals"."original_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "edit_proposals_nonce_hash_hex" CHECK ("edit_proposals"."confirmation_nonce_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "edit_proposals_status_check" CHECK ("edit_proposals"."status" in ('pending', 'rejected', 'applied', 'expired')),
	CONSTRAINT "edit_proposals_operation_object" CHECK (jsonb_typeof("edit_proposals"."operation") = 'object'),
	CONSTRAINT "edit_proposals_selected_candidate_object" CHECK ("edit_proposals"."selected_candidate" is null or jsonb_typeof("edit_proposals"."selected_candidate") = 'object')
);
--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_proposals_note_status_expires_idx" ON "edit_proposals" USING btree ("note_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "edit_proposals_status_expires_idx" ON "edit_proposals" USING btree ("status","expires_at");