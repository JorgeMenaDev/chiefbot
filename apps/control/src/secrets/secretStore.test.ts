import { expect, test } from "bun:test";
import { configuredGitHubApp, configuredSignIn } from "@chiefbot/setup";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecretManager } from "./fakeSecretManager.ts";
import { restoreSetup, secretManagerStore } from "./secretManager.ts";
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

test("on GCP control writes setup's two files from Secret Manager into its home, owner-only, and names a missing one", async () => {
  const { client } = fakeSecretManager();
  const home = join(dir(), "chiefbot");
  const app = { id: 42, slug: "chiefbot-abc123", clientId: "Iv1.repo", owner: "octo-org", htmlUrl: "https://github.com/apps/chiefbot-abc123" };
  const config = { githubApp: app, signIn: { kind: "github-app", app: { ...app, id: 43, clientId: "Iv1.signin" } } };
  const keys = { clientSecret: "secret", webhookSecret: null, privateKey: "-----BEGIN RSA PRIVATE KEY-----" };

  await expect(restoreSetup(client, home)).rejects.toThrow(
    "Secret Manager has no version of chiefbot-config. Add it: gcloud secrets versions add chiefbot-config --data-file=$HOME/.chiefbot/config.json",
  );
  for (const [id, data] of [["chiefbot-config", config], ["chiefbot-github-app-secrets", keys]] as const) {
    await client.createSecret(id);
    await client.addVersion(id, JSON.stringify(data));
  }
  await restoreSetup(client, home);

  const env = { CHIEFBOT_HOME: home };
  expect(configuredSignIn(env, "/nowhere")).toEqual({ kind: "github-app", clientId: "Iv1.signin" });
  expect(configuredGitHubApp(env, "/nowhere")).toEqual({ id: 42, privateKey: "-----BEGIN RSA PRIVATE KEY-----" });
  expect(statSync(join(home, "github-app-secrets.json")).mode & 0o777).toBe(0o600);
});
