import { Bot, type BotAvatar, DEFAULT_AVATAR } from "@chiefbot/contracts";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Avatar, avatarColorOptions, avatarShapes } from "./Avatar.tsx";
import { ErrorText } from "./Pane.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { cn } from "./lib/utils.ts";

// A picked option's ring (checked) and the keyboard's (focus-visible) differ, so both can show at once.
// Health's service icon picker (Services.tsx) uses it too.
export const option =
  "flex cursor-pointer items-center justify-center rounded-full outline-ring outline-offset-2 transition-shadow has-checked:ring-2 has-checked:ring-foreground/24 has-focus-visible:outline-2";

// The Create New Bot dialog, after Grok's: a live preview of the bot's face over its
// name, the faces and the colours. Open while mounted; Cancel, Escape or a made bot call onClose.
export function NewBot({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<BotAvatar>(DEFAULT_AVATAR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  // Whether this dialog was dismissed while its bot was still being made. The bot still
  // gets made and selected, but closing then must not close a New bot dialog opened since.
  const dismissed = useRef(false);
  useEffect(() => {
    dismissed.current = false;
    return () => {
      dismissed.current = true;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bot = Bot.parse(await window.chiefbot.bots.create({ name, avatar }));
      onCreated(bot.id);
      if (!dismissed.current) onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} aria-labelledby={titleId}>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle id={titleId}>Create New Bot</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col items-center gap-6 space-y-0 pt-2">
            <Avatar avatar={avatar} className="size-24" />
            <Input
              aria-label="Bot name"
              placeholder="Name your bot"
              value={name}
              maxLength={60}
              disabled={busy}
              className="h-10 text-center text-base"
              onChange={(event) => setName(event.target.value)}
            />
            <fieldset disabled={busy} className="grid grid-cols-6 gap-x-3 gap-y-2">
              <legend className="sr-only">Face</legend>
              {avatarShapes.map(({ shape, label }) => (
                <label key={shape} title={label} className={cn(option, "size-14 hover:bg-accent")}>
                  <input
                    type="radio"
                    name="shape"
                    aria-label={label}
                    className="sr-only"
                    checked={avatar.shape === shape}
                    onChange={() => setAvatar({ ...avatar, shape })}
                  />
                  <Avatar avatar={{ ...avatar, shape }} className="size-10" />
                </label>
              ))}
            </fieldset>
            <fieldset disabled={busy} className="flex flex-wrap justify-center gap-2">
              <legend className="sr-only">Colour</legend>
              {avatarColorOptions.map(({ color, label, hex }) => (
                <label key={color} title={label} className={cn(option, "size-9")}>
                  <input
                    type="radio"
                    name="color"
                    aria-label={label}
                    className="sr-only"
                    checked={avatar.color === color}
                    onChange={() => setAvatar({ ...avatar, color })}
                  />
                  <span className="size-7 rounded-full" style={{ backgroundColor: hex }} />
                </label>
              ))}
            </fieldset>
            <ErrorText message={error} />
          </DialogPanel>
          <DialogFooter>
            {busy && (
              <p className="flex items-center gap-1.5 text-muted-foreground text-xs sm:me-auto">
                <Spinner className="size-3" />
                Starting its computer…
              </p>
            )}
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
    </Dialog>
  );
}
