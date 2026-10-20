import {
  CopilotClient,
  type CopilotClientOptions,
  type ElicitationHandler,
  type ElicitationResult,
  type MCPServerConfig,
  type ResumeSessionConfig,
  type SessionEvent,
  type SessionHooks,
} from "@github/copilot-sdk";
import { connectionsRoot } from "./connections.ts";
import type { BotSession, Copilot, QuestionRequest } from "./copilot.ts";

// The real Copilot SDK in copilot-cli mode: the bundled runtime runs in the bot
// computer with its full tool set (shell, files, git), working in `workingDirectory`.
// Session history lives under ~/.copilot, on the bot's own disk.
// GitHub identity comes only from each session's auth (copilot.ts), never from a
// logged-in user or an ambient env token. The runtime's shell inherits agentEnv()
// plus `gitConfig`, the GIT_CONFIG_* variables that send git to control's proxy,
// with the turn's connection wrappers first on its PATH (connections.ts).
// An organization's installation token is the exception: GitHub wants it in the
// runtime's own environment, so that runtime's shell sees it. It may only make
// Copilot requests, never read or write a repo.
export function copilotSdk({ workingDirectory, gitConfig }: { workingDirectory: string; gitConfig: Record<string, string> }): Copilot {
  return sdkCopilot(
    {
      mode: "copilot-cli",
      workingDirectory,
      useLoggedInUser: false,
      env: { ...agentEnv(process.env), ...gitConfig, PATH: `${connectionsRoot}/bin:${process.env.PATH ?? ""}` },
    },
    workerSessionConfig(workingDirectory),
  );
}

// A bot's or task worker's session config: the runtime's full tool set, its
// custom tools, its connectors' MCP servers and its turn's skill roots (a bot's
// connections), always named, so a resumed session keeps none of an earlier
// turn's. Its instructions follow the SDK's own system message. No ambient
// config discovery. No model here: the worker sets the bot's model before each
// turn that needs it.
export const workerSessionConfig =
  (workingDirectory: string) =>
  ({ onPermissionRequest, tools, instructions, mcpServers, onMcpCall, skillDirectories = [] }: Parameters<Copilot["openSession"]>[0]) => ({
    workingDirectory,
    streaming: true,
    onPermissionRequest,
    tools,
    enableSkills: true,
    skillDirectories,
    ...connectorConfig(mcpServers, onMcpCall),
    ...appended(instructions),
  });

// Tokens the agent's shell is not handed: a GitHub token would let gh or curl
// write to repos without control's approval. The bot's (or task worker's) credential is withheld too,
// though a process in the computer can still read it (docs/isolation.md).
const withheld = ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "CHIEFBOT_BOT_TOKEN", "CHIEFBOT_TASK_WORKER_TOKEN"];

// The environment the Copilot runtime (and every command it runs) gets: the worker's, minus those tokens.
export function agentEnv(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !withheld.includes(name)));
}

// The real Copilot SDK in empty mode, for a project's coordinator: no shell, no
// files, no ambient config or skills. Each session can use only the custom tools
// it is opened with. Session history lives under `baseDirectory`.
export function coordinatorSdk({ baseDirectory }: { baseDirectory: string }): Copilot {
  return sdkCopilot({ mode: "empty", baseDirectory, useLoggedInUser: false, env: agentEnv(process.env) }, coordinatorSessionConfig);
}

// A coordinator session's config: its tools and its MCP servers' tools are the
// only ones it may use, and its instructions follow the SDK's own system message.
export function coordinatorSessionConfig({
  onPermissionRequest,
  tools,
  instructions,
  mcpServers = {},
  onMcpCall,
}: Parameters<Copilot["openSession"]>[0]) {
  const hasMcp = Object.keys(mcpServers).length > 0;
  return {
    onPermissionRequest,
    tools,
    streaming: true,
    availableTools: [...tools.map(({ name }) => `custom:${name}`), ...(hasMcp ? ["mcp:*"] : [])],
    ...connectorConfig(mcpServers, onMcpCall),
    ...appended(instructions),
  };
}

// A session's `instructions`, after the SDK's own system message.
const appended = (instructions: string | undefined) =>
  instructions === undefined ? {} : { systemMessage: { mode: "append" as const, content: instructions } };

// A session's connectors: their MCP servers, and `onMcpCall` before each of their tool calls.
function connectorConfig(mcpServers: Record<string, MCPServerConfig> = {}, onMcpCall?: (serverName: string, toolName: string) => Promise<void>) {
  return {
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(onMcpCall ? { hooks: { onPreMcpToolCall: async ({ serverName, toolName }) => void (await onMcpCall(serverName, toolName)) } satisfies SessionHooks } : {}),
  };
}

// A session's ask_user tool as structured forms (askUserVariant "elicitation"),
// each answered by `onQuestion`. The SDK calls onElicitationRequest without the
// request's id, but always synchronously while it dispatches the raw
// elicitation.requested event, before any subscriber sees it (dist/session.js
// _dispatchEvent). So each call waits in line until `onEvent`, subscribed to the
// session, hands it that event's requestId: two identical forms still get their own.
export function askUser(onQuestion: (request: QuestionRequest) => Promise<ElicitationResult>) {
  const unmatched: Array<(requestId: string) => void> = [];
  const onElicitationRequest: ElicitationHandler = (context) =>
    new Promise((resolve, reject) => void unmatched.push((requestId) => void onQuestion({ ...context, requestId }).then(resolve, reject)));
  return {
    config: { askUserVariant: "elicitation" as const, onElicitationRequest },
    onEvent(event: SessionEvent) {
      if (event.type === "elicitation.requested") unmatched.shift()?.(event.data.requestId);
    },
  };
}

// A Copilot on the SDK with `clientOptions`. Seat sessions share one runtime
// and get their tokens from gitHubTokenProvider. An installation session gets a
// runtime of its own, started with its token in COPILOT_GITHUB_TOKEN, which
// stops when the session disconnects. Either resumes the session's history
// when it exists on disk. A session opened with onQuestion gets the ask_user tool (askUser).
function sdkCopilot(
  clientOptions: CopilotClientOptions & { env: Record<string, string | undefined> },
  sessionConfig: (options: Parameters<Copilot["openSession"]>[0]) => ResumeSessionConfig,
): Copilot {
  const shared = new CopilotClient(clientOptions);
  return {
    async openSession(options) {
      const asks = options.onQuestion && askUser(options.onQuestion);
      const config = { ...sessionConfig(options), ...asks?.config };
      const opened = (session: Awaited<ReturnType<typeof openOn>>) => {
        if (asks) session.on(asks.onEvent);
        return bound(session);
      };
      if (options.auth.kind === "seat") {
        const session = await openOn(shared, options.sessionId, { ...config, gitHubTokenProvider: options.auth.gitHubTokenProvider });
        return { ...opened(session), disconnect: () => session.disconnect() };
      }
      const own = new CopilotClient({ ...clientOptions, env: { ...clientOptions.env, COPILOT_GITHUB_TOKEN: options.auth.token } });
      const session = await openOn(own, options.sessionId, config);
      return { ...opened(session), disconnect: async () => void (await own.stop()) };
    },
  };
}

// Starts the client and resumes the session, or creates it the first time.
async function openOn(client: CopilotClient, sessionId: string, config: ResumeSessionConfig) {
  await client.start();
  const existing = await client.getSessionMetadata(sessionId);
  return existing ? client.resumeSession(sessionId, config) : client.createSession({ ...config, sessionId });
}

// The session's methods a BotSession uses, bound to it.
function bound(session: Awaited<ReturnType<typeof openOn>>): Omit<BotSession, "disconnect"> {
  return {
    on: (handler) => session.on(handler),
    send: (prompt, files = []) => session.send(files.length > 0 ? { prompt, attachments: files } : { prompt }),
    abort: () => session.abort(),
    // The SDK's setModel without its types' limit: its switchTo takes a null effort,
    // which clears the effort an earlier turn set (setModel can only keep or replace it).
    setModel: async (modelId, reasoningEffort) => void (await session.rpc.model.switchTo({ modelId, reasoningEffort })),
    rpc: session.rpc,
  };
}
