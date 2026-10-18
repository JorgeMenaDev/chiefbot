import { afterEach, expect, test } from "bun:test";
import { Bot, SignInResponse } from "@chiefbot/contracts";
import { startControl } from "@chiefbot/control";
import { fakeComputers } from "@chiefbot/control/fake-computers";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { createRoutines } from "./routines.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

test("a bot's routines are created, edited and deleted through control, and a bad schedule fails with control's reason", async () => {
  const github = startFakeGitHub();
  const computers = fakeComputers();
  const control = startControl({ port: 0, dbPath: ":memory:", githubApiUrl: github.url, githubClientId: "test-client", githubApp: github.app, computers: computers.provider });
  stops.push(github.stop, computers.stopAll, control.stop);
  const { accessToken, refreshToken } = github.issueTokens();
  const signIn = await fetch(`${control.url}/sessions`, {
    method: "POST",
    body: JSON.stringify({ accessToken, accessTokenExpiresAt: 0, refreshToken, refreshTokenExpiresAt: 0 }),
  });
  const { sessionToken } = SignInResponse.parse(await signIn.json());
  const bot = Bot.parse(
    await (
      await fetch(`${control.url}/bots`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ name: "Ada" }),
      })
    ).json(),
  );
  const routines = createRoutines({ controlUrl: control.url, session: () => sessionToken });
  const input = { prompt: "Summarise my inbox", cron: "0 9 * * *", timezone: "Europe/London" };

  const created = await routines.create(bot.id, input);
  await routines.update(bot.id, created.id, { ...input, prompt: "Summarise my calendar" });
  const listed = await routines.list(bot.id);
  await routines.remove(bot.id, created.id);

  expect(listed.map(({ prompt, cron }) => [prompt, cron])).toEqual([["Summarise my calendar", "0 9 * * *"]]);
  expect(await routines.list(bot.id)).toEqual([]);
  await expect(routines.create(bot.id, { ...input, cron: "daily" })).rejects.toThrow("invalid_schedule");
});
