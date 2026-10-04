/**
 * The only place the API reads or writes the resources table.
 *
 * Its inputs are the schema's own inferred types and its outputs are the
 * schema's row type — no hand-written DTO sits between the contract and the
 * database. Handlers wear a thin coat over these methods, so a change in query
 * shape is reviewed in one file instead of scattered across routes.
 */
import { db } from "@app/db";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import {
  type ResourceChanges,
  type ResourceInput,
  type ResourceRow,
  resources,
} from "./resource.schema";

export interface ResourceListQuery {
  page: number;
  limit: number;
  status?: "draft" | "published" | "archived";
  ownerId?: number;
  search?: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

export class ResourceRepository {
  private visible(query: ResourceListQuery) {
    const conditions = [isNull(resources.deletedAt)];

    if (query.status) conditions.push(eq(resources.status, query.status));
    if (query.ownerId !== undefined) {
      conditions.push(eq(resources.ownerId, query.ownerId));
    }
    if (query.search) {
      conditions.push(ilike(resources.title, `%${query.search}%`));
    }

    return and(...conditions);
  }

  async list(query: ResourceListQuery): Promise<Page<ResourceRow>> {
    const offset = (query.page - 1) * query.limit;
    const where = this.visible(query);

    const [rows, counted] = await Promise.all([
      db
        .select()
        .from(resources)
        .where(where)
        .orderBy(desc(resources.createdAt))
        .limit(query.limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(resources)
        .where(where),
    ]);

    return {
      rows,
      total: counted[0]?.count ?? 0,
      limit: query.limit,
      offset,
    };
  }

  async findById(uuid: string): Promise<ResourceRow | undefined> {
    const [row] = await db
      .select()
      .from(resources)
      .where(and(eq(resources.uuid, uuid), isNull(resources.deletedAt)))
      .limit(1);

    return row;
  }

  async create(input: ResourceInput, ownerId: number): Promise<ResourceRow> {
    const [row] = await db
      .insert(resources)
      .values({ ...input, ownerId })
      .returning();

    return row;
  }

  async update(uuid: string, changes: ResourceChanges): Promise<ResourceRow> {
    const [row] = await db
      .update(resources)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(resources.uuid, uuid))
      .returning();

    return row;
  }

  async archive(uuid: string): Promise<void> {
    await db
      .update(resources)
      .set({ status: "archived", deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(resources.uuid, uuid));
  }
}

export const resourceRepository = new ResourceRepository();
