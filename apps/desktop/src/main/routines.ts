import { Routine, type BotId, type RoutineId, type RoutineInput } from "@chiefbot/contracts";
import { controlCaller } from "./controlApi.ts";

export type RoutinesOptions = {
  controlUrl: string;
  // The saved control session, or null when signed out.
  session: () => string | null;
};

// A bot's routines, owned by Electron main: plain HTTP calls to control. Control
// runs them on schedule, whether or not the desktop is open.
export function createRoutines({ controlUrl, session }: RoutinesOptions) {
  const call = controlCaller({ controlUrl, session });

  return {
    list: async (botId: BotId) => Routine.array().parse(await (await call("GET", `/bots/${botId}/routines`)).json()),
    create: async (botId: BotId, input: RoutineInput) =>
      Routine.parse(await (await call("POST", `/bots/${botId}/routines`, input)).json()),
    update: async (botId: BotId, routineId: RoutineId, input: RoutineInput) =>
      Routine.parse(await (await call("PUT", `/bots/${botId}/routines/${routineId}`, input)).json()),
    remove: async (botId: BotId, routineId: RoutineId) => void (await call("DELETE", `/bots/${botId}/routines/${routineId}`)),
  };
}
