# Connectors and the access checklist

A **connector** is an MCP server a workspace defines once. A project asks for the connectors its agents need by name, in its config: its `chiefbot.project.yaml` or its settings in the app (README, Projects):

```yaml
connectors: [github, github-actions, jira]
```

Control gives each agent session only those connectors, and only the ones ready for the member the session works for. Every call is logged.

A **connection** (`docs/connections.md`) is different: a command-line tool, like Jira's `acli`, signed in with one person's own token for their own bots only, set up under **Connect apps** in the gear menu. Its credential is on the bot's computer during that person's turns, which a connector's never is.

## A connector

| Field | Meaning |
| --- | --- |
| `name` | How a project's config names it, and the MCP server name agents see. Lower-case letters, digits and hyphens. |
| `title` | What the desktop shows. |
| `server` | `remote`: a Streamable HTTP MCP server at `url`. `command`: a stdio MCP server the agent's computer starts (`command`, `args`, `env`). |
| `auth` | `none`, `workspace-secret` (one service credential the workspace owner sets) or `personal-oauth` (each member's own account). A `command` connector takes only `none`: control refuses any other with `400 invalid_connector`. |
| `scope` | The OAuth scope a personal sign-in asks for. Empty asks for the server's default. |
| `writesWithoutApproval` | Default `false`: each call to a tool that may write waits for the member's approval (below). The owner can turn it on for a connector they trust, from the connector's row or `PUT /workspaces/:id/connectors/:name/approval`. |

The workspace owner adds, deletes and sets the secrets of connectors. Members connect their own accounts. Secrets go through control's `SecretStore` (encrypted in SQLite locally, Secret Manager on GCP) and never appear in an API answer.

## Identity per call

- **Remote connectors** are reached only through control: each agent session gets `<control>/coordinator/<project>/mcp/<name>` (a project's worker: `<control>/task-worker/<worker>/mcp/<name>`, running as the member who asked for it) as the server's URL, through a forwarder on the agent's own computer: the session presents its turn's private forwarder secret (32 random bytes, forgotten when the turn ends; anything else gets `401`), and the forwarder adds the turn's key to each request as it goes out (so a new key after a control restart applies at once), which control issues when the turn starts and revokes when it ends. For each request control picks the identity (no credential, the workspace secret, or the member's own token), adds it as `Authorization: Bearer …` and forwards the request. Tokens never reach a computer. The member is always the one the key's turn runs for (the coordinator's scheduled turn, or the worker's task), never one a request names, and a request without a live key is refused (`403 invalid_turn_key`).
- **Command connectors** run on the agent's computer with no credential. A credential on a computer could be read by the agent and used without control seeing it, so a connector with one must be remote. Their `env` is plain configuration that members and agents can read: put no secret in it.
- A member's OAuth sign-in is refreshed by control shortly before it expires.

## Approvals

Before control's proxy forwards a call to a remote connector's tool, it checks the server's own `tools/list`: a tool is read-only only when its `annotations.readOnlyHint` is `true`. Any other call waits, held in control, until the member whose turn makes it approves it. So does every other request, whatever the server's annotations say (`resources/read`, `prompts/get`, an answer to the server, a `DELETE` that ends the session…): only the server's event stream (`GET`) and the messages `initialize`, `notifications/initialized`, `notifications/cancelled`, `ping` and `tools/list` pass without asking. A POST body that is not JSON-RPC is refused (`400 invalid_connector`). Every request, an open event stream included, is cut when its turn ends or its member leaves the workspace. The card shows in that member's chat with the coordinator (**Connector approval**, with the connector's title and the tool), or under the task for a worker, like a push. Declined, the agent gets `403 declined`; if the turn ends first, `409 no_turn`. An approval belongs to the turn that asked: it can be answered only while that turn runs, and only that turn's request uses it. A connector the owner marked `writesWithoutApproval` skips this. Control keeps each server's list of read-only tools for ten minutes.

A command connector runs on the agent's computer, so control cannot hold its calls: a worker asks the member itself before a tool that may write, and a coordinator has no shell, and no files for such a tool to touch but its copy of the repo, which each turn fetches again.

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
| `github` | `https://api.githubcopilot.com/mcp/readonly` | GitHub's official remote MCP server, in read-only mode: agents push and open pull requests only through control's git proxy and pull request tool, which ask first. GitHub offers no dynamic client registration, so members paste a fine-grained personal access token. |
| `github-actions` | `https://api.githubcopilot.com/mcp/x/actions/readonly` | The same server limited to its Actions toolset (workflows, runs and logs), read-only too. |
| `jira` | `https://mcp.atlassian.com/v1/mcp` | Atlassian's remote MCP server (Jira and Confluence), with OAuth 2.1 sign-in. |

## More examples

Add these with the custom connector form. Check each vendor's documentation for the current URL and the token it takes.

| Tool | Connector |
| --- | --- |
| GitLab | Remote `https://<your GitLab host>/api/v4/mcp`, `personal-oauth`, scope `mcp`. GitLab's MCP server signs members in with OAuth and dynamic client registration. |
| Harness | Remote: Harness's hosted MCP server (github.com/harness/mcp-server documents its URL), `workspace-secret` with a Harness API key. For your own bots, the Harness connection (`docs/connections.md`) is simpler. |
| Dynatrace | Remote: the MCP server Dynatrace hosts for each environment, `workspace-secret` with a platform token (github.com/dynatrace-oss/dynatrace-mcp). |

Any other MCP server works the same way: a remote URL with an auth type and a scope, or a command that needs no credential.

## Limits

- Remote connectors must speak Streamable HTTP (the older SSE transport is not proxied).
- A pending OAuth sign-in lives in control's memory for ten minutes: after a control restart, click **Connect** again.
- Removing a member from a workspace leaves their connector secrets in the `SecretStore` until the connector is deleted. Control no longer uses them: nothing runs for that member any more.
- Subscriptions (README, **Subscriptions**) poll only remote connectors: control calls them itself, as the workspace's credential or the adding member's own, and logs each call with the subscription's id as the run.
