import { expect, test } from "bun:test";
import { ProjectId, TaskWorker } from "@chiefbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlPill, engineerScreen } from "./screenTargets.tsx";

const engineer = (screenHolder: string | null) =>
  TaskWorker.parse({
    id: "worker_1",
    projectId: "project_1",
    taskNumber: 1,
    requestedBy: "octo-user",
    payer: null,
    state: "working",
    result: null,
    pullRequest: null,
    pendingApprovals: [],
    computerRemoved: false,
    screenHolder,
    setup: [],
    createdAt: 0,
    updatedAt: 0,
  });
// The pill under an engineer's screen, as octo-user sees it.
const pill = (screenHolder: string | null) =>
  renderToStaticMarkup(<ControlPill target={engineerScreen(ProjectId.parse("project_1"), engineer(screenHolder), "octo-user")} />);

test("while another member drives an engineer's screen, the pill says who, and Take control waits", () => {
  const html = pill("octo-friend");

  expect(html).toContain("octo-friend is in control");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Take control of the screen"|<button[^>]*aria-label="Take control of the screen"[^>]*disabled=""/);
});

test("the member who drives it sees they are in control, with Stop; with nobody driving, anyone can take control", () => {
  expect(pill("octo-user")).toContain("You&#x27;re in control");
  expect(pill("octo-user")).toContain('aria-label="Stop and hand the screen back"');
  expect(pill(null)).toContain("Watching");
  expect(pill(null)).not.toMatch(/disabled=""/);
});

test("a screen is named for whose it is: an engineer's or a verifier's, on its task", () => {
  const project = ProjectId.parse("project_1");

  expect(engineerScreen(project, engineer(null), "octo-user").name).toBe("Engineer on #1");
  expect(engineerScreen(project, { ...engineer(null), kind: "verifier" }, "octo-user").name).toBe("Verifier on #1");
});
