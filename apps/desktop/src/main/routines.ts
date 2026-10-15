import { Routine, type BotId, type RoutineId, type RoutineInput } from "@chiefbot/contracts";
import { refusal } from "./controlApi.ts";

export type RoutinesOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
};

// A bot's routines, owned by Electron main: plain HTTP calls to control. Control
// runs them on schedule, whether or not the desktop is open.
export function createRoutines({ controlUrl, session }: RoutinesOptions) {
  // One control call; throws with control's error code when it refuses.
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${controlUrl}/bots/${path}`, {
      method,
      headers: { authorization: `Bearer ${session() ?? ""}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await refusal(res);
    return res;
  }

  return {
    list: async (botId: BotId) => Routine.array().parse(await (await call("GET", `${botId}/routines`)).json()),
    create: async (botId: BotId, input: RoutineInput) =>
      Routine.parse(await (await call("POST", `${botId}/routines`, input)).json()),
    update: async (botId: BotId, routineId: RoutineId, input: RoutineInput) =>
      Routine.parse(await (await call("PUT", `${botId}/routines/${routineId}`, input)).json()),
    remove: async (botId: BotId, routineId: RoutineId) => void (await call("DELETE", `${botId}/routines/${routineId}`)),
  };
}
