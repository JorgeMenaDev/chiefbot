import { startCoordinator } from "./coordinator.ts";
import { coordinatorSdk, copilotSdk } from "./copilotSdk.ts";
import { defaultGitSocket, gitProxyConfig } from "./gitProxy.ts";
import { startWorker } from "./worker.ts";

// Entry point inside a computer. Env (set by the ComputerProvider at start):
//   CHIEFBOT_CONTROL_URL  control as seen from the computer
// A bot's computer:
//   CHIEFBOT_BOT_ID       the bot this computer belongs to
//   CHIEFBOT_BOT_TOKEN    this bot's credential, valid for that bot only
// A project's computer, which runs the project's coordinator instead:
//   CHIEFBOT_PROJECT_ID     the project this computer belongs to
//   CHIEFBOT_PROJECT_TOKEN  this project's credential, valid for that project only
// A task worker's throwaway computer, which runs one task of a project like a bot's worker:
//   CHIEFBOT_TASK_WORKER_ID     the task worker this computer belongs to
//   CHIEFBOT_TASK_WORKER_TOKEN  its credential, valid for that task worker only
const {
  CHIEFBOT_CONTROL_URL: controlUrl,
  CHIEFBOT_BOT_ID: botId,
  CHIEFBOT_BOT_TOKEN: botToken,
  CHIEFBOT_PROJECT_ID: projectId,
  CHIEFBOT_PROJECT_TOKEN: projectToken,
  CHIEFBOT_TASK_WORKER_ID: taskWorkerId,
  CHIEFBOT_TASK_WORKER_TOKEN: taskWorkerToken,
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
  const agent =
    taskWorkerId && taskWorkerToken
      ? { route: "task-worker" as const, id: taskWorkerId, token: taskWorkerToken }
      : botId && botToken
        ? { route: "worker" as const, id: botId, token: botToken }
        : null;
  if (!controlUrl || !agent) {
    throw new Error("CHIEFBOT_CONTROL_URL and CHIEFBOT_BOT_ID with CHIEFBOT_BOT_TOKEN (or the task worker's) must be set");
  }
  startWorker({
    controlUrl,
    ...agent,
    // The bot's workspace on its own disk (the image's WORKDIR). Git in the agent's
    // shell reaches github.com only through control's git proxy.
    copilot: copilotSdk({ workingDirectory: "/home/bot/workspace", gitConfig: gitProxyConfig({ controlUrl }) }),
    gitSocket: defaultGitSocket,
    onBound: () => console.log(`worker connected to ${controlUrl} as ${agent.id}`),
    onModelsError: (error) => console.error("could not list Copilot models:", error),
  });
}
