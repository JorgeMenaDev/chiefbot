import type { GitHubTokenProvider, PermissionHandler, SessionConfig, SessionEvent } from "@github/copilot-sdk";

// The slice of the Copilot SDK the worker uses: one long-lived session per bot.
// copilotSdk() (copilotSdk.ts) is the real SDK; tests use fakeCopilot().
export type Copilot = {
  // Opens the bot's session, resuming its history when it already exists on disk.
  // Every tool call goes through onPermissionRequest; `tools` are the worker's custom tools.
  openSession(options: {
    sessionId: string;
    gitHubTokenProvider: GitHubTokenProvider;
    onPermissionRequest: PermissionHandler;
    tools: NonNullable<SessionConfig["tools"]>;
  }): Promise<BotSession>;
};

export type BotSession = {
  // Every event of the session, for as long as it is open. Returns the unsubscribe.
  on(handler: (event: SessionEvent) => void): () => void;
  // Starts a turn. Its events follow through on(), ending with session.idle.
  send(prompt: string): Promise<unknown>;
};
