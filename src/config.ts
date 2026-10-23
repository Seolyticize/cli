import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the CLI keeps the key between runs.
 *
 * ~/.config/seolyticize/config.json, or under $XDG_CONFIG_HOME where that is
 * set, because that is where a person looks for it and where dotfile managers
 * already know not to sync secrets from. The file is 0600 and its directory
 * 0700: an API key reaches every client the key can, and a world-readable copy
 * on a shared machine is a key anybody on it can use.
 */
export type StoredConfig = { apiKey?: string; baseUrl?: string };

export type ConfigEnv = Record<string, string | undefined>;

export function configDir(env: ConfigEnv, home: string): string {
  const base = env["XDG_CONFIG_HOME"] || join(home, ".config");
  return join(base, "seolyticize");
}

export function configPath(env: ConfigEnv, home: string): string {
  return join(configDir(env, home), "config.json");
}

export async function readConfig(env: ConfigEnv, home: string): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(env, home), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const { apiKey, baseUrl } = parsed as Record<string, unknown>;
    return {
      ...(typeof apiKey === "string" ? { apiKey } : {}),
      ...(typeof baseUrl === "string" ? { baseUrl } : {}),
    };
  } catch {
    // Missing or unreadable reads as "not logged in", which is what it means.
    return {};
  }
}

export async function writeConfig(
  env: ConfigEnv,
  home: string,
  config: StoredConfig,
): Promise<string> {
  const dir = configDir(env, home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is ignored for a directory that already exists and is
  // masked by umask for one that does not, so it is set explicitly too.
  await chmod(dir, 0o700);
  const path = configPath(env, home);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies when it creates the file; an older config
  // written by hand with looser permissions is tightened here.
  await chmod(path, 0o600);
  return path;
}

export async function deleteConfig(env: ConfigEnv, home: string): Promise<boolean> {
  try {
    await rm(configPath(env, home));
    return true;
  } catch {
    return false;
  }
}

export type Credentials = {
  apiKey: string | null;
  baseUrl: string | undefined;
  /** Where the key came from, for whoami — never the key itself. */
  source: "environment" | "config" | null;
};

/**
 * The environment wins over the file, so CI can use a key without logging in
 * and a person can point one command at staging without editing their config.
 */
export function resolveCredentials(env: ConfigEnv, stored: StoredConfig): Credentials {
  const envKey = env["SEOLYTICIZE_API_KEY"];
  const baseUrl = env["SEOLYTICIZE_BASE_URL"] || stored.baseUrl || undefined;
  if (envKey) return { apiKey: envKey, baseUrl, source: "environment" };
  if (stored.apiKey) return { apiKey: stored.apiKey, baseUrl, source: "config" };
  return { apiKey: null, baseUrl, source: null };
}

/** Enough of a key to recognise it in a list, never enough to use it. */
export function maskKey(key: string): string {
  return key.length <= 12 ? "sk_seo_…" : `${key.slice(0, 11)}…${key.slice(-4)}`;
}
