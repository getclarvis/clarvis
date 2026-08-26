import { describe, expect, test } from "bun:test";
import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import { WORKFLOW_RESULT_SCHEMAS, type WorkflowResultSchema } from "../../src/schemas.ts";

const entries = Object.entries(WORKFLOW_RESULT_SCHEMAS);

function propertiesOf(schema: WorkflowResultSchema): Record<string, unknown> {
  const properties = schema.properties;
  expect(typeof properties).toBe("object");
  return properties as Record<string, unknown>;
}

function schemaNodes(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(schemaNodes);
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(schemaNodes)];
}

describe("the shipped leader-result schemas", () => {
  test("every round the manager runs has a schema to reuse", () => {
    expect(Object.keys(WORKFLOW_RESULT_SCHEMAS).sort()).toEqual([
      "discovery",
      "findings",
      "verdict",
    ]);
  });

  test.each(entries)(
    "'%s' describes an object, which is what the loop requires of an output_schema",
    (_name, schema) => {
      expect(schema.type).toBe("object");
    },
  );

  test.each(entries)("'%s' survives the trip through JSON to a leader run", (_name, schema) => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  test.each(entries)("'%s' closes the object so a leader cannot pad it", (_name, schema) => {
    expect(schema.additionalProperties).toBe(false);
  });

  test.each(entries)("'%s' requires only fields it actually declares", (_name, schema) => {
    const properties = propertiesOf(schema);
    for (const name of schema.required as string[]) {
      expect(Object.keys(properties)).toContain(name);
    }
  });

  test.each(entries)("'%s' makes the leader cite evidence, not just assert", (_name, schema) => {
    expect(JSON.stringify(schema)).toContain("evidence");
  });

  test.each(entries)("'%s' hard-bounds every array and string payload", (_name, schema) => {
    for (const node of schemaNodes(schema)) {
      if (node.type === "array") {
        expect(typeof node.maxItems).toBe("number");
        expect(node.maxItems as number).toBeLessThanOrEqual(WORKFLOW_LIMITS.workItems);
      }
      if (node.type === "string") {
        expect(typeof node.maxLength).toBe("number");
        expect(node.maxLength as number).toBeLessThanOrEqual(WORKFLOW_LIMITS.textChars);
      }
    }
  });
});
