# seolyticize

Every Seolyticize tool from a terminal or a script. Built on
[`@seolyticize/sdk`](https://github.com/Seolyticize/sdk-typescript); tools are discovered from the API at runtime, so a
tool added to the platform today is a command today, without a new CLI release.

## Install

```sh
npm install -g github:Seolyticize/cli
seolyticize --help
```

## Log in

```sh
# Piped, so the key never lands in shell history:
printf '%s' "$KEY" | seolyticize login

# Or interactively (the key is not echoed):
seolyticize login

# Another instance:
seolyticize login --base-url https://seolyticize.example.com
```

The key is checked against the API before it is stored, in
`~/.config/seolyticize/config.json` (or `$XDG_CONFIG_HOME/seolyticize/config.json`), with
permissions `0600` on the file and `0700` on its directory.

`SEOLYTICIZE_API_KEY` and `SEOLYTICIZE_BASE_URL` override the stored values, which is how CI
should provide them.

```sh
seolyticize whoami      # role, reach (agency-wide or one client), tool count
seolyticize logout
```

## Use

```sh
seolyticize tools                         # what this key may call
seolyticize describe get_top_searches     # a tool's options
seolyticize call get_top_searches --market=uk --since=2026-09-01 --limit=20
seolyticize get_top_searches --market=uk --since=2026-09-01   # same, without "call"

# Input as JSON, inline, from a file, or from stdin; options apply on top:
seolyticize call get_keyword_gap --input '{"clientId":"c1","competitorDomains":["a.com"]}'
seolyticize call get_keyword_gap --file gap.json
cat gap.json | seolyticize call get_keyword_gap --file -
```

Options are typed from the tool's schema: numbers and booleans are converted, arrays take
repeated options or commas (`--domains=a.com,b.com`), objects take JSON, `null` is null
where the schema allows it, and `--client-id` is accepted for `clientId`.

### Shortcuts

```sh
seolyticize clients                        # list_clients
seolyticize rank <trackerId> --client <id> # get_rank_summary
seolyticize alerts --client <id> [--since 2026-10-01T00:00:00Z]   # last 7 days by default
```

### Output

Human-readable tables by default. Scripts should pass `--json`, which prints the tool's
result exactly as the API returned it under `data`:

```sh
seolyticize clients --json | jq -r '.clients[].id'
```

## Exit codes

Stable, so scripts can branch on them:

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | success                                              |
| 1    | unexpected error                                     |
| 2    | usage error (bad command, option or JSON)            |
| 3    | authentication failed (missing, unknown, revoked)    |
| 4    | not permitted (role or client scope)                 |
| 5    | not found (no such tool for this key)                |
| 6    | invalid input (did not match the tool's schema)      |
| 7    | refused (a well-formed request the product declined) |
| 8    | rate limited (after the SDK's retries)               |
| 9    | server error or network failure                      |

Errors go to stderr; results go to stdout.

## MCP over stdio

For an MCP client that only launches a local command, `seolyticize mcp` relays the hosted server (https://seolyticize.com/api/mcp) over stdin and stdout with your key:

```json
{ "mcpServers": { "seolyticize": { "command": "seolyticize", "args": ["mcp", "--group", "onboarding"], "env": { "SEOLYTICIZE_API_KEY": "sk_seo_…" } } } }
```

`--group` (onboarding, weekly, technical, research, reporting) lists only that job's tools. Clients that speak HTTP can connect to the hosted URL directly instead.
