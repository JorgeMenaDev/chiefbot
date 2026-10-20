import type { TaskWorkerId } from "@chiefbot/contracts";
import { BUILD_STAGE, stackStages, type StackPlan, type StackRunner } from "./stacks.ts";

// A StackRunner for tests: it starts nothing. Each stage it reports passes at
// once with a one-line log, unless the test fails it (`failAt`). Tests read what
// started and stopped, and which stacks run.
export function fakeStacks() {
  const started: Array<{ id: TaskWorkerId; plan: StackPlan }> = [];
  const stopped: TaskWorkerId[] = [];
  const running = new Set<TaskWorkerId>();
  // The stage that fails next, with its log.
  let failure: { label: string; log: string } | null = null;

  const runner: StackRunner = {
    async start(id, plan, onStage) {
      started.push({ id, plan });
      running.add(id);
      for (const label of [BUILD_STAGE, ...stackStages(plan.template, plan.own).map(({ label }) => label)]) {
        onStage({ label, state: "running", log: "" });
        if (failure?.label === label) {
          onStage({ label, state: "failed", log: failure.log });
          failure = null;
          return "failed";
        }
        onStage({ label, state: "passed", log: `${label} is up\n` });
      }
      return "ready";
    },
    async stop(id) {
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
  };
}

export type FakeStacks = ReturnType<typeof fakeStacks>;
