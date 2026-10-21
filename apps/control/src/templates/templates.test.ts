import { afterEach, expect, test } from "bun:test";
import { Template } from "@chiefbot/contracts";
import { cleanUp, startTestControl } from "../testControl.ts";

afterEach(cleanUp);

test("a signed-in person lists the templates the repo ships, with their services, stages and brief notes", async () => {
  const { url, user } = await startTestControl();

  const res = await user.api("GET", "/templates");
  const templates = Template.array().parse(await res.json());

  expect(templates.map(({ name, title, services, stages }) => [name, title, Object.keys(services), stages.map(({ label }) => label)])).toEqual([
    ["java-react-enterprise", "Java and React enterprise", ["ui", "meta", "auth"], ["Database", "API", "Gateway", "Seed", "App"]],
  ]);
  expect(templates[0]?.notes[0]).toBe("The app: http://localhost:3000/acme-ui");
  expect((await fetch(`${url}/templates`)).status).toBe(401);
});
