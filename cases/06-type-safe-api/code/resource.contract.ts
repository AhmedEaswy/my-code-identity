/**
 * The API contract.
 *
 * Every procedure declares, in one place, the route it mounts at, the schema it
 * accepts, the schema it returns, and the handler. The router type at the
 * bottom is what the browser compiles against: `RouterClient<AppRouter>` turns
 * the handler signatures into a callable client, so a call the API would reject
 * is a compile error in the front end.
 */
import { os } from "@orpc/server";
import { z } from "zod/v4";
import type { ResourceRepository } from "./resource.repository";
import {
  resourceInsert,
  resourceSelect,
  resourceUpdate,
} from "./resource.schema";

export interface RequestContext {
  requestId: string;
  user: { id: number; role: "member" | "admin" };
  repositories: { resources: ResourceRepository };
}

const procedure = os.$context<RequestContext>();

const listResources = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  status: z.enum(["draft", "published", "archived"]).optional(),
  ownerId: z.number().int().positive().optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

/** The success envelope every single-item procedure returns. */
const success = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    meta: z.object({ requestId: z.string() }),
  });

/** The paged envelope every list procedure returns. */
const paged = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    meta: z.object({
      pagination: z.object({
        total: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
      }),
    }),
  });

export const resourceProcedures = {
  list: procedure
    .route({ method: "GET", path: "/resources", tags: ["resources"] })
    .input(listResources)
    .output(paged(resourceSelect))
    .handler(async ({ input, context }) => {
      const result = await context.repositories.resources.list(input);

      return {
        data: result.rows,
        meta: {
          pagination: {
            total: result.total,
            limit: result.limit,
            offset: result.offset,
          },
        },
      };
    }),

  get: procedure
    .route({ method: "GET", path: "/resources/{id}", tags: ["resources"] })
    .input(z.object({ id: z.uuid() }))
    .output(success(resourceSelect.nullable()))
    .handler(async ({ input, context }) => ({
      data: (await context.repositories.resources.findById(input.id)) ?? null,
      meta: { requestId: context.requestId },
    })),

  create: procedure
    .route({ method: "POST", path: "/resources", tags: ["resources"] })
    .input(resourceInsert)
    .output(success(resourceSelect))
    .handler(async ({ input, context }) => {
      const created = await context.repositories.resources.create(
        input,
        context.user.id,
      );

      return { data: created, meta: { requestId: context.requestId } };
    }),

  update: procedure
    .route({ method: "PATCH", path: "/resources/{id}", tags: ["resources"] })
    .input(resourceUpdate.extend({ id: z.uuid() }))
    .output(success(resourceSelect))
    .handler(async ({ input, context }) => {
      const { id, ...changes } = input;
      const updated = await context.repositories.resources.update(id, changes);

      return { data: updated, meta: { requestId: context.requestId } };
    }),

  archive: procedure
    .route({ method: "DELETE", path: "/resources/{id}", tags: ["resources"] })
    .input(z.object({ id: z.uuid() }))
    .output(z.object({ data: z.object({ archived: z.boolean() }) }))
    .handler(async ({ input, context }) => {
      await context.repositories.resources.archive(input.id);

      return { data: { archived: true } };
    }),
};

export const appRouter = { resources: resourceProcedures };

export type AppRouter = typeof appRouter;
