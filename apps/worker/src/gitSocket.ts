import { z } from "zod";

// Where the worker serves git in the bot computer: the credential helper
// (gitCredential.ts) and the pre-push hook (prePush.ts) ask here, unless
// CHIEFBOT_GIT_SOCKET says otherwise. One worker per computer.
export const defaultGitSocket = "/tmp/chiefbot-git.sock";

export const gitSocket = () => process.env.CHIEFBOT_GIT_SOCKET ?? defaultGitSocket;

// What the pre-push hook sends: git's hook arguments (the remote's name and URL)
// and, from its stdin, the remote ref of each update. A deletion's localRef is "(delete)".
export const PrePushRequest = z.object({
  remote: z.string(),
  url: z.string(),
  updates: z.array(z.object({ localRef: z.string(), remoteRef: z.string() })),
});
export type PrePushRequest = z.infer<typeof PrePushRequest>;
