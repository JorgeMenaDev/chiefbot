import type { SetupStep, StackRow, TaskWorker } from "@chiefbot/contracts";
import { CheckIcon, ChevronRightIcon, CircleIcon, MinusIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Markdown } from "./Markdown.tsx";
import { ErrorText } from "./Pane.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { cn } from "./lib/utils.ts";

// What an engineer's row on its task shows below its state: why it is queued
// (`max` is the project's workers.max), its setup as one list (SetupProgress),
// and how it ended: its report or summary once finished, or why it stopped.
export function EngineerDetails({ worker, max }: { worker: TaskWorker; max: number }) {
  const ended = worker.state === "blocked" || worker.state === "failed" || worker.state === "stopped";
  return (
    <>
      {worker.state === "queued" && (
        <span className="text-muted-foreground text-xs">This project runs {max} {max === 1 ? "engineer or verifier" : "engineers and verifiers"} at once: it starts when one ends.</span>
      )}
      {(worker.stack.length > 0 || worker.setup.length > 0) && <SetupProgress stack={worker.stack} steps={worker.setup} live={worker.state === "setting_up"} />}
      {worker.state === "finished" && worker.result && (
        <div className="text-sm">
          <Markdown text={worker.result} />
        </div>
      )}
      {ended && <ErrorText message={worker.result} />}
    </>
  );
}

// One row of the list: a stage of the stack, or a step of the setup, which has
// its command and, once it ended, its exit code.
type Row = Omit<StackRow, "id"> & { command?: string; exitCode?: number | null };

const stepLabel: Record<SetupStep["step"], string> = { clone: "Clone", checkout: "Check out", setup: "Setup" };

// An engineer's or verifier's setup: its stack's stages and its setup steps, and
// whether it still sets up (`live`).
type Setup = { stack: StackRow[]; steps: SetupStep[]; live: boolean };

const setupRows = ({ stack, steps }: Setup): Row[] => [
  ...stack,
  ...steps.map(({ step, exitCode, ...rest }) => ({
    ...rest,
    label: stepLabel[step],
    state: exitCode === null ? ("running" as const) : exitCode === 0 ? ("passed" as const) : ("failed" as const),
    exitCode,
  })),
];

// A member's click on the list's first line: the list open or folded, for the phase of the setup it was made in.
export type SetupChoice = { phase: string; open: boolean };

// Whether the setup list is open. It is while the worker sets up and once a row
// failed, and folded once its agent works. A member's click (`choice`) holds
// until the phase changes: the worker stops setting up, or a row fails. So a new
// failure opens the list with its log, and the list folds once the agent works.
export function setupDisclosure(setup: Setup, choice: SetupChoice | null) {
  const failed = setupRows(setup).findIndex(({ state }) => state === "failed");
  const phase = `${setup.live ? "setting up" : "set up"}, failed at ${failed}`;
  return { phase, open: choice?.phase === phase ? choice.open : setup.live || failed !== -1 };
}

// An engineer's or verifier's setup as one list, after T3 Code's worktree setup
// card: each stage of its template stack (`stack`), then each step of its
// computer's setup (`steps`), with its state, how long it took (ticking while
// it runs) and its log, folded away unless it failed. While it sets up (`live`)
// the list is open, its first line naming the row that runs; once its agent
// works it folds into one line, Ready, unless something failed, which stays
// open with its log (setupDisclosure). Its task and its transcript
// (Engineers.tsx) both show it.
export function SetupProgress(setup: Setup) {
  const { live } = setup;
  const rows = setupRows(setup);
  const failed = rows.find(({ state }) => state === "failed");
  const running = rows.find(({ state }) => state === "running");
  const [choice, setChoice] = useState<SetupChoice | null>(null);
  const { phase, open } = setupDisclosure(setup, choice);
  const now = useNow(live && running !== undefined);
  const header: { icon: ReactNode; text: ReactNode } = live
    ? { icon: <Spinner className="size-3" />, text: <span className="animate-working">{running ? `Setting up: ${running.label}` : "Setting up"}</span> }
    : failed
      ? { icon: stateIcon.failed, text: <span className="text-destructive-foreground">{failed.label} failed</span> }
      : rows.some(({ state }) => state === "waiting" || state === "running")
        ? { icon: <MinusIcon className="size-3 shrink-0" />, text: "Setup did not finish" }
        : {
            icon: stateIcon.passed,
            text: (
              <>
                Ready <span className="text-muted-foreground/70">· {rows.length === 1 ? "1 step" : `${rows.length} steps`}</span>
              </>
            ),
          };
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        className="flex h-6 max-w-full cursor-pointer items-center gap-2 text-muted-foreground text-xs transition-colors hover:text-foreground"
        onClick={() => setChoice({ phase, open: !open })}
      >
        {header.icon}
        <span className="truncate">{header.text}</span>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="flex flex-col ps-5">
          {rows.map((row, index) => (
            // Rows only ever join at the end, so a row keeps its index.
            <SetupRow key={index} row={row} live={live} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

const stateIcon: Record<StackRow["state"], ReactNode> = {
  waiting: <CircleIcon className="size-3 shrink-0 opacity-40" aria-label="waiting" />,
  running: <Spinner className="size-3 shrink-0" />,
  passed: <CheckIcon className="size-3 shrink-0 text-success" aria-label="passed" />,
  failed: <XIcon className="size-3 shrink-0 text-destructive" aria-label="failed" />,
};

// A row in a line of fixed height: its state, label and command, then how long
// it took, or "not run" for a stage the setup never reached. One with a log
// opens it, as a failed one is.
function SetupRow({ row, live, now }: { row: Row; live: boolean; now: number }) {
  const { label, state, log, startedAt, endedAt, command, exitCode } = row;
  const took = startedAt === null || state === "waiting" ? null : (endedAt ?? now) - startedAt;
  const line = (
    <>
      {stateIcon[state]}
      <span className={cn("shrink-0", state === "failed" ? "text-destructive-foreground" : state === "running" ? "text-foreground" : state === "waiting" && "opacity-60")}>
        {label}
      </span>
      {command && (
        <span className="min-w-0 truncate font-mono opacity-80" title={command}>
          {command}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1.5 tabular-nums">
        {state === "failed" && exitCode !== undefined && <span className="text-destructive-foreground">exit {exitCode}</span>}
        {took !== null && <span>{duration(took)}</span>}
        {state === "waiting" && !live && <span className="opacity-60">not run</span>}
        {log && <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />}
      </span>
    </>
  );
  const lineClass = "flex h-6 items-center gap-2 text-muted-foreground text-xs";
  return (
    <li data-state={state} data-label={label}>
      {log ? (
        <details open={state === "failed"} className="group">
          <summary className={cn(lineClass, "cursor-pointer list-none transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden")}>{line}</summary>
          <pre className="mt-1 mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/65 bg-background/70 p-3 font-mono text-xs leading-relaxed">{log}</pre>
        </details>
      ) : (
        <div className={lineClass}>{line}</div>
      )}
    </li>
  );
}

// The time now, once a second while `ticking`, for a running stage's time.
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

// How long something took, in its largest units: 350ms, 3.5s, 42s, 2m 5s, 1h 3m
// (T3 Code's formatDuration).
export function duration(ms: number) {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) {
    const tenths = Math.round(ms / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const parts = [[Math.floor(seconds / 3_600), "h"], [Math.floor((seconds % 3_600) / 60), "m"], [seconds % 60, "s"]] as const;
  return parts.flatMap(([value, unit]) => (value > 0 ? [`${value}${unit}`] : [])).join(" ");
}
