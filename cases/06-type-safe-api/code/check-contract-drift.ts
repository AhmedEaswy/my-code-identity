#!/usr/bin/env bun
/**
 * Contract drift gate.
 *
 * Runs in CI between the two apps. It parses every front-end resource
 * declaration with the TypeScript compiler, converts the declared Zod schemas
 * to JSON Schema, loads the backend's OpenAPI document, and diffs the two. Any
 * finding — a required field the form has no control for, a bound the form
 * loosens, an enum that lost a member, a decimal sent as a number — exits 1 and
 * blocks the deploy.
 *
 * A regex over source would be shorter. It would also break on the first nested
 * object or `satisfies`; the AST is the same tree the build already trusts.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { z } from "zod/v4";
import { loadOpenApiDocument } from "./lib/openapi";

const root = path.resolve(import.meta.dir, "..");

interface Declaration {
  file: string;
  base: string;
  create?: string;
  update?: string;
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  for (const member of object.properties) {
    if (
      ts.isPropertyAssignment(member) &&
      member.name.getText().replaceAll('"', "") === name
    ) {
      return member.initializer;
    }
  }
}

function objectOf(expression?: ts.Expression) {
  return expression && ts.isObjectLiteralExpression(expression)
    ? expression
    : undefined;
}

function textOf(expression?: ts.Expression) {
  return expression &&
    (ts.isStringLiteral(expression) || ts.isIdentifier(expression))
    ? expression.text
    : undefined;
}

async function declarations(): Promise<Declaration[]> {
  const found: Declaration[] = [];
  const features = path.join(root, "src", "features");

  for (const entry of await readdir(features, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const file = path.join(features, entry.name, "resource.ts");
    if (!existsSync(file)) continue;

    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      // setParentNodes: getText() on a nested node needs the source map.
      true,
      ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText() === "defineResource"
      ) {
        const config = objectOf(node.initializer.arguments[0]);
        const paths = config && objectOf(property(config, "paths"));
        const schemas = config && objectOf(property(config, "schemas"));
        const base = paths && textOf(property(paths, "base"));

        if (base && schemas) {
          found.push({
            file,
            base,
            create: textOf(property(schemas, "create")),
            update: textOf(property(schemas, "update")),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return found;
}

/** Flatten every anyOf/oneOf/allOf branch so a constraint inside one is seen. */
function schemaNodes(schema: any): any[] {
  if (!schema || typeof schema !== "object") return [];
  const children = [schema.anyOf, schema.oneOf, schema.allOf]
    .filter(Array.isArray)
    .flat();

  return [schema, ...children.flatMap(schemaNodes)];
}

/** The strongest bound across branches: the largest min, the smallest max. */
function bound(schema: any, key: string, mode: "min" | "max"): number | undefined {
  const values = schemaNodes(schema)
    .map((node) => node[key])
    .filter((value): value is number => typeof value === "number");

  if (values.length === 0) return undefined;
  return mode === "min" ? Math.max(...values) : Math.min(...values);
}

/** Every value an enum admits, or undefined when a branch is unrestricted. */
function enumValues(schema: any): Set<unknown> | undefined {
  const leaves = schemaNodes(schema).filter(
    (node) => node.type !== "null" && !(node.anyOf || node.oneOf || node.allOf),
  );

  const values = new Set<unknown>();
  for (const node of leaves) {
    if (Array.isArray(node.enum)) {
      for (const value of node.enum) if (value !== null) values.add(value);
    } else if (node.const !== undefined) {
      values.add(node.const);
    } else {
      return undefined;
    }
  }

  return values.size > 0 ? values : undefined;
}

function patterns(schema: any): Set<string> {
  return new Set(
    schemaNodes(schema)
      .map((node) => node.pattern)
      .filter((value): value is string => typeof value === "string"),
  );
}

type Kind = "required" | "strict" | "bounds" | "format" | "enum" | "pattern" | "wire";
const findings: Array<{ kind: Kind; message: string }> = [];

const openapi: any = await loadOpenApiDocument();

for (const declaration of await declarations()) {
  const module: Record<string, z.ZodType> = await import(
    path.join(path.dirname(declaration.file), "schemas.ts")
  );

  for (const action of ["create", "update"] as const) {
    const symbol = declaration[action];
    if (!symbol || !module[symbol]) continue;

    const route = `/api/v1${declaration.base}${action === "create" ? "/" : "/{id}"}`;
    const operation =
      action === "create"
        ? openapi.paths[route]?.post
        : openapi.paths[route]?.patch;
    const backend = operation?.requestBody?.content?.["application/json"]?.schema;
    if (!backend) continue;

    const frontend: any = z.toJSONSchema(module[symbol], {
      unrepresentable: "any",
      // The contract is what the schema ACCEPTS, not what it EMITS: a
      // .default() must never make a field required of the caller. This is
      // exactly where "422 after submit" begins.
      io: "input",
    });

    const requiredFrontend = new Set(frontend.required ?? []);
    const requiredBackend = new Set(backend.required ?? []);

    for (const field of requiredBackend) {
      if (!requiredFrontend.has(field)) {
        findings.push({
          kind: "required",
          message: `${symbol}.${field}: required by the API`,
        });
      }
    }
    for (const field of requiredFrontend) {
      if (backend.properties?.[field as string] && !requiredBackend.has(field)) {
        findings.push({
          kind: "strict",
          message: `${symbol}.${field}: required by the form, optional in the API`,
        });
      }
    }

    for (const [field, backendField] of Object.entries<any>(
      backend.properties ?? {},
    )) {
      const frontendField = frontend.properties?.[field];
      if (!frontendField) continue;

      for (const [key, mode] of [
        ["minLength", "min"],
        ["minimum", "min"],
        ["maxLength", "max"],
        ["maximum", "max"],
      ] as const) {
        const expected = bound(backendField, key, mode);
        const actual = bound(frontendField, key, mode);

        if (
          expected !== undefined &&
          (actual === undefined ||
            (mode === "min" ? actual < expected : actual > expected))
        ) {
          findings.push({
            kind: "bounds",
            message: `${symbol}.${field}: ${key} weaker than the API (${expected})`,
          });
        }
      }

      const formats = new Set(
        schemaNodes(backendField)
          .map((node) => node.format)
          .filter((value): value is string => typeof value === "string"),
      );
      if (
        formats.size > 0 &&
        !schemaNodes(frontendField).some((node) => formats.has(node.format))
      ) {
        findings.push({
          kind: "format",
          message: `${symbol}.${field}: missing format ${[...formats].join("|")}`,
        });
      }

      const backendEnum = enumValues(backendField);
      if (backendEnum) {
        const frontendEnum = enumValues(frontendField);
        const missing = [...backendEnum].filter((value) => !frontendEnum?.has(value));
        const extra = frontendEnum
          ? [...frontendEnum].filter((value) => !backendEnum.has(value))
          : [];

        if (!frontendEnum || missing.length > 0 || extra.length > 0) {
          findings.push({
            kind: "enum",
            message: `${symbol}.${field}: enum differs`,
          });
        }
      }

      for (const pattern of patterns(backendField)) {
        if (!patterns(frontendField).has(pattern)) {
          findings.push({
            kind: "pattern",
            message: `${symbol}.${field}: missing pattern ${pattern}`,
          });
        }
      }

      // A numeric column arrives as a string. A form that sends a number is
      // refused only after the user submits — the drift that hurts most.
      if (backendField.type === "string" && frontendField.type === "number") {
        findings.push({
          kind: "wire",
          message: `${symbol}.${field}: send a string, not a number`,
        });
      }
    }
  }
}

const counts = findings.reduce<Record<string, number>>((tally, finding) => {
  tally[finding.kind] = (tally[finding.kind] ?? 0) + 1;
  return tally;
}, {});

console.log(
  `API contract drift: ${findings.length} finding(s)` +
    (findings.length > 0
      ? ` — ${Object.entries(counts)
          .map(([kind, count]) => `${count} ${kind}`)
          .join(", ")}`
      : ""),
);
for (const finding of findings) {
  console.log(`- [${finding.kind}] ${finding.message}`);
}

// Every kind is held at zero: a form that accepts what the API refuses is a 422
// the user meets after submitting, and one that refuses what the API accepts
// cannot save a valid record.
if (findings.length > 0) process.exit(1);
