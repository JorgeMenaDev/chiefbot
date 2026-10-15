import { Routine, type Bot, type RoutineInput, type RoutineRun } from "@chiefbot/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

const RoutineList = z.array(Routine);

// The bot's routines: prompts control runs on a schedule, with the desktop open
// or not. A run's result lands in the chat. The list reloads when the bot's
// status changes, since a run starts and stops a stopped bot.
export function Routines({ bot }: { bot: Bot }) {
  const api = window.chiefbot.routines;
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => setRoutines(RoutineList.parse(await api.list(bot.id)));
  useEffect(() => {
    void reload();
  }, [bot.id, bot.status]);

  // Runs one change, then reloads. Control's refusal shows under the list.
  async function act(change: () => Promise<unknown>) {
    setError(null);
    try {
      await change();
      setEditing(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="routines">
      {routines.length === 0 && editing === null && <p className="muted">No routines yet.</p>}
      {routines.map((routine) =>
        editing !== "new" && editing?.id === routine.id ? (
          <RoutineForm
            key={routine.id}
            initial={routine}
            onSave={(input) => act(() => api.update(bot.id, routine.id, input))}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={routine.id} className="routine-row">
            <div className="routine-text">
              <strong>{routine.prompt}</strong>
              <span className="muted">
                <code>{routine.cron}</code> in {routine.timezone} · next {new Date(routine.nextDueAt).toLocaleString()}
              </span>
              {routine.lastRun && <LastRun run={routine.lastRun} />}
            </div>
            <div className="actions">
              <button onClick={() => setEditing(routine)}>Edit</button>
              <button className="danger" onClick={() => void act(() => api.remove(bot.id, routine.id))}>
                Delete
              </button>
            </div>
          </div>
        ),
      )}
      {editing === "new" ? (
        <RoutineForm
          initial={{ prompt: "", cron: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }}
          onSave={(input) => act(() => api.create(bot.id, input))}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button className="link-button" onClick={() => setEditing("new")}>
          + New routine
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function LastRun({ run }: { run: RoutineRun }) {
  const when = new Date(run.dueAt).toLocaleString();
  return (
    <span className={run.status === "failed" ? "error" : "muted"}>
      Last run {when}: {run.status}
      {run.error && ` (${run.error})`}
    </span>
  );
}

// Prompt, cron expression and timezone. Saving waits for control, which refuses
// a schedule it cannot run.
function RoutineForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: RoutineInput;
  onSave: (input: RoutineInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [input, setInput] = useState(initial);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof RoutineInput) => ({
    value: input[key],
    disabled: busy,
    onChange: (event: { target: { value: string } }) => setInput({ ...input, [key]: event.target.value }),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onSave(input);
    setBusy(false);
  }

  return (
    <form className="routine-form" onSubmit={(event) => void submit(event)}>
      <textarea rows={2} placeholder="What should the bot do?" autoFocus {...field("prompt")} />
      <div className="routine-schedule">
        <label>
          Cron <input placeholder="0 9 * * 1-5" {...field("cron")} />
        </label>
        <label>
          Timezone <input placeholder="Europe/London" {...field("timezone")} />
        </label>
        <button type="submit" disabled={busy || input.prompt.trim() === ""}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
