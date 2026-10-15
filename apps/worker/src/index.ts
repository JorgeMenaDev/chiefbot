import { copilotSdk } from "./copilotSdk.ts";
import { defaultGitCredentialSocket } from "./gitCredentialSocket.ts";
import { startWorker } from "./worker.ts";

// Entry point inside a bot computer. Env (set by the ComputerProvider at start):
//   CHIEFBOT_CONTROL_URL  control as seen from the computer
//   CHIEFBOT_BOT_ID       the bot this computer belongs to
//   CHIEFBOT_BOT_TOKEN    this bot's credential, valid for that bot only
//   CHIEFBOT_GITHUB_API_URL  default https://api.github.com
const { CHIEFBOT_CONTROL_URL: controlUrl, CHIEFBOT_BOT_ID: botId, CHIEFBOT_BOT_TOKEN: botToken } = process.env;
if (!controlUrl || !botId || !botToken) {
  throw new Error("CHIEFBOT_CONTROL_URL, CHIEFBOT_BOT_ID and CHIEFBOT_BOT_TOKEN must be set");
}

startWorker({
  controlUrl,
  botId,
  botToken,
  // The bot's workspace on its own disk (the image's WORKDIR).
  copilot: copilotSdk({ workingDirectory: "/home/bot/workspace" }),
  ...(process.env.CHIEFBOT_GITHUB_API_URL ? { githubApiUrl: process.env.CHIEFBOT_GITHUB_API_URL } : {}),
  gitCredentialSocket: defaultGitCredentialSocket,
  onBound: (botId) => console.log(`worker connected to ${controlUrl} as ${botId}`),
});
