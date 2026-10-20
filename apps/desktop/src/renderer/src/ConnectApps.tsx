import { ChatView, Connection, ConnectionCall, SetupLink, type Bot } from "@chiefbot/contracts";
import { BlocksIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorText, Muted, PaneBody, PaneHeader, PanelSection, Row, Section } from "./Pane.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { useAction } from "./Workspaces.tsx";
import { listOf } from "./lib/utils.ts";

const ConnectionList = z.array(Connection);
const CallList = z.array(ConnectionCall);

// Connect apps, from the gear menu: the connections the repo ships, one row each
// with whether it is on for the user. Connect (or Edit) opens a form of its
// fields, secret ones as password fields; Save turns it on, Disconnect turns it
// off and deletes the fields. Control never sends a saved value back, so Edit
// asks for every field again.
export function ConnectApps() {
  const api = window.chiefbot.connections;
  // Null until the first list arrives.
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const reload = async () => setConnections(ConnectionList.parse(await api.list()));
  const { run, busy, error } = useAction(reload);

  useEffect(() => {
    void run(async () => {});
  }, []);

  return (
    <>
      <PaneHeader icon={<BlocksIcon className="size-4 text-muted-foreground" />} title="Connect apps" note="Tools and skills for your Chief of Staff" />
      <PaneBody>
        <Section
          title="Your connections"
          description="Turn one on with your own token. Your bots use the app as you, from their next message, and ask before a command that changes something. That check is a guardrail, not a boundary: paste a token with only the access they need, and one that expires."
        >
          {connections === null && !error && <Muted>Loading…</Muted>}
          {connections?.length === 0 && <Muted>No connections ship with this Chiefbot.</Muted>}
          {connections?.map((connection) => (
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

// The connection's setup steps, what the bot then does with and without asking,
// one labelled input per field with its help under it, then Cancel and Save.
// Save needs every field.
export function FieldsForm({
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
    <form className="flex max-w-xl flex-col gap-3 pt-2" onSubmit={(event) => void submit(event)}>
      <ol className="flex list-decimal flex-col gap-1 ps-4 text-foreground/80 text-xs leading-relaxed marker:text-muted-foreground">
        {connection.setup.map((step, index) => (
          <li key={index}>
            <SetupText text={step} />
          </li>
        ))}
      </ol>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <dt className="text-muted-foreground">Without asking</dt>
        <dd>{connection.withoutAsking}</dd>
        <dt className="text-muted-foreground">Asks first</dt>
        <dd>{connection.asksFirst}</dd>
      </dl>
      {fields.map(([name, { label, secret, help, placeholder }], index) => (
        <label key={name} className="flex flex-col gap-1 font-medium text-foreground text-xs">
          {label}
          <Input
            type={secret ? "password" : "text"}
            autoComplete="off"
            autoFocus={index === 0}
            placeholder={placeholder}
            value={values[name] ?? ""}
            disabled={busy}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
          />
          {help && (
            <span className="font-normal text-muted-foreground leading-relaxed">
              <SetupText text={help} />
            </span>
          )}
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

// A line of setup help, its one [text](https://…) link (if any) as a link. The
// window opens it in the system browser (main's setWindowOpenHandler).
function SetupText({ text }: { text: string }) {
  const match = SetupLink.exec(text);
  if (!match) return text;
  const [whole, label, url] = match;
  return (
    <>
      {text.slice(0, match.index)}
      <a className="text-primary underline-offset-4 hover:underline" href={url} target="_blank" rel="noreferrer">
        {label}
      </a>
      {text.slice(match.index + whole.length)}
    </>
  );
}

// A bot's connection calls in its Details tab, newest first: each command of a
// connection's CLI it ran, and when. Reloaded each time one of its turns ends.
export function ConnectionCalls({ bot }: { bot: Bot }) {
  const [calls, setCalls] = useState<ConnectionCall[]>([]);
  // The titles of the user's connections that are on; null until they arrive.
  const [on, setOn] = useState<string[] | null>(null);
  useEffect(() => {
    void window.chiefbot.connections.list().then((next) => setOn(ConnectionList.parse(next).flatMap(({ on, title }) => (on ? [title] : []))));
  }, [bot.id]);
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
      {calls.length === 0 && on !== null && <Muted>{noCallsText(on)}</Muted>}
      {[...calls].reverse().map((call, index) => (
        <Row key={index} title={<span className="font-mono text-xs">{call.command}</span>} meta={`${call.connection} · ${new Date(call.at).toLocaleString()}`} />
      ))}
    </PanelSection>
  );
}

// What an empty call log says, by the titles of the connections that are on.
export function noCallsText(on: string[]) {
  if (on.length === 0) return "No connection calls yet. Turn an app on under Connect apps in the gear menu.";
  return `No connection calls yet. ${listOf(on)} ${on.length === 1 ? "is" : "are"} on. Commands your bot runs with ${on.length === 1 ? "it" : "them"} show here when each turn ends.`;
}
