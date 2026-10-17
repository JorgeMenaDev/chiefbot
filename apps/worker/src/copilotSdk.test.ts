import { expect, test } from "bun:test";
import { agentEnv, coordinatorSessionConfig } from "./copilotSdk.ts";
import { coordinatorTools } from "./coordinatorTools.ts";

test("the agent's shell gets no GitHub token and no bot credential, so gh and the broker are out of reach", () => {
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
  });

  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/bot", CHIEFBOT_BOT_ID: "bot_1" });
});

test("a coordinator session may use only its task and context tools: no shell, no files, no MCP without connectors", () => {
  const tools = coordinatorTools(async () => "[]");

  const config = coordinatorSessionConfig({
    sessionId: "project_1-user_1",
    gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }),
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
  ]);
  expect(config.systemMessage).toEqual({ mode: "append", content: "Coordinate." });
});

test("a coordinator session with connectors also gets their MCP servers' tools, and reports each call", async () => {
  const reported: string[] = [];
  const config = coordinatorSessionConfig({
    sessionId: "project_1-user_1",
    gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }),
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
