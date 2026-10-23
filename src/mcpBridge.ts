/**
 * `seolyticize mcp`: the hosted MCP server, over stdio.
 *
 * Some MCP clients only launch a local command and speak to it over stdin and
 * stdout. This relays each newline-delimited JSON-RPC message to the hosted
 * endpoint with the key attached, and writes every message that comes back,
 * whether the server answered with JSON or with an event stream. stdout
 * carries protocol messages only; anything else goes to stderr.
 */

export type BridgeOptions = {
  apiKey: string;
  baseUrl: string;
  /** Only this job's tools are listed: onboarding, weekly, technical, research, reporting. */
  group?: string | undefined;
  lines: AsyncIterable<string>;
  write: (line: string) => void;
  log: (line: string) => void;
  fetch?: typeof fetch;
};

type Message = { jsonrpc?: string; id?: string | number | null; method?: string };

/** The JSON-RPC messages in a response: one JSON value, a batch, or an event stream. */
export function messagesFrom(contentType: string, text: string): unknown[] {
  if (contentType.includes("text/event-stream")) {
    const messages: unknown[] = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          messages.push(JSON.parse(data));
        } catch {
          // A keep-alive or a non-JSON event: not a message.
        }
      }
    }
    return messages;
  }
  if (!text.trim()) return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function runMcpBridge(options: BridgeOptions): Promise<void> {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/api/mcp${
    options.group ? `?group=${encodeURIComponent(options.group)}` : ""
  }`;
  const doFetch: typeof fetch = options.fetch ?? fetch;
  let session: string | null = null;
  let protocol: string | null = null;

  for await (const raw of options.lines) {
    const line = raw.trim();
    if (!line) continue;
    let message: Message | Message[];
    try {
      message = JSON.parse(line) as Message | Message[];
    } catch {
      options.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      continue;
    }
    const ids = (Array.isArray(message) ? message : [message])
      .filter((entry) => entry.id !== undefined && entry.id !== null)
      .map((entry) => entry.id);

    try {
      const response: Response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session ? { "mcp-session-id": session } : {}),
          ...(protocol ? { "mcp-protocol-version": protocol } : {}),
        },
        body: line,
      });
      session = response.headers.get("mcp-session-id") ?? session;
      const text = await response.text();
      if (!response.ok && ids.length > 0) {
        let detail = `HTTP ${response.status}`;
        try {
          detail = (JSON.parse(text) as { error?: string }).error ?? detail;
        } catch {
          // Not JSON; the status says enough.
        }
        for (const id of ids) {
          options.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: detail },
            }),
          );
        }
        continue;
      }
      for (const reply of messagesFrom(
        response.headers.get("content-type") ?? "",
        text,
      )) {
        const version = (reply as { result?: { protocolVersion?: string } }).result
          ?.protocolVersion;
        if (version) protocol = version;
        options.write(JSON.stringify(reply));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.log(`seolyticize mcp: ${detail}`);
      for (const id of ids) {
        options.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: `No response from Seolyticize: ${detail}` },
          }),
        );
      }
    }
  }
}
