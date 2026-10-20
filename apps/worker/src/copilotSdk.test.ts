import { expect, test } from "bun:test";
import type { QuestionRequest } from "./copilot.ts";
import { agentEnv, askUser, coordinatorSessionConfig, workerSessionConfig } from "./copilotSdk.ts";
import { coordinatorTools } from "./coordinatorTools.ts";
import { sdk } from "./fakeCopilot.ts";

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

test("a coordinator session with the repo's skill folders loads skills from them: the runtime's skill tool is the only one of its own it gets", () => {
  const config = coordinatorSessionConfig({
    sessionId: "project_1-user_1",
    auth: { kind: "seat", gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }) },
    onPermissionRequest: async () => ({ kind: "reject" }),
    tools: coordinatorTools(async () => "[]"),
    skillDirectories: ["/home/bot/repo/.agents/skills"],
  });

  expect(config.availableTools.filter((tool) => !tool.startsWith("custom:"))).toEqual(["builtin:skill"]);
  expect([config.enableSkills, config.skillDirectories]).toEqual([true, ["/home/bot/repo/.agents/skills"]]);
});

test("a coordinator session with helpers gets them as custom agents, and the runtime's task tool that starts them", () => {
  const explore = { name: "explore", tools: ["repo_read", "repo_search"], prompt: "Read the repo." };
  const config = coordinatorSessionConfig({
    sessionId: "project_1-user_1",
    auth: { kind: "seat", gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }) },
    onPermissionRequest: async () => ({ kind: "reject" }),
    tools: coordinatorTools(async () => "[]"),
    agents: [explore],
  });

  expect(config.availableTools.filter((tool) => !tool.startsWith("custom:"))).toEqual(["builtin:task"]);
  expect(config.customAgents).toEqual([explore]);
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

test("a worker session gets its instructions after the SDK's own system message", () => {
  const config = workerSessionConfig("/home/bot/workspace")({
    sessionId: "bot_1",
    auth: { kind: "seat", gitHubTokenProvider: async () => ({ kind: "token", accessToken: "gho_a", expiresIn: 3600 }) },
    onPermissionRequest: async () => ({ kind: "reject" }),
    tools: [],
    instructions: "You have your own computer.",
  });

  expect(config.systemMessage).toEqual({ mode: "append", content: "You have your own computer." });
});

test("ask_user forms: each SDK call gets the request id of the elicitation.requested event it was dispatched with, and close cancels the rest", async () => {
  const asked: QuestionRequest[] = [];
  const asks = askUser({
    async ask(request) {
      asked.push(request);
      return { action: "decline" };
    },
    ended: () => {},
  });
  const { onElicitationRequest, onEvent } = asks.config;
  const call = () => onElicitationRequest({ sessionId: "bot_1", message: "Same form", mode: "form" });
  // As the SDK dispatches each event: its own handler first, then the subscribers
  // (onEvent among them, subscribed before the session opened).
  const dispatch = (requestId: string) => {
    const answer = call();
    onEvent(sdk.elicitationRequested(requestId, "Same form"));
    return answer;
  };

  const answers = await Promise.all([dispatch("request-1"), dispatch("request-2")]);
  onEvent(sdk.elicitationRequested("request-3", "Nobody's handler asked this"));
  const unmatched = call();
  asks.close();

  expect(asks.config.askUserVariant).toBe("elicitation");
  expect(answers).toEqual([{ action: "decline" }, { action: "decline" }]);
  expect(await unmatched).toEqual({ action: "cancel" });
  expect(asked).toEqual([
    { sessionId: "bot_1", message: "Same form", mode: "form", requestId: "request-1" },
    { sessionId: "bot_1", message: "Same form", mode: "form", requestId: "request-2" },
  ]);
});

test("ask_user forms: the config's onEvent, which the SDK subscribes before the session opens, reports each resolved request", () => {
  const ended: string[] = [];
  const { onEvent } = askUser({ ask: async () => ({ action: "cancel" }), ended: (requestId) => ended.push(requestId) }).config;

  onEvent(sdk.elicitationCompleted("request-1"));
  onEvent(sdk.idle());
  onEvent(sdk.elicitationCompleted("request-2", "accept"));

  expect(ended).toEqual(["request-1", "request-2"]);
});
