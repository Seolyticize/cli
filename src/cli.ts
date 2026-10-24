import { runMcpBridge } from "./mcpBridge.js";
import {
  AuthenticationError,
  DEFAULT_BASE_URL,
  NotFoundError,
  createClient as createSdkClient,
  type ClientOptions,
  type Discovery,
  type SeolyticizeClient,
  type ToolDescriptor,
} from "@seolyticize/sdk";
import { UsageError, flag, option, parseArgs, type ParsedArgs } from "./args.js";
import { coerceFlags } from "./coerce.js";
import {
  configPath,
  deleteConfig,
  maskKey,
  readConfig,
  resolveCredentials,
  writeConfig,
  type ConfigEnv,
} from "./config.js";
import { EXIT, EXIT_HELP, exitCodeFor } from "./exitCodes.js";
import { formatResult, formatTable } from "./format.js";

export const CLI_VERSION = "0.2.0";

/**
 * Everything the CLI touches outside itself, passed in.
 *
 * The real process supplies these in index.ts; tests supply fakes, so every
 * command — login writing a 0600 file, a call failing with a 403 — is
 * exercised without a terminal, a home directory or a network.
 */
export type CliIo = {
  stdout(text: string): void;
  stderr(text: string): void;
  /** The whole of stdin, for `login` piped a key and `--file -`. */
  readStdin(): Promise<string>;
  /** Asks for a secret without echoing it. */
  promptSecret(question: string): Promise<string>;
  stdinIsTty: boolean;
  readFile(path: string): Promise<string>;
  env: ConfigEnv;
  home: string;
  createClient?: (options: ClientOptions) => SeolyticizeClient;
  /** stdin as lines, for `seolyticize mcp`. */
  stdinLines?: () => AsyncIterable<string>;
  now?: () => Date;
};

export const USAGE = `seolyticize — every Seolyticize tool from a terminal or a script.

Usage:
  seolyticize login [--key <key>] [--base-url <url>]   store a key (reads stdin if piped)
  seolyticize logout                                   forget the stored key
  seolyticize whoami                                   show the key's role and reach
  seolyticize tools                                    list the tools this key may call
  seolyticize describe <tool>                          show a tool's options
  seolyticize call <tool> [--input <json> | --file <path|-> ] [--<option>=<value> ...]
  seolyticize <tool> [--<option>=<value> ...]          same as call
  seolyticize mcp [--group <group>]                    the hosted MCP server over stdio, for
                                                      clients that only launch a command

Shortcuts:
  seolyticize clients                                  list_clients
  seolyticize find "<task>"                            find_tools: the tools for a task
  seolyticize recipe [<name>] --client <client>        get_recipe: a named plan of calls
  seolyticize wait <kind:id> --client <client>         wait_for_job (crawl:<id>, rank:<id>…)
  seolyticize rank <trackerId> --client <clientId>     get_rank_summary
  seolyticize alerts --client <clientId> [--since <iso>]
                                                      list_recent_alerts (default: last 7 days)

Options:
  --json        print the raw result as JSON (use this in scripts)
  --base-url    API origin (default ${DEFAULT_BASE_URL})
  -h, --help    show this help
  --version     show the version

Tool options are read from the tool's own schema: arrays take repeated options or
commas (--domains=a.com,b.com), objects take JSON, and --client-id is the same as
--clientId. --client takes a client's id or its name (--client numestri). The
common names work on every tool: --target, --market us-en, --country US, --days.
Tools are discovered at runtime, so new ones work without upgrading.

Environment:
  SEOLYTICIZE_API_KEY    key to use instead of the stored one
  SEOLYTICIZE_BASE_URL   API origin to use instead of the stored one

${EXIT_HELP}
`;

/** Options the CLI itself consumes; never forwarded to a tool. */
const RESERVED = new Set([
  "json",
  "input",
  "file",
  "base-url",
  "help",
  "version",
  "key",
  "group",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function print(io: CliIo, args: ParsedArgs, data: unknown, human: () => string): void {
  io.stdout(`${flag(args, "json") ? JSON.stringify(data, null, 2) : human()}\n`);
}

function scopeOf(caller: Discovery["caller"]): string {
  return caller.clientIds === "all"
    ? "agency-wide"
    : `client ${caller.clientIds.join(", ")}`;
}

function typeLabel(schema: Record<string, unknown>): string {
  if (Array.isArray(schema["enum"])) {
    return (schema["enum"] as unknown[]).map((value) => JSON.stringify(value)).join("|");
  }
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) {
    return union.map((member) => typeLabel(member as Record<string, unknown>)).join("|");
  }
  if (schema["type"] === "array") {
    const items = schema["items"];
    return `${typeof items === "object" && items !== null ? typeLabel(items as Record<string, unknown>) : "any"}[]`;
  }
  if (Array.isArray(schema["type"])) return (schema["type"] as string[]).join("|");
  return typeof schema["type"] === "string" ? schema["type"] : "any";
}

/** The tool's options as rows, so `describe` can be read rather than parsed. */
export function optionRows(tool: ToolDescriptor): Array<Record<string, unknown>> {
  const properties = (tool.inputSchema["properties"] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((tool.inputSchema["required"] ?? []) as string[]);
  return Object.entries(properties).map(([name, schema]) => ({
    option: `--${name}`,
    type: typeLabel(schema),
    required: required.has(name) ? "yes" : "",
    default: schema["default"] === undefined ? "" : JSON.stringify(schema["default"]),
  }));
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  const [command, ...rest] = args.positionals;

  try {
    if (flag(args, "version")) {
      io.stdout(`${CLI_VERSION}\n`);
      return EXIT.ok;
    }
    if (command === undefined || command === "help" || flag(args, "help")) {
      io.stdout(USAGE);
      return command === undefined && !flag(args, "help") ? EXIT.usage : EXIT.ok;
    }

    const stored = await readConfig(io.env, io.home);
    const credentials = resolveCredentials(io.env, stored);
    const baseUrl = option(args, "base-url") ?? credentials.baseUrl;
    const build = io.createClient ?? createSdkClient;

    const connect = (apiKey = credentials.apiKey): SeolyticizeClient => {
      if (!apiKey) {
        throw new AuthenticationError(
          "Not logged in. Run `seolyticize login` or set SEOLYTICIZE_API_KEY.",
          { status: null },
        );
      }
      return build({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    };

    let discovery: Discovery | null = null;
    const discover = async (client: SeolyticizeClient) => {
      discovery ??= await client.listTools();
      return discovery;
    };

    /**
     * --client takes a client's id or its name: `--client numestri` is the
     * client called Numestri, so a person need not look the id up first. A
     * name matching more than one client is refused with the candidates.
     */
    const resolveClient = async (input: Record<string, unknown>) => {
      const given = input["clientId"] ?? input["client"];
      delete input["client"];
      if (typeof given !== "string" || /^client_[A-Za-z0-9]+$/.test(given)) {
        if (given !== undefined) input["clientId"] = given;
        return input;
      }
      const { clients } = (await connect().call("list_clients", {})) as {
        clients: Array<{ id: string; name: string }>;
      };
      // An id this key can reach is taken as one, whatever it looks like.
      if (clients.some((client) => client.id === given)) {
        input["clientId"] = given;
        return input;
      }
      const wanted = given.trim().toLowerCase();
      const named = clients.filter((client) => typeof client.name === "string");
      const exact = named.filter((client) => client.name.toLowerCase() === wanted);
      const partial = named.filter((client) =>
        client.name.toLowerCase().includes(wanted),
      );
      const found = exact.length > 0 ? exact : partial;
      if (found.length !== 1) {
        throw new UsageError(
          found.length === 0
            ? `No client is called "${given}". \`seolyticize clients\` lists them.`
            : `"${given}" matches ${found.map((client) => `${client.name} (${client.id})`).join(", ")}: give the id.`,
        );
      }
      input["clientId"] = found[0]!.id;
      return input;
    };

    const callTool = async (name: string, input: Record<string, unknown>) => {
      const client = connect();
      const data = await client.call(name, await resolveClient(input));
      print(io, args, data, () => formatResult(data));
      return EXIT.ok;
    };

    /**
     * The input for a tool call: --input or --file as the base, then any
     * --option=value on top, typed by the tool's schema from discovery.
     * Discovery is only asked when there are options to type, so a call made
     * entirely from JSON costs one request, not two.
     */
    const buildInput = async (name: string): Promise<Record<string, unknown>> => {
      let base: unknown = {};
      const inline = option(args, "input");
      const file = option(args, "file");
      if (inline !== undefined && file !== undefined) {
        throw new UsageError("Give --input or --file, not both.");
      }
      const text =
        inline ??
        (file === undefined
          ? undefined
          : file === "-"
            ? await io.readStdin()
            : await io.readFile(file));
      if (text !== undefined) {
        try {
          base = JSON.parse(text);
        } catch {
          throw new UsageError(
            `The ${inline !== undefined ? "--input" : "--file"} value is not JSON.`,
          );
        }
        if (typeof base !== "object" || base === null || Array.isArray(base)) {
          throw new UsageError("Tool input must be a JSON object.");
        }
      }

      const hasOptions = [...args.options.keys()].some((key) => !RESERVED.has(key));
      if (!hasOptions) return base as Record<string, unknown>;

      const { tools } = await discover(connect());
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) {
        throw new NotFoundError(
          `No tool called ${name} is available to this key. Run \`seolyticize tools\`.`,
          { status: 404, tool: name },
        );
      }
      return {
        ...(base as Record<string, unknown>),
        ...coerceFlags(tool.inputSchema, args.options, RESERVED),
      };
    };

    switch (command) {
      case "mcp": {
        if (!credentials.apiKey) {
          throw new AuthenticationError(
            "Not logged in. Run `seolyticize login` or set SEOLYTICIZE_API_KEY.",
            { status: null },
          );
        }
        if (!io.stdinLines)
          throw new UsageError("seolyticize mcp needs a stdin to read.");
        await runMcpBridge({
          apiKey: credentials.apiKey,
          baseUrl: baseUrl ?? DEFAULT_BASE_URL,
          group: option(args, "group"),
          lines: io.stdinLines(),
          write: (line) => io.stdout(`${line}\n`),
          log: (line) => io.stderr(`${line}\n`),
        });
        return EXIT.ok;
      }
      case "login": {
        const flagKey = option(args, "key");
        const key = (
          flagKey ??
          (io.stdinIsTty
            ? await io.promptSecret("Paste your Seolyticize API key: ")
            : await io.readStdin())
        ).trim();
        if (!key) throw new UsageError("No key given.");
        if (flagKey !== undefined) {
          io.stderr(
            "Note: a key passed with --key is kept in your shell history. Piping it in avoids that.\n",
          );
        }
        // Proven before it is stored, so a typo is reported now rather than as
        // a mysterious 401 on the next command.
        const { caller } = await connect(key).listTools();
        const path = await writeConfig(io.env, io.home, {
          apiKey: key,
          ...(baseUrl ? { baseUrl } : {}),
        });
        io.stdout(
          `Logged in as ${caller.role} (${scopeOf(caller)}) at ${baseUrl ?? DEFAULT_BASE_URL}.\nKey stored in ${path}.\n`,
        );
        return EXIT.ok;
      }

      case "logout": {
        const removed = await deleteConfig(io.env, io.home);
        io.stdout(
          removed
            ? `Removed ${configPath(io.env, io.home)}.\n`
            : "No stored key to remove.\n",
        );
        if (io.env["SEOLYTICIZE_API_KEY"]) {
          io.stderr("SEOLYTICIZE_API_KEY is still set in your environment.\n");
        }
        return EXIT.ok;
      }

      case "whoami": {
        const client = connect();
        const { caller, tools } = await discover(client);
        const summary = {
          baseUrl: baseUrl ?? DEFAULT_BASE_URL,
          key: maskKey(credentials.apiKey ?? ""),
          keySource: credentials.source,
          role: caller.role,
          clientIds: caller.clientIds,
          tools: tools.length,
        };
        print(io, args, summary, () =>
          formatTable(
            [
              { field: "base url", value: summary.baseUrl },
              { field: "key", value: `${summary.key} (from ${summary.keySource})` },
              { field: "role", value: summary.role },
              { field: "reach", value: scopeOf(caller) },
              { field: "tools", value: summary.tools },
            ],
            ["field", "value"],
          ),
        );
        return EXIT.ok;
      }

      case "tools": {
        const { tools } = await discover(connect());
        print(io, args, tools, () =>
          formatTable(
            tools.map((tool) => ({
              name: tool.name,
              access: tool.readOnly ? "read" : "write",
              scope: tool.clientScoped ? "client" : "agency",
              permission: tool.permission,
              title: tool.title,
            })),
          ),
        );
        return EXIT.ok;
      }

      case "describe": {
        const name = rest[0];
        if (!name) throw new UsageError("Usage: seolyticize describe <tool>");
        const { tools } = await discover(connect());
        const tool = tools.find((entry) => entry.name === name);
        if (!tool) {
          throw new NotFoundError(`No tool called ${name} is available to this key.`, {
            status: 404,
            tool: name,
          });
        }
        print(io, args, tool, () => {
          const options = optionRows(tool);
          return [
            `${tool.name} — ${tool.title}`,
            "",
            tool.description,
            "",
            `Permission: ${tool.permission}. ${tool.clientScoped ? "Client-scoped" : "Agency-wide"}, ${tool.readOnly ? "read-only" : "changes state"}.`,
            "",
            options.length > 0 ? formatTable(options) : "Takes no options.",
          ].join("\n");
        });
        return EXIT.ok;
      }

      case "call": {
        const name = rest[0];
        if (!name)
          throw new UsageError("Usage: seolyticize call <tool> [--input <json>]");
        return await callTool(name, await buildInput(name));
      }

      case "clients":
        return await callTool("list_clients", {});

      case "find": {
        const task = rest.join(" ").trim();
        if (!task)
          throw new UsageError('Usage: seolyticize find "<what you want to do>"');
        return await callTool("find_tools", { task });
      }

      case "recipe": {
        const name = rest[0];
        const client = option(args, "client");
        if (!client)
          throw new UsageError("Usage: seolyticize recipe [<name>] --client <client>");
        return await callTool("get_recipe", { client, name: name ?? null });
      }

      case "wait": {
        const jobId = rest[0];
        const client = option(args, "client");
        if (!jobId || !client) {
          throw new UsageError("Usage: seolyticize wait <kind:id> --client <client>");
        }
        return await callTool("wait_for_job", { client, jobId, timeoutSeconds: 60 });
      }

      case "rank": {
        const trackerId = rest[0] ?? option(args, "tracker");
        const clientId = option(args, "client");
        if (!trackerId || !clientId) {
          throw new UsageError("Usage: seolyticize rank <trackerId> --client <clientId>");
        }
        return await callTool("get_rank_summary", { clientId, trackerId });
      }

      case "alerts": {
        const clientId = option(args, "client");
        if (!clientId) {
          throw new UsageError(
            "Usage: seolyticize alerts --client <clientId> [--since <iso>]",
          );
        }
        const now = io.now?.() ?? new Date();
        const since =
          option(args, "since") ?? new Date(now.getTime() - 7 * DAY_MS).toISOString();
        return await callTool("list_recent_alerts", { clientId, since });
      }

      default: {
        // Any tool the key can see is a command, so a tool added to the
        // registry tomorrow is `seolyticize new_tool` without a new release.
        const { tools } = await discover(connect());
        if (tools.some((tool) => tool.name === command)) {
          return await callTool(command, await buildInput(command));
        }
        throw new UsageError(
          `Unknown command or tool: ${command}. Run \`seolyticize tools\` to list tools.`,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}\n`);
    if (error instanceof UsageError) io.stderr("Run `seolyticize --help` for usage.\n");
    return exitCodeFor(error);
  }
}
