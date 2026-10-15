import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import type { BotSession, Copilot } from "./copilot.ts";

// A fake Copilot SDK for tests. Each send() plays a script of real-shaped SDK
// session events. The default script echoes the prompt with one tool call.
// A script is an async generator, so a test can pause a turn halfway. Through
// `runtime` it acts like the agent: shell commands and custom tools go through
// the session's permission handler first, as in the real runtime.
export type FakeScript = (prompt: string, runtime: FakeRuntime) => AsyncGenerator<SessionEvent>;

export type FakeRuntime = {
  // Runs a real shell command in `shell.cwd` once the permission handler approves it.
  shell(command: string): Promise<{ approved: boolean; exitCode: number; output: string }>;
  // Calls one of the session's custom tools once the permission handler approves it.
  tool(name: string, args: unknown): Promise<{ approved: boolean; result: unknown }>;
};

export type FakeCopilotOptions = {
  script?: FakeScript;
  // Where runtime.shell runs commands, and with which environment.
  shell?: { cwd: string; env: Record<string, string> };
};

export function fakeCopilot({ script = echo, shell }: FakeCopilotOptions = {}) {
  // The access token each opened session got from its gitHubTokenProvider.
  const tokens: string[] = [];
  // Ids of every session opened, in order (a resume counts again).
  const sessionIds: string[] = [];

  const copilot: Copilot = {
    async openSession({ sessionId, gitHubTokenProvider, onPermissionRequest, tools }) {
      const token = await gitHubTokenProvider({ host: "https://github.com", sessionId, reason: "initial" });
      if (token.kind === "token") tokens.push(token.accessToken);
      sessionIds.push(sessionId);
      const handlers = new Set<(event: SessionEvent) => void>();
      const allowed = async (request: PermissionRequest) =>
        (await onPermissionRequest(request, { sessionId })).kind === "approve-once";
      const runtime: FakeRuntime = {
        async shell(command) {
          if (!(await allowed(fakeRequest.shell(command)))) return { approved: false, exitCode: -1, output: "" };
          if (!shell) throw new Error("fakeCopilot needs `shell` to run commands");
          const proc = Bun.spawn(["sh", "-c", command], { cwd: shell.cwd, env: shell.env, stdout: "pipe", stderr: "pipe" });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { approved: true, exitCode, output: stdout + stderr };
        },
        async tool(name, args) {
          const tool = tools.find((candidate) => candidate.name === name);
          if (!tool?.handler) throw new Error(`no tool ${name}`);
          if (!(await allowed(fakeRequest.tool(name, args)))) return { approved: false, result: null };
          const result = await tool.handler(args, { sessionId, toolCallId: `call-${name}`, toolName: name, arguments: args });
          return { approved: true, result };
        },
      };
      const session: BotSession = {
        on(handler) {
          handlers.add(handler);
          return () => void handlers.delete(handler);
        },
        async send(prompt) {
          // Like the SDK: send returns once the message is admitted; events follow.
          void (async () => {
            for await (const event of fake.script(prompt, runtime)) for (const handler of handlers) handler(event);
          })();
          return "user-msg";
        },
      };
      return session;
    },
  };

  const fake = { copilot, tokens, sessionIds, script, shell };
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

// Permission requests shaped like the ones the Copilot runtime sends.
export const fakeRequest = {
  shell: (fullCommandText: string): PermissionRequest => ({
    kind: "shell",
    fullCommandText,
    intention: "Run a command",
    commands: [],
    possiblePaths: [],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
  }),
  tool: (toolName: string, args: unknown): PermissionRequest => ({
    kind: "custom-tool",
    toolName,
    toolDescription: toolName,
    args: JSON.parse(JSON.stringify(args)),
  }),
  mcp: (serverName: string, toolTitle: string, readOnly: boolean): PermissionRequest => ({
    kind: "mcp",
    serverName,
    toolName: toolTitle.toLowerCase().replaceAll(" ", "_"),
    toolTitle,
    readOnly,
  }),
};
