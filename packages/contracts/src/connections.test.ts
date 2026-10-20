import { expect, test } from "bun:test";
import { ConnectionDefinition } from "./connections.ts";

const definition = {
  title: "Tool",
  description: "A tool.",
  cli: "tool",
  setup: ["Open [Tokens](https://tool.example/tokens) and create a token.", "Pick an expiry date.", "Copy it."],
  withoutAsking: "Read things.",
  asksFirst: "Change things.",
  fields: { token: { label: "Token", secret: true, help: "From step 1, read-only.", placeholder: "tk_123" } },
};

test("a connection carries setup steps, what it asks about, and help and an example per field", () => {
  const parsed = ConnectionDefinition.parse(definition);
  expect(parsed.setup).toHaveLength(3);
  expect(parsed.fields.token).toEqual({ label: "Token", secret: true, help: "From step 1, read-only.", placeholder: "tk_123" });
  expect(ConnectionDefinition.safeParse({ ...definition, fields: { token: { label: "Token" } } }).success).toBe(true);
});

test("setup help is 3 to 6 steps, each with at most one https link, and both approval lines", () => {
  const refused = (change: Record<string, unknown>) => ConnectionDefinition.safeParse({ ...definition, ...change }).success === false;
  expect(refused({ setup: ["One.", "Two."] })).toBe(true);
  expect(refused({ setup: ["1", "2", "3", "4", "5", "6", "7"] })).toBe(true);
  expect(refused({ setup: ["[a](https://a.example) and [b](https://b.example)", "Two.", "Three."] })).toBe(true);
  expect(refused({ setup: ["[a](http://a.example)", "Two.", "Three."] })).toBe(true);
  expect(refused({ fields: { token: { label: "Token", help: "[a](javascript:alert(1))" } } })).toBe(true);
  expect(refused({ withoutAsking: undefined })).toBe(true);
  expect(refused({ asksFirst: "" })).toBe(true);
});
