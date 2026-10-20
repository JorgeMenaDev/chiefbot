import { expect, test } from "bun:test";
import { savedSecretKept, ServiceInput } from "./health.ts";

const meta = {
  name: "Meta",
  icon: "data",
  environments: [
    { name: "prod", url: "https://meta.example.com/actuator/health", auth: { kind: "bearer" }, secret: "prod-token" },
    { name: "preprod", url: "http://localhost:7471/preprod/meta/actuator/health", auth: { kind: "none" } },
  ],
};

test("a service has 1 to 6 environments with names of their own, and http or https URLs without credentials", () => {
  const refused = (change: Record<string, unknown>) => ServiceInput.safeParse({ ...meta, ...change }).success === false;
  const env = (change: Record<string, unknown>) => ({ environments: [{ ...meta.environments[1], ...change }] });

  expect(ServiceInput.parse(meta).environments.map(({ name }) => name)).toEqual(["prod", "preprod"]);
  expect(refused({ environments: [] })).toBe(true);
  expect(refused({ environments: ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ ...meta.environments[1], name })) })).toBe(true);
  expect(refused({ environments: [meta.environments[1], { ...meta.environments[1], name: "PREPROD" }] })).toBe(true);
  expect(refused({ name: "x".repeat(41) })).toBe(true);
  expect(refused({ icon: "rocket" })).toBe(true);
  expect(refused(env({ name: "x".repeat(21) }))).toBe(true);
  expect(refused(env({ url: "ftp://meta.example.com/health" }))).toBe(true);
  expect(refused(env({ url: "https://user:pass@meta.example.com/health" }))).toBe(true);
  expect(refused(env({ auth: { kind: "header", header: "Host" } }))).toBe(true);
  expect(refused(env({ auth: { kind: "header", header: "X Api Key" } }))).toBe(true);
  expect(refused(env({ auth: { kind: "bearer" }, secret: "line\nbreak" }))).toBe(true);
  expect(refused(env({ auth: { kind: "header", header: "X-API-Key" }, secret: "key" }))).toBe(false);
});

test("a saved secret stays only with the same kind of authentication and the same origin", () => {
  const saved = { url: "https://meta.example.com/actuator/health", auth: { kind: "bearer" as const } };

  expect(savedSecretKept(saved, { ...saved, url: "https://meta.example.com/health" })).toBe(true);
  expect(savedSecretKept(saved, { ...saved, url: "https://elsewhere.example.com/actuator/health" })).toBe(false);
  expect(savedSecretKept(saved, { ...saved, url: "http://meta.example.com/actuator/health" })).toBe(false);
  expect(savedSecretKept(saved, { ...saved, auth: { kind: "header", header: "X-API-Key" } })).toBe(false);
  expect(savedSecretKept({ ...saved, auth: { kind: "none" } }, { ...saved, auth: { kind: "none" } })).toBe(false);
  expect(savedSecretKept(undefined, saved)).toBe(false);
});
