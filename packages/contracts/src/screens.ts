import { z } from "zod";

// Who drives a computer's screen (a bot's, or an engineer's). agent: the agent; a
// viewer only watches. human: a person took over (mouse and keyboard); the agent
// waits until hand-back: control refuses a bot's new chat turns, and a running
// turn's tool calls wait.
export const ScreenControl = z.enum(["agent", "human"]);
export type ScreenControl = z.infer<typeof ScreenControl>;
