import type { BotId, ProjectId, TaskWorkerId } from "@chiefbot/contracts";

// The one planned seam: where a computer runs. DockerProvider runs it as a
// local container; GceProvider runs it as a Compute Engine VM.
// Every computer has a durable disk for its home and workspace that
// survives stop/start, and is removed only by destroy({ deleteData: true }).

export type ComputerStatus = "absent" | "stopped" | "running";

// A bot's computer, a project's (the one its coordinator runs on), or a task worker's throwaway one.
export type ComputerId = BotId | ProjectId | TaskWorkerId;

export type ComputerSpec = {
  id: ComputerId;
  // Handed to the worker at start. Carries the bot's, project's or task worker's credential, never a user's GitHub token.
  env: Record<string, string>;
};

export type ComputerProvider = {
  // Makes the computer and its disk. Docker leaves it stopped; a GCE VM boots on
  // creation. Call start next either way.
  create(spec: ComputerSpec): Promise<void>;
  start(id: ComputerId): Promise<void>;
  stop(id: ComputerId): Promise<void>;
  // Removes the computer. Its disk is kept unless deleteData is true. Absent is fine.
  destroy(id: ComputerId, options: { deleteData: boolean }): Promise<void>;
  status(id: ComputerId): Promise<ComputerStatus>;
};
