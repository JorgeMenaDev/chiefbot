import type { BotId } from "@chiefbot/contracts";

// The one planned seam: where a bot's computer runs. DockerProvider runs it as a
// local container; GceProvider (ticket #10) will run it as a Compute Engine VM.
// Every computer has a durable disk for the bot's home and workspace that
// survives stop/start, and is removed only by destroy({ deleteData: true }).

export type ComputerStatus = "absent" | "stopped" | "running";

export type ComputerSpec = {
  botId: BotId;
  // Handed to the worker at start. Carries the bot's credential, never a user's GitHub token.
  env: Record<string, string>;
};

export type ComputerProvider = {
  // Makes the computer and its disk, stopped.
  create(spec: ComputerSpec): Promise<void>;
  start(botId: BotId): Promise<void>;
  stop(botId: BotId): Promise<void>;
  // Removes the computer. Its disk is kept unless deleteData is true. Absent is fine.
  destroy(botId: BotId, options: { deleteData: boolean }): Promise<void>;
  status(botId: BotId): Promise<ComputerStatus>;
};
