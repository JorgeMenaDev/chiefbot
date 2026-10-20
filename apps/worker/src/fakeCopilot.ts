import type { ReasoningEffort } from "@chiefbot/contracts";
import type { JsonValue, MCPServerConfig, PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import type { BotSession, Copilot, FileAttachment, SdkModelList } from "./copilot.ts";

// A fake Copilot SDK for tests. Each send() plays a script of real-shaped SDK
// session events. The default script echoes the prompt with one tool call.
// A script is an async generator, so a test can pause a turn halfway. Through
// `runtime` it acts like the agent: shell commands and custom tools go through
// the session's permission handler first, as in the real runtime. A shell command
// streams tool.execution_start and tool.execution_complete events around it.
export type FakeScript = (prompt: string, runtime: FakeRuntime) => AsyncGenerator<SessionEvent>;

export type FakeRuntime = {
  // Runs a real shell command in `shell.cwd` once the permission handler approves it.
  shell(command: string): Promise<{ approved: boolean; exitCode: number; output: string }>;
  // Calls one of the session's custom tools once the permission handler approves it.
  tool(name: string, args: JsonValue): Promise<{ approved: boolean; result: unknown }>;
  // An MCP server's tool (a GitHub tool that writes, unless readOnly): resolves
  // with whether the permission handler let it run. It does nothing else.
  mcp(serverName: string, toolTitle: string, readOnly: boolean): Promise<boolean>;
  // Calls `toolName` on one of the session's MCP servers as the runtime does:
  // permission first (a read-only tool unless `readOnly` is false), then the
  // session's onMcpCall hook, then, for an http server, a JSON-RPC tools/call
  // POSTed to its url with its headers. Resolves with the HTTP status and JSON
  // answer (null for a local server, which it does not start).
  callMcp(serverName: string, toolName: string, readOnly?: boolean): Promise<{ approved: boolean; status: number | null; body: unknown }>;
};

// What every session's model listing returns. The default is Copilot Free with an empty catalog.
export type FakeModels = SdkModelList;

export type FakeCopilotOptions = {
  script?: FakeScript;
  models?: FakeModels;
  // Where runtime.shell runs commands, and with which environment.
  shell?: { cwd: string; env: Record<string, string> };
};

export function fakeCopilot({ script = echo, models = { list: [] }, shell }: FakeCopilotOptions = {}) {
  // The token each opened session ran on: a seat's access token from its
  // gitHubTokenProvider, or an installation token its runtime started with.
  const tokens: string[] = [];
  // Ids of every session disconnected, in order.
  const closed: string[] = [];
  // Ids of every session whose running turn was aborted, in order.
  const aborted: string[] = [];
  // Ids of every session opened, in order (a resume counts again).
  const sessionIds: string[] = [];
  // Each opened session's MCP servers, in the order sessions opened.
  const mcpServers: Array<Record<string, MCPServerConfig>> = [];
  // Each opened session's skill roots, in the order sessions opened.
  const skillDirectories: string[][] = [];
  // Every turn started, with the model its session was on ("default" before any setModel),
  // that model's reasoning effort (null: its default) and the files attached.
  const sends: Array<{ sessionId: string; prompt: string; model: string; effort: ReasoningEffort | null; files: FileAttachment[] }> = [];

  const copilot: Copilot = {
    async openSession({ sessionId, auth, onPermissionRequest, tools, mcpServers: servers = {}, onMcpCall, skillDirectories: skills = [] }) {
      if (auth.kind === "installation") tokens.push(auth.token);
      else {
        const token = await auth.gitHubTokenProvider({ host: "https://github.com", sessionId, reason: "initial" });
        if (token.kind === "token") tokens.push(token.accessToken);
      }
      sessionIds.push(sessionId);
      mcpServers.push(servers);
      skillDirectories.push(skills);
      const handlers = new Set<(event: SessionEvent) => void>();
      const allowed = async (request: PermissionRequest) =>
        (await onPermissionRequest(request, { sessionId })).kind === "approve-once";
      const publish = (event: SessionEvent) => {
        for (const handler of handlers) handler(event);
      };
      let shellCalls = 0;
      let toolCalls = 0;
      const runtime: FakeRuntime = {
        async shell(command) {
          const toolCallId = `shell-${++shellCalls}`;
          publish(sdk.toolStart(toolCallId, "bash", "Run a command"));
          const result = await runShell(command, toolCallId);
          publish(sdk.toolComplete(toolCallId, result.approved && result.exitCode === 0));
          return result;
        },
        async tool(name, args) {
          const tool = tools.find((candidate) => candidate.name === name);
          if (!tool?.handler) throw new Error(`no tool ${name}`);
          if (!(await allowed(fakeRequest.tool(name, args)))) return { approved: false, result: null };
          const result = await tool.handler(args, { sessionId, toolCallId: `call-${name}-${++toolCalls}`, toolName: name, arguments: args });
          return { approved: true, result };
        },
        mcp: (serverName, toolTitle, readOnly) => allowed(fakeRequest.mcp(serverName, toolTitle, readOnly)),
        async callMcp(serverName, toolName, readOnly = true) {
          const server = servers[serverName];
          if (!server) throw new Error(`no MCP server ${serverName}`);
          if (!(await allowed(fakeRequest.mcp(serverName, toolName, readOnly)))) return { approved: false, status: null, body: null };
          await onMcpCall?.(serverName, toolName);
          if (server.type !== "http") return { approved: true, status: null, body: null };
          const res = await fetch(server.url, {
            method: "POST",
            headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: {} } }),
          });
          return { approved: true, status: res.status, body: await res.json().catch(() => null) };
        },
      };
      async function runShell(command: string, toolCallId: string) {
        if (!(await allowed(fakeRequest.shell(command, toolCallId)))) return { approved: false, exitCode: -1, output: "" };
        if (!shell) throw new Error("fakeCopilot needs `shell` to run commands");
        const proc = Bun.spawn(["sh", "-c", command], { cwd: shell.cwd, env: shell.env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { approved: true, exitCode, output: stdout + stderr };
      }
      let model = "default";
      let effort: ReasoningEffort | null = null;
      // Bumped by abort: a script of an earlier turn publishes nothing more.
      let turn = 0;
      const session: BotSession = {
        on(handler) {
          handlers.add(handler);
          return () => void handlers.delete(handler);
        },
        async send(prompt, files = []) {
          sends.push({ sessionId, prompt, model, effort, files });
          const mine = ++turn;
          // Like the SDK: send returns once the message is admitted; events follow.
          void (async () => {
            for await (const event of fake.script(prompt, runtime)) {
              if (turn !== mine) return;
              publish(event);
            }
          })();
          return "user-msg";
        },
        async abort() {
          turn++;
          aborted.push(sessionId);
        },
        async setModel(next, nextEffort) {
          model = next;
          effort = nextEffort;
        },
        rpc: { model: { list: async () => models } },
        async disconnect() {
          handlers.clear();
          closed.push(sessionId);
        },
      };
      return session;
    },
  };

  const fake = { copilot, tokens, closed, aborted, sessionIds, mcpServers, skillDirectories, sends, script, shell };
  return fake;
}

export type FakeCopilot = ReturnType<typeof fakeCopilot>;

async function* echo(prompt: string): AsyncGenerator<SessionEvent> {
  yield sdk.intent("Answering");
  yield sdk.toolStart("tool-1", "echo", "Echo");
  yield sdk.toolComplete("tool-1", true);
  yield sdk.delta("msg-1", "You said: ");
  yield sdk.delta("msg-1", prompt);
  yield sdk.message("msg-1", `You said: ${prompt}`);
  yield sdk.idle();
}

// Builders for the SDK events the worker reads, with the envelope filled in.
let nextId = 0;
const envelope = () => ({ id: `event-${++nextId}`, parentId: null, timestamp: new Date().toISOString() });

export const sdk = {
  intent: (intent: string): SessionEvent => ({ ...envelope(), ephemeral: true, type: "assistant.intent", data: { intent } }),
  delta: (messageId: string, deltaContent: string, agentId?: string): SessionEvent => ({
    ...envelope(),
    ...(agentId === undefined ? {} : { agentId }),
    ephemeral: true,
    type: "assistant.message_delta",
    data: { messageId, deltaContent },
  }),
  message: (messageId: string, content: string): SessionEvent => ({
    ...envelope(),
    type: "assistant.message",
    data: { messageId, content },
  }),
  toolStart: (toolCallId: string, toolName: string, toolTitle?: string): SessionEvent => ({
    ...envelope(),
    type: "tool.execution_start",
    data: { toolCallId, toolName, ...(toolTitle === undefined ? {} : { toolTitle }) },
  }),
  toolComplete: (toolCallId: string, success: boolean): SessionEvent => ({
    ...envelope(),
    type: "tool.execution_complete",
    data: { toolCallId, success },
  }),
  error: (message: string): SessionEvent => ({
    ...envelope(),
    type: "session.error",
    data: { errorType: "query", message },
  }),
  idle: (): SessionEvent => ({ ...envelope(), ephemeral: true, type: "session.idle", data: {} }),
};

// A shell command's segments as the runtime parses them, roughly: split on
// &&, ||, ; and |, each named by its first word after any VAR=value.
function segmentsOf(fullCommandText: string) {
  return fullCommandText.split(/&&|\|\||;|\||\n/).flatMap((segment) => {
    const words = segment.trim().split(/\s+/).filter((word) => word !== "");
    const identifier = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    return identifier ? [{ identifier, fullCommandText: segment.trim() }] : [];
  });
}

// A shell permission request whose every command the runtime parsed as `readOnly`, or not.
const shellRequest = (fullCommandText: string, readOnly: boolean, toolCallId?: string): PermissionRequest => ({
  kind: "shell",
  ...(toolCallId === undefined ? {} : { toolCallId }),
  fullCommandText,
  intention: "Run a command",
  commandSegments: segmentsOf(fullCommandText),
  commands: segmentsOf(fullCommandText).map(({ identifier }) => ({ identifier, readOnly })),
  possiblePaths: [],
  possibleUrls: [],
  hasWriteFileRedirection: false,
  canOfferSessionApproval: false,
});

// Permission requests shaped like the ones the Copilot runtime sends.
export const fakeRequest = {
  shell: (fullCommandText: string, toolCallId?: string) => shellRequest(fullCommandText, false, toolCallId),
  // A command the runtime sees only reading, such as `ls`.
  readOnlyShell: (fullCommandText: string) => shellRequest(fullCommandText, true),
  write: (fileName: string): PermissionRequest => ({ kind: "write", fileName, intention: "Edit a file", diff: "", canOfferSessionApproval: false }),
  tool: (toolName: string, args: JsonValue): PermissionRequest => ({ kind: "custom-tool", toolName, toolDescription: toolName, args }),
  mcp: (serverName: string, toolTitle: string, readOnly: boolean): PermissionRequest => ({
    kind: "mcp",
    serverName,
    toolName: toolTitle.toLowerCase().replaceAll(" ", "_"),
    toolTitle,
    readOnly,
  }),
};
