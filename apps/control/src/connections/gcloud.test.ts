import { afterEach, expect, spyOn, test } from "bun:test";
import { ApiError, ConnectionDefinition } from "@chiefbot/contracts";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerProvider } from "../computers/computer.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import { atCleanUp, cleanUp, doneCount, startTestControl } from "../testControl.ts";
import { googleAccessToken } from "./googleToken.ts";

afterEach(cleanUp);

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const serviceAccount = { type: "service_account", client_email: "bot@demo-project.iam.gserviceaccount.com", private_key: privateKey };
const authorizedUser = { type: "authorized_user", client_id: "client.apps.example", client_secret: "client-secret", refresh_token: "1//refresh-secret" };

// A fake Google token endpoint: a JWT bearer grant whose assertion the service
// account's key signed for an hour of cloud-platform, or the authorized user's
// refresh grant, gets an access token; anything else is refused. It answers once
// `hold` settles.
function fakeGoogle(hold: Promise<unknown>) {
  const grants: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = new URLSearchParams(await req.text());
      const grant = form.get("grant_type") ?? "";
      grants.push(grant);
      await hold;
      if (grant === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
        const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
        const signed = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url");
        const { iss, scope, aud, iat, exp } = JSON.parse(Buffer.from(claims, "base64url").toString());
        if (signed && iss === serviceAccount.client_email && scope === "https://www.googleapis.com/auth/cloud-platform" && aud === server.url.href && exp - iat === 3600) {
          return Response.json({ access_token: "ya29.service-account", expires_in: 3599, token_type: "Bearer" });
        }
      }
      if (grant === "refresh_token" && form.get("refresh_token") === authorizedUser.refresh_token && form.get("client_secret") === authorizedUser.client_secret) {
        return Response.json({ access_token: "ya29.authorized-user", expires_in: 3599, token_type: "Bearer" });
      }
      return Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 });
    },
  });
  atCleanUp(() => server.stop(true));
  return { url: server.url.href, grants };
}

// Control minting tokens at a fake Google, whose bots stage connections under
// `root`, with a fake `gcloud` on the shell's PATH (after the wrappers) that prints
// the token it reads from its file and its project.
async function setup({ hold = Promise.resolve(), provider }: { hold?: Promise<unknown>; provider?: (fake: ComputerProvider) => ComputerProvider } = {}) {
  const google = fakeGoogle(hold);
  const secrets = new Map<string, string>();
  const store: SecretStore = {
    get: async (name) => secrets.get(name) ?? null,
    put: async (name, value) => void secrets.set(name, value),
    delete: async (name) => void secrets.delete(name),
  };
  const root = mkdtempSync(join(tmpdir(), "chiefbot-turn-"));
  const tools = mkdtempSync(join(tmpdir(), "chiefbot-tools-"));
  writeFileSync(join(tools, "gcloud"), '#!/bin/sh\necho "gcloud $* token=$(cat "$CLOUDSDK_AUTH_ACCESS_TOKEN_FILE") project=$CLOUDSDK_CORE_PROJECT"\n');
  chmodSync(join(tools, "gcloud"), 0o755);
  const shell = { cwd: tmpdir(), env: { PATH: `${root}/bin:${tools}:${process.env.PATH ?? ""}` } };
  const control = await startTestControl({
    secrets: store,
    connectionsRoot: root,
    googleTokenUrl: google.url,
    copilot: fakeCopilot({ shell }),
    ...(provider === undefined ? {} : { provider }),
  });
  return { ...control, ...control.user, root, google };
}

// Every file staged under `root` during a turn, by path, with its content.
function staged(root: string) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [join(entry.parentPath, entry.name).slice(root.length + 1), readFileSync(join(entry.parentPath, entry.name), "utf8")]),
  );
}

for (const [kind, key, token, secrets] of [
  ["a service account key", serviceAccount, "ya29.service-account", [serviceAccount.private_key]],
  ["authorized_user credentials", authorizedUser, "ya29.authorized-user", [authorizedUser.refresh_token, authorizedUser.client_secret]],
] as const) {
  test(`${kind} stays in control: the bot's turn gets a one-hour access token for gcloud, never the key`, async () => {
    const { api, computers, root, onlineBot, send, watchChat } = await setup();
    expect((await api("PUT", "/connections/gcloud", { fields: { key: JSON.stringify(key), project: "demo-project" } })).status).toBe(200);
    const bot = await onlineBot("Ada");
    const seen: Array<{ output: string; files: Record<string, string> }> = [];
    computers.copilot.script = async function* (_prompt, runtime) {
      const { output } = await runtime.shell("gcloud run services list");
      seen.push({ output, files: staged(root) });
      yield sdk.idle();
    };

    await send(bot.id, "is the hello service up?");
    await watchChat(bot.id).until(doneCount(1));

    const [turn] = seen;
    expect(turn?.output).toBe(`gcloud run services list token=${token} project=demo-project\n`);
    expect(Object.keys(turn?.files ?? {}).filter((path) => path.startsWith("connections/")).sort()).toEqual(["connections/gcloud/project", "connections/gcloud/token"]);
    const everything = JSON.stringify(turn?.files);
    for (const secret of secrets) expect(everything).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
}

test("a pasted key that is no Google credential is refused when saved", async () => {
  const { api } = await setup();

  for (const key of ["not json", JSON.stringify({ type: "external_account", audience: "x" }), JSON.stringify({ ...serviceAccount, private_key: "" })]) {
    const res = await api("PUT", "/connections/gcloud", { fields: { key, project: "demo-project" } });
    expect([res.status, ApiError.parse(await res.json())]).toEqual([
      400,
      { error: "invalid_connection", message: "key is not a service account key or authorized_user credentials JSON" },
    ]);
  }
});

test("a key Google refuses leaves gcloud out of the turn, and the log names Google's error, never the key", async () => {
  const { api, computers, root, onlineBot, send, watchChat, google } = await setup();
  const revoked = { ...authorizedUser, refresh_token: "1//revoked-refresh-secret" };
  await api("PUT", "/connections/gcloud", { fields: { key: JSON.stringify(revoked), project: "demo-project" } });
  const bot = await onlineBot("Ada");
  const errors = spyOn(console, "error").mockImplementation(() => {});
  atCleanUp(() => errors.mockRestore());
  const seen: string[][] = [];
  computers.copilot.script = async function* () {
    seen.push(existsSync(root) ? readdirSync(root) : []);
    yield sdk.idle();
  };

  await send(bot.id, "is the hello service up?");
  await watchChat(bot.id).until(doneCount(1));

  expect(google.grants).toEqual(["refresh_token"]);
  expect(seen).toEqual([[]]);
  const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
  expect(logged).toContain("gcloud connection out of a turn: Google refused the saved key: 400 invalid_grant");
  expect(logged).not.toContain(revoked.refresh_token);
});

test("google-access-token needs a secret key field, and makes the field token that env may name", () => {
  const definition = (fields: Record<string, { label: string; secret?: boolean }>) =>
    ConnectionDefinition.safeParse({ title: "G", description: "G.", cli: "gcloud", fields, exchange: "google-access-token", env: { TOKEN_FILE: "{dir}/token", T: "{token}" } });
  const issues = (fields: Record<string, { label: string; secret?: boolean }>) => definition(fields).error?.issues.map(({ path, message }) => [path.join("."), message]);

  expect(definition({ key: { label: "Key", secret: true } }).success).toBe(true);
  expect(issues({ key: { label: "Key" } })).toEqual([["exchange", "google-access-token needs a secret field named key"]]);
  expect(issues({ key: { label: "Key", secret: true }, token: { label: "Token" } })).toEqual([["fields.token", "google-access-token makes the field token itself"]]);
  // Without the exchange, {token} names no field.
  expect(ConnectionDefinition.safeParse({ title: "G", description: "G.", cli: "gcloud", fields: { key: { label: "Key", secret: true } }, env: { T: "{token}" } }).success).toBe(false);
});

test("a turn stopped while its token is being minted never reaches the worker", async () => {
  const google = Promise.withResolvers<void>();
  const shutdown = Promise.withResolvers<void>();
  atCleanUp(() => shutdown.resolve());
  // The computer takes its time to stop, so its worker is still connected when the token comes.
  const { api, computers, onlineBot, send, watchChat, google: endpoint } = await setup({
    hold: google.promise,
    provider: (fake) => ({ ...fake, stop: (botId) => shutdown.promise.then(() => fake.stop(botId)) }),
  });
  await api("PUT", "/connections/gcloud", { fields: { key: JSON.stringify(serviceAccount), project: "demo-project" } });
  const bot = await onlineBot("Ada");
  const ran: string[] = [];
  computers.copilot.script = async function* (prompt) {
    ran.push(prompt);
    yield sdk.idle();
  };
  const chat = watchChat(bot.id);

  await send(bot.id, "is the hello service up?");
  while (endpoint.grants.length === 0) await Bun.sleep(10);
  const stopped = api("POST", `/bots/${bot.id}/stop`);
  await chat.until(doneCount(1));
  google.resolve();
  await Bun.sleep(200);
  shutdown.resolve();

  expect(ran).toEqual([]);
  expect((await stopped).status).toBe(200);
});

test("a token endpoint that stalls, before answering or mid-answer, fails within the timeout", async () => {
  const stalled = [
    () => new Promise<Response>(() => {}),
    () => new Response(new ReadableStream({ start: (body) => body.enqueue(new TextEncoder().encode('{"access_token":')) }), { headers: { "content-type": "application/json" } }),
  ];
  for (const fetch of stalled) {
    const server = Bun.serve({ port: 0, fetch });
    atCleanUp(() => server.stop(true));
    const started = Date.now();

    await expect(googleAccessToken(JSON.stringify(authorizedUser), server.url.href, 200)).rejects.toThrow("Google's token endpoint did not answer within 200 ms");
    expect(Date.now() - started).toBeLessThan(2000);
  }
});
