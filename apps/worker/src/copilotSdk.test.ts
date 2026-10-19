import { expect, test } from "bun:test";
import { agentEnv, coordinatorSessionConfig, workerSessionConfig } from "./copilotSdk.ts";
import { coordinatorTools } from "./coordinatorTools.ts";

test("the agent's shell gets no GitHub token and no bot or task worker credential, so gh and the broker are out of reach", () => {
  const env = agentEnv({
    PATH: "/usr/bin",
    HOME: "/home/bot",
    GH_TOKEN: "gho_a",
    GITHUB_TOKEN: "gho_b",
    COPILOT_GITHUB_TOKEN: "gho_c",
    GH_ENTERPRISE_TOKEN: "gho_d",
    GITHUB_ENTERPRISE_TOKEN: "gho_e",
    CHIEFBOT_BOT_ID: "bot_1",
    CHIEFBOT_BOT_TOKEN: "secret",
    CHIEFBOT_TASK_WORKER_TOKEN: "secret too",
  });

  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/bot", CHIEFBOT_BOT_ID: "bot_1" });
});

test("a coordinator session may use only its task, context and worker tools: no shell, no files, no MCP without connectors", () => {
  const tools = coordinatorTools(async () => "[]");

  const config = coordinatorSessionConfig({
    sessionId: "project_1-user_1",
    auth: { kind: "seat", gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }) },
    onPermissionRequest: async () => ({ kind: "reject" }),
    tools,
    instructions: "Coordinate.",
  });

  expect(config.availableTools).toEqual([
    "custom:create_task",
    "custom:update_task",
    "custom:list_tasks",
    "custom:read_context",
    "custom:write_context",
    "custom:dispatch_worker",
    "custom:worker_status",
    "custom:worker_transcript",
    "custom:stop_worker",
  ]);
  expect(config.systemMessage).toEqual({ mode: "append", content: "Coordinate." });
});

test("a coordinator session with connectors also gets their MCP servers' tools, and reports each call", async () => {
  const reported: string[] = [];
  const config = coordinatorSessionConfig({
    sessionId: "project_1-user_1",
    auth: { kind: "seat", gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }) },
    onPermissionRequest: async () => ({ kind: "reject" }),
    tools: coordinatorTools(async () => "[]"),
    mcpServers: { jira: { type: "http", url: "http://control/coordinator/project_1/mcp/jira", tools: ["*"] } },
    onMcpCall: async (server, tool) => void reported.push(`${server}/${tool}`),
  });
  const call = { sessionId: "s", timestamp: new Date(), workingDirectory: "/", serverName: "jira", toolName: "search", arguments: {} };
  await config.hooks?.onPreMcpToolCall(call);

  expect(config.availableTools.at(-1)).toBe("mcp:*");
  expect(Object.keys(config.mcpServers ?? {})).toEqual(["jira"]);
  expect(reported).toEqual(["jira/search"]);
});

test("a worker session gets its connectors' MCP servers and reports each call", async () => {
  const reported: string[] = [];
  const config = workerSessionConfig("/home/bot/workspace")({
    sessionId: "worker_1",
    auth: { kind: "seat", gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }) },
    onPermissionRequest: async () => ({ kind: "reject" }),
    tools: [],
    mcpServers: { jira: { type: "http", url: "http://control/task-worker/worker_1/mcp/jira", tools: ["*"] } },
    onMcpCall: async (server, tool) => void reported.push(`${server}/${tool}`),
  });
  const call = { sessionId: "s", timestamp: new Date(), workingDirectory: "/", serverName: "jira", toolName: "search", arguments: {} };
  await config.hooks?.onPreMcpToolCall?.(call);

  expect(config.workingDirectory).toBe("/home/bot/workspace");
  expect(Object.keys(config.mcpServers ?? {})).toEqual(["jira"]);
  expect(reported).toEqual(["jira/search"]);
});

test("a worker session loads skills only from the roots its turn names, and names none without them", () => {
  const options = {
    sessionId: "bot_1",
    auth: { kind: "seat" as const, gitHubTokenProvider: async () => ({ kind: "token" as const, accessToken: "gho_a", expiresIn: 3600 }) },
    onPermissionRequest: async () => ({ kind: "reject" as const }),
    tools: [],
  };

  const withSkills = workerSessionConfig("/home/bot/workspace")({ ...options, skillDirectories: ["/tmp/chiefbot/skills"] });
  const without = workerSessionConfig("/home/bot/workspace")(options);

  expect([withSkills.enableSkills, withSkills.skillDirectories]).toEqual([true, ["/tmp/chiefbot/skills"]]);
  expect(without.skillDirectories).toEqual([]);
});
