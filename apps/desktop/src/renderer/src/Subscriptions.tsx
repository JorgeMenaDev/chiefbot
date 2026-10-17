import { DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, Subscription, type Project, type SubscriptionInput } from "@chiefbot/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

const SubscriptionList = z.array(Subscription);
type Kind = SubscriptionInput["kind"];

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
    <section className="routines">
      {subscriptions.length === 0 && !adding && <p className="muted">Not listening to anything yet.</p>}
      {subscriptions.map((subscription) => (
        <div key={subscription.id} className="routine-row">
          <div className="routine-text">
            <strong>{describe(subscription.source)}</strong>
            <span className={subscription.lastError ? "error" : "muted"}>{status(subscription)}</span>
          </div>
          <div className="actions">
            <button className="danger" onClick={() => void act(() => api.unsubscribe(project.id, subscription.id))}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {adding ? (
        <SubscriptionForm project={project} onSave={(input) => act(() => api.subscribe(project.id, input))} onCancel={() => setAdding(false)} />
      ) : (
        <button className="link-button" onClick={() => setAdding(true)}>
          + Listen to…
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
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
  const [kind, setKind] = useState<Kind>("ci-status");
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

  return (
    <form className="routine-form" onSubmit={(event) => void submit(event)}>
      <div className="routine-schedule">
        <select value={kind} disabled={busy} onChange={(event) => setKind(z.enum(["ci-status", "issue-query", "schedule"]).parse(event.target.value))}>
          <option value="ci-status">CI failures on a branch</option>
          <option value="issue-query">An issue query</option>
          <option value="schedule">A schedule</option>
        </select>
        {kind !== "schedule" && (
          <label>
            Connector{" "}
            <select {...field("connector")}>
              {declared.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {kind === "ci-status" && (
        <label>
          Branch <input placeholder="main" {...field("branch")} />
        </label>
      )}
      {kind === "issue-query" && (
        <>
          <input placeholder="repo:owner/name label:bug is:open, or JQL for Jira" autoFocus {...field("query")} />
          <input placeholder="Jira only: your-site.atlassian.net" {...field("site")} />
        </>
      )}
      {kind === "schedule" && <textarea rows={2} placeholder="What should the coordinator do?" autoFocus {...field("prompt")} />}
      <div className="routine-schedule">
        {kind === "schedule" ? (
          <>
            <label>
              Cron <input placeholder="0 9 * * 1-5" {...field("cron")} />
            </label>
            <label>
              Timezone <input placeholder="Europe/London" {...field("timezone")} />
            </label>
          </>
        ) : (
          <label>
            Check every <input type="number" min={MIN_POLL_SECONDS / 60} {...field("minutes")} /> min
          </label>
        )}
        <button type="submit" disabled={busy || tooOften || (kind !== "schedule" && declared.length === 0)}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {kind !== "schedule" && declared.length === 0 && <p className="muted">{project.name}'s chiefbot.project.yaml declares no connectors.</p>}
    </form>
  );
}
