import { expect, test } from "bun:test";
import { jsonWithin } from "./http.ts";

const post = (body: string) => new Request("http://control.test/", { method: "POST", body });

test("a body is read as JSON only while it stays within the limit", async () => {
  expect(await jsonWithin(post("[1,2,3]"), 100)).toEqual({ json: [1, 2, 3] });
  expect(await jsonWithin(post("not json"), 100)).toEqual({ json: null });
  expect(await jsonWithin(post("[1,2,3]"), 6)).toBeNull();
});
