// Git in the bot computer reaches GitHub only through control's git proxy
// (/git/<owner>/<repo>.git on control), which asks the user before any push and
// holds the only credential that may write. The worker serves git's credential
// helper (gitCredential.ts) on a unix socket, CHIEFBOT_GIT_SOCKET overriding the path.
export const defaultGitSocket = "/tmp/chiefbot-git.sock";

export const gitSocket = () => process.env.CHIEFBOT_GIT_SOCKET ?? defaultGitSocket;

// Git config for the agent's shell, as GIT_CONFIG_* variables: every github.com
// remote goes to control's proxy, and control's Basic auth challenge is answered
// with the bot's credential through `helper`. Git gets no GitHub token.
export function gitProxyConfig({
  controlUrl,
  helper = "bun /opt/chiefbot/git-credential.js",
  githubUrl = "https://github.com",
}: {
  controlUrl: string;
  // The command that runs gitCredential.ts. Default: the image's bundle.
  helper?: string;
  // Where the remotes the proxy replaces point. Default: github.com; a fake in tests.
  githubUrl?: string;
}): Record<string, string> {
  const entries = [
    [`url.${controlUrl}/git/.insteadOf`, `${githubUrl}/`],
    [`credential.${controlUrl}.helper`, `!${helper}`],
  ];
  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
}
