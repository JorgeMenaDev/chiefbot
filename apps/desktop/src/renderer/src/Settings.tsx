import type { Theme } from "@chiefbot/contracts";
import { SettingsIcon } from "lucide-react";
import { PaneHeader } from "./Pane.tsx";
import { cn } from "./lib/utils.ts";
import { useTheme } from "./lib/theme.ts";

// Settings, from the gear menu: for now only the colour scheme, as T3 Code's
// Settings → Appearance shows it (apps/web/src/components/settings/ThemeSettings.tsx,
// MIT): a tile per mode with a small picture of the app in it. Dark is the default.
export function Settings() {
  const [theme, setTheme] = useTheme();
  return (
    <>
      <PaneHeader icon={<SettingsIcon className="size-4 text-muted-foreground" />} title="Settings" note="Appearance" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-labelledby="color-scheme" className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-5 pt-6 pb-12 sm:px-6">
          <h3 id="color-scheme" className="px-3 font-normal text-foreground/70 text-sm sm:px-4">
            Color scheme
          </h3>
          <div aria-label="Appearance mode" className="grid w-full grid-cols-3 gap-3" role="group">
            {modes.map(({ mode, label }) => {
              const active = theme === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-label={mode === "system" ? "Follow the system appearance" : `Use ${mode} mode`}
                  aria-pressed={active}
                  className={cn(
                    "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid focus-visible:-outline-offset-2",
                    active ? "border-transparent bg-accent/30 shadow-[inset_0_0_0_1px_var(--ring)]" : "border-border/70 bg-card/60 hover:bg-accent/10",
                  )}
                  onClick={() => setTheme(mode)}
                >
                  <Wireframe panes={mode === "system" ? ["light", "dark"] : [mode]} />
                  <span className={cn("flex items-center justify-center font-medium text-xs", active ? "text-foreground" : "text-muted-foreground")}>{label}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </>
  );
}

// T3 Code's modes, in its order.
const modes: { mode: Theme; label: string }[] = [
  { mode: "system", label: "System" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

// Chiefbot's colours (styles.css) for the picture, which shows both whatever the theme.
const previewColors = {
  light: { canvas: "#fcfcfc", sidebar: "#fafafa", surface: "#ffffff", accentSurface: "#f4f4f5", messageSurface: "#e4e4e7", messageAction: "oklch(0.488 0.217 264)" },
  dark: { canvas: "#0a0a0a", sidebar: "#000000", surface: "#121212", accentSurface: "#27272a", messageSurface: "#27272a", messageAction: "oklch(0.588 0.217 264)" },
};

// A small picture of the app: one pane, or for System the light half beside the dark half.
// Adapted from T3 Code's apps/web/src/components/settings/ThemeWireframe.tsx (MIT).
function Wireframe({ panes }: { panes: ("light" | "dark")[] }) {
  return (
    <span aria-hidden className="relative block h-[8.75rem] w-full overflow-hidden rounded-lg border border-border/60">
      {panes.map((appearance) => (
        <WireframePane key={appearance} colors={previewColors[appearance]} clip={panes.length === 1 ? undefined : appearance === "light" ? "left" : "right"} />
      ))}
    </span>
  );
}

function WireframePane({ colors, clip }: { colors: (typeof previewColors)["light"]; clip: "left" | "right" | undefined }) {
  const line = "rgb(127 127 127 / 0.25)";
  return (
    <span
      className="absolute inset-0"
      style={
        clip && {
          clipPath:
            clip === "left"
              ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
              : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
        }
      }
    >
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      {/* The sidebar and its rows. */}
      <span className="absolute inset-y-0 left-0 w-[22%]" style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${line}` }} />
      <span className="absolute top-[8%] left-[3%] h-[8%] w-[16%] rounded-md" style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }} />
      <span className="absolute top-[22%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.accentSurface }} />
      <span className="absolute top-[32%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.messageSurface, opacity: 0.7 }} />
      <span className="absolute top-[42%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.messageSurface, opacity: 0.5 }} />
      {/* The chat: a message, a reply and the composer. */}
      <span className="absolute top-[11%] right-[28%] h-[9%] w-[24%] rounded-lg" style={{ backgroundColor: colors.messageSurface }} />
      <span className="absolute top-[28%] left-[27%] h-[5%] w-[34%] rounded-sm" style={{ backgroundColor: line }} />
      <span className="absolute top-[38%] left-[27%] h-[5%] w-[26%] rounded-sm" style={{ backgroundColor: line }} />
      <span
        className="absolute right-[6%] bottom-[8%] left-[26%] flex h-[15%] items-center justify-between rounded-md px-1"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      >
        <span className="block h-[26%] w-[34%] rounded-full" style={{ backgroundColor: line, opacity: 0.7 }} />
        <span className="block aspect-square h-[58%] rounded-full" style={{ backgroundColor: colors.messageAction }} />
      </span>
      {/* The details panel. */}
      <span
        className="absolute top-[8%] right-[5%] h-[46%] w-[20%] rounded-lg"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}, 0 2px 5px rgb(0 0 0 / 0.14)` }}
      >
        {["#34d399", colors.messageAction, "#fbbf24"].map((dot, row) => (
          <span key={row} className="absolute right-[11%] left-[11%] flex items-center gap-1" style={{ top: `${10 + row * 30}%`, height: "20%" }}>
            <span className="block aspect-square h-[26%] rounded-full" style={{ backgroundColor: dot, opacity: 0.55 }} />
            <span className="block h-[30%] w-[52%] rounded-sm" style={{ backgroundColor: line }} />
          </span>
        ))}
      </span>
    </span>
  );
}
