import { expect, test } from "bun:test";
import type { SessionEvent } from "@github/copilot-sdk";
import { fakeClock } from "./clock.ts";
import { fakeCopilot, sdk } from "./fakeCopilot.ts";
import { installationSession } from "./installationSession.ts";

const minute = 60_000;

// Resolves once check passes, failing after two real seconds.
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(5);
  }
}

test("an organization's turn longer than its token runs as successive turns: before the token runs out it is renewed, the runtime restarts and the session continues", async () => {
  const time = fakeClock(Date.now());
  let minted = 0;
  const fake = fakeCopilot({
    script: async function* (prompt) {
      // The first turn would outlive its token.
      if (prompt === "Do the long task") await new Promise(() => {});
      yield sdk.message("msg-1", "Done.");
      yield sdk.idle();
    },
  });
  const session = await installationSession({
    copilot: fake.copilot,
    clock: time.clock,
    sessionId: "worker_1",
    onPermissionRequest: async () => ({ kind: "approve-once" }),
    tools: [],
    token: async () => ({ token: `ghs_org_${++minted}`, expiresAt: time.clock.now() + 60 * minute }),
  });
  const seen: SessionEvent["type"][] = [];
  session.on((event) => void seen.push(event.type));

  await session.send("Do the long task");
  time.advance(54 * minute);
  const before = [...fake.tokens];
  time.advance(2 * minute);
  await eventually(() => seen.includes("session.idle"));

  expect(before).toEqual(["ghs_org_1"]);
  expect(fake.tokens).toEqual(["ghs_org_1", "ghs_org_2"]);
  expect(fake.aborted).toEqual(["worker_1"]);
  expect(fake.closed).toEqual(["worker_1"]);
  expect(fake.sends.map(({ sessionId, prompt }) => [sessionId, prompt])).toEqual([
    ["worker_1", "Do the long task"],
    ["worker_1", "continue"],
  ]);
  // The agent's turn sees one end: the cut-short turn's never reaches it.
  expect(seen.filter((type) => type === "session.idle")).toHaveLength(1);
});
