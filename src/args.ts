/**
 * Command-line parsing, written by hand.
 *
 * The grammar is small — positionals, `--name=value`, `--name value`, bare
 * switches, and `--` to stop — and a parsing library would be a dependency and
 * a licence for thirty lines. More to the point, tool options are not known
 * until discovery has answered, so a parser that wants options declared up
 * front would have nothing to declare.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParsedArgs = {
  positionals: string[];
  /** Every value given for an option, in order; repeated options accumulate. */
  options: Map<string, string[]>;
};

/**
 * Options that never take a value. Without this list `--json clients` would
 * read "clients" as the value of --json rather than as the command.
 */
export const SWITCHES = new Set(["json", "help", "version"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const add = (name: string, value: string) => {
    options.set(name, [...(options.get(name) ?? []), value]);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h") {
      add("help", "true");
      continue;
    }
    if (!arg.startsWith("--") || arg.length === 2) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals > 0) {
      add(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (body.startsWith("no-") && !SWITCHES.has(body)) {
      // --no-flag is the conventional way to say false for a boolean input.
      add(body.slice(3), "false");
      continue;
    }

    const next = argv[index + 1];
    if (!SWITCHES.has(body) && next !== undefined && !next.startsWith("--")) {
      add(body, next);
      index += 1;
    } else {
      add(body, "true");
    }
  }

  return { positionals, options };
}

/** The last value given for an option, which is the one a person meant. */
export function option(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name)?.at(-1);
}

export function flag(args: ParsedArgs, name: string): boolean {
  const value = option(args, name);
  return value !== undefined && value !== "false";
}
