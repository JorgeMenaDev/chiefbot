import { Routine, type Bot, type RoutineInput, type RoutineRun } from "@chiefbot/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorText, Muted, Panel, Row } from "./Pane.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input, Textarea } from "./components/ui/input.tsx";

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
    <Panel title="Routines">
      {routines.length === 0 && editing === null && <Muted>No routines yet.</Muted>}
      {routines.map((routine) =>
        editing !== "new" && editing?.id === routine.id ? (
          <RoutineForm
            key={routine.id}
            initial={routine}
            onSave={(input) => act(() => api.update(bot.id, routine.id, input))}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Row
            key={routine.id}
            title={routine.prompt}
            meta={
              <>
                <code className="font-mono">{routine.cron}</code> in {routine.timezone} · next {new Date(routine.nextDueAt).toLocaleString()}
              </>
            }
            actions={
              <>
                <Button size="xs" variant="ghost" onClick={() => setEditing(routine)}>
                  Edit
                </Button>
                <Button size="xs" variant="ghost" className="text-destructive-foreground" onClick={() => void act(() => api.remove(bot.id, routine.id))}>
                  Delete
                </Button>
              </>
            }
          >
            {routine.lastRun && <LastRun run={routine.lastRun} />}
          </Row>
        ),
      )}
      {editing === "new" ? (
        <RoutineForm
          initial={{ prompt: "", cron: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }}
          onSave={(input) => act(() => api.create(bot.id, input))}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <Button size="xs" variant="ghost" className="mt-1 self-start text-muted-foreground" onClick={() => setEditing("new")}>
          <PlusIcon />
          New routine
        </Button>
      )}
      <ErrorText message={error} />
    </Panel>
  );
}

function LastRun({ run }: { run: RoutineRun }) {
  const when = new Date(run.dueAt).toLocaleString();
  return (
    <span className={run.status === "failed" ? "text-destructive-foreground text-xs" : "text-muted-foreground text-xs"}>
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
    <form className="flex flex-col gap-2 py-2.5" onSubmit={(event) => void submit(event)}>
      <Textarea rows={2} placeholder="What should the bot do?" autoFocus {...field("prompt")} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-muted-foreground text-xs">
          Cron <Input className="w-36 font-mono" placeholder="0 9 * * 1-5" {...field("cron")} />
        </label>
        <label className="flex items-center gap-2 text-muted-foreground text-xs">
          Timezone <Input className="w-40" placeholder="Europe/London" {...field("timezone")} />
        </label>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={busy || input.prompt.trim() === ""}>
          Save
        </Button>
      </div>
    </form>
  );
}
