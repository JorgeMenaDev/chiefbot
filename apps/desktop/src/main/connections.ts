import { Connection, ConnectionCall, HealthReport, type BotId, type ConnectionName } from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type ConnectionsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
};

// The user's own connections (Connect apps), their bots' connection calls and
// control's health checks of them (Health), owned by Electron main: plain HTTP calls to control.
export function createConnections({ controlUrl, session }: ConnectionsOptions) {
  const call = controlCaller({ controlUrl, session });
  return {
    list: async () => Connection.array().parse(await (await call("GET", "/connections")).json()),
    // Saves every field (secret ones included), which turns the connection on.
    connect: async (name: ConnectionName, fields: Record<string, string>) =>
      Connection.parse(await (await call("PUT", `/connections/${name}`, { fields })).json()),
    // Turns it off: control deletes its fields.
    disconnect: async (name: ConnectionName) => void (await call("DELETE", `/connections/${name}`)),
    calls: async (botId: BotId) => ConnectionCall.array().parse(await (await call("GET", `/bots/${botId}/connection-calls`)).json()),
    health: async () => HealthReport.parse(await (await call("GET", "/health")).json()),
    // Checks every connection again now; resolves once they are all checked.
    refreshHealth: async () => HealthReport.parse(await (await call("POST", "/health/refresh")).json()),
  };
}
