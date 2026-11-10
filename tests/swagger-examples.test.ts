import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import * as A from "../src/lib/schemas.ts";
import * as B from "../src/lib/schemasCp4.ts";

const spec = JSON.parse(readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { example?: unknown; examples?: Record<string, { value: unknown }> }> }> }>>;
};

function examplesOf(path: string, method: string, status: string): Array<[string, unknown]> {
  const content = spec.paths[path]?.[method]?.responses?.[status]?.content?.["application/json"];
  if (!content) return [];
  const out: Array<[string, unknown]> = [];
  if (content.example !== undefined) out.push(["example", content.example]);
  for (const [name, entry] of Object.entries(content.examples ?? {})) out.push([name, entry.value]);
  return out;
}

const cases: Array<[string, string, string, z.ZodType]> = [
  ["/files", "get", "200", A.FilePageSchema],
  ["/files/{id}", "get", "200", A.DataFileSchema],
  ["/files/{id}/rules", "get", "200", A.RulesSchema],
  ["/files/{id}/tiles/{tileRow}/{tileCol}", "get", "200", A.TileSchema],
  ["/files/{id}/refinements", "post", "201", A.RefineResultSchema],
  ["/clearance", "get", "200", A.ClearanceSchema],
  ["/clearance/check", "post", "200", A.ClearanceCheckResultSchema],
  ["/integrations/status", "get", "200", A.IntegrationStatusSchema],
  ["/refiners", "get", "200", B.RefinerPageSchema],
  ["/refiners/{id}", "get", "200", B.RefinerSchema],
  ["/refiners/{id}", "patch", "200", B.RefinerSchema],
  ["/departments", "get", "200", z.array(B.DepartmentSchema)],
  ["/media/tickets", "post", "201", B.MediaTicketSchema],
  ["/media/tickets/{id}/confirm", "post", "201", B.MediaSchema],
  ["/incidents", "get", "200", B.IncidentPageSchema],
  ["/incidents", "post", "201", B.IncidentSchema],
  ["/events/tickets", "post", "201", B.TicketSchema],
  ["/floor/tickets", "post", "201", B.TicketSchema],
];

for (const [path, method, status, schema] of cases) {
  test(`${method.toUpperCase()} ${path} -> ${status} valida contra los ejemplos de Swagger`, () => {
    const examples = examplesOf(path, method, status);
    assert.ok(examples.length > 0, "Swagger no trae ejemplo para esta respuesta");
    for (const [name, value] of examples) {
      const parsed = schema.safeParse(value);
      assert.ok(parsed.success, `${name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 2))}`);
    }
  });
}
