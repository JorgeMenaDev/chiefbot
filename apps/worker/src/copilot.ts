import type { GitHubTokenProvider, PermissionHandler, SessionConfig, SessionEvent } from "@github/copilot-sdk";

// The slice of the Copilot SDK the worker uses: one long-lived session per bot,
// or one per member's chat on a project's coordinator. copilotSdk() and
// coordinatorSdk() (copilotSdk.ts) are the real SDK; tests use fakeCopilot().
export type Copilot = {
  // Opens a session, resuming its history when it already exists on disk.
  // Every tool call goes through onPermissionRequest; `tools` are the worker's
  // custom tools. `instructions` are added to the system message.
  openSession(options: {
    sessionId: string;
    gitHubTokenProvider: GitHubTokenProvider;
    onPermissionRequest: PermissionHandler;
    tools: NonNullable<SessionConfig["tools"]>;
    instructions?: string;
  }): Promise<BotSession>;
};

// What the session's model listing returns (the SDK's SessionModelList, the parts the
// worker reads). `list` entries are untyped JSON in the SDK. On Copilot Free `list` is
// empty and only `modelPriceCategories` names the catalog.
export type SdkModelList = { list: unknown[]; modelPriceCategories?: ReadonlyArray<{ id: string }> };

export type BotSession = {
  // Every event of the session, for as long as it is open. Returns the unsubscribe.
  on(handler: (event: SessionEvent) => void): () => void;
  // Starts a turn. Its events follow through on(), ending with session.idle.
  send(prompt: string): Promise<unknown>;
  // Runs the next turns on `model`. The conversation is kept.
  setModel(model: string): Promise<void>;
  // Lists models with the session's own auth, so for the bot owner's plan.
  rpc: { model: { list(): Promise<SdkModelList> } };
};
