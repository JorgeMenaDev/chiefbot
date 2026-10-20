import { expect, test } from "bun:test";
import { EnvironmentId, ServiceId, type ServiceCheck } from "@chiefbot/contracts";
import { openStore } from "../store.ts";
import type { SavedEnvironment } from "./serviceStore.ts";

const service = { id: ServiceId.parse("service_meta"), name: "Meta", icon: "data" } as const;
const prod: SavedEnvironment = {
  id: EnvironmentId.parse("env_prod"),
  name: "prod",
  url: "https://meta.example.com/actuator/health",
  auth: { kind: "bearer" },
  secretName: "service-first",
};
const down: ServiceCheck = { at: 1000, status: "down", code: 503, bodyStatus: "DOWN", latencyMs: 40, problem: "Answered 503 and reports DOWN" };

function setup() {
  const store = openStore(":memory:");
  const userId = store.upsertUser({ githubId: 1, login: "octo", copilotPlan: null });
  const latest = () => store.services.recent(prod.id, 0).map(({ at }) => at);
  return { store, services: store.services, userId, latest };
}

test("a check is kept only while its environment checks the same URL, the same way, with the same secret", () => {
  const { services, userId, latest } = setup();
  services.save(userId, service, [prod], 0);
  services.record(prod, down);

  // Renamed: still the same target, so its checks stay.
  services.save(userId, service, [{ ...prod, name: "production" }], 0);
  expect(latest()).toEqual([1000]);

  // A new secret, URL or authentication: the old checks describe something else.
  const replaced = { ...prod, secretName: "service-second" };
  services.save(userId, service, [replaced], 0);
  expect(latest()).toEqual([]);
  // A check that started before the change finishes after it: dropped.
  services.record(prod, { ...down, at: 2000 });
  services.record(replaced, { ...down, at: 3000 });
  expect(latest()).toEqual([3000]);
  services.save(userId, service, [{ ...replaced, url: "https://meta.example.com/health" }], 0);
  expect(latest()).toEqual([]);
});

test("saving and removing hand back the secret names no environment holds any more", () => {
  const { services, userId } = setup();
  const preprod: SavedEnvironment = { ...prod, id: EnvironmentId.parse("env_preprod"), name: "preprod", secretName: "service-preprod" };

  expect(services.save(userId, service, [prod, preprod], 0)).toEqual([]);
  expect(services.save(userId, service, [{ ...prod, secretName: "service-second" }, preprod], 0)).toEqual(["service-first"]);
  expect(services.saved(userId).map(({ secretName }) => secretName)).toEqual(["service-second", "service-preprod"]);
  expect(services.save(userId, service, [{ ...prod, auth: { kind: "none" }, secretName: null }], 0).sort()).toEqual(["service-preprod", "service-second"]);
  expect(services.save(userId, service, [prod], 0)).toEqual([]);
  expect(services.remove(userId, service.id)).toEqual(["service-first"]);
  expect(services.list(userId)).toEqual([]);
});

test("a stored check that is no longer a valid result is left out of the report, not thrown", () => {
  const { store, services, userId } = setup();
  services.save(userId, service, [prod], 0);
  services.record(prod, down);
  services.record(prod, { ...down, at: 2000, problem: "x".repeat(301) });

  expect(store.services.recent(prod.id, 0)).toEqual([down]);
});
