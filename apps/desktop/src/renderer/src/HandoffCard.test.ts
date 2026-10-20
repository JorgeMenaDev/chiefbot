import { expect, test } from "bun:test";
import { replyFor } from "./HandoffCard.tsx";

test("an answer sent again unchanged keeps its delivery id, and an edited one or one for a new question gets a new id", () => {
  const first = replyFor(null, "Stripe.", "Stripe or Adyen?");
  // The first send got no reply (control may have it): the same answer is the same delivery.
  expect(replyFor(first, "Stripe.", "Stripe or Adyen?")).toEqual(first);
  const edited = replyFor(first, "Adyen instead.", "Stripe or Adyen?");
  expect(edited).toMatchObject({ text: "Adyen instead.", question: "Stripe or Adyen?" });
  expect(edited.deliveryId).not.toBe(first.deliveryId);
  expect(replyFor(first, "Stripe.", "Which payment provider?").deliveryId).not.toBe(first.deliveryId);
});
