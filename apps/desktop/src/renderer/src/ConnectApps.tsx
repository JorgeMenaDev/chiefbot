import { ChatView, Connection, ConnectionCall, type Bot } from "@chiefbot/contracts";
import { BlocksIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorText, Muted, PaneBody, PaneHeader, PanelSection, Row, Section } from "./Pane.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { useAction } from "./Workspaces.tsx";

const ConnectionList = z.array(Connection);
const CallList = z.array(ConnectionCall);

// Connect apps, from the gear menu: the connections the repo ships, one row each
// with whether it is on for the user. Connect (or Edit) opens a form of its
// fields, secret ones as password fields; Save turns it on, Disconnect turns it
// off and deletes the fields. Control never sends a saved value back, so Edit
// asks for every field again.
export function ConnectApps() {
  const api = window.chiefbot.connections;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const reload = async () => setConnections(ConnectionList.parse(await api.list()));
  const { run, busy, error } = useAction(reload);

  useEffect(() => {
    void reload();
  }, []);

  return (
    <>
      <PaneHeader icon={<BlocksIcon className="size-4 text-muted-foreground" />} title="Connect apps" note="Tools and skills for your Chief of Staff" />
      <PaneBody>
        <Section
          title="Your connections"
          description="Turn one on with your own token. Your bots use the app as you, from their next message, and ask before a command that changes something. That check is a guardrail, not a boundary: paste a token with only the access they need, and one that expires."
        >
          {connections.length === 0 && <Muted>No connections ship with this Chiefbot.</Muted>}
          {connections.map((connection) => (
            <Row
              key={connection.name}
              title={
                <span className="flex items-center gap-2">
                  {connection.title}
                  <Badge variant={connection.on ? "success" : "outline"}>{connection.on ? "On" : "Off"}</Badge>
                </span>
              }
              meta={connection.description}
              actions={
                editing !== connection.name && (
                  <>
                    <Button size="xs" variant={connection.on ? "outline" : "default"} disabled={busy} onClick={() => setEditing(connection.name)}>
                      {connection.on ? "Edit" : "Connect"}
                    </Button>
                    {connection.on && (
                      <Button size="xs" variant="destructive-outline" disabled={busy} onClick={() => void run(() => api.disconnect(connection.name))}>
                        Disconnect
                      </Button>
                    )}
                  </>
                )
              }
            >
              {editing === connection.name && (
                <FieldsForm
                  connection={connection}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (fields) => {
                    if (await run(() => api.connect(connection.name, fields))) setEditing(null);
                  }}
                />
              )}
            </Row>
          ))}
          <ErrorText message={error} />
        </Section>
      </PaneBody>
    </>
  );
}

// One labelled input per field of the connection, then Cancel and Save. Save
// needs every field.
function FieldsForm({
  connection,
  busy,
  onSave,
  onCancel,
}: {
  connection: Connection;
  busy: boolean;
  onSave: (fields: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const fields = Object.entries(connection.fields);
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = fields.every(([name]) => (values[name] ?? "").trim() !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (complete) await onSave(values);
  }

  return (
    <form className="flex max-w-md flex-col gap-2 pt-2" onSubmit={(event) => void submit(event)}>
      {fields.map(([name, { label, secret }], index) => (
        <label key={name} className="flex flex-col gap-1 text-muted-foreground text-xs">
          {label}
          <Input
            type={secret ? "password" : "text"}
            autoComplete="off"
            autoFocus={index === 0}
            value={values[name] ?? ""}
            disabled={busy}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
          />
        </label>
      ))}
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={busy || !complete}>
          Save
        </Button>
      </div>
    </form>
  );
}

// A bot's connection calls in its Details tab, newest first: each command of a
// connection's CLI it ran, and when. Reloaded each time one of its turns ends.
export function ConnectionCalls({ bot }: { bot: Bot }) {
  const [calls, setCalls] = useState<ConnectionCall[]>([]);
  useEffect(() => {
    const reload = () => void window.chiefbot.connections.calls(bot.id).then((next) => setCalls(CallList.parse(next)));
    let working = false;
    reload();
    return window.chiefbot.chat.onChange((next) => {
      const view = ChatView.parse(next);
      if (view.botId !== bot.id) return;
      if (working && view.working === null) reload();
      working = view.working !== null;
    });
  }, [bot.id]);
  return (
    <PanelSection title="Connection calls">
      {calls.length === 0 && <Muted>No connection calls yet. Turn an app on under Connect apps in the gear menu.</Muted>}
      {[...calls].reverse().map((call, index) => (
        <Row key={index} title={<span className="font-mono text-xs">{call.command}</span>} meta={`${call.connection} · ${new Date(call.at).toLocaleString()}`} />
      ))}
    </PanelSection>
  );
}
