import { z } from "zod";
import { ConnectorName } from "./connectors.ts";

// A connection: a CLI a person's own bots use as that person, with a credential
// they paste (docs/connections.md). The repo ships one folder per connection,
// connections/<name>/: connection.yaml (ConnectionDefinition), SKILL.md (what the
// agent learns while it is on) and install.sh (puts the CLI on the computer).
// Unlike a connector, it belongs to a person, not a workspace, and its
// credential reaches the person's own bot's computer for the length of a turn.

// A connection's name is its folder's name, with a connector's naming rule.
export const ConnectionName = ConnectorName;
export type ConnectionName = z.infer<typeof ConnectionName>;

// One value the person pastes. A secret one is a password field, kept in control's
// SecretStore and never sent back to the desktop.
export const ConnectionField = z.strictObject({
  label: z.string().trim().min(1).max(80),
  secret: z.boolean().default(false),
});
export type ConnectionField = z.infer<typeof ConnectionField>;

// The `{x}` placeholders of an env template.
const placeholders = (template: string) => [...template.matchAll(/\{([^{}]*)\}/g)].map(([, name]) => name ?? "");

// connections/<name>/connection.yaml.
//   cli       the command the agent runs; a shell command naming it is the connection's
//   fields    what the person pastes, by name; every one is required
//   env       what the CLI's process gets, as templates: {field} is that field's value and
//             {dir} the connection's folder on the computer for the turn
//   readOnly  shell globs over one command (`*` is any text): a command of `cli` that
//             matches one runs without asking; any other waits for the person's approval
export const ConnectionDefinition = z
  .strictObject({
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(200),
    cli: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "expected a command name, like acli"),
    fields: z.record(z.string().regex(/^[a-z][a-z0-9]*$/, "expected lower-case letters and digits, like token"), ConnectionField),
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "expected an environment variable name"), z.string()).default({}),
    readOnly: z.array(z.string().trim().min(1)).default([]),
  })
  .superRefine(({ fields, env }, ctx) => {
    for (const [variable, template] of Object.entries(env)) {
      for (const name of placeholders(template)) {
        if (name !== "dir" && !(name in fields)) ctx.addIssue({ code: "custom", path: ["env", variable], message: `{${name}} names no field` });
      }
    }
  });
export type ConnectionDefinition = z.infer<typeof ConnectionDefinition>;

// One row of GET /connections: a connection the repo ships, and whether the person
// has it on (every field saved). Never a secret's value.
export const Connection = z.object({
  name: ConnectionName,
  title: z.string(),
  description: z.string(),
  fields: z.record(z.string(), ConnectionField),
  on: z.boolean(),
});
export type Connection = z.infer<typeof Connection>;

// Body of PUT /connections/:name: every field, secret ones included. It replaces
// the saved ones and turns the connection on.
export const ConnectRequest = z.object({ fields: z.record(z.string(), z.string().trim().min(1).max(20_000)) });
export type ConnectRequest = z.infer<typeof ConnectRequest>;

// A connection as a bot's computer gets it for one turn (run-turn): its `fields`
// values, which the computer writes to files in the connection's folder, and its
// `env` templates, which the computer fills in ({field} and {dir}, the folder only
// it knows) and hands the CLI through a wrapper. `skill` is its SKILL.md.
export const AgentConnection = z.object({
  name: ConnectionName,
  title: z.string(),
  cli: z.string(),
  skill: z.string(),
  fields: z.record(z.string(), z.string()),
  env: z.record(z.string(), z.string()),
  readOnly: z.array(z.string()),
});
export type AgentConnection = z.infer<typeof AgentConnection>;

// Body of POST /worker/:botId/connection-calls: a run of a connection's CLI, as the
// CLI and the leading subcommands one of its read-only globs names (never a flag or
// a value; a command no glob names is the bare CLI), reported with the turn's key.
export const ReportedConnectionCall = z.object({ connection: ConnectionName, command: z.string().min(1).max(200) });
export type ReportedConnectionCall = z.infer<typeof ReportedConnectionCall>;

// One logged connection call of a bot (GET /bots/:id/connection-calls). `run` is
// the turn's id; `at` is epoch milliseconds.
export const ConnectionCall = ReportedConnectionCall.extend({ run: z.string(), at: z.number() });
export type ConnectionCall = z.infer<typeof ConnectionCall>;
