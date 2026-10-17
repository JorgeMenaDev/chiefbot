import type { BrokeredGitHubToken, CopilotInstallationToken, CopilotPayer, ProjectId, UserId } from "@chiefbot/contracts";
import type { openStore } from "./store.ts";
import type { tokenBroker } from "./tokens.ts";

// Mints a one-hour installation token that may only make Copilot requests,
// billed to `account`, the owner of `repo` (github.ts copilotRequestsToken; a
// fake in tests). Or what the deployer must fix.
export type CopilotTokenMinter = (repo: string) => Promise<{ token: string; expiresAt: number; account: string } | { error: string }>;

// A run of an agent whose Copilot someone pays for:
//   chief    a user's own bot (a chief of staff), on its owner's behalf
//   project  a project's coordinator or worker, for the member who asked
export type CopilotRun = { kind: "chief"; ownerId: UserId } | { kind: "project"; projectId: ProjectId; askerId: UserId };

// A run's payer and its token for the agent's runtime, or why there is none.
export type CopilotToken =
  | { kind: "seat"; token: BrokeredGitHubToken }
  | { kind: "org"; token: CopilotInstallationToken }
  | { error: "reauth_needed" }
  | { error: "copilot_token_failed"; message: string };

// Picks who pays for each agent run. Chiefs always use their owner's seat. A
// project's agents follow the workspace's mode: the asker's seat, or the
// organization that installed the repo app on the project's repo, through an
// installation token with only Copilot Requests.
export function copilotIdentity({
  store,
  broker,
  mint,
}: {
  store: ReturnType<typeof openStore>;
  broker: ReturnType<typeof tokenBroker>;
  mint: CopilotTokenMinter;
}) {
  const seat = (userId: UserId): CopilotPayer => ({ kind: "seat", userId, login: store.user(userId).login });

  // Who pays for the run, and its token. Null for a project that is gone.
  return function forRun(run: CopilotRun): { payer: CopilotPayer; token: () => Promise<CopilotToken> } | null {
    const seatRun = (userId: UserId) => ({
      payer: seat(userId),
      token: async (): Promise<CopilotToken> => {
        const token = await broker.accessToken(userId);
        return token ? { kind: "seat", token } : { error: "reauth_needed" };
      },
    });
    if (run.kind === "chief") return seatRun(run.ownerId);
    const project = store.projects.project(run.projectId);
    if (!project) return null;
    if (store.workspaces.copilotMode(project.workspaceId) !== "org") return seatRun(run.askerId);
    const [account = project.repo] = project.repo.split("/");
    return {
      payer: { kind: "org", account },
      token: async (): Promise<CopilotToken> => {
        const minted = await mint(project.repo);
        if ("error" in minted) return { error: "copilot_token_failed", message: minted.error };
        return { kind: "org", token: { token: minted.token, expiresAt: minted.expiresAt } };
      },
    };
  };
}
