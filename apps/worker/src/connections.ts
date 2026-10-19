import type { PermissionRequest } from "@github/copilot-sdk";
import type { AgentConnection } from "@chiefbot/contracts";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Where a bot's computer stages its owner's connections for one turn: outside the
// bot's disk (/home/bot), so nothing of them outlives the container, and removed
// at the turn's end and at the worker's start (a turn a crash cut short).
//   bin/<cli>                  a wrapper that runs the CLI with the connection's env
//   connections/<name>/<field> each field's value, readable by user bot only
//   skills/<name>/SKILL.md     the skill, under the root the session's skillDirectories name
// The runtime's shell has bin/ first on its PATH (copilotSdk.ts).
export const connectionsRoot = "/tmp/chiefbot";

// Writes `connections` under `root` for the turn, replacing whatever was there.
// Returns the session's skill roots (none without a connection) and `cleanup`,
// which removes it all. A connection that is off has nothing here: its bare CLI
// runs with no credential.
export function stageConnections(root: string, connections: AgentConnection[]) {
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  cleanup();
  if (connections.length === 0) return { skillDirectories: [], cleanup };
  const folder = (...path: string[]) => {
    mkdirSync(join(root, ...path), { recursive: true, mode: 0o700 });
    return join(root, ...path);
  };
  chmodSync(folder(), 0o700);
  for (const { name, title, cli, skill, fields, env } of connections) {
    const dir = folder("connections", name);
    for (const [field, value] of Object.entries(fields)) writeFileSync(join(dir, field), value, { mode: 0o600 });
    writeFileSync(join(folder("skills", name), "SKILL.md"), skill, { mode: 0o600 });
    // {field} and {dir} in one pass, so a value that looks like a placeholder stays as it is.
    const rendered = Object.entries(env).map(
      ([variable, template]) => `export ${variable}=${quoted(template.replace(/\{([^{}]*)\}/g, (match, key: string) => (key === "dir" ? dir : (fields[key] ?? match))))}`,
    );
    const wrapper = [
      "#!/bin/sh",
      `# ${title}: runs ${cli} as the bot's owner, for this turn only (staged by Chiefbot).`,
      ...rendered,
      "# The real CLI is behind this wrapper on PATH.",
      `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -Fvx ${quoted(join(root, "bin"))} | paste -sd: -)`,
      `exec ${cli} "$@"`,
      "",
    ];
    writeFileSync(join(folder("bin"), cli), wrapper.join("\n"), { mode: 0o700 });
  }
  return { skillDirectories: [join(root, "skills")], cleanup };
}

// A shell word that is exactly `value`.
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// One command of a connection's CLI in a shell request: its text (leading
// variable assignments dropped, the CLI by its bare name), the name it is
// logged under, and whether it matches one of the connection's read-only globs.
export type ConnectionCallInRequest = { connection: AgentConnection; command: string; logged: string; readOnly: boolean };

// The commands of `connections`' CLIs in `request`, from the runtime's parsed
// segments of a shell command. Without segments, each command the runtime names
// as a connection's CLI counts as one that may write. Anything else (a script
// that runs the CLI, `sh -c "…"`) is not seen here: approvals are a guardrail.
export function connectionCalls(request: PermissionRequest, connections: AgentConnection[]): ConnectionCallInRequest[] {
  if (request.kind !== "shell" || connections.length === 0) return [];
  const byCli = (identifier: string) => connections.find(({ cli }) => cli === basename(identifier));
  if (!request.commandSegments) {
    return request.commands.flatMap(({ identifier }) => {
      const connection = byCli(identifier);
      return connection ? [{ connection, command: request.fullCommandText.trim(), logged: connection.cli, readOnly: false }] : [];
    });
  }
  return request.commandSegments.flatMap(({ identifier, fullCommandText }) => {
    const connection = byCli(identifier);
    if (!connection) return [];
    const words = fullCommandText.trim().split(/\s+/);
    while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    words[0] = connection.cli;
    const command = words.join(" ");
    // The CLI and its subcommands: the leading lower-case words, without flags or values like keys.
    const subcommands = words.findIndex((word, index) => index > 0 && !/^[a-z][a-z0-9-]*$/.test(word));
    const logged = words.slice(0, Math.min(subcommands === -1 ? words.length : subcommands, 4)).join(" ");
    return [{ connection, command, logged, readOnly: connection.readOnly.some((glob) => matches(glob, command)) }];
  });
}

// Whether `command` matches the shell glob `glob` as a whole: `*` is any text, `?` one character.
function matches(glob: string, command: string) {
  const pattern = glob
    .trim()
    .split(/\s+/)
    .join(" ")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${pattern}$`, "s").test(command);
}
