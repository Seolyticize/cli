/**
 * Human output. Scripts should pass --json and read that instead: the table
 * is for eyes, and its column widths and truncation are free to change.
 */

const MAX_CELL = 60;

function cell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else text = JSON.stringify(value);
  text = text.replaceAll(/\s+/g, " ");
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Left-aligned columns, upper-case headers, every column as wide as its widest cell. */
export function formatTable(
  rows: Array<Record<string, unknown>>,
  columns?: readonly string[],
): string {
  const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (keys.length === 0) return "";
  const grid = [
    keys.map((key) => key.toUpperCase()),
    ...rows.map((row) => keys.map((key) => cell(row[key]))),
  ];
  const widths = keys.map((_key, column) =>
    Math.max(...grid.map((line) => line[column]!.length)),
  );
  return grid
    .map((line) =>
      line
        .map((text, column) => text.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function isTable(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

/**
 * A tool result as a person would want to read it.
 *
 * Most tools answer `{ things: [...] }`, so a result whose only list is a list
 * of records is shown as that table, with any other scalar fields above it.
 * Anything else is printed as indented JSON, which is at least honest about
 * its shape.
 */
export function formatResult(data: unknown): string {
  if (isTable(data)) return formatTable(data);
  if (Array.isArray(data) && data.length === 0) return "(none)";
  if (isRecord(data)) {
    const entries = Object.entries(data);
    const lists = entries.filter(([, value]) => Array.isArray(value));
    const scalars = entries.filter(
      ([, value]) => !Array.isArray(value) && !isRecord(value),
    );
    const nested = entries.filter(([, value]) => isRecord(value));
    if (lists.length === 1 && nested.length === 0) {
      const [name, list] = lists[0]!;
      const header = scalars.map(([key, value]) => `${key}: ${cell(value)}`).join("\n");
      const body = isTable(list)
        ? formatTable(list)
        : (list as unknown[]).length === 0
          ? "(none)"
          : (list as unknown[]).map(cell).join("\n");
      return [header, `${name}:`, body].filter((part) => part.length > 0).join("\n");
    }
    if (lists.length === 0 && nested.length === 0) {
      return formatTable(
        entries.map(([key, value]) => ({ field: key, value })),
        ["field", "value"],
      );
    }
  }
  return JSON.stringify(data, null, 2);
}
