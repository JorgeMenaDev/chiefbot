import type { TaskWorkerId } from "@chiefbot/contracts";
import { secretRedactor } from "@chiefbot/worker/secret-redactor";
import { BUILD_STAGE, stackStages, type StackPlan, type StackRunner } from "./stacks.ts";

// A StackRunner for tests: it starts nothing. Each stage it reports passes at
// once with a one-line log, unless the test fails it (`failAt`), its log with
// the plan's secrets and tokens hidden, as a runner must. Tests read what
// started and stopped, and which stacks run.
export function fakeStacks() {
  const started: Array<{ id: TaskWorkerId; plan: StackPlan }> = [];
  const stopped: TaskWorkerId[] = [];
  const running = new Set<TaskWorkerId>();
  // The stage that fails next, by its label, with its log.
  let failure: { label: string; log: string } | null = null;
  let stopsFail = false;
  // What the next start throws, made from its plan.
  let thrown: ((plan: StackPlan) => Error) | null = null;

  const runner: StackRunner = {
    async start(id, plan, onStage) {
      started.push({ id, plan });
      running.add(id);
      const error = thrown?.(plan);
      thrown = null;
      if (error) throw error;
      for (const { id, label } of [BUILD_STAGE, ...stackStages(plan.template, plan.own)]) {
        onStage({ id, label, state: "running", log: "" });
        if (failure?.label === label) {
          const tokens = Object.values(plan.repos).flatMap(({ token }) => (token === null ? [] : [token]));
          onStage({ id, label, state: "failed", log: secretRedactor([...plan.secrets, ...tokens]).redact(failure.log) });
          failure = null;
          return "failed";
        }
        onStage({ id, label, state: "passed", log: `${label} is up\n` });
      }
      return "ready";
    },
    async stop(id) {
      if (stopsFail) throw new Error("Docker is not answering");
      stopped.push(id);
      running.delete(id);
    },
  };

  return {
    runner,
    started,
    stopped,
    running,
    // The next stack's stage `label` fails with `log`.
    failAt: (label: string, log: string) => void (failure = { label, log }),
    // The next start throws the error `make` makes from its plan, as a runner's own failure would.
    throwAtStart: (make: (plan: StackPlan) => Error) => void (thrown = make),
    // While `failing`, every stop fails, as when Docker does not answer.
    failStops: (failing: boolean) => void (stopsFail = failing),
  };
}

export type FakeStacks = ReturnType<typeof fakeStacks>;
