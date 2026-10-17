import { z } from "zod";

// A JSON-RPC answer from an MCP server.
const RpcAnswer = z.object({
  id: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

// What tools/call answers: content blocks, and from newer servers a typed copy.
const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

const ToolList = z.object({ tools: z.array(z.object({ name: z.string() })) });

// A minimal MCP client over Streamable HTTP, for control's own calls (subscription
// polls): initialize, then tools/list and tools/call. `token`, if any, goes in
// as `Authorization: Bearer …`. Answers may be JSON or an event stream. Throws
// with what went wrong: the subscription shows it as its last error.
export async function openMcpSession(url: string, token: string | null) {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 1;

  async function send(method: string, params: Record<string, unknown>, notification = false) {
    const id = nextId++;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notification ? {} : { id }) }),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`The MCP server refused the credential (${res.status}).`);
    if (!res.ok) throw new Error(`The MCP server answered ${res.status} to ${method}.`);
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    if (notification) return null;
    const answer = await answerIn(res, id);
    if (answer.error) throw new Error(`${method} failed: ${answer.error.message}`);
    return answer.result;
  }

  const init = z
    .object({ protocolVersion: z.string() })
    .parse(await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chiefbot-control", version: "1" } }));
  protocolVersion = init.protocolVersion;
  await send("notifications/initialized", {}, true);

  return {
    // The names of the server's tools.
    listTools: async () => ToolList.parse(await send("tools/list", {})).tools.map(({ name }) => name),
    // The tool's result as data: its structured content, or its text read as JSON.
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      const result = ToolResult.parse(await send("tools/call", { name, arguments: args }));
      const text = result.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
      if (result.isError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
      if (result.structuredContent !== undefined) return result.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${name} answered text that is not JSON: ${text.slice(0, 200)}`);
      }
    },
  };
}

// The answer with `id` in a JSON or event-stream response.
async function answerIn(res: Response, id: number) {
  const body = await res.text();
  const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [body];
  for (const message of messages) {
    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      continue;
    }
    for (const candidate of Array.isArray(json) ? json : [json]) {
      const answer = RpcAnswer.safeParse(candidate);
      if (answer.success && answer.data.id === id) return answer.data;
    }
  }
  throw new Error(`The MCP server sent no answer to request ${id}.`);
}
