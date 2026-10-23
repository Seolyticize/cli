import { UsageError } from "./args.js";

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Schema)
    : {};
}

/** client-id → clientId, so options can be typed the way shells are typed. */
export function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** The JSON types a schema admits, flattening anyOf/oneOf and type arrays. */
function typesOf(schema: Schema): Set<string> {
  const types = new Set<string>();
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) {
    for (const member of union)
      for (const type of typesOf(asSchema(member))) types.add(type);
  }
  const type = schema["type"];
  if (typeof type === "string") types.add(type);
  if (Array.isArray(type)) for (const member of type) types.add(String(member));
  if (Array.isArray(schema["enum"])) {
    for (const value of schema["enum"] as unknown[]) {
      types.add(value === null ? "null" : typeof value);
    }
  }
  return types;
}

/** The array member of a union, so `string[] | null` still splits on commas. */
function arraySchema(schema: Schema): Schema | null {
  if (schema["type"] === "array") return schema;
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) {
    for (const member of union) {
      const found = arraySchema(asSchema(member));
      if (found) return found;
    }
  }
  return null;
}

function coerceScalar(name: string, raw: string, schema: Schema): unknown {
  const types = typesOf(schema);
  if (types.has("null") && raw === "null") return null;
  if (types.has("integer") || types.has("number")) {
    const value = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(value)) {
      if (types.has("integer") && !types.has("number") && !Number.isInteger(value)) {
        throw new UsageError(`--${name} must be a whole number, not ${raw}.`);
      }
      return value;
    }
    if (!types.has("string"))
      throw new UsageError(`--${name} must be a number, not ${raw}.`);
  }
  if (types.has("boolean")) {
    if (raw === "true" || raw === "") return true;
    if (raw === "false") return false;
    if (!types.has("string")) throw new UsageError(`--${name} must be true or false.`);
  }
  if (types.has("object") || (types.has("array") && raw.trimStart().startsWith("["))) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`--${name} must be JSON.`);
    }
  }
  return raw;
}

/**
 * Turns `--flag=value` options into a tool input, using the tool's own schema
 * to decide what each value means.
 *
 * Typed by schema rather than by guessing from the text: "007" is a string
 * where the schema says string, and a number only where it says number. The
 * server validates again — this only spares a round trip for an obvious
 * mistake, and gives arrays a shell-friendly spelling (repeat the option, or
 * separate with commas).
 */
export function coerceFlags(
  schema: Record<string, unknown>,
  options: Map<string, string[]>,
  reserved: ReadonlySet<string>,
): Record<string, unknown> {
  const properties = asSchema(schema["properties"]);
  const input: Record<string, unknown> = {};

  for (const [rawName, values] of options) {
    if (reserved.has(rawName)) continue;
    const name = rawName in properties ? rawName : camelCase(rawName);
    if (!(name in properties)) {
      const known = Object.keys(properties);
      throw new UsageError(
        `This tool has no --${rawName} option.${
          known.length > 0
            ? ` It takes: ${known.map((key) => `--${key}`).join(", ")}.`
            : ""
        }`,
      );
    }
    const property = asSchema(properties[name]);
    const array = arraySchema(property);
    if (array) {
      const items = asSchema(array["items"]);
      const first = values[0] ?? "";
      if (values.length === 1 && first.trimStart().startsWith("[")) {
        input[name] = coerceScalar(rawName, first, { type: "array" });
      } else {
        input[name] = values
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) => coerceScalar(rawName, value, items));
      }
      continue;
    }
    input[name] = coerceScalar(rawName, values.at(-1) ?? "", property);
  }

  return input;
}
