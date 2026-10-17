import { startCoordinator } from "./coordinator.ts";
import { coordinatorSdk, copilotSdk } from "./copilotSdk.ts";
import { defaultGitSocket } from "./gitSocket.ts";
import { startWorker } from "./worker.ts";

// Entry point inside a computer. Env (set by the ComputerProvider at start):
//   CHIEFBOT_CONTROL_URL  control as seen from the computer
// A bot's computer:
//   CHIEFBOT_BOT_ID       the bot this computer belongs to
//   CHIEFBOT_BOT_TOKEN    this bot's credential, valid for that bot only
//   CHIEFBOT_GITHUB_API_URL  default https://api.github.com
// A project's computer, which runs the project's coordinator instead:
//   CHIEFBOT_PROJECT_ID     the project this computer belongs to
//   CHIEFBOT_PROJECT_TOKEN  this project's credential, valid for that project only
const {
  CHIEFBOT_CONTROL_URL: controlUrl,
  CHIEFBOT_BOT_ID: botId,
  CHIEFBOT_BOT_TOKEN: botToken,
  CHIEFBOT_PROJECT_ID: projectId,
  CHIEFBOT_PROJECT_TOKEN: projectToken,
} = process.env;

if (controlUrl && projectId && projectToken) {
  startCoordinator({
    controlUrl,
    projectId,
    projectToken,
    // Session history on the computer's own disk.
    copilot: coordinatorSdk({ baseDirectory: "/home/bot/.copilot" }),
    onBound: (project) => console.log(`coordinator connected to ${controlUrl} for ${project.repo}`),
  });
} else {
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
    gitSocket: defaultGitSocket,
    onBound: (botId) => console.log(`worker connected to ${controlUrl} as ${botId}`),
    onModelsError: (error) => console.error("could not list Copilot models:", error),
  });
}
