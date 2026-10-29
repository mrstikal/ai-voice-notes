CREATE TABLE "meeting_saves" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"input_hash" text NOT NULL,
	"note_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_saves_input_hash_hex" CHECK ("meeting_saves"."input_hash" ~ '^[0-9a-f]{64}$')
);
