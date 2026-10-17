import { z } from "zod";

// The deployer's own GitHub App, as `bun run setup` registered it. Kept in
// config.json in the Chiefbot home folder (~/.chiefbot); control and the desktop
// read clientId from it. The app's secrets sit beside it in github-app-secrets.json.
export const GitHubAppConfig = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  clientId: z.string().min(1),
  // The account that owns the app: the deployer or their organization.
  owner: z.string().min(1),
  htmlUrl: z.url(),
});
export type GitHubAppConfig = z.infer<typeof GitHubAppConfig>;

export const LocalConfig = z.object({ githubApp: GitHubAppConfig });
export type LocalConfig = z.infer<typeof LocalConfig>;
