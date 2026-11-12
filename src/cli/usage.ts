import { DEFAULT_BASE_URL } from "@seolyticize/sdk";
import { EXIT_HELP } from "../exitCodes.js";

/** The --help text. */
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
  seolyticize init --domain <domain> [--framework nextjs|astro|…] [--dir .] [--public public]
            [--verification file|meta|dns] [--force] [--dry-run]
                                                      onboard_site, then write its files to the repo:
                                                      verification and IndexNow files, robots, and for
                                                      Next.js the analytics component, CSP origins and
                                                      a sitemap source. Existing files are kept.
  seolyticize verify --site <domain> | --client <id>   verify_site: one line per item not done;
                                                      exit 10 when an item failed
  seolyticize verify --local <dir> [--public public]   the same mistakes in the repo's files, before a
                                                      deploy; no key, no network; exit 10 on any
  seolyticize doctor --site <domain> | --client <id>   one PASS, FAIL or INFO line per check; a read-only
                                                      key will do; exit 10 on any FAIL
  seolyticize env --client <id> [--format dotenv|coolify|vercel|k8s]
            [--push coolify --coolify-url <url> --coolify-app <uuid> [--force]]
                                                      the site's variables, scope and reader; --push
                                                      adds the readable ones, token from COOLIFY_TOKEN;
                                                      changes a set value only with --force (else exit 7)

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
