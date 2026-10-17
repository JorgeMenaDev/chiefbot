import { z } from "zod";
import { WorkspaceId } from "./ids.ts";

// A connector's name: how a project's chiefbot.project.yaml asks for it, and the
// MCP server name agents see. Lower-case letters, digits and hyphens.
export const ConnectorName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "expected lower-case letters, digits and hyphens, like github-actions");
export type ConnectorName = z.infer<typeof ConnectorName>;

// Where a connector's MCP server runs.
//   remote   a Streamable HTTP MCP server at `url`. Agents reach it only through
//            control, which adds the identity's token to each request
//            (`Authorization: Bearer …`), so tokens never reach a computer.
//   command  a stdio MCP server the agent's computer starts: `command` with `args`
//            and `env`. The identity's token, if any, goes in the variable `tokenEnv`.
export const ConnectorServer = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("remote"), url: z.url({ protocol: /^https?$/ }) }),
  z.strictObject({
    kind: z.literal("command"),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  }),
]);
export type ConnectorServer = z.infer<typeof ConnectorServer>;

// Whose identity a connector's calls run as:
//   none              no credential
//   workspace-secret  the workspace's one service credential, which its owner sets
//   personal-oauth    the member whose turn makes the call: their own OAuth sign-in
//                     when the MCP server supports it, or a token they paste
export const ConnectorAuth = z.enum(["none", "workspace-secret", "personal-oauth"]);
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

// A connector as the workspace owner defines it (body of POST /workspaces/:id/connectors).
// `scope` is the OAuth scope a personal sign-in asks for (space-separated); empty
// asks for the server's default.
export const ConnectorInput = z.strictObject({
  name: ConnectorName,
  title: z.string().trim().min(1).max(60),
  server: ConnectorServer,
  auth: ConnectorAuth,
  scope: z.string().trim().max(500).default(""),
});
export type ConnectorInput = z.infer<typeof ConnectorInput>;

// A workspace's connector. `hasWorkspaceSecret`: its owner has set the service credential.
export const Connector = ConnectorInput.extend({ workspaceId: WorkspaceId, hasWorkspaceSecret: z.boolean() });
export type Connector = z.infer<typeof Connector>;

// Body of PUT /workspaces/:id/connectors/:name/secret (the workspace's credential)
// and PUT /workspaces/:id/connectors/:name/token (the member's own token).
export const ConnectorTokenRequest = z.object({ token: z.string().trim().min(1).max(10_000) });
export type ConnectorTokenRequest = z.infer<typeof ConnectorTokenRequest>;

// Answer of POST /workspaces/:id/connectors/:name/connect, the member's connect action:
//   oauth  open `authorizeUrl` in the browser; control finishes the sign-in on its callback
//   token  the MCP server offers no sign-in control can run: paste a token instead
export const ConnectStart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("oauth"), authorizeUrl: z.url() }),
  z.object({ kind: z.literal("token") }),
]);
export type ConnectStart = z.infer<typeof ConnectStart>;

// One line of a member's access checklist in a workspace: a connector the
// workspace's projects declare, and what it still needs.
//   ready            calls can run (no auth, the workspace secret is set, or the member is connected)
//   connect          personal-oauth and the member has not connected: theirs to do
//   workspace-secret the owner has not set the workspace's credential
//   not-defined      no connector of that name in the workspace: the owner adds one
export const ChecklistStatus = z.enum(["ready", "connect", "workspace-secret", "not-defined"]);
export type ChecklistStatus = z.infer<typeof ChecklistStatus>;

export const ChecklistItem = z.object({
  name: z.string(),
  // The connector's title; null while it is not defined.
  title: z.string().nullable(),
  auth: ConnectorAuth.nullable(),
  // Names of the projects that declare it.
  projects: z.array(z.string()),
  status: ChecklistStatus,
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

// Whose identity one connector call ran as: none, the workspace's credential, or the requester's own.
export const CallIdentity = z.enum(["none", "workspace", "personal"]);
export type CallIdentity = z.infer<typeof CallIdentity>;

// One logged connector call of a project (GET /projects/:id/connector-calls).
// `requester` is the login of the member whose turn made it; `run` is that
// coordinator turn's id. `at` is epoch milliseconds.
export const ConnectorCall = z.object({
  connector: z.string(),
  tool: z.string(),
  requester: z.string(),
  identity: CallIdentity,
  run: z.string(),
  at: z.number(),
});
export type ConnectorCall = z.infer<typeof ConnectorCall>;

// A connector as an agent session gets it (in a coordinator's run-turn):
//   remote   reached through control at <control>/coordinator/:projectId/mcp/:name
//   command  started on the computer; `env` already holds the identity's token
export const AgentConnector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remote"), name: ConnectorName }),
  z.object({
    kind: z.literal("command"),
    name: ConnectorName,
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  }),
]);
export type AgentConnector = z.infer<typeof AgentConnector>;

// Ready-made connectors the owner adds in one click. Data, not code paths: each
// is an ordinary ConnectorInput. docs/connectors.md has more examples.
//   github          the official GitHub MCP server (remote), its default toolsets
//   github-actions  the same server limited to its Actions toolset (workflows, runs, logs)
//   jira            Atlassian's remote MCP server (Jira and Confluence)
export const connectorPresets: ConnectorInput[] = [
  { name: "github", title: "GitHub", server: { kind: "remote", url: "https://api.githubcopilot.com/mcp/" }, auth: "personal-oauth", scope: "" },
  {
    name: "github-actions",
    title: "GitHub Actions",
    server: { kind: "remote", url: "https://api.githubcopilot.com/mcp/x/actions" },
    auth: "personal-oauth",
    scope: "",
  },
  { name: "jira", title: "Jira", server: { kind: "remote", url: "https://mcp.atlassian.com/v1/mcp" }, auth: "personal-oauth", scope: "" },
];

// Body of POST /coordinator/:projectId/connector-calls: a call to a command
// connector, which runs on the computer, so the agent reports it for the log.
// (Control logs remote connectors' calls itself, in its proxy.)
export const ReportedConnectorCall = z.object({ connector: ConnectorName, tool: z.string().min(1).max(200) });
export type ReportedConnectorCall = z.infer<typeof ReportedConnectorCall>;
