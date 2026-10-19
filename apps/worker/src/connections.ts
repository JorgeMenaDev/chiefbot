import type { PermissionRequest } from "@github/copilot-sdk";
import type { AgentConnection, ReportedConnectionCall } from "@chiefbot/contracts";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Where a bot's computer stages its owner's connections for one turn: outside the
// bot's disk (/home/bot), so nothing of them outlives the container, and removed
// at the turn's end and at the worker's start (a turn a crash cut short).
//   bin/<cli>                  a wrapper that runs the CLI with the connection's env
//   connections/<name>/<field> each field's value, readable by user bot only
//   skills/<name>/SKILL.md     the skill, under the root the session's skillDirectories name
//   calls                      what the wrappers ran: per run, NUL-terminated, the
//                              CLI, its argument count and its arguments
// The runtime's shell has bin/ first on its PATH (copilotSdk.ts).
export const connectionsRoot = "/tmp/chiefbot";

// Writes `connections` under `root` for the turn, replacing whatever was there.
// Returns the session's skill roots (none without a connection), `calls`, which
// gives the runs of the connections' CLIs since its last call, and `cleanup`,
// which removes it all. A connection that is off has nothing here: its bare CLI
// runs with no credential. Staging that fails removes what it wrote, then throws.
export function stageConnections(root: string, connections: AgentConnection[]) {
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  cleanup();
  if (connections.length === 0) return { skillDirectories: [], calls: (): ReportedConnectionCall[] => [], cleanup };
  try {
    write(root, connections);
  } catch (error) {
    cleanup();
    throw error;
  }
  let seen = 0;
  return {
    skillDirectories: [join(root, "skills")],
    calls() {
      const runs = existsSync(join(root, "calls")) ? parseRuns(readFileSync(join(root, "calls"), "utf8")).slice(seen) : [];
      seen += runs.length;
      return runs.flatMap(([cli, ...args]) => {
        const connection = connections.find((candidate) => candidate.cli === cli);
        return connection ? [{ connection: connection.name, command: logged(connection, args) }] : [];
      });
    },
    cleanup,
  };
}

function write(root: string, connections: AgentConnection[]) {
  const folder = (...path: string[]) => {
    mkdirSync(join(root, ...path), { recursive: true, mode: 0o700 });
    return join(root, ...path);
  };
  chmodSync(folder(), 0o700);
  writeFileSync(join(root, "calls"), "", { mode: 0o600 });
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
      "# Each run is logged for the worker to report.",
      `printf '%s\\0' ${quoted(cli)} "$#" "$@" >> ${quoted(join(root, "calls"))}`,
      "# The real CLI is behind this wrapper on PATH.",
      `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -Fvx ${quoted(join(root, "bin"))} | paste -sd: -)`,
      `exec ${cli} "$@"`,
      "",
    ];
    writeFileSync(join(folder("bin"), cli), wrapper.join("\n"), { mode: 0o700 });
  }
}

// A shell word that is exactly `value`.
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// The whole runs in the calls log, each as the CLI and its arguments. A run
// still being written is left for a later read.
function parseRuns(text: string) {
  // The last field follows the last NUL: unfinished, or empty.
  const fields = text.split("\0");
  const runs: string[][] = [];
  for (let at = 0; at + 1 < fields.length; ) {
    const count = Number(fields[at + 1]);
    if (at + 2 + count >= fields.length) break;
    runs.push([fields[at] ?? "", ...fields.slice(at + 2, at + 2 + count)]);
    at += 2 + count;
  }
  return runs;
}

// How a run of `connection`'s CLI with `args` is logged: the CLI and the leading
// words a read-only glob of the connection names before its first wildcard. Those
// are subcommands, never values; a command no glob names is logged as the bare CLI.
function logged(connection: AgentConnection, args: string[]) {
  const words = [connection.cli, ...args];
  const named = Math.max(
    1,
    ...connection.readOnly.map((glob) => {
      const literal = glob.trim().split(/\s+/);
      let n = 0;
      while (n < literal.length && n < words.length && !/[*?]/.test(literal[n] ?? "") && literal[n] === words[n]) n++;
      return n;
    }),
  );
  return words.slice(0, named).join(" ");
}

// What a shell request runs of `connections`' CLIs that needs the owner's
// approval: each command that matches none of its connection's read-only globs
// (leading variable assignments dropped, the CLI by its bare name). When the
// request names a CLI anywhere the runtime's parsed segments do not show it
// running (`env X=1 acli …`, `sh -c "…"`, no segments), the whole command asks.
// A script that runs the CLI is not seen here: approvals are a guardrail.
export function connectionWrites(request: PermissionRequest, connections: AgentConnection[]) {
  if (request.kind !== "shell") return [];
  const text = request.fullCommandText.trim();
  return connections.flatMap((connection) => {
    const mentions = text.match(new RegExp(`(?<![\\w.-])${escape(connection.cli)}(?![\\w.-])`, "g"))?.length ?? 0;
    if (mentions === 0) return [];
    const runs = (request.commandSegments ?? []).flatMap(({ identifier, fullCommandText }) => {
      if (basename(identifier) !== connection.cli) return [];
      const words = fullCommandText.trim().split(/\s+/);
      while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
      words[0] = connection.cli;
      return [words.join(" ")];
    });
    if (runs.length !== mentions) return [{ connection, command: text }];
    return runs.filter((command) => !connection.readOnly.some((glob) => matches(glob, command))).map((command) => ({ connection, command }));
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whether `command` matches the shell glob `glob` as a whole: `*` is any text, `?` one character.
function matches(glob: string, command: string) {
  const pattern = escape(glob.trim().split(/\s+/).join(" ").replaceAll("*", "\0").replaceAll("?", "\x01"))
    .replaceAll("\0", ".*")
    .replaceAll("\x01", ".");
  return new RegExp(`^${pattern}$`, "s").test(command);
}
