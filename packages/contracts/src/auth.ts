import { z } from "zod";
import { UserId } from "./ids.ts";

// Chartpilot's public OAuth App: device flow, no client secret, expiring tokens.
// The desktop signs in with it and control refreshes with it, so both must agree.
export const defaultGitHubClientId = "Ov23liONZsgOtJmCUaGB";

// Opaque bearer token the control plane issues to a signed-in desktop.
export const SessionToken = z.string().min(1).brand<"SessionToken">();
export type SessionToken = z.infer<typeof SessionToken>;

// The tokens GitHub's device flow returns. The desktop posts them to control once
// (POST /sessions) and keeps none of them. Expiry times are epoch milliseconds.
export const GitHubTokens = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.number().int(),
});
export type GitHubTokens = z.infer<typeof GitHubTokens>;

// The user's Copilot subscription as GitHub reports it, or null without Copilot.
// `plan` is GitHub's `copilot_plan` ("individual", "business"…); `sku` tells Free
// from paid ("free_limited_copilot", "monthly_subscriber"…).
export const CopilotPlan = z.object({ plan: z.string(), sku: z.string() }).nullable();
export type CopilotPlan = z.infer<typeof CopilotPlan>;

// A user as control shows it to clients. Never carries GitHub tokens.
// needsGitHubSignIn: control has no usable GitHub sign-in for them (it expired,
// GitHub revoked it, or they disconnected GitHub), so their bots get no token
// until they sign in again.
export const User = z.object({
  id: UserId,
  login: z.string(),
  copilotPlan: CopilotPlan,
  needsGitHubSignIn: z.boolean(),
});
export type User = z.infer<typeof User>;

// Response of POST /sessions.
export const SignInResponse = z.object({ sessionToken: SessionToken, user: User });
export type SignInResponse = z.infer<typeof SignInResponse>;

// What the desktop window shows. Sent from Electron main to the renderer.
export const AuthState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed-out") }),
  z.object({ status: z.literal("waiting-for-code"), userCode: z.string(), verificationUri: z.string() }),
  z.object({ status: z.literal("signed-in"), user: User }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type AuthState = z.infer<typeof AuthState>;
