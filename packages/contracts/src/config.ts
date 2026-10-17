import { z } from "zod";

// A GitHub App of the deployer's, as `bun run setup` registered it.
export const GitHubAppConfig = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  clientId: z.string().min(1),
  // The account that owns the app: the deployer or their organization.
  owner: z.string().min(1),
  htmlUrl: z.url(),
});
export type GitHubAppConfig = z.infer<typeof GitHubAppConfig>;

// What the desktop signs in with, and so the token a bot's Copilot SDK gets.
// It has no repository permissions, so that token cannot write to any repo:
// a GitHub App with none (setup registers it), or an OAuth App with only
// read:user (the deployer creates it by hand; setup records its client ID).
export const SignInConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github-app"), app: GitHubAppConfig }),
  z.object({ kind: z.literal("oauth-app"), clientId: z.string().min(1) }),
]);
export type SignInConfig = z.infer<typeof SignInConfig>;

// config.json in the Chiefbot home folder (~/.chiefbot). githubApp is the repo
// app: control alone uses it, through installation tokens, to reach repos for
// bots; its secrets sit beside it in github-app-secrets.json. signIn is missing
// in a config written before the sign-in app existed: setup adds it.
export const LocalConfig = z.object({ githubApp: GitHubAppConfig, signIn: SignInConfig.optional() });
export type LocalConfig = z.infer<typeof LocalConfig>;

// github-app-secrets.json beside config.json: what GitHub handed setup once for the repo app.
// Control signs the app's JWTs with privateKey (PEM) to mint installation tokens.
export const GitHubAppSecrets = z.object({
  clientSecret: z.string(),
  webhookSecret: z.string().nullable(),
  privateKey: z.string().min(1),
});
export type GitHubAppSecrets = z.infer<typeof GitHubAppSecrets>;
