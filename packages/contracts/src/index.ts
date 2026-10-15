// Typed messages shared by the desktop app, the control plane and the bot worker.
// Every message that crosses a process boundary is defined here as a Zod schema.
export * from "./ids.ts";
export * from "./auth.ts";
