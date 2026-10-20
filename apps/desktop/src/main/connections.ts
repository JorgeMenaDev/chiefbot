import {
  Connection,
  ConnectionCall,
  HealthReport,
  Service,
  ServiceHealth,
  ServiceResult,
  Template,
  type BotId,
  type ConnectionName,
  type EnvironmentInput,
  type ServiceId,
  type ServiceInput,
} from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type ConnectionsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
};

// The user's own connections and the template catalog (Connect apps), their bots'
// connection calls and control's health checks of them (Health), owned by Electron
// main: plain HTTP calls to control.
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
    templates: async () => Template.array().parse(await (await call("GET", "/templates")).json()),
    health: async () => HealthReport.parse(await (await call("GET", "/health")).json()),
    // Checks every connection and service again now; resolves once they are all checked.
    refreshHealth: async () => HealthReport.parse(await (await call("POST", "/health/refresh")).json()),
    // The user's own services on Health: each check resolves with every service once done.
    checkServices: async () => ServiceHealth.array().parse(await (await call("POST", "/health/services/check")).json()),
    checkService: async (id: ServiceId) => ServiceHealth.array().parse(await (await call("POST", `/health/services/${id}/check`)).json()),
    addService: async (input: ServiceInput) => Service.parse(await (await call("POST", "/health/services", input)).json()),
    updateService: async (id: ServiceId, input: ServiceInput) => Service.parse(await (await call("PUT", `/health/services/${id}`, input)).json()),
    removeService: async (id: ServiceId) => void (await call("DELETE", `/health/services/${id}`)),
    // Checks one environment of the Add/Edit dialog's unsaved form, keeping nothing.
    testEnvironment: async (input: EnvironmentInput) => ServiceResult.parse(await (await call("POST", "/health/services/test", input)).json()),
  };
}
