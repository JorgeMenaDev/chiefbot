import {
  CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type CustomAgentConfig,
  type ElicitationContext,
  type ElicitationHandler,
  type ElicitationResult,
  type MCPServerConfig,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
  type SessionHooks,
} from "@github/copilot-sdk";
import { connectionsRoot } from "./connections.ts";
import type { BotSession, Copilot, Questions } from "./copilot.ts";

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
// connections, or an engineer's repo's skill folders), always named, so a
// resumed session keeps none of an earlier turn's. Its instructions follow the
// SDK's own system message. No ambient config discovery. No model here: the
// worker sets the bot's model before each turn that needs it. It works in
// `workingDirectory` unless the session names its own (an engineer's clone).
export const workerSessionConfig =
  (workingDirectory: string) =>
  ({ onPermissionRequest, tools, instructions, mcpServers, onMcpCall, skillDirectories = [], ...options }: Parameters<Copilot["openSession"]>[0]) => ({
    workingDirectory: options.workingDirectory ?? workingDirectory,
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
// file tools, no ambient config or skills. Each session can use only the custom
// tools it is opened with, skills from the skill folders it names, and the helpers
// it names. Session history lives under `baseDirectory`. `connect` starts a
// runtime (the SDK's CopilotClient; a stand-in in tests), and `log` reports
// once that sessions run without their helpers.
export function coordinatorSdk({
  baseDirectory,
  connect = sdkClient,
  log = console.error,
}: {
  baseDirectory: string;
  connect?: (options: RuntimeOptions) => SdkClient;
  log?: (line: string) => void;
}): Copilot {
  const options = { mode: "empty" as const, baseDirectory, useLoggedInUser: false, env: agentEnv(process.env) };
  return sdkCopilot(options, coordinatorSessionConfig, { connect, helpersReady: builtinAgentsOff, log });
}

// Turns the runtime's built-in agents off for the session (task, research,
// rubber-duck and more), which would get every tool of the session, so the task
// tool starts only the session's own helpers. Whether the runtime said it did:
// the SDK takes this only as an update of an open session's options.
const builtinAgentsOff = (session: SdkSession) => session.rpc.options.update({ includedBuiltinAgents: [] }).then(({ success }) => success, () => false);

// A coordinator session's config: its tools and its MCP servers' tools are the
// only ones it may use, plus two of the runtime's own, which BuiltInTools.Isolated
// lists as safe in empty mode: the skill tool when it has skill folders (the
// repo's, in the coordinator's copy), and the task tool when it has helpers
// (`agents`), which starts them. Its instructions, and a line on its helpers,
// follow the SDK's own system message.
export function coordinatorSessionConfig({
  onPermissionRequest,
  tools,
  instructions,
  mcpServers = {},
  onMcpCall,
  skillDirectories = [],
  agents = [],
}: Parameters<Copilot["openSession"]>[0]) {
  const hasMcp = Object.keys(mcpServers).length > 0;
  const hasSkills = skillDirectories.length > 0;
  const { hooks, ...connectors } = connectorConfig(mcpServers, onMcpCall);
  const told = [...(instructions === undefined ? [] : [instructions]), ...helpersLine(agents)];
  return {
    onPermissionRequest,
    tools,
    streaming: true,
    availableTools: [
      ...tools.map(({ name }) => `custom:${name}`),
      ...(hasMcp ? ["mcp:*"] : []),
      ...(hasSkills ? ["builtin:skill"] : []),
      ...(agents.length > 0 ? ["builtin:task"] : []),
    ],
    enableSkills: hasSkills,
    skillDirectories,
    customAgents: agents,
    ...connectors,
    ...(hooks || agents.length > 0 ? { hooks: { ...hooks, ...(agents.length > 0 ? { onPreToolUse: helperLimits(agents) } : {}) } satisfies SessionHooks } : {}),
    ...appended(told.length > 0 ? told.join("\n\n") : undefined),
  };
}

// What the agent is told of its helpers, if it has any.
function helpersLine(agents: CustomAgentConfig[]) {
  if (agents.length === 0) return [];
  const each = agents.map(({ name, description }) => `- ${name}${description ? `: ${description}` : ""}`);
  return [['Start a helper with the task tool, mode "sync": it works in a context of its own and answers you.', ...each].join("\n")];
}

// Each helper may call only the tools its custom agent names: the runtime's own
// limit, checked again before every call a helper makes. The coordinator's own
// calls go on to its permission check.
const helperLimits =
  (agents: CustomAgentConfig[]): NonNullable<SessionHooks["onPreToolUse"]> =>
  ({ agentType, toolName }) => {
    const agent = agents.find(({ name }) => name === agentType);
    if (!agent?.tools || agent.tools.includes(toolName)) return;
    return { permissionDecision: "deny", permissionDecisionReason: `The ${agent.name} helper may only use ${agent.tools.join(", ")}.` };
  };

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
// each answered by `ask`. The SDK calls onElicitationRequest without the
// request's id, but always synchronously while it dispatches the raw
// elicitation.requested event, before any subscriber sees it (dist/session.js
// _dispatchEvent). So each call waits in line until `onEvent` hands it that
// event's requestId: two identical forms still get their own. `onEvent` also
// passes each elicitation.completed to `ended`. It is in the config, so the SDK
// subscribes it before it creates or resumes the session: a request made or
// resolved while the session opens is heard too. `close` cancels the calls
// still waiting for their event once the session closes.
export function askUser({ ask, ended }: Questions) {
  const waiting: Array<{ context: ElicitationContext; resolve: (result: ElicitationResult) => void; reject: (reason: unknown) => void }> = [];
  const onElicitationRequest: ElicitationHandler = (context) => new Promise((resolve, reject) => void waiting.push({ context, resolve, reject }));
  const onEvent = (event: SessionEvent) => {
    if (event.type === "elicitation.completed") ended(event.data.requestId);
    if (event.type !== "elicitation.requested") return;
    const call = waiting.shift();
    if (call) ask({ ...call.context, requestId: event.data.requestId }).then(call.resolve, call.reject);
  };
  return {
    config: { askUserVariant: "elicitation" as const, onElicitationRequest, onEvent },
    close() {
      for (const { resolve } of waiting.splice(0)) resolve({ action: "cancel" });
    },
  };
}

// What starts a runtime: the SDK's client options, with its whole environment.
type RuntimeOptions = CopilotClientOptions & { env: Record<string, string | undefined> };

// The parts of the SDK's CopilotClient and CopilotSession that sdkCopilot uses,
// so a test can stand in for the runtime.
export type SdkSession = Pick<CopilotSession, "send" | "abort" | "disconnect"> & {
  on(handler: (event: SessionEvent) => void): () => void;
  rpc: { model: Pick<CopilotSession["rpc"]["model"], "switchTo" | "list">; options: Pick<CopilotSession["rpc"]["options"], "update"> };
};
export type SdkClient = {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getSessionMetadata(sessionId: string): Promise<unknown>;
  createSession(config: SessionConfig): Promise<SdkSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<SdkSession>;
};
const sdkClient = (options: RuntimeOptions): SdkClient => new CopilotClient(options);

// A Copilot on the SDK with `clientOptions`. Seat sessions share one runtime
// and get their tokens from gitHubTokenProvider. An installation session gets a
// runtime of its own, started with its token in COPILOT_GITHUB_TOKEN, and so
// does a session with an `env` (an engineer's secrets), whose variables the
// runtime's own override. That runtime stops when the session disconnects, or
// fails to open. Either resumes the session's history when it exists on disk. A
// session opened with `questions` gets the ask_user tool (askUser). A session
// with helpers keeps them only when `helpersReady` says the runtime will keep
// them to their tools. Otherwise it closes and opens again without them, and so
// does every session after it, which `log` reports once.
function sdkCopilot(
  clientOptions: RuntimeOptions,
  sessionConfig: (options: Parameters<Copilot["openSession"]>[0]) => ResumeSessionConfig,
  {
    connect = sdkClient,
    helpersReady = async () => true,
    log = console.error,
  }: { connect?: (options: RuntimeOptions) => SdkClient; helpersReady?: (session: SdkSession) => Promise<boolean>; log?: (line: string) => void } = {},
): Copilot {
  const shared = connect(clientOptions);
  let withoutHelpers = false;

  // The session as `options` say, on the shared runtime or one of its own.
  async function open(options: Parameters<Copilot["openSession"]>[0]) {
    const asks = options.questions && askUser(options.questions);
    const config = { ...sessionConfig(options), ...asks?.config };
    const extra = options.env ?? {};
    if (options.auth.kind === "seat" && Object.keys(extra).length === 0) {
      const session = await openOn(shared, options.sessionId, { ...config, gitHubTokenProvider: options.auth.gitHubTokenProvider });
      const disconnect = () => {
        asks?.close();
        return session.disconnect();
      };
      return { session, bot: { ...bound(session), disconnect } };
    }
    const env = { ...extra, ...clientOptions.env };
    const own = connect({ ...clientOptions, env: options.auth.kind === "seat" ? env : { ...env, COPILOT_GITHUB_TOKEN: options.auth.token } });
    const auth = options.auth.kind === "seat" ? { gitHubTokenProvider: options.auth.gitHubTokenProvider } : {};
    // A runtime whose session never opened stops at once, with the secrets or token it holds.
    const session = await openOn(own, options.sessionId, { ...config, ...auth }).catch(async (error: unknown) => {
      await own.stop().catch(() => []);
      throw error;
    });
    const disconnect = async () => {
      asks?.close();
      await own.stop();
    };
    return { session, bot: { ...bound(session), disconnect } };
  }

  return {
    async openSession(requested) {
      const options = withoutHelpers ? { ...requested, agents: [] } : requested;
      const { session, bot } = await open(options);
      if ((options.agents ?? []).length === 0 || (await helpersReady(session))) return bot;
      if (!withoutHelpers) log("The Copilot runtime would not turn off its built-in agents, so project sessions now run without their helpers.");
      withoutHelpers = true;
      await bot.disconnect();
      return (await open({ ...requested, agents: [] })).bot;
    },
  };
}

// Starts the client and resumes the session, or creates it the first time.
async function openOn(client: SdkClient, sessionId: string, config: ResumeSessionConfig) {
  await client.start();
  const existing = await client.getSessionMetadata(sessionId);
  return existing ? client.resumeSession(sessionId, config) : client.createSession({ ...config, sessionId });
}

// The session's methods a BotSession uses, bound to it.
function bound(session: SdkSession): Omit<BotSession, "disconnect"> {
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
