/**
 * seolyticize apply: a repo's seolyticize.manifest.yaml, sent to apply_manifest.
 *
 * The file is YAML (or JSON). Secrets never sit in it: any value written as
 * {$env: NAME} is read from the environment here, and every value read that
 * way is masked in what is printed. --diff and --ci write nothing (dryRun);
 * --ci exits 11 when the live config differs from the file, so a pipeline
 * catches a setting changed in the app. seolyticize plan is apply --diff, and
 * --check is --ci. --env-out writes the site key, deploy-hook URL and ids to a
 * file with mode 600, and masks the key and URL in what is printed.
 */
import { chmod, writeFile } from "node:fs/promises";
import { load } from "js-yaml";
import { UsageError } from "./args.js";
import { EXIT } from "./exitCodes.js";
import type { ConfigEnv } from "./config.js";

type Caller = { call(tool: string, input: unknown): Promise<unknown> };
type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Replaces each {$env: NAME} with the variable's value, noting the value to mask. */
export function resolveEnvRefs(
  value: unknown,
  env: ConfigEnv,
  secrets: Map<string, string>,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => resolveEnvRefs(item, env, secrets));
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$env") {
    const name = value["$env"];
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new UsageError("$env takes the name of an environment variable.");
    }
    const found = env[name];
    if (found === undefined || found === "") {
      throw new UsageError(`The manifest reads $env ${name}, which is not set.`);
    }
    secrets.set(found, name);
    return found;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveEnvRefs(item, env, secrets)]),
  );
}

/**
 * The file's shape to apply_manifest's input: `site: {domain, framework, name}`
 * is flattened, `version` (1) and `client` are the file's own, and a goal
 * given by name alone is the event of that name.
 */
export function manifestInput(doc: unknown): { input: Rec; client: string | null } {
  if (!isRecord(doc)) throw new UsageError("The manifest must be a YAML mapping.");
  const { version, client, site, budget, deployHook, ...rest } = doc;
  if (version !== undefined && version !== 1) {
    throw new UsageError(`Manifest version ${String(version)} is not known; use 1.`);
  }
  // client: {domain, name, framework} is site under another name; a string is the client id.
  const input: Rec = {
    ...(isRecord(client) ? client : {}),
    ...(isRecord(site) ? site : {}),
    ...rest,
  };
  // The short forms of deploy/seolyticize/seolyticize.yaml, as apply_manifest takes them.
  if (isRecord(budget)) {
    if (budget["monthlyUsd"] !== undefined)
      input["monthlyBudgetUsd"] = budget["monthlyUsd"];
    if (budget["alertAt"] !== undefined) input["budgetAlertAt"] = budget["alertAt"];
  }
  const platforms: Rec = isRecord(input["platforms"]) ? { ...input["platforms"] } : {};
  if (isRecord(deployHook)) {
    input["deployHook"] = true;
    if (isRecord(deployHook["forumulate"]))
      platforms["forumulate"] = {
        ...deployHook["forumulate"],
        ...(platforms["forumulate"] as Rec),
      };
  } else if (deployHook !== undefined) input["deployHook"] = deployHook;
  if (isRecord(input["analytics"])) {
    const { include, exclude, ...analytics } = input["analytics"];
    input["analytics"] = {
      ...(include !== undefined ? { includePaths: include } : {}),
      ...(exclude !== undefined ? { excludePaths: exclude } : {}),
      ...analytics,
    };
  }
  // alerts as a list of one destination; a Watchtower one names its project, linked here.
  if (Array.isArray(input["alerts"])) {
    if (input["alerts"].length > 1)
      throw new UsageError(
        "alerts takes one destination: the default alerts all go there.",
      );
    const { projectId, apiKey, ...alerts } = (input["alerts"][0] ?? {}) as Rec;
    input["alerts"] = alerts;
    if (alerts["channel"] === "watchtower" && projectId !== undefined)
      platforms["watchtower"] = {
        projectId,
        ...(apiKey !== undefined ? { apiKey } : {}),
      };
  }
  if (Object.keys(platforms).length > 0) input["platforms"] = platforms;
  if (Array.isArray(input["goals"])) {
    input["goals"] = input["goals"].map((goal) =>
      isRecord(goal) && goal["kind"] === undefined && typeof goal["name"] === "string"
        ? { kind: "event", match: goal["name"], ...goal }
        : goal,
    );
  }
  if (typeof input["domain"] !== "string") {
    throw new UsageError("The manifest needs site.domain (or domain).");
  }
  return { input, client: typeof client === "string" ? client : null };
}

/** Text with every value read from $env replaced by its name. */
export function mask(text: string, secrets: Map<string, string>): string {
  let out = text;
  for (const [value, name] of secrets) out = out.split(value).join(`<$env ${name}>`);
  return out;
}

/** The same, through every string in a JSON value. */
export function maskDeep(value: unknown, secrets: Map<string, string>): unknown {
  if (typeof value === "string") return mask(value, secrets);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, maskDeep(item, secrets)]),
  );
}

type EnvEntry = { name: string; value: string };

export type ApplyAnswer = {
  clientId: string | null;
  dryRun: boolean;
  env?: { build?: EnvEntry[]; runtime?: EnvEntry[] };
  steps: Array<{ tool: string; outcome: string; result?: unknown; warnings?: string[] }>;
};

export async function applyCommand(
  sdk: Caller,
  text: string,
  options: { env: ConfigEnv; diff: boolean; ci: boolean; envOut?: string | undefined },
): Promise<{ data: unknown; text: string; exit: number }> {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (error) {
    throw new UsageError(
      `The manifest is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
  const secrets = new Map<string, string>();
  const { input, client } = manifestInput(resolveEnvRefs(doc, options.env, secrets));
  const dryRun = options.diff || options.ci;
  const answer = (await sdk.call("apply_manifest", { ...input, dryRun })) as ApplyAnswer;
  const changes = answer.steps.filter((step) => step.outcome === "would_run");
  // --env-out: the site key, hook URL and ids to a file only the user can read, never printed.
  const written = [...(answer.env?.build ?? []), ...(answer.env?.runtime ?? [])].filter(
    (entry, i, all) =>
      !entry.value.startsWith("<") && all.findIndex((e) => e.name === entry.name) === i,
  );
  if (options.envOut) {
    await writeFile(
      options.envOut,
      written
        .map(
          (entry) => `${entry.name}=${entry.value}
`,
        )
        .join(""),
      { mode: 0o600 },
    );
    // mode applies only when writeFile creates the file.
    await chmod(options.envOut, 0o600);
    for (const entry of written)
      if (/SITE_KEY|HOOK_URL/.test(entry.name) && !secrets.has(entry.value))
        secrets.set(entry.value, entry.name);
  }
  const lines = [
    `${dryRun ? "Dry run for" : "Applied to"} ${answer.clientId ?? `${String(input["domain"])} (no client yet)`}`,
    ...(client && answer.clientId && client !== answer.clientId
      ? [
          `WARN the file names ${client}, but ${String(input["domain"])} is ${answer.clientId}.`,
        ]
      : []),
    ...answer.steps.map((step) =>
      [
        `  ${step.outcome.padEnd(9)} ${step.tool}`,
        ...(options.diff && step.outcome === "would_run" && step.result != null
          ? [`            from: ${JSON.stringify(step.result)}`]
          : []),
        ...(step.warnings ?? []).map((warning) => `            WARN ${warning}`),
      ].join("\n"),
    ),
    ...(options.envOut
      ? [
          `Wrote ${written.map((entry) => entry.name).join(", ") || "nothing (no value yet: a dry run for a new client)"} to ${options.envOut} (mode 600).`,
        ]
      : []),
    ...(options.ci
      ? [
          changes.length === 0
            ? "The live config matches the file."
            : `${changes.length} part${changes.length === 1 ? "" : "s"} of the live config differ from the file: run seolyticize apply to write them.`,
        ]
      : []),
  ];
  return {
    data: maskDeep(answer, secrets),
    text: mask(lines.join("\n"), secrets),
    exit: options.ci && changes.length > 0 ? EXIT.drift : EXIT.ok,
  };
}
