import { expect, test } from "bun:test";
import { ProjectId } from "@chiefbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectRow } from "./ProjectList.tsx";

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
