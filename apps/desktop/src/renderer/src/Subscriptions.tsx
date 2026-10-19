import { DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, Subscription, SubscriptionKind, type Project, type SubscriptionInput } from "@chiefbot/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorText, Muted, Panel, Row } from "./Pane.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input, Select, Textarea } from "./components/ui/input.tsx";

const SubscriptionList = z.array(Subscription);

// What a project listens to: CI runs on a branch and issue queries, which control
// polls through the project's connectors, and schedules. Each event becomes one
// task in the ledger and one message in the chat of the member who added it.
// Any member adds or removes them.
export function ListeningTo({ project }: { project: Project }) {
  const api = window.chiefbot.projects;
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => setSubscriptions(SubscriptionList.parse(await api.subscriptions(project.id)));
  useEffect(() => {
    void reload();
  }, [project.id]);

  // Runs one change, then reloads. Control's refusal shows under the list.
  async function act(change: () => Promise<unknown>) {
    setError(null);
    try {
      await change();
      setAdding(false);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <Panel title="Listening to">
      {subscriptions.length === 0 && !adding && <Muted>Not listening to anything yet.</Muted>}
      {subscriptions.map((subscription) => (
        <Row
          key={subscription.id}
          title={describe(subscription.source)}
          meta={<span className={subscription.lastError ? "text-destructive-foreground" : undefined}>{status(subscription)}</span>}
          actions={
            <Button size="xs" variant="ghost" className="text-destructive-foreground" onClick={() => void act(() => api.unsubscribe(project.id, subscription.id))}>
              Remove
            </Button>
          }
        />
      ))}
      {adding ? (
        <SubscriptionForm project={project} onSave={(input) => act(() => api.subscribe(project.id, input))} onCancel={() => setAdding(false)} />
      ) : (
        <Button size="xs" variant="ghost" className="mt-1 self-start text-muted-foreground" onClick={() => setAdding(true)}>
          <PlusIcon />
          Listen to…
        </Button>
      )}
      <ErrorText message={error} />
    </Panel>
  );
}

function describe(source: SubscriptionInput) {
  switch (source.kind) {
    case "ci-status":
      return `CI failures on ${source.branch} (${source.connector})`;
    case "issue-query":
      return `Issues matching ${source.query} (${source.connector})`;
    case "schedule":
      return source.prompt;
  }
}

// Who added it, who it polls as, and how it last went.
function status({ source, addedBy, identity, lastPolledAt, lastError, nextDueAt, events }: Subscription) {
  const parts = [`added by ${addedBy}`, `${events} event${events === 1 ? "" : "s"}`];
  if (source.kind === "schedule") parts.push(`${source.cron} in ${source.timezone}`, `next ${new Date(nextDueAt).toLocaleString()}`);
  else {
    parts.push(`every ${Math.round(source.intervalSeconds / 60)} min`);
    if (identity) parts.push(`as ${identity === "personal" ? addedBy : identity === "workspace" ? "the workspace" : "no one"}`);
    if (lastPolledAt !== null) parts.push(`checked ${new Date(lastPolledAt).toLocaleString()}`);
  }
  return [...parts, ...(lastError ? [lastError] : [])].join(" · ");
}

// One form for the three kinds. Saving waits for control, which refuses a
// connector the project does not declare or a schedule it cannot run.
function SubscriptionForm({ project, onSave, onCancel }: { project: Project; onSave: (input: SubscriptionInput) => Promise<void>; onCancel: () => void }) {
  const declared = project.file.connectors;
  const [kind, setKind] = useState<SubscriptionKind>("ci-status");
  const [fields, setFields] = useState({
    connector: declared.includes("github-actions") ? "github-actions" : (declared[0] ?? ""),
    branch: "main",
    query: "",
    site: "",
    minutes: String(DEFAULT_POLL_SECONDS / 60),
    prompt: "",
    cron: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof fields) => ({
    value: fields[key],
    disabled: busy,
    onChange: (event: { target: { value: string } }) => setFields({ ...fields, [key]: event.target.value }),
  });

  const intervalSeconds = Math.round(Number(fields.minutes) * 60);
  const input: SubscriptionInput =
    kind === "ci-status"
      ? { kind, connector: fields.connector, branch: fields.branch.trim(), intervalSeconds }
      : kind === "issue-query"
        ? { kind, connector: fields.connector, query: fields.query.trim(), intervalSeconds, ...(fields.site.trim() ? { site: fields.site.trim() } : {}) }
        : { kind, prompt: fields.prompt.trim(), cron: fields.cron.trim(), timezone: fields.timezone.trim() };
  const tooOften = kind !== "schedule" && !(intervalSeconds >= MIN_POLL_SECONDS);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onSave(input);
    setBusy(false);
  }

  const label = "flex items-center gap-2 text-muted-foreground text-xs";
  return (
    <form className="flex flex-col gap-2 py-2.5" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} disabled={busy} onChange={(event) => setKind(SubscriptionKind.parse(event.target.value))}>
          <option value="ci-status">CI failures on a branch</option>
          <option value="issue-query">An issue query</option>
          <option value="schedule">A schedule</option>
        </Select>
        {kind !== "schedule" && (
          <label className={label}>
            Connector{" "}
            <Select {...field("connector")}>
              {declared.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
          </label>
        )}
      </div>
      {kind === "ci-status" && (
        <label className={label}>
          Branch <Input className="w-48" placeholder="main" {...field("branch")} />
        </label>
      )}
      {kind === "issue-query" && (
        <>
          <Input placeholder="repo:owner/name label:bug is:open, or JQL for Jira" autoFocus {...field("query")} />
          <Input placeholder="Jira only: your-site.atlassian.net" {...field("site")} />
        </>
      )}
      {kind === "schedule" && <Textarea rows={2} placeholder="What should the coordinator do?" autoFocus {...field("prompt")} />}
      <div className="flex flex-wrap items-center gap-2">
        {kind === "schedule" ? (
          <>
            <label className={label}>
              Cron <Input className="w-36 font-mono" placeholder="0 9 * * 1-5" {...field("cron")} />
            </label>
            <label className={label}>
              Timezone <Input className="w-40" placeholder="Europe/London" {...field("timezone")} />
            </label>
          </>
        ) : (
          <label className={label}>
            Check every <Input className="w-20" type="number" min={MIN_POLL_SECONDS / 60} {...field("minutes")} /> min
          </label>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={busy || tooOften || (kind !== "schedule" && declared.length === 0)}>
          Save
        </Button>
      </div>
      {kind !== "schedule" && declared.length === 0 && <Muted>{project.name}'s chiefbot.project.yaml declares no connectors.</Muted>}
    </form>
  );
}
