/**
 * The browser's half of the contract.
 *
 * One factory binds a resource declaration to typed calls; one transport
 * normalises the backend envelope and revalidates with ETags. Every generic is
 * inferred from the declaration's Zod schemas, so no screen names a wire type
 * by hand. The `defineResource(...)` call at the bottom is the anchor the CI
 * drift gate walks the AST for.
 */
import { z } from "zod/v4";
import {
  resourceInsert,
  resourceSelect,
  resourceUpdate,
} from "./resource.schema";

const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A response that does not match its schema is a contract breach, not a UI bug. */
function decode<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  throw new ApiError(422, "schema_mismatch", z.prettifyError(result.error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** { success, data, meta } -> data. Anything else is passed through untouched. */
function unwrapEnvelope(body: unknown): unknown {
  if (isRecord(body) && body.success === true && "data" in body) return body.data;
  return body;
}

/**
 * Lists leave the backend as `data: [...]` on the generic route and as
 * `data: { rows, meta }` on paged actions, while the UI contracts use
 * `{ rows, items, total }`. Translate once here so no screen learns the wire
 * shape — and preserve non-envelopes rather than rewriting them to `undefined`.
 */
export function normalizeListEnvelope(value: unknown): unknown {
  const paged = pagedActionRows(value);
  if (paged !== null) return paged;

  if (!isRecord(value) || value.success !== true || !Array.isArray(value.data)) {
    return value;
  }

  const total =
    isRecord(value.meta) &&
    isRecord(value.meta.pagination) &&
    typeof value.meta.pagination.total === "number"
      ? value.meta.pagination.total
      : value.data.length;

  return { rows: value.data, items: value.data, total };
}

function pagedActionRows(value: unknown): unknown {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    return null;
  }

  const rows = value.data.rows;
  if (!Array.isArray(rows)) return null;

  const meta = value.data.meta;
  const total =
    isRecord(meta) && typeof meta.total === "number" ? meta.total : rows.length;

  return { rows, items: rows, total };
}

/**
 * Conditional GET, in memory.
 *
 * Authenticated answers are `Cache-Control: private, no-store`, so the
 * browser's cache can never hold them and can never revalidate. This map
 * recreates that revalidation one level up. The key carries a cheap hash of the
 * credential, because one process answers every caller and two of them must
 * never share an entry.
 */
const ETAG_CACHE_MAX = 256;
const etagCache = new Map<string, { etag: string; body: string }>();

function credentialFingerprint(token: string | null): string {
  if (token === null) return "anonymous";

  let hash = 0;
  for (let index = 0; index < token.length; index++) {
    hash = (hash * 31 + token.charCodeAt(index)) | 0;
  }

  return String(hash);
}

interface RequestOptions {
  body?: unknown;
  token?: string | null;
  normalize?: (value: unknown) => unknown;
}

async function request<S extends z.ZodType>(
  method: string,
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  const token = options.token ?? null;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  const key =
    method === "GET" ? `${credentialFingerprint(token)} ${path}` : null;
  const cached = key === null ? undefined : etagCache.get(key);
  if (cached !== undefined) headers["If-None-Match"] = cached.etag;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE}${path}`, { method, headers, body });

  // 304 carries no body: the bytes the ETag named are the ones we already hold.
  const text =
    response.status === 304 && cached !== undefined
      ? cached.body
      : await response.text();

  if (!response.ok && !(response.status === 304 && cached !== undefined)) {
    throw toApiError(response.status, text);
  }

  if (method === "GET" && key !== null && response.status === 200) {
    const etag = response.headers.get("etag");
    if (etag !== null) {
      etagCache.delete(key);
      etagCache.set(key, { etag, body: text });
      if (etagCache.size > ETAG_CACHE_MAX) {
        etagCache.delete(etagCache.keys().next().value as string);
      }
    }
  }

  if (text.length === 0) return undefined as z.output<S>;

  const parsed: unknown = JSON.parse(text);
  const shaped = options.normalize ? options.normalize(parsed) : parsed;

  return decode(schema, unwrapEnvelope(shaped));
}

function toApiError(status: number, text: string): ApiError {
  let code = `http_${status}`;
  let message = code;
  let requestId: string | null = null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      if (typeof parsed.error.code === "string") code = parsed.error.code;
      if (typeof parsed.error.message === "string") message = parsed.error.message;
    }
    if (
      isRecord(parsed) &&
      isRecord(parsed.meta) &&
      typeof parsed.meta.requestId === "string"
    ) {
      requestId = parsed.meta.requestId;
    }
  } catch {
    message = text;
  }

  return new ApiError(status, code, message, requestId);
}

export function substituteId(path: string, id: string): string {
  return path.replace(/\{[^}]*\}/g, () => encodeURIComponent(id));
}

function withQuery(path: string, params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }

  return parts.length > 0 ? `${path}?${parts.join("&")}` : path;
}

export interface ResourceDeclaration<List, Item, Create, Update> {
  resource: string;
  paths: { base: string; detail?: string };
  schemas: {
    list: z.ZodType<List>;
    item: z.ZodType<Item>;
    create: z.ZodType<Create>;
    update: z.ZodType<Update>;
  };
}

/**
 * Bind a declaration to typed calls. The shape is deliberately literal —
 * `paths.base` and `schemas.create` are string-valued members, not computed
 * expressions — because the CI gate reads exactly those keys off the AST.
 */
export function defineResource<List, Item, Create, Update>(
  declaration: ResourceDeclaration<List, Item, Create, Update>,
  token: string | null = null,
) {
  const detail = declaration.paths.detail ?? `${declaration.paths.base}/{id}`;

  return {
    list: (params: Record<string, unknown> = {}) =>
      request("GET", withQuery(declaration.paths.base, params), declaration.schemas.list, {
        token,
        normalize: normalizeListEnvelope,
      }),
    get: (id: string) =>
      request("GET", substituteId(detail, id), declaration.schemas.item, { token }),
    create: (input: Create) =>
      request("POST", declaration.paths.base, declaration.schemas.item, {
        token,
        body: decode(declaration.schemas.create, input),
      }),
    update: (id: string, input: Update) =>
      request("PATCH", substituteId(detail, id), declaration.schemas.item, {
        token,
        body: decode(declaration.schemas.update, input),
      }),
  };
}

// In the real tree this lives at src/features/resources/resource.ts and the CI
// gate walks src/features/**; shown here so the declaration and its consumer
// read together.
export const resourceClient = defineResource({
  resource: "resources",
  paths: { base: "/resources" },
  schemas: {
    list: resourceSelect,
    item: resourceSelect,
    create: resourceInsert,
    update: resourceUpdate,
  },
});
