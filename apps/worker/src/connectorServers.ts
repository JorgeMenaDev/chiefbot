import type { MCPServerConfig } from "@github/copilot-sdk";
import type { AgentConnector } from "@chiefbot/contracts";

// The SDK's MCP server config for an agent session's connectors (from control).
// A remote connector is reached at `remoteUrl(name)`: the control link's
// forwarder, which sends it to control's proxy with the turn's key; control
// adds the identity of that turn's member. A command connector is started on
// this computer with the env control sent, which holds no credential.
export function connectorServers(connectors: AgentConnector[], remoteUrl: (name: string) => string): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    connectors.map((connector): [string, MCPServerConfig] =>
      connector.kind === "remote"
        ? [
            connector.name,
            { type: "http", url: remoteUrl(connector.name), tools: ["*"] },
          ]
        : [connector.name, { type: "local", command: connector.command, args: connector.args, env: connector.env, tools: ["*"] }],
    ),
  );
}
