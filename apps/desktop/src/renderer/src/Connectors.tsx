import {
  ChecklistItem,
  ConnectStart,
  Connector,
  ConnectorCall,
  ConnectorInput,
  connectorPresets,
  type ChecklistStatus,
  type ConnectorAuth,
  type Project,
  type Workspace,
} from "@chiefbot/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { useAction } from "./Workspaces.tsx";

const Checklist = z.array(ChecklistItem);
const ConnectorList = z.array(Connector);
const CallList = z.array(ConnectorCall);

// The connectors screen of a workspace. On top, the user's access checklist:
// what the workspace's projects declare minus what is ready for them, each with
// its action. Below, the workspace's connectors; the owner adds them (from a
// preset or by hand), sets workspace secrets and deletes them. Control sends no
// events for these, so the screen reloads after each change, and every two
// seconds while an OAuth sign-in is open in the browser.
export function Connectors({ workspace }: { workspace: Workspace }) {
  const api = window.chiefbot.connectors;
  const owner = workspace.role === "owner";
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  // The connector whose token field is open, and the ones signing in in the browser.
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string[]>([]);
  const reload = async () => {
    const [checklist, list] = await Promise.all([api.checklist(workspace.id), api.list(workspace.id)]);
    setItems(Checklist.parse(checklist));
    setConnectors(ConnectorList.parse(list));
  };
  const { run, busy, error } = useAction(reload);

  useEffect(() => {
    void reload();
  }, [workspace.id]);

  // Polls while a sign-in is open, for at most five minutes.
  useEffect(() => {
    if (signingIn.length === 0) return;
    const timer = setInterval(() => void reload(), 2000);
    const giveUp = setTimeout(() => setSigningIn([]), 300_000);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [signingIn.length]);
  useEffect(() => {
    setSigningIn((names) => names.filter((name) => items.some((item) => item.name === name && item.status === "connect")));
  }, [items]);

  async function connect(name: string) {
    const started = await run(async () => ConnectStart.parse(await api.connect(workspace.id, name)));
    if (started?.value.kind === "oauth") setSigningIn([...signingIn, name]);
    if (started?.value.kind === "token") setTokenFor(name);
  }

  const open = items.filter(({ status }) => status !== "ready");
  return (
    <div className="bot-pane">
      <header className="bot-header">
        <div>
          <h2>Connectors</h2>
          <p className="muted">
            The tools {workspace.name}'s projects declare in chiefbot.project.yaml. Agents get a connector once it is ready for
            the member they work for.
          </p>
        </div>
      </header>
      <section className="routines">
        <h3>Your checklist</h3>
        {items.length === 0 && <p className="muted">No project in this workspace declares a connector.</p>}
        {items.length > 0 && open.length === 0 && <p className="muted">All set: every connector your projects need is ready.</p>}
        {[...open, ...items.filter(({ status }) => status === "ready")].map((item) => {
          const preset = presetFor(item.name);
          return (
          <div key={item.name} className="routine-row">
            <div className="routine-text">
              <strong>{item.title ?? item.name}</strong>
              <span className="muted">
                {statusText(item.status, owner)} · needed by {item.projects.join(", ")}
              </span>
              {tokenFor === item.name && (
                <TokenForm
                  placeholder={`Your ${item.title ?? item.name} token`}
                  busy={busy}
                  onSave={(token) => run(() => api.setToken(workspace.id, item.name, token)).then((saved) => saved && setTokenFor(null))}
                />
              )}
              {item.status === "workspace-secret" && owner && (
                <TokenForm
                  placeholder="The workspace's service token"
                  busy={busy}
                  onSave={(token) => run(() => api.setSecret(workspace.id, item.name, token))}
                />
              )}
            </div>
            {item.status === "connect" && (
              <button disabled={busy || signingIn.includes(item.name)} onClick={() => void connect(item.name)}>
                {signingIn.includes(item.name) ? "Finish in your browser…" : "Connect"}
              </button>
            )}
            {item.status === "not-defined" && owner && preset && (
              <button disabled={busy} onClick={() => void run(() => api.define(workspace.id, preset))}>
                Add preset
              </button>
            )}
          </div>
          );
        })}
        {error && <p className="error">{error}</p>}
      </section>
      <section className="routines">
        <h3>Workspace connectors</h3>
        {connectors.map((connector) => (
          <div key={connector.name} className="routine-row">
            <div className="routine-text">
              <strong>
                {connector.title} <span className="muted">({connector.name})</span>
              </strong>
              <span className="muted">
                {connector.server.kind === "remote" ? connector.server.url : [connector.server.command, ...connector.server.args].join(" ")} ·{" "}
                {authText[connector.auth]}
                {connector.auth === "workspace-secret" && (connector.hasWorkspaceSecret ? " (set)" : " (not set)")}
                {connector.server.kind === "remote" &&
                  (connector.writesWithoutApproval ? " · tools that may write run without asking" : " · tools that may write ask the member first")}
              </span>
              {owner && connector.server.kind === "remote" && (
                <label className="muted">
                  <input
                    type="checkbox"
                    checked={connector.writesWithoutApproval}
                    disabled={busy}
                    onChange={(event) => void run(() => api.setWritesWithoutApproval(workspace.id, connector.name, event.target.checked))}
                  />{" "}
                  Writes allowed without approval
                </label>
              )}
              {owner && connector.auth === "workspace-secret" && connector.hasWorkspaceSecret && (
                <TokenForm placeholder="Replace the service token" busy={busy} onSave={(token) => run(() => api.setSecret(workspace.id, connector.name, token))} />
              )}
            </div>
            {owner && (
              <button className="danger" disabled={busy} onClick={() => void run(() => api.remove(workspace.id, connector.name))}>
                Delete
              </button>
            )}
          </div>
        ))}
        {connectors.length === 0 && <p className="muted">No connectors yet.</p>}
        {owner && (
          <div className="actions">
            {connectorPresets
              .filter(({ name }) => !connectors.some((connector) => connector.name === name))
              .map((preset) => (
                <button key={preset.name} disabled={busy} onClick={() => void run(() => api.define(workspace.id, preset))}>
                  + {preset.title}
                </button>
              ))}
          </div>
        )}
        {owner && <NewConnector busy={busy} onDefine={(input) => run(() => api.define(workspace.id, input))} />}
      </section>
    </div>
  );
}

const presetFor = (name: string) => connectorPresets.find((preset) => preset.name === name);

function statusText(status: ChecklistStatus, owner: boolean) {
  switch (status) {
    case "ready":
      return "Ready";
    case "connect":
      return "Connect your own account";
    case "workspace-secret":
      return owner ? "Set the workspace's service token" : "Waiting for the workspace owner to set its service token";
    case "not-defined":
      return owner ? "Not defined in this workspace: add it below" : "Not defined in this workspace: ask its owner to add it";
  }
}

const authText: Record<ConnectorAuth, string> = {
  none: "no credential",
  "workspace-secret": "workspace service token",
  "personal-oauth": "each member's own account",
};

// One password field and Save. Clears itself once saved.
function TokenForm({ placeholder, busy, onSave }: { placeholder: string; busy: boolean; onSave: (token: string) => Promise<unknown> }) {
  const [token, setToken] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSave(token);
    setToken("");
  }
  return (
    <form className="routine-schedule" onSubmit={(event) => void submit(event)}>
      <input type="password" placeholder={placeholder} value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} />
      <button type="submit" disabled={busy || token.trim() === ""}>
        Save
      </button>
    </form>
  );
}

// The owner's form for a connector that is not a preset: a remote MCP server's
// URL, or a command (split on spaces), which runs with no credential.
function NewConnector({ busy, onDefine }: { busy: boolean; onDefine: (input: ConnectorInput) => Promise<unknown> }) {
  const empty = { name: "", title: "", kind: "remote", target: "", auth: "personal-oauth", scope: "" };
  const [form, setForm] = useState(empty);
  const [command, ...args] = form.target.trim().split(/\s+/);
  const input = ConnectorInput.safeParse({
    name: form.name,
    title: form.title,
    server:
      form.kind === "remote"
        ? { kind: "remote", url: form.target.trim() }
        : { kind: "command", command, args, env: {} },
    auth: form.kind === "remote" ? form.auth : "none",
    scope: form.scope,
  });
  const field = (key: keyof typeof empty) => ({
    value: form[key],
    disabled: busy,
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.success) return;
    await onDefine(input.data);
    setForm(empty);
  }

  return (
    <form className="routine-form" onSubmit={(event) => void submit(event)}>
      <div className="routine-schedule">
        <input placeholder="name, e.g. gitlab" {...field("name")} />
        <input placeholder="Title" {...field("title")} />
        <select {...field("kind")}>
          <option value="remote">Remote URL</option>
          <option value="command">Command</option>
        </select>
      </div>
      <div className="routine-schedule">
        <input placeholder={form.kind === "remote" ? "https://…/mcp" : "npx -y some-mcp-server"} {...field("target")} />
      </div>
      <div className="routine-schedule">
        {form.kind === "remote" ? (
          <>
            <select {...field("auth")}>
              <option value="personal-oauth">Each member's own account</option>
              <option value="workspace-secret">Workspace service token</option>
              <option value="none">No credential</option>
            </select>
            <input placeholder="OAuth scope (optional)" {...field("scope")} />
          </>
        ) : (
          <span className="muted">Runs on the agent's computer with no credential</span>
        )}
        <button type="submit" disabled={busy || !input.success}>
          Add connector
        </button>
      </div>
    </form>
  );
}

// A project's connector call log: who asked, as which identity, in which run.
export function ConnectorCalls({ project }: { project: Project }) {
  const [calls, setCalls] = useState<ConnectorCall[]>([]);
  useEffect(() => {
    void window.chiefbot.connectors.calls(project.id).then((next) => setCalls(CallList.parse(next)));
  }, [project.id]);
  return (
    <section className="routines">
      {calls.length === 0 && <p className="muted">No connector calls yet.</p>}
      {[...calls].reverse().map((call, index) => (
        <div key={index} className="routine-row">
          <div className="routine-text">
            <strong>
              {call.connector} · {call.tool}
            </strong>
            <span className="muted">
              {new Date(call.at).toLocaleString()} · asked by {call.requester} · as{" "}
              {call.identity === "personal" ? call.requester : call.identity === "workspace" ? "the workspace" : "no one"} · run {call.run}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}
