import { z } from "zod";

// The desktop's theme, as T3 Code offers it: follow the OS, or always light or dark.
// The renderer sends it to Electron main, which sets the native theme to match.
export const Theme = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof Theme>;
