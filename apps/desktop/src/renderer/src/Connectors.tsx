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
import { CircleCheckIcon, CircleDashedIcon, PlugIcon, PlusIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorText, Muted, PaneBody, PaneHeader, Panel, Row, Section } from "./Pane.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input, Select } from "./components/ui/input.tsx";
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
    <>
      <PaneHeader
        icon={<PlugIcon className="size-4 text-muted-foreground" />}
        title="Connectors"
        note={workspace.name}
      />
      <PaneBody>
        <Section
          title="Your checklist"
          description={`The tools ${workspace.name}'s projects declare in chiefbot.project.yaml. Agents get a connector once it is ready for the member they work for.`}
        >
          {items.length === 0 && <Muted>No project in this workspace declares a connector.</Muted>}
          {items.length > 0 && open.length === 0 && <Muted>All set: every connector your projects need is ready.</Muted>}
          {[...open, ...items.filter(({ status }) => status === "ready")].map((item) => {
            const preset = presetFor(item.name);
            return (
              <Row
                key={item.name}
                title={
                  <span className="flex items-center gap-2">
                    {item.status === "ready" ? (
                      <CircleCheckIcon className="size-4 shrink-0 text-success" aria-label="Ready" />
                    ) : (
                      <CircleDashedIcon className="size-4 shrink-0 text-warning" aria-label="Needs action" />
                    )}
                    {item.title ?? item.name}
                  </span>
                }
                meta={
                  <span className="ps-6">
                    {statusText(item.status, owner)} · needed by {item.projects.join(", ")}
                  </span>
                }
                actions={
                  <>
                    {item.status === "connect" && (
                      <Button size="xs" disabled={busy || signingIn.includes(item.name)} onClick={() => void connect(item.name)}>
                        {signingIn.includes(item.name) ? "Finish in your browser…" : "Connect"}
                      </Button>
                    )}
                    {item.status === "not-defined" && owner && preset && (
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => api.define(workspace.id, preset))}>
                        Add preset
                      </Button>
                    )}
                  </>
                }
              >
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
              </Row>
            );
          })}
          <ErrorText message={error} />
        </Section>
        <Section title="Workspace connectors">
          {connectors.map((connector) => (
            <Row
              key={connector.name}
              title={
                <>
                  {connector.title} <span className="font-normal text-muted-foreground">({connector.name})</span>
                </>
              }
              meta={
                <>
                  <span className="font-mono">
                    {connector.server.kind === "remote" ? connector.server.url : [connector.server.command, ...connector.server.args].join(" ")}
                  </span>{" "}
                  · {authText[connector.auth]}
                  {connector.auth === "workspace-secret" && (connector.hasWorkspaceSecret ? " (set)" : " (not set)")}
                  {connector.server.kind === "remote" &&
                    (connector.writesWithoutApproval ? " · tools that may write run without asking" : " · tools that may write ask the member first")}
                </>
              }
              actions={
                owner && (
                  <Button size="xs" variant="destructive-outline" disabled={busy} onClick={() => void run(() => api.remove(workspace.id, connector.name))}>
                    Delete
                  </Button>
                )
              }
            >
              {owner && connector.server.kind === "remote" && (
                <label className="flex items-center gap-2 text-muted-foreground text-xs">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={connector.writesWithoutApproval}
                    disabled={busy}
                    onChange={(event) => void run(() => api.setWritesWithoutApproval(workspace.id, connector.name, event.target.checked))}
                  />
                  Writes allowed without approval
                </label>
              )}
              {owner && connector.auth === "workspace-secret" && connector.hasWorkspaceSecret && (
                <TokenForm placeholder="Replace the service token" busy={busy} onSave={(token) => run(() => api.setSecret(workspace.id, connector.name, token))} />
              )}
            </Row>
          ))}
          {connectors.length === 0 && <Muted>No connectors yet.</Muted>}
          {owner && (
            <div className="flex flex-wrap gap-2 pt-3">
              {connectorPresets
                .filter(({ name }) => !connectors.some((connector) => connector.name === name))
                .map((preset) => (
                  <Button key={preset.name} size="xs" variant="outline" disabled={busy} onClick={() => void run(() => api.define(workspace.id, preset))}>
                    <PlusIcon />
                    {preset.title}
                  </Button>
                ))}
            </div>
          )}
        </Section>
        {owner && (
          <Section title="Add a connector" description="A remote MCP server's URL, or a command that runs on the agent's computer.">
            <NewConnector busy={busy} onDefine={(input) => run(() => api.define(workspace.id, input))} />
          </Section>
        )}
      </PaneBody>
    </>
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
    <form className="flex max-w-md gap-2 pt-1" onSubmit={(event) => void submit(event)}>
      <Input type="password" placeholder={placeholder} value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} />
      <Button type="submit" variant="outline" disabled={busy || token.trim() === ""}>
        Save
      </Button>
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
    <form className="flex flex-col gap-2 pb-2" onSubmit={(event) => void submit(event)}>
      <div className="flex gap-2">
        <Input placeholder="name, e.g. gitlab" {...field("name")} />
        <Input placeholder="Title" {...field("title")} />
        <Select className="shrink-0" {...field("kind")}>
          <option value="remote">Remote URL</option>
          <option value="command">Command</option>
        </Select>
      </div>
      <Input className="font-mono" placeholder={form.kind === "remote" ? "https://…/mcp" : "npx -y some-mcp-server"} {...field("target")} />
      <div className="flex items-center gap-2">
        {form.kind === "remote" ? (
          <>
            <Select className="shrink-0" {...field("auth")}>
              <option value="personal-oauth">Each member's own account</option>
              <option value="workspace-secret">Workspace service token</option>
              <option value="none">No credential</option>
            </Select>
            <Input placeholder="OAuth scope (optional)" {...field("scope")} />
          </>
        ) : (
          <span className="flex-1 text-muted-foreground text-xs">Runs on the agent's computer with no credential</span>
        )}
        <Button type="submit" className="shrink-0" disabled={busy || !input.success}>
          Add connector
        </Button>
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
    <Panel title="Connector calls">
      {calls.length === 0 && <Muted>No connector calls yet.</Muted>}
      {[...calls].reverse().map((call, index) => (
        <Row
          key={index}
          title={
            <>
              {call.connector} <span className="text-muted-foreground">·</span> <span className="font-mono">{call.tool}</span>
            </>
          }
          meta={
            <>
              {new Date(call.at).toLocaleString()} · asked by {call.requester} · as{" "}
              {call.identity === "personal" ? call.requester : call.identity === "workspace" ? "the workspace" : "no one"} · run {call.run}
            </>
          }
        />
      ))}
    </Panel>
  );
}
