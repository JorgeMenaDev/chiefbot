import { startWorker } from "./worker.ts";

// Entry point inside a bot computer. Env (set by the ComputerProvider at start):
//   CHIEFBOT_CONTROL_URL  control as seen from the computer
//   CHIEFBOT_BOT_TOKEN    this bot's credential
const controlUrl = process.env.CHIEFBOT_CONTROL_URL;
const botToken = process.env.CHIEFBOT_BOT_TOKEN;
if (!controlUrl || !botToken) throw new Error("CHIEFBOT_CONTROL_URL and CHIEFBOT_BOT_TOKEN must be set");

startWorker({ controlUrl, botToken, onBound: (botId) => console.log(`worker connected to ${controlUrl} as ${botId}`) });
