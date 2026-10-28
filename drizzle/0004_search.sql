ALTER TABLE "notes" ADD COLUMN "search_vector" "tsvector";--> statement-breakpoint
UPDATE "notes" AS n
SET "search_vector" = CASE
	WHEN n."deleted_at" IS NULL THEN
		setweight(to_tsvector('simple', unaccent(coalesce(n."title", ''))), 'A') ||
		setweight(to_tsvector('simple', unaccent(coalesce(n."content_plain", ''))), 'B') ||
		setweight(to_tsvector('simple', unaccent(coalesce((
			SELECT string_agg(t."tag", ' ' ORDER BY t."tag")
			FROM "note_tags" AS t
			WHERE t."note_id" = n."id"
		), ''))), 'C')
	ELSE NULL
END;--> statement-breakpoint
CREATE INDEX "notes_search_vector_gin" ON "notes" USING gin ("search_vector");