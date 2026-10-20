import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EffortPicker } from "./BotComposerControls.tsx";

// The choice the effort menu shows checked, by its label.
const checked = (html: string) => [...html.matchAll(/aria-pressed="true"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/g)].map(([, label]) => label);

test("the effort menu's Default is its own choice, checked while the bot has no effort", () => {
  const html = renderToStaticMarkup(<EffortPicker efforts={["low", "medium", "high"]} effort={null} defaultEffort="medium" onChange={() => {}} />);
  expect(html).toContain('aria-label="Reasoning effort: Default"');
  expect(checked(html)).toEqual(["Default"]);
});

test("an explicit effort is checked on its own, apart from Default and the model's default level", () => {
  const html = renderToStaticMarkup(<EffortPicker efforts={["low", "medium", "high"]} effort="medium" defaultEffort="medium" onChange={() => {}} />);
  expect(html).toContain('aria-label="Reasoning effort: Medium"');
  expect(checked(html)).toEqual(["Medium"]);
});
