# Connectors and the access checklist

A **connector** is an MCP server a workspace defines once. A project asks for the connectors its agents need by name, in its `chiefbot.project.yaml`:

```yaml
connectors: [github, github-actions, jira]
```

Control gives each agent session only those connectors, and only the ones ready for the member the session works for. Every call is logged.

## A connector

| Field | Meaning |
| --- | --- |
| `name` | How project files name it, and the MCP server name agents see. Lower-case letters, digits and hyphens. |
| `title` | What the desktop shows. |
| `server` | `remote`: a Streamable HTTP MCP server at `url`. `command`: a stdio MCP server the agent's computer starts (`command`, `args`, `env`), with the identity's token in the variable `tokenEnv`. |
| `auth` | `none`, `workspace-secret` (one service credential the workspace owner sets) or `personal-oauth` (each member's own account). |
| `scope` | The OAuth scope a personal sign-in asks for. Empty asks for the server's default. |

The workspace owner adds, deletes and sets the secrets of connectors. Members connect their own accounts. Secrets go through control's `SecretStore` (encrypted in SQLite locally, Secret Manager on GCP) and never appear in an API answer.

## Identity per call

- **Remote connectors** are reached only through control: each agent session gets `<control>/coordinator/<project>/mcp/<name>` as the server's URL, with the computer's own credential. For each request control picks the identity (no credential, the workspace secret, or the member's own token), adds it as `Authorization: Bearer …` and forwards the request. Tokens never reach a computer. A tool call is only accepted during a turn of the member the session belongs to.
- **Command connectors** run on the agent's computer, so their token (if any) is in the process's environment there. Prefer remote servers where a vendor offers one.
- A member's OAuth sign-in is refreshed by control shortly before it expires.

## The call log

Each tool call is logged with the connector, the tool, who asked (the member whose turn made it), the identity used (`none`, `workspace` or `personal`), the project and the run (the coordinator turn). Control logs remote calls in its proxy. A command connector's call is reported by the agent through the SDK's pre-MCP-call hook. The desktop shows a project's log under **Connector calls**; the API is `GET /projects/:id/connector-calls`.

## The checklist

For each member, the **Connectors** screen of a workspace lists every connector its projects declare, minus what is ready for that member:

- **Connect your own account**: a `personal-oauth` connector the member has not connected. **Connect** runs the MCP server's own OAuth sign-in in the browser when the server offers one control can run (OAuth metadata with dynamic client registration, as the MCP authorization spec describes). Otherwise it shows a token field.
- **Set the workspace's service token**: a `workspace-secret` connector whose secret is not set. Only the owner can set it.
- **Not defined**: no connector of that name in the workspace. The owner adds it, in one click when a preset has that name.

A member who connects after their chat with a coordinator started gets the connector from their next message: the coordinator resumes their session with the new set.

## Presets

Presets are data (`connectorPresets` in `packages/contracts/src/connectors.ts`), not code paths:

| Name | Server | Notes |
| --- | --- | --- |
| `github` | `https://api.githubcopilot.com/mcp/` | GitHub's official remote MCP server. GitHub offers no dynamic client registration, so members paste a fine-grained personal access token. |
| `github-actions` | `https://api.githubcopilot.com/mcp/x/actions` | The same server limited to its Actions toolset: workflows, runs and logs. |
| `jira` | `https://mcp.atlassian.com/v1/mcp` | Atlassian's remote MCP server (Jira and Confluence), with OAuth 2.1 sign-in. |

## More examples

Add these with the custom connector form. Check each vendor's documentation for the current URL and the token it takes.

| Tool | Connector |
| --- | --- |
| GitLab | Remote `https://<your GitLab host>/api/v4/mcp`, `personal-oauth`, scope `mcp`. GitLab's MCP server signs members in with OAuth and dynamic client registration. |
| Harness | Command `npx -y harness-mcp-v2`, `workspace-secret`, token variable `HARNESS_API_KEY`. Harness's official MCP server (github.com/harness/mcp-server); it also has a hosted version. |
| Dynatrace | Command `npx -y @dynatrace-oss/dynatrace-mcp-server` with env `DT_ENVIRONMENT=https://<environment>.apps.dynatrace.com` (github.com/dynatrace-oss/dynatrace-mcp). Dynatrace also hosts a remote MCP server per environment. |

Any other MCP server works the same way: a remote URL or a command, an auth type and a scope.

## Limits

- Remote connectors must speak Streamable HTTP (the older SSE transport is not proxied).
- A pending OAuth sign-in lives in control's memory for ten minutes: after a control restart, click **Connect** again.
- Removing a member from a workspace leaves their connector secrets in the `SecretStore` until the connector is deleted.
- Subscriptions (README, **Subscriptions**) poll only remote connectors: control calls them itself, as the workspace's credential or the adding member's own, and logs each call with the subscription's id as the run.
- Workers (one task, one throwaway computer) get connectors the same way once they exist: `connectorServers` in `apps/worker` builds the SDK config.
