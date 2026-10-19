import { Connection, ConnectionCall, type BotId, type ConnectionName } from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type ConnectionsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
};

// The user's own connections (Connect apps) and their bots' connection calls,
// owned by Electron main: plain HTTP calls to control.
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
  };
}
