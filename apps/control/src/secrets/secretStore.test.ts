import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecretManager } from "./fakeSecretManager.ts";
import { secretManagerStore } from "./secretManager.ts";
import { localSecretStore, secretKeyFile } from "./secretStore.ts";

const dir = () => mkdtempSync(join(tmpdir(), "chiefbot-secrets-"));

test("the local store reads secrets back, and its file holds none of them in plain text", async () => {
  const dbPath = join(dir(), "control.sqlite");
  const key = secretKeyFile(join(dir(), "secret.key"));
  const store = localSecretStore({ dbPath, key });

  await store.put("github-refresh-token-user_1", "ghr_plain_secret_value");
  await store.put("github-refresh-token-user_2", "ghr_other");
  await store.delete("github-refresh-token-user_2");

  expect(await store.get("github-refresh-token-user_1")).toBe("ghr_plain_secret_value");
  expect(await store.get("github-refresh-token-user_2")).toBeNull();
  const onDisk = [dbPath, `${dbPath}-wal`].map((path) => readFileSync(path, { flag: "a+" }).toString("latin1")).join("");
  expect(onDisk).not.toContain("ghr_plain_secret_value");
  // Another key cannot read it.
  const otherKey = secretKeyFile(join(dir(), "secret.key"));
  await expect(localSecretStore({ dbPath, key: otherKey }).get("github-refresh-token-user_1")).rejects.toThrow();
});

test("the key file is made once, readable by its owner only, and reused", () => {
  const path = join(dir(), "nested", "secret.key");

  const first = secretKeyFile(path);
  const second = secretKeyFile(path);

  expect(first.length).toBe(32);
  expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("the Secret Manager store reads back the latest value and leaves one version enabled", async () => {
  const manager = fakeSecretManager();
  const store = secretManagerStore(manager.client);

  expect(await store.get("github-refresh-token-user_1")).toBeNull();
  await store.put("github-refresh-token-user_1", "ghr_first");
  await store.put("github-refresh-token-user_1", "ghr_second");

  expect(await store.get("github-refresh-token-user_1")).toBe("ghr_second");
  expect(manager.enabledVersions("github-refresh-token-user_1")).toBe(1);
  await store.delete("github-refresh-token-user_1");
  await store.delete("github-refresh-token-user_1");
  expect(await store.get("github-refresh-token-user_1")).toBeNull();
});
