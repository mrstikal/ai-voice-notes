CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"reserved_cost_usd" numeric(12, 6) NOT NULL,
	"provider_usage" jsonb,
	"reported_cost_usd" numeric(12, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_usage_status_check" CHECK ("ai_usage"."status" in ('started', 'settled', 'unknown')),
	CONSTRAINT "ai_usage_reserved_cost_nonnegative" CHECK ("ai_usage"."reserved_cost_usd" >= 0),
	CONSTRAINT "ai_usage_reported_cost_nonnegative" CHECK ("ai_usage"."reported_cost_usd" is null or "ai_usage"."reported_cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "note_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"note_version" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"model" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_chunks_note_version_positive" CHECK ("note_chunks"."note_version" >= 1),
	CONSTRAINT "note_chunks_chunk_index_nonnegative" CHECK ("note_chunks"."chunk_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "note_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"note_version" integer NOT NULL,
	"reason" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_revisions_note_version_positive" CHECK ("note_revisions"."note_version" >= 1),
	CONSTRAINT "note_revisions_reason_check" CHECK ("note_revisions"."reason" in ('initial', 'manual', 'voice', 'ai', 'undo', 'restore', 'metadata')),
	CONSTRAINT "note_revisions_before_snapshot_object" CHECK (jsonb_typeof("note_revisions"."before_snapshot") = 'object'),
	CONSTRAINT "note_revisions_after_snapshot_object" CHECK (jsonb_typeof("note_revisions"."after_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "note_tags" (
	"note_id" uuid NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "note_tags_pkey" PRIMARY KEY("note_id","tag")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed_key" text,
	"title" text NOT NULL,
	"content_md" text NOT NULL,
	"content_plain" text NOT NULL,
	"category" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notes_seed_key_unique" UNIQUE("seed_key"),
	CONSTRAINT "notes_version_positive" CHECK ("notes"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "note_chunks" ADD CONSTRAINT "note_chunks_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_tags" ADD CONSTRAINT "note_tags_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_started_at_idx" ON "ai_usage" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_usage_status_idx" ON "ai_usage" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "note_chunks_note_version_chunk_unique" ON "note_chunks" USING btree ("note_id","note_version","chunk_index");--> statement-breakpoint
CREATE INDEX "note_chunks_note_version_idx" ON "note_chunks" USING btree ("note_id","note_version");--> statement-breakpoint
CREATE UNIQUE INDEX "note_revisions_note_version_unique" ON "note_revisions" USING btree ("note_id","note_version");--> statement-breakpoint
CREATE INDEX "note_revisions_note_created_at_idx" ON "note_revisions" USING btree ("note_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "note_tags_tag_idx" ON "note_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "notes_active_created_at_id_idx" ON "notes" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "notes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "notes_deleted_at_idx" ON "notes" USING btree ("deleted_at");