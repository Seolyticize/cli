/**
 * seolyticize env: every environment variable a client's site reads, in the
 * shape a platform takes, and optionally pushed to a Coolify application.
 *
 * A secret Seolyticize shows only once (the server collect key, the deploy
 * hook secret, an API key) cannot be read back, so it is printed as a
 * commented placeholder naming the call that issues it, and never pushed:
 * a placeholder pushed over a working secret would break the site.
 */
import { UsageError } from "./args.js";

type Caller = { call(tool: string, input: unknown): Promise<unknown> };

export type EnvVar = {
  name: string;
  /** null for a secret that is shown once and cannot be read back. */
  value: string | null;
  /** build: read when the pages are built (public); run: read by the server; secret: run, and secret. */
  scope: "build" | "run" | "secret";
  usedBy: string;
  /** For a value of null: the call that issues (or replaces) it. */
  issuedBy?: string;
};

export const ENV_FORMATS = ["dotenv", "coolify", "vercel", "k8s"] as const;
export type EnvFormat = (typeof ENV_FORMATS)[number];

/** The full set for one client, from the tools a read-only key may call. */
export async function clientEnv(sdk: Caller, clientId: string): Promise<EnvVar[]> {
  const [analytics, hook] = (await Promise.all([
    sdk.call("get_web_analytics_setup", { clientId }),
    sdk.call("get_deploy_hook", { clientId }),
  ])) as [
    { siteKey?: string | null },
    { deployHook: { hookId: string; url?: string } | null },
  ];
  const siteKey = analytics.siteKey ?? null;
  const vars: EnvVar[] = [
    {
      name: "SEOLYTICIZE_CLIENT_ID",
      value: clientId,
      scope: "run",
      usedBy: "seolyticize doctor --client, the SDKs",
    },
    {
      name: "NEXT_PUBLIC_SEOLYTICIZE_SITE_KEY",
      value: siteKey,
      scope: "build",
      usedBy:
        "<SeolyticizeAnalytics /> (@seolyticize/next), inlined into the pages at build",
      issuedBy: "set_up_web_analytics",
    },
    {
      name: "SEOLYTICIZE_SITE_KEY",
      value: siteKey,
      scope: "run",
      usedBy: "createCollector (server-side collection) and non-Next tags",
      issuedBy: "set_up_web_analytics",
    },
    {
      name: "SEOLYTICIZE_SERVER_COLLECT_KEY",
      value: null,
      scope: "secret",
      usedBy: "createCollector, POST /api/collect with Authorization: Bearer",
      issuedBy:
        "issue_server_collect_key (shown once; issuing revokes the last). list_collect_keys confirms which key is in use",
    },
    {
      name: "SEOLYTICIZE_API_KEY",
      value: null,
      scope: "secret",
      usedBy: "seolyticize doctor, the SDKs and the MCP server",
      issuedBy:
        "create_api_key, or apply_manifest / onboard_site with healthKey: true (shown once)",
    },
  ];
  if (hook.deployHook) {
    vars.push(
      {
        name: "SEOLYTICIZE_DEPLOY_HOOK_URL",
        value: hook.deployHook.url ?? null,
        scope: "run",
        usedBy: "the post-deploy command (get_deploy_hook howToCall.coolify)",
        issuedBy: "create_deploy_hook",
      },
      {
        name: "SEOLYTICIZE_DEPLOY_HOOK_ID",
        value: hook.deployHook.hookId,
        scope: "run",
        usedBy: "seolyticize-notify-deploy (@seolyticize/next 0.4+)",
      },
      {
        name: "SEOLYTICIZE_DEPLOY_HOOK_SECRET",
        value: null,
        scope: "secret",
        usedBy: "the post-deploy command, sent as Authorization: Bearer",
        issuedBy: "rotate_deploy_hook (shown once; the old secret stops at once)",
      },
    );
  }
  return vars;
}

const missing = (one: EnvVar) => `<not readable: ${one.issuedBy ?? "issue it"}>`;
const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const note = (one: EnvVar) => `# ${one.name} (${one.scope}): ${one.usedBy}`;

/** The set as text in one platform's form. Unreadable secrets are always commented out. */
export function renderEnv(vars: EnvVar[], format: EnvFormat): string {
  const known = vars.filter((one) => one.value !== null);
  const unknown = vars.filter((one) => one.value === null);
  switch (format) {
    case "dotenv":
      return [
        ...known.flatMap((one) => [note(one), `${one.name}=${one.value}`]),
        ...unknown.flatMap((one) => [note(one), `# ${one.name}=${missing(one)}`]),
      ].join("\n");
    case "vercel":
      return [
        "# Vercel reads every variable at build and at run time.",
        ...known.flatMap((one) => [
          note(one),
          `printf %s ${sh(one.value!)} | vercel env add ${one.name} production`,
        ]),
        ...unknown.flatMap((one) => [
          note(one),
          `# printf %s "$VALUE" | vercel env add ${one.name} production --sensitive  # ${missing(one)}`,
        ]),
      ].join("\n");
    case "k8s": {
      const plain = known.filter((one) => one.scope !== "secret");
      return [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: seolyticize",
        "data:",
        ...plain.flatMap((one) => [
          `  ${note(one)}${one.scope === "build" ? " (also pass it as a build argument)" : ""}`,
          `  ${one.name}: ${JSON.stringify(one.value)}`,
        ]),
        "---",
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: seolyticize",
        "type: Opaque",
        "stringData:",
        ...unknown
          .flatMap((one) => [note(one), `# ${one.name}: ${missing(one)}`])
          .map((line) => `  ${line}`),
      ].join("\n");
    }
    case "coolify":
      return JSON.stringify(
        {
          data: coolifyEntries(known),
          buildTime: known.filter((one) => one.scope === "build").map((one) => one.name),
          note: COOLIFY_BUILD_NOTE,
          notSet: unknown.map((one) => ({ key: one.name, issuedBy: one.issuedBy })),
        },
        null,
        2,
      );
  }
}

/**
 * The bulk-update entries for Coolify's API (PATCH /api/v1/applications/{uuid}/envs/bulk),
 * readable values only. Its documented request fields have no build-time flag
 * (is_buildtime appears only in responses), so build-time is left to Coolify.
 */
export function coolifyEntries(vars: EnvVar[]) {
  return vars
    .filter((one) => one.value !== null)
    .map((one) => ({
      key: one.name,
      value: one.value!,
      is_preview: false,
      // A key or URL is never meant to be interpolated.
      is_literal: true,
    }));
}

const COOLIFY_BUILD_NOTE =
  "Coolify's API documents no build-time flag: check that build-scope variables are available at build in the application's Environment Variables.";

/**
 * Pushes the readable values to a Coolify application through its API. The
 * token is read from COOLIFY_TOKEN only, so it never sits in shell history,
 * and is never printed.
 */
export async function pushToCoolify(input: {
  vars: EnvVar[];
  coolifyUrl: string;
  appUuid: string;
  token: string | undefined;
  fetch: typeof fetch;
}): Promise<{ pushed: string[]; notSet: string[] }> {
  if (!input.token) {
    throw new UsageError(
      "Set COOLIFY_TOKEN to a Coolify API token (the whole value, id|secret) to push.",
    );
  }
  if (!/^[A-Za-z0-9-]+$/.test(input.appUuid)) {
    throw new UsageError("--coolify-app takes the application's uuid.");
  }
  let base: URL;
  try {
    base = new URL(input.coolifyUrl);
  } catch {
    throw new UsageError("--coolify-url takes the Coolify instance's address.");
  }
  const data = coolifyEntries(input.vars);
  const response = await input.fetch(
    new URL(`/api/v1/applications/${input.appUuid}/envs/bulk`, base),
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ data }),
    },
  );
  if (!response.ok) {
    // Coolify's message, never the request: that holds the token.
    const reason = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Coolify refused the update (${response.status}): ${reason}`);
  }
  return {
    pushed: data.map((entry) => entry.key),
    notSet: input.vars.filter((one) => one.value === null).map((one) => one.name),
  };
}

/** The `env` command: printed in a format, or pushed to Coolify. */
export async function envCommand(
  sdk: Caller,
  clientId: unknown,
  options: {
    format: string | undefined;
    push: string | undefined;
    coolifyUrl: string | undefined;
    coolifyApp: string | undefined;
    token: string | undefined;
    fetch: typeof fetch;
  },
): Promise<{ data: unknown; text: string }> {
  const format = (options.format ?? "dotenv") as EnvFormat;
  if (
    typeof clientId !== "string" ||
    !ENV_FORMATS.includes(format) ||
    (options.push !== undefined && options.push !== "coolify")
  ) {
    throw new UsageError(
      "Usage: seolyticize env --client <id> [--format dotenv|coolify|vercel|k8s] [--push coolify --coolify-url <url> --coolify-app <uuid>]",
    );
  }
  const vars = await clientEnv(sdk, clientId);
  if (!options.push) return { data: { clientId, vars }, text: renderEnv(vars, format) };
  const result = await pushToCoolify({
    vars,
    coolifyUrl: options.coolifyUrl ?? "",
    appUuid: options.coolifyApp ?? "",
    token: options.token,
    fetch: options.fetch,
  });
  return {
    data: result,
    text: `Set in Coolify: ${result.pushed.join(", ")}\nNot readable, set by hand (--format dotenv names the call for each): ${result.notSet.join(", ")}\n${COOLIFY_BUILD_NOTE}`,
  };
}
