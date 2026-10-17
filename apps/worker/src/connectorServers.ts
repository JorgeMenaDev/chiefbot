import type { MCPServerConfig } from "@github/copilot-sdk";
import type { AgentConnector, UserId } from "@chiefbot/contracts";

// The SDK's MCP server config for an agent session's connectors (from control).
// A remote connector is reached through control's proxy at
// `<base>/mcp/<name>` with the computer's credential and the member the session
// runs for; control adds the real identity per call. A command connector is
// started on this computer with the env control sent (its token included).
export function connectorServers(
  connectors: AgentConnector[],
  { base, credential, member }: { base: string; credential: string; member: UserId },
): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    connectors.map((connector): [string, MCPServerConfig] =>
      connector.kind === "remote"
        ? [
            connector.name,
            {
              type: "http",
              url: `${base}/mcp/${connector.name}`,
              headers: { authorization: `Bearer ${credential}`, "x-chiefbot-member": member },
              tools: ["*"],
            },
          ]
        : [connector.name, { type: "local", command: connector.command, args: connector.args, env: connector.env, tools: ["*"] }],
    ),
  );
}
