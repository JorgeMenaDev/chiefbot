import type { SetupStep, TaskWorker } from "@chiefbot/contracts";
import { Markdown } from "./Markdown.tsx";
import { ErrorText } from "./Pane.tsx";

// What an engineer's row on its task shows below its state: why it is queued
// (`max` is the project's workers.max), each setup step that ran with its log,
// and how it ended: its report or summary once finished, or why it stopped.
export function EngineerDetails({ worker, max }: { worker: TaskWorker; max: number }) {
  const ended = worker.state === "blocked" || worker.state === "failed" || worker.state === "stopped";
  return (
    <>
      {worker.state === "queued" && (
        <span className="text-muted-foreground text-xs">This project runs {max} {max === 1 ? "engineer or verifier" : "engineers and verifiers"} at once: it starts when one ends.</span>
      )}
      {worker.setup.map((step) => (
        <SetupLog key={step.step} step={step} />
      ))}
      {worker.state === "finished" && worker.result && (
        <div className="text-sm">
          <Markdown text={worker.result} />
        </div>
      )}
      {ended && <ErrorText message={worker.result} />}
    </>
  );
}

// One setup step: its command and exit code, its log folded away unless the
// step failed. Its transcript shows the same row (Engineers.tsx).
export function SetupLog({ step: { step, command, exitCode, log } }: { step: SetupStep }) {
  return (
    <details open={exitCode !== 0}>
      <summary className={exitCode === 0 ? "cursor-pointer text-muted-foreground text-xs" : "cursor-pointer text-destructive-foreground text-xs"}>
        {step}: {command} · exit {exitCode}
      </summary>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/65 bg-background/70 p-3 font-mono text-xs leading-relaxed">
        {log || "(no output)"}
      </pre>
    </details>
  );
}
