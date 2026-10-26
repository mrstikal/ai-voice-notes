CREATE TABLE "ai_budget" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"budget_usd" numeric(12, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_budget_single_row" CHECK ("ai_budget"."id" = 1),
	CONSTRAINT "ai_budget_nonnegative" CHECK ("ai_budget"."budget_usd" >= 0)
);
--> statement-breakpoint
INSERT INTO "ai_budget" ("id", "budget_usd") VALUES (1, 2.000000) ON CONFLICT ("id") DO NOTHING;
