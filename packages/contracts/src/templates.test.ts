import { expect, test } from "bun:test";
import { TemplateManifest } from "./templates.ts";

const manifest = {
  title: "Shop",
  description: "A web app behind a gateway, with its database.",
  compose: "compose.yaml",
  services: { web: { context: "." }, api: { context: "services/api" } },
  stages: [
    { label: "Database", waitsFor: ["db"] },
    { label: "API", waitsFor: ["api", "gateway"] },
    { label: "Seed", waitsFor: ["seed"] },
  ],
  seed: "seed",
  notes: ["The app: http://localhost:3000", "Sign in as demo, password demo-password."],
};

test("a manifest names its compose file, the services a repo may replace, its stages in order, its seed and the brief's notes", () => {
  const parsed = TemplateManifest.parse(manifest);

  expect(parsed.services).toEqual({ web: { context: "." }, api: { context: "services/api" } });
  expect(parsed.stages.map(({ label }) => label)).toEqual(["Database", "API", "Seed"]);
  expect(parsed.seed).toBe("seed");
});

test("an unknown key, a path out of the folder or repo, or nothing to run is refused", () => {
  const refused = (change: Record<string, unknown>) => TemplateManifest.safeParse({ ...manifest, ...change }).success === false;

  expect(refused({ ports: [3000] })).toBe(true);
  expect(refused({ services: { web: { context: ".", dockerfile: "Dockerfile" } } })).toBe(true);
  expect(refused({ stages: [{ label: "Database", waitsFor: ["db"], timeout: 60 }] })).toBe(true);
  expect(refused({ compose: "../compose.yaml" })).toBe(true);
  expect(refused({ compose: "compose.json" })).toBe(true);
  expect(refused({ services: { web: { context: "../web" } } })).toBe(true);
  expect(refused({ services: { web: { context: "/srv/web" } } })).toBe(true);
  expect(refused({ services: {} })).toBe(true);
  expect(refused({ stages: [] })).toBe(true);
  expect(refused({ stages: [{ label: "Database", waitsFor: [] }] })).toBe(true);
  expect(refused({ notes: [] })).toBe(true);
});
