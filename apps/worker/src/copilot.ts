import type { ReasoningEffort } from "@chiefbot/contracts";
import type {
  CustomAgentConfig,
  ElicitationContext,
  ElicitationResult,
  GitHubTokenProvider,
  MCPServerConfig,
  PermissionHandler,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";

// How a session's runtime signs in to Copilot, and so who pays:
//   seat          a person's Copilot seat: user tokens from the session's gitHubTokenProvider
//   installation  an organization's: an installation token with Copilot Requests. GitHub
//                 wants it in the runtime's COPILOT_GITHUB_TOKEN, never through
//                 gitHubTokenProvider, so the session gets a runtime of its own,
//                 started with this token (installationSession.ts renews it).
// One ask_user form the agent puts to the user, with the requestId of its raw
// elicitation.requested event (the elicitation.completed that ends it names the same id).
export type QuestionRequest = ElicitationContext & { requestId: string };

// A session's answers to the agent's ask_user forms (the SDK's elicitation):
// `ask` answers each request, and `ended` hears that the runtime resolved
// request `requestId` itself (elicitation.completed). Both hear the session from
// before it opens, so nothing said while it opens is missed.
export type Questions = { ask: (request: QuestionRequest) => Promise<ElicitationResult>; ended: (requestId: string) => void };

export type CopilotAuth = { kind: "seat"; gitHubTokenProvider: GitHubTokenProvider } | { kind: "installation"; token: string };

// The slice of the Copilot SDK the worker uses: one long-lived session per bot,
// or one per member's chat on a project's coordinator. copilotSdk() and
// coordinatorSdk() (copilotSdk.ts) are the real SDK; tests use fakeCopilot().
export type Copilot = {
  // Opens a session, resuming its history when it already exists on disk.
  // Every tool call goes through onPermissionRequest; `tools` are the worker's
  // custom tools. `instructions` are added to the system message. `mcpServers`
  // are the session's MCP servers (a project's connectors), by name; `onMcpCall`
  // runs before each of their tool calls (the SDK's onPreMcpToolCall hook).
  // `skillDirectories` are the roots of the skills it may load (a bot's turn's
  // connections); every session names them, so none carry over from an earlier one.
  // `agents` are helpers the model may start in the session with the runtime's
  // task tool (the SDK's custom agents), each limited to the tools it names. Only
  // a coordinator's sessions take them (coordinatorSdk); a bot's has the runtime's own.
  // `questions` answers the agent's ask_user forms (the SDK's elicitation); a
  // session without it has no ask_user tool, so the agent asks in plain text.
  // An engineer's session works in its clone (`workingDirectory`) and gets the
  // project's secrets as `env`: a runtime of its own, started with them, which
  // stops when the session disconnects. Neither applies to a coordinator.
  openSession(options: {
    sessionId: string;
    auth: CopilotAuth;
    onPermissionRequest: PermissionHandler;
    tools: NonNullable<SessionConfig["tools"]>;
    instructions?: string;
    mcpServers?: Record<string, MCPServerConfig>;
    onMcpCall?: (serverName: string, toolName: string) => Promise<void>;
    skillDirectories?: string[];
    agents?: CustomAgentConfig[];
    questions?: Questions;
    workingDirectory?: string;
    env?: Record<string, string>;
  }): Promise<BotSession>;
};

// What the session's model listing returns (the SDK's SessionModelList, the parts the
// worker reads). `list` entries are untyped JSON in the SDK. On Copilot Free `list` is
// empty and only `modelPriceCategories` names the catalog.
export type SdkModelList = { list: unknown[]; modelPriceCategories?: ReadonlyArray<{ id: string }> };

// A file the runtime reads from disk and gives the model with the prompt (the SDK's
// file attachment, which its docs use for images and documents alike).
export type FileAttachment = { type: "file"; path: string; displayName: string };

export type BotSession = {
  // Every event of the session, for as long as it is open. Returns the unsubscribe.
  on(handler: (event: SessionEvent) => void): () => void;
  // Starts a turn on `prompt`, with `files` attached. Its events follow through on(), ending with session.idle.
  send(prompt: string, files?: FileAttachment[]): Promise<unknown>;
  // Cuts the running turn short. The conversation is kept.
  abort(): Promise<void>;
  // Runs the next turns on `model` at `effort`; null clears any effort set before, so
  // the model's default applies. The session keeps both, and its conversation.
  setModel(model: string, effort: ReasoningEffort | null): Promise<void>;
  // Lists models with the session's own auth, so for the bot owner's plan.
  rpc: { model: { list(): Promise<SdkModelList> } };
  // Closes the session; its history stays on disk to resume. An installation
  // session's runtime stops with it.
  disconnect(): Promise<void>;
};
