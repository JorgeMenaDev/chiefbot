import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplates, repoTemplates } from "./catalog.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A templates folder holding `folders`, each a map of file name to content.
function templatesDir(folders: Record<string, Record<string, string>>) {
  const dir = mkdtempSync(join(tmpdir(), "chiefbot-templates-"));
  dirs.push(dir);
  for (const [name, files] of Object.entries(folders)) {
    mkdirSync(join(dir, name));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, name, file), content);
  }
  return dir;
}

const manifest = `title: Shop
description: An API with its database.
compose: compose.yaml
services:
  api: { context: . }
stages:
  - { label: Database, waitsFor: [db] }
  - { label: API, waitsFor: [api] }
  - { label: Seed, waitsFor: [seed] }
seed: seed
notes: ["The API: http://localhost:8080"]
`;

// The compose file with `pod` (which owns the namespace) given `podPorts`, a line of its YAML.
const compose = (podPorts = 'expose: ["8080", "5432"]') => `services:
  pod: { image: pause, ${podPorts} }
  db: { image: postgres, network_mode: service:pod }
  api: { build: ./api, network_mode: service:pod }
  seed: { build: ./seed, network_mode: service:pod }
`;

test("the template the repo ships loads, with the services a repo may replace and its stages", () => {
  const catalog = loadTemplates(repoTemplates);

  expect(catalog.map(({ name }) => name)).toEqual(["java-react-enterprise"]);
  const [template] = catalog;
  expect(Object.keys(template?.services ?? {})).toEqual(["ui", "meta", "auth"]);
  expect(template?.stages).toEqual([
    { label: "Database", waitsFor: ["postgres"] },
    { label: "API", waitsFor: ["meta"] },
    { label: "Gateway", waitsFor: ["auth"] },
    { label: "Seed", waitsFor: ["seed"] },
    { label: "App", waitsFor: ["ui"] },
  ]);
  expect(template?.seed).toBe("seed");
});

test("a template that breaks the rules stops control, naming its file and what is wrong", () => {
  const load = (files: Record<string, string>) => () => loadTemplates(templatesDir({ shop: files }));
  const withManifest = (text: string) => load({ "template.yaml": text, "compose.yaml": compose() });

  expect(withManifest(manifest)).not.toThrow();
  expect(withManifest(`${manifest}extra: 1\n`)).toThrow(/shop\/template\.yaml[\s\S]*extra/);
  expect(withManifest(manifest.replace("waitsFor: [api]", "waitsFor: [api, cache]"))).toThrow(/shop\/template\.yaml: stage API waits for cache, which compose\.yaml has no service for/);
  expect(withManifest(manifest.replace("api: { context: . }", "web: { context: . }"))).toThrow(/shop\/template\.yaml: service web is not in compose\.yaml/);
  expect(withManifest(manifest.replace("api: { context: . }", "db: { context: . }"))).toThrow(/shop\/template\.yaml: service db has no build in compose\.yaml/);
  expect(withManifest(manifest.replace("seed: seed", "seed: fixtures"))).toThrow(/shop\/template\.yaml: seed fixtures is not in compose\.yaml/);
  expect(load({ "template.yaml": manifest })).toThrow(/shop\/compose\.yaml: missing/);
  expect(() => loadTemplates(templatesDir({ "Not Valid": { "template.yaml": manifest, "compose.yaml": compose() } }))).toThrow(/Not Valid[\s\S]*lower-case/);
});

test("a template that binds or publishes the engineer computer's screen port (5900) is refused", () => {
  const load = (podPorts: string) => () => loadTemplates(templatesDir({ shop: { "template.yaml": manifest, "compose.yaml": compose(podPorts) } }));

  expect(load('expose: ["5900"]')).toThrow(/shop\/compose\.yaml: service pod binds port 5900, which the engineer computer uses for its screen \(VNC\)/);
  expect(load('expose: ["5800-6000/tcp"]')).toThrow(/shop\/compose\.yaml: service pod binds port 5900/);
  expect(load('ports: ["127.0.0.1:8080:5900"]')).toThrow(/shop\/compose\.yaml: service pod binds port 5900/);
  expect(load('ports: ["5900:8080"]')).toThrow(/shop\/compose\.yaml: service pod binds port 5900/);
  expect(load('ports: [{ target: 8080, published: "5900" }]')).toThrow(/shop\/compose\.yaml: service pod binds port 5900/);
  expect(load('ports: ["${PORT}:8080"]')).toThrow(/shop\/compose\.yaml: service pod: cannot read the port \$\{PORT\}:8080/);
  expect(load('ports: ["127.0.0.1:8080:8080", 5432, { target: 3000 }], expose: [5901]')).not.toThrow();
});
