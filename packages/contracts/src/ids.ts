import { z } from "zod";

// Branded ids so a BotId can never be passed where a UserId is expected.
export const UserId = z.string().min(1).brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const BotId = z.string().min(1).brand<"BotId">();
export type BotId = z.infer<typeof BotId>;
