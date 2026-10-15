import { expect, test } from "bun:test";
import { agentEnv } from "./copilotSdk.ts";

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
