import type { LlmOperation } from "../ai/schemas.ts";
import type { OperationCandidate } from "../notes/operations.ts";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const tsvector = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return "tsvector";
  },
});

export interface NoteSnapshot {
  title: string;
  contentMd: string;
  category: string | null;
  tags: string[];
}

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seedKey: text("seed_key").unique(),
    title: text("title").notNull(),
    contentMd: text("content_md").notNull(),
    contentPlain: text("content_plain").notNull(),
    category: text("category"),
    searchVector: tsvector("search_vector"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check("notes_version_positive", sql`${table.version} >= 1`),
    index("notes_active_created_at_id_idx")
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null`),
    index("notes_deleted_at_idx").on(table.deletedAt),
    index("notes_search_vector_gin").using("gin", table.searchVector),
  ],
);

export const noteRevisions = pgTable(
  "note_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    noteVersion: integer("note_version").notNull(),
    reason: text("reason").notNull(),
    beforeSnapshot: jsonb("before_snapshot").$type<NoteSnapshot>().notNull(),
    afterSnapshot: jsonb("after_snapshot").$type<NoteSnapshot>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("note_revisions_note_version_positive", sql`${table.noteVersion} >= 1`),
    check(
      "note_revisions_reason_check",
      sql`${table.reason} in ('initial', 'manual', 'voice', 'ai', 'undo', 'restore', 'metadata')`,
    ),
    check(
      "note_revisions_before_snapshot_object",
      sql`jsonb_typeof(${table.beforeSnapshot}) = 'object'`,
    ),
    check(
      "note_revisions_after_snapshot_object",
      sql`jsonb_typeof(${table.afterSnapshot}) = 'object'`,
    ),
    uniqueIndex("note_revisions_note_version_unique").on(
      table.noteId,
      table.noteVersion,
    ),
    index("note_revisions_note_created_at_idx").on(
      table.noteId,
      table.createdAt.desc(),
    ),
  ],
);

export const noteTags = pgTable(
  "note_tags",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [
    primaryKey({
      name: "note_tags_pkey",
      columns: [table.noteId, table.tag],
    }),
    index("note_tags_tag_idx").on(table.tag),
  ],
);

export const noteChunks = pgTable(
  "note_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    noteVersion: integer("note_version").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    model: text("model").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("note_chunks_note_version_positive", sql`${table.noteVersion} >= 1`),
    check("note_chunks_chunk_index_nonnegative", sql`${table.chunkIndex} >= 0`),
    uniqueIndex("note_chunks_note_version_chunk_unique").on(
      table.noteId,
      table.noteVersion,
      table.chunkIndex,
    ),
    index("note_chunks_note_version_idx").on(table.noteId, table.noteVersion),
  ],
);

export const aiBudget = pgTable(
  "ai_budget",
  {
    id: integer("id").primaryKey().default(1),
    budgetUsd: numeric("budget_usd", {
      precision: 12,
      scale: 6,
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("ai_budget_single_row", sql`${table.id} = 1`),
    check("ai_budget_nonnegative", sql`${table.budgetUsd} >= 0`),
  ],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operation: text("operation").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(),
    reservedCostUsd: numeric("reserved_cost_usd", {
      precision: 12,
      scale: 6,
    }).notNull(),
    providerUsage: jsonb("provider_usage"),
    reportedCostUsd: numeric("reported_cost_usd", {
      precision: 12,
      scale: 6,
    }),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "ai_usage_status_check",
      sql`${table.status} in ('started', 'settled', 'unknown')`,
    ),
    check(
      "ai_usage_reserved_cost_nonnegative",
      sql`${table.reservedCostUsd} >= 0`,
    ),
    check(
      "ai_usage_reported_cost_nonnegative",
      sql`${table.reportedCostUsd} is null or ${table.reportedCostUsd} >= 0`,
    ),
    index("ai_usage_started_at_idx").on(table.startedAt.desc()),
    index("ai_usage_status_idx").on(table.status),
  ],
);

export const editProposals = pgTable(
  "edit_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    noteTitle: text("note_title").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    originalHash: text("original_hash").notNull(),
    operation: jsonb("operation").$type<LlmOperation>().notNull(),
    beforeMd: text("before_md").notNull(),
    afterMd: text("after_md").notNull(),
    selectedCandidate: jsonb("selected_candidate").$type<OperationCandidate | null>(),
    status: text("status").notNull().default("pending"),
    confirmationNonceHash: text("confirmation_nonce_hash").notNull(),
    confirmationNonceUsedAt: timestamp("confirmation_nonce_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "edit_proposals_expected_version_positive",
      sql`${table.expectedVersion} >= 1`,
    ),
    check(
      "edit_proposals_original_hash_hex",
      sql`${table.originalHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "edit_proposals_nonce_hash_hex",
      sql`${table.confirmationNonceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "edit_proposals_status_check",
      sql`${table.status} in ('pending', 'rejected', 'applied', 'expired')`,
    ),
    check(
      "edit_proposals_operation_object",
      sql`jsonb_typeof(${table.operation}) = 'object'`,
    ),
    check(
      "edit_proposals_selected_candidate_object",
      sql`${table.selectedCandidate} is null or jsonb_typeof(${table.selectedCandidate}) = 'object'`,
    ),
    index("edit_proposals_note_status_expires_idx").on(
      table.noteId,
      table.status,
      table.expiresAt,
    ),
    index("edit_proposals_status_expires_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const meetingSaves = pgTable(
  "meeting_saves",
  {
    requestId: uuid("request_id").primaryKey(),
    inputHash: text("input_hash").notNull(),
    noteIds: uuid("note_ids").array().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "meeting_saves_input_hash_hex",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
