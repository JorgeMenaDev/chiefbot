import {
  ChecklistItem,
  ConnectStart,
  Connector,
  ConnectorCall,
  type ConnectorInput,
  type ProjectId,
  type WorkspaceId,
} from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type ConnectorsOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
};

// A workspace's connectors and the user's access checklist, owned by Electron
// main: plain HTTP calls to control, which checks membership and roles on each.
export function createConnectors({ controlUrl, session }: ConnectorsOptions) {
  const call = controlCaller({ controlUrl, session });
  const base = (workspaceId: WorkspaceId) => `/workspaces/${workspaceId}/connectors`;

  return {
    list: async (workspaceId: WorkspaceId) => Connector.array().parse(await (await call("GET", base(workspaceId))).json()),
    // The owner only.
    define: async (workspaceId: WorkspaceId, input: ConnectorInput) =>
      Connector.parse(await (await call("POST", base(workspaceId), input)).json()),
    remove: async (workspaceId: WorkspaceId, name: string) => void (await call("DELETE", `${base(workspaceId)}/${name}`)),
    // The owner only: whether the connector's tools that may write run without the member's approval.
    setWritesWithoutApproval: async (workspaceId: WorkspaceId, name: string, writesWithoutApproval: boolean) =>
      Connector.parse(await (await call("PUT", `${base(workspaceId)}/${name}/approval`, { writesWithoutApproval })).json()),
    // The workspace's credential (owner only), or the user's own token.
    setSecret: async (workspaceId: WorkspaceId, name: string, token: string) =>
      void (await call("PUT", `${base(workspaceId)}/${name}/secret`, { token })),
    setToken: async (workspaceId: WorkspaceId, name: string, token: string) =>
      void (await call("PUT", `${base(workspaceId)}/${name}/token`, { token })),
    // The connect action: an OAuth sign-in to open in the browser, or "token".
    connect: async (workspaceId: WorkspaceId, name: string) =>
      ConnectStart.parse(await (await call("POST", `${base(workspaceId)}/${name}/connect`)).json()),
    checklist: async (workspaceId: WorkspaceId) =>
      ChecklistItem.array().parse(await (await call("GET", `/workspaces/${workspaceId}/checklist`)).json()),
    // A project's connector call log.
    calls: async (projectId: ProjectId) => ConnectorCall.array().parse(await (await call("GET", `/projects/${projectId}/connector-calls`)).json()),
  };
}
