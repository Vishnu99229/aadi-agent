import type { JsonSchema } from "./types.js";

/**
 * Checks a value against the JSON Schema subset the tool definitions use: type,
 * properties, required, items and enum. Small on purpose: the phone doesn't need
 * a schema library for this.
 */
export function validateSchema(
  value: unknown,
  schema: JsonSchema | undefined,
  path = "input",
): string[] {
  if (!schema) {
    return [];
  }
  const problems: string[] = [];
  check(value, schema, path, problems);
  return problems;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function check(value: unknown, schema: JsonSchema, path: string, problems: string[]): void {
  if (problems.length >= 8) {
    return;
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    problems.push(`${path} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
    return;
  }
  const actual = typeOf(value);
  switch (schema.type) {
    case undefined:
      return;
    case "integer":
      if (actual !== "number" || !Number.isInteger(value)) {
        problems.push(`${path} must be an integer`);
      }
      return;
    case "number":
      if (actual !== "number" || !Number.isFinite(value)) {
        problems.push(`${path} must be a number`);
      }
      return;
    case "string":
    case "boolean":
    case "null":
      if (actual !== schema.type) {
        problems.push(`${path} must be a ${schema.type}`);
      }
      return;
    case "array": {
      if (actual !== "array") {
        problems.push(`${path} must be an array`);
        return;
      }
      if (schema.items) {
        (value as unknown[]).forEach((item, index) =>
          check(item, schema.items!, `${path}[${index}]`, problems),
        );
      }
      return;
    }
    case "object": {
      if (actual !== "object") {
        problems.push(`${path} must be an object`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined || record[key] === null) {
          problems.push(`${path}.${key} is required`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (record[key] !== undefined && record[key] !== null) {
          check(record[key], child, `${path}.${key}`, problems);
        }
      }
      if (schema.additionalProperties === false) {
        const known = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(record)) {
          if (!known.has(key)) {
            problems.push(`${path}.${key} is not allowed`);
          }
        }
      }
      return;
    }
  }
}
