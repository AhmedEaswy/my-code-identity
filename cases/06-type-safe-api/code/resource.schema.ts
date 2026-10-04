/**
 * The one description of a resource.
 *
 * The table, the row types, and the Zod schemas the API validates against are
 * all derived here. Adding a column changes the database, the contract, the
 * repository's return type, and the browser's inferred types in a single edit —
 * which is the point: there is no second definition to forget.
 */
import {
  bigint,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod/v4";
import { users } from "./user.schema";

const tableName = "resources";

export const resources = pgTable(
  tableName,
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    uuid: text("uuid")
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary"),
    status: text("status").notNull().default("draft"),
    // A numeric column is a *string* on the wire; drizzle-zod types it as
    // z.string(), and the drift gate fails a form that sends a number.
    price: numeric("price", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    currency: text("currency").notNull().default("USD"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index(`${tableName}_owner_id_idx`).on(table.ownerId),
    index(`${tableName}_status_idx`).on(table.status),
    unique(`${tableName}_slug_unique`).on(table.slug, table.deletedAt),
  ],
);

export type ResourceRow = typeof resources.$inferSelect;
export type NewResourceRow = typeof resources.$inferInsert;

// The read model crosses the wire whole; the client decodes it against this
// same schema, so a column added here is immediately a typed field in the UI.
export const resourceSelect = createSelectSchema(resources);

// The write models are narrowed to what a client may send. Server-owned
// columns (ids, owner, timestamps) are omitted *in the schema*, not filtered in
// the handler, so the contract cannot accept them by accident.
export const resourceInsert = createInsertSchema(resources, {
  title: (schema) => schema.min(3).max(160),
  slug: (schema) => schema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  summary: (schema) => schema.max(2000),
}).omit({
  id: true,
  uuid: true,
  ownerId: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

export const resourceUpdate = createUpdateSchema(resources, {
  title: (schema) => schema.min(3).max(160),
  slug: (schema) => schema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  summary: (schema) => schema.max(2000),
}).omit({
  id: true,
  uuid: true,
  ownerId: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

export type ResourceInput = z.input<typeof resourceInsert>;
export type ResourceChanges = z.input<typeof resourceUpdate>;
