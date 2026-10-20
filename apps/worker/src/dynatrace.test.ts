import { expect, test } from "bun:test";
import { ConnectionDefinition, type AgentConnection } from "@chiefbot/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalFor } from "./approvals.ts";
import { fakeRequest } from "./fakeCopilot.ts";

// The Dynatrace connection the repo ships (connections/dynatrace/), as a turn gets it.
const folder = join(import.meta.dir, "../../../connections/dynatrace");
const definition = ConnectionDefinition.parse(Bun.YAML.parse(readFileSync(join(folder, "connection.yaml"), "utf8")));
const dynatrace: AgentConnection = {
  ...definition,
  name: "dynatrace",
  skill: "",
  fields: { environment: "https://abc12345.apps.dynatrace.com", token: "dt0s16.secret" },
};

test("dtctl's health reads run without asking; anything that changes Dynatrace or shows the token asks", () => {
  const ask = (command: string) => approvalFor(fakeRequest.shell(command), [dynatrace])?.detail ?? null;

  for (const read of [
    `dtctl query 'fetch dt.davis.problems, from:now()-24h' --agent`,
    "dtctl get slos -o wide",
    "dtctl describe slo 7c1f",
    "dtctl doctor",
    "dtctl version",
    "dtctl get workflows --help",
    "dtctl inspect /tmp/chiefbot/spill.jsonl --head 20",
  ]) {
    expect(ask(read)).toBeNull();
  }
  for (const write of [
    "dtctl apply -f workflow.yaml",
    "dtctl edit dashboard d-1",
    "dtctl delete slo 7c1f",
    "dtctl exec workflow wf-1",
    "dtctl config set-context other --environment https://evil.example",
    "dtctl ctx token",
    "dtctl --context other get slos",
  ]) {
    expect(ask(write)).toBe(`Dynatrace: ${write}`);
  }
});

test("the guard in front of dtctl refuses --config and --spill-to, however they are written, and passes the rest on", () => {
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["sh", join(folder, "guard.sh"), ...args]);
    return [result.exitCode, result.stderr.toString().trim()];
  };

  expect(run("get", "slos", "--config", "./repo-config.yaml")).toEqual([2, "dtctl: --config is turned off on this computer"]);
  expect(run("--config=./repo-config.yaml", "get", "slos")).toEqual([2, "dtctl: --config is turned off on this computer"]);
  expect(run("query", "fetch logs, from:now()-1h", "--spill-to", "/home/bot/result.jsonl")).toEqual([2, "dtctl: --spill-to is turned off on this computer"]);
  expect(run("inspect", "x.jsonl", "--spill-to=/home/bot/x.jsonl")).toEqual([2, "dtctl: --spill-to is turned off on this computer"]);
  // Anything else goes on to the real dtctl, which only the computer image has.
  expect(run("query", "fetch logs, from:now()-1h", "--spill=always")[1]).toContain("/usr/local/lib/dtctl/dtctl");
});

test("the config install.sh writes is the one the wrapper names, and reads the URL and token from the wrapper's variables", () => {
  const install = readFileSync(join(folder, "install.sh"), "utf8");

  expect(install).toContain(`cat > ${definition.env.DTCTL_CONFIG} <<'CONFIG'`);
  expect(install).toContain("environment: ${DT_ENVIRONMENT_URL}");
  expect(install).toContain("token: ${DT_API_TOKEN}");
  expect([definition.env.DT_ENVIRONMENT_URL, definition.env.DT_API_TOKEN]).toEqual(["{environment}", "{token}"]);
});
