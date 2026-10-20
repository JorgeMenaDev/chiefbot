import { afterEach, expect, test } from "bun:test";
import { startMockServices } from "./mockServices.ts";

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

// The mock's own check, on 127.0.0.1: the one test here that uses a real socket.
test("the mock answers each service per environment, and flips one environment without the others", async () => {
  const mock = startMockServices({ port: 0, token: "mock-token", slowMs: 50 });
  stops.push(mock.stop);
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${mock.url}${path}`, { headers });
    return [res.status, await res.text()];
  };
  const bearer = { authorization: "Bearer mock-token" };

  expect(await get("/prod/ui/health")).toEqual([200, "OK"]);
  expect(await get("/int/meta/actuator/health")).toEqual([200, '{"status":"UP"}']);
  expect(await get("/prod/auth/actuator/health")).toEqual([401, '{"error":"unauthorized"}']);
  expect(await get("/prod/auth/actuator/health", { authorization: "Bearer wrong" })).toEqual([401, '{"error":"unauthorized"}']);
  expect(await get("/prod/auth/actuator/health", bearer)).toEqual([200, '{"status":"UP"}']);
  expect(await get("/staging/ui/health")).toEqual([404, "Not found"]);

  expect((await fetch(`${mock.url}/_mock/meta/preprod/down`, { method: "POST" })).status).toBe(200);
  expect((await fetch(`${mock.url}/_mock/meta/int/slow`, { method: "POST" })).status).toBe(200);
  expect((await fetch(`${mock.url}/_mock/meta/qa/down`, { method: "POST" })).status).toBe(400);

  expect(await get("/prod/meta/actuator/health")).toEqual([200, '{"status":"UP"}']);
  expect(await get("/preprod/meta/actuator/health")).toEqual([503, '{"status":"DOWN"}']);
  const started = performance.now();
  expect(await get("/int/meta/actuator/health")).toEqual([200, '{"status":"UP"}']);
  expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  expect(await (await fetch(`${mock.url}/_mock`)).json()).toMatchObject({ meta: { prod: "up", preprod: "down", int: "slow" }, ui: { prod: "up" } });
});
