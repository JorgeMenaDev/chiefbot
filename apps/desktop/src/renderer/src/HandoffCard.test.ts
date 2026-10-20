import { expect, test } from "bun:test";
import { HandoffId, ProjectId, WorkspaceId } from "@chiefbot/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoffCard, replyFor, type HandoffItem } from "./HandoffCard.tsx";

test("an answer sent again unchanged keeps its delivery id, and an edited one or one for a new question gets a new id", () => {
  const first = replyFor(null, "Stripe.", "Stripe or Adyen?");
  // The first send got no reply (control may have it): the same answer is the same delivery.
  expect(replyFor(first, "Stripe.", "Stripe or Adyen?")).toEqual(first);
  const edited = replyFor(first, "Adyen instead.", "Stripe or Adyen?");
  expect(edited).toMatchObject({ text: "Adyen instead.", question: "Stripe or Adyen?" });
  expect(edited.deliveryId).not.toBe(first.deliveryId);
  expect(replyFor(first, "Stripe.", "Which payment provider?").deliveryId).not.toBe(first.deliveryId);
});

test("a handoff card names a verifier's verdict on its pull request, tests only when no screenshot backs it, and a PASS at its head is the Verified stage", () => {
  const card = (stage: HandoffItem["stage"], verification: HandoffItem["verification"]): HandoffItem => ({
    kind: "handoff",
    id: "handoff-1",
    handoffId: HandoffId.parse("handoff-1"),
    workspaceId: WorkspaceId.parse("workspace-1"),
    projectId: ProjectId.parse("project-1"),
    project: "shop",
    title: "Checkout",
    taskNumber: 1,
    stage,
    question: null,
    pullRequests: ["https://github.com/octo-org/shop/pull/7"],
    verification,
    settingUp: null,
  });
  const sha = "abc1234def5678abc1234def5678abc1234def56";
  const render = (item: HandoffItem) => renderToStaticMarkup(createElement(HandoffCard, { item, onReply: async () => {}, onOpen: () => {} }));

  expect(render(card("verified", { result: "pass", sha, stale: false, testsOnly: false, summary: "Pays with a test card." }))).toContain(">Verified<");
  expect(render(card("verified", { result: "pass", sha, stale: false, testsOnly: false, summary: "Pays with a test card." }))).toContain("Verified PASS @abc1234");
  expect(render(card("pr_opened", { result: "pass", sha, stale: true, testsOnly: false, summary: "Pays with a test card." }))).toContain("Verified PASS @abc1234 · stale");
  expect(render(card("pr_opened", { result: "issues", sha, stale: false, testsOnly: false, summary: "The card is declined." }))).toContain("ISSUES @abc1234: The card is declined.");
  expect(render(card("verified", { result: "pass", sha, stale: false, testsOnly: true, summary: "Its tests pass." }))).toContain("Verified PASS @abc1234 · tests only");
});

test("while the task's engineer sets up its stack, the handoff card shows the stage it is on, and nothing about setup otherwise", () => {
  const card = (settingUp: string | null): HandoffItem => ({
    kind: "handoff",
    id: "handoff-1",
    handoffId: HandoffId.parse("handoff-1"),
    workspaceId: WorkspaceId.parse("workspace-1"),
    projectId: ProjectId.parse("project-1"),
    project: "shop",
    title: "Checkout",
    taskNumber: 1,
    stage: "working",
    question: null,
    pullRequests: [],
    verification: null,
    settingUp,
  });
  const render = (item: HandoffItem) => renderToStaticMarkup(createElement(HandoffCard, { item, onReply: async () => {}, onOpen: () => {} }));

  expect(render(card("Database"))).toContain("Setting up: Database");
  expect(render(card(null))).not.toContain("Setting up");
});
