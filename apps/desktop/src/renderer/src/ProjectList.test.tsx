import { expect, test } from "bun:test";
import { ProjectId, type ProjectStates } from "@chiefbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { followProjectStates, ProjectRow } from "./ProjectList.tsx";

const row = (state: Parameters<typeof ProjectRow>[0]["state"]) =>
  renderToStaticMarkup(<ProjectRow id={ProjectId.parse("project_1")} name="shop" repo="octo-org/shop" state={state} active={false} onSelect={() => {}} />);

test("a project's row says its state in words beside its dot, and its repo's owner while idle", () => {
  // The row's note: the last text in it.
  const note = (html: string) => html.match(/>([^<>]+)<\/span><\/button>$/)?.[1];
  expect(note(row("needs_you"))).toBe("needs you");
  expect(row("needs_you")).toContain('aria-label="Needs you"');
  expect(note(row("working"))).toBe("working");
  expect(note(row("sleeping"))).toBe("sleeping");
  expect(note(row("idle"))).toBe("octo-org");
  expect(note(row(undefined))).toBe("octo-org");
});

test("an update that comes before main's kept states wins: the older kept states never replace it", async () => {
  const shop = ProjectId.parse("project_1");
  // Main as the hook sees it: the kept states reply when `reply` is called, and `push` sends an update.
  const main = () => {
    let push = (_states: unknown) => {};
    let reply = (_states: unknown) => {};
    const api = {
      onStates: (listener: (states: unknown) => void) => {
        push = listener;
        return () => undefined;
      },
      states: () => new Promise<unknown>((resolve) => (reply = resolve)),
    };
    return { api, push: (states: unknown) => push(states), reply: (states: unknown) => reply(states) };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const late = main();
  const seen: ProjectStates[] = [];
  followProjectStates(late.api, (states) => seen.push(states));
  late.push({});
  late.reply({ [shop]: "needs_you" });
  await tick();
  expect(seen).toEqual([{}]);

  const quiet = main();
  const kept: ProjectStates[] = [];
  followProjectStates(quiet.api, (states) => kept.push(states));
  quiet.reply({ [shop]: "working" });
  await tick();
  expect(kept).toEqual([{ [shop]: "working" }]);
});
