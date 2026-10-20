// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT): the context chip of
// apps/web/src/components/ContextChip.tsx, the composer's attachment tray and file rows in
// apps/web/src/components/chat/ChatComposer.tsx, and a sent message's images and files in MessagesTimeline.tsx.
import type { SentAttachment } from "@chiefbot/contracts";
import { FileTextIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { chipFor, isImage, sizeLabel, type DraftAttachment } from "./composerAttachments.ts";
import { Button } from "./components/ui/button.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { cn } from "./lib/utils.ts";

type Named = Pick<SentAttachment, "name" | "mimeType">;

// `text` with each file's chip ([name], composerAttachments.ts) drawn as T3 Code's
// context chip: red for an image, blue for any other file. The chip keeps the
// text's exact width (its brackets turn invisible, no padding or border), so the
// composer can draw it under the prompt's own letters.
export function ChipText({ text, attachments }: { text: string; attachments: readonly Named[] }) {
  if (attachments.length === 0) return text;
  const byChip = new Map(attachments.map((file) => [chipFor(file.name), file]));
  const chips = [...byChip.keys()].sort((a, b) => b.length - a.length).map((chip) => chip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Splitting on a capturing group keeps the chips, at odd positions.
  return text.split(new RegExp(`(${chips.join("|")})`)).map((part, index) => {
    const file = index % 2 === 1 ? byChip.get(part) : undefined;
    if (!file) return part;
    return (
      <span
        // A chip's text is unique within the message, but may repeat.
        key={index}
        className={cn(
          "rounded-[0.4em] bg-(--chip)/11 text-(--chip-foreground) shadow-[inset_0_0_0_1px_var(--chip-border)] [box-decoration-break:clone]",
          "[--chip-border:color-mix(in_oklab,var(--chip)_34%,var(--border))] [--chip-foreground:color-mix(in_oklab,var(--chip)_22%,var(--foreground))]",
          isImage(file.mimeType) ? "[--chip:oklch(0.62_0.16_16)]" : "[--chip:oklch(0.62_0.136_237)]",
        )}
      >
        <span className="text-transparent">[</span>
        {file.name}
        <span className="text-transparent">]</span>
      </span>
    );
  });
}

// The composer's files above its prompt: images as thumbnails (a spinner while
// read), other files as a row each, every one with a remove button. A file with a
// chip in the prompt keeps its row too: the chip is text, with no button of its own.
export function AttachmentTray({ attachments, onRemove }: { attachments: DraftAttachment[]; onRemove: (file: DraftAttachment) => void }) {
  const images = attachments.filter(({ mimeType }) => isImage(mimeType));
  const files = attachments.filter(({ mimeType }) => !isImage(mimeType));
  return (
    <>
      {images.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {images.map((image) => (
            <div key={image.id} className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-border/80 bg-background">
              {image.data === null ? (
                <Spinner className="size-4 text-muted-foreground" />
              ) : (
                <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} className="h-full w-full object-cover" />
              )}
              <RemoveButton name={image.name} variant="media-close" className="absolute top-1 right-1" onClick={() => onRemove(image)} />
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-3 flex flex-col gap-1">
          {files.map((file) => (
            <div key={file.id} className="flex min-w-0 items-center gap-2 py-1 text-foreground text-sm">
              {file.data === null ? <Spinner className="size-4 shrink-0 text-muted-foreground" /> : <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="shrink-0 text-muted-foreground text-xs">{sizeLabel(file.size)}</span>
              <RemoveButton name={file.name} variant="ghost" onClick={() => onRemove(file)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RemoveButton({ name, variant, className, onClick }: { name: string; variant: "media-close" | "ghost"; className?: string; onClick: () => void }) {
  return (
    <Button variant={variant} size="icon-xs" className={className} aria-label={`Remove ${name}`} onClick={onClick}>
      <XIcon />
    </Button>
  );
}

// A sent message's files, at the top of its bubble: images as thumbnails
// (`read` gives each one's data: URL), then the files its text has no chip for.
export function SentAttachments({ text, attachments, read }: { text: string; attachments: SentAttachment[]; read: (id: SentAttachment["id"]) => Promise<unknown> }) {
  const images = attachments.filter(({ mimeType }) => isImage(mimeType));
  const files = attachments.filter(({ mimeType, name }) => !isImage(mimeType) && !text.includes(chipFor(name)));
  return (
    <>
      {images.length > 0 && (
        <div className="mb-2 grid max-w-[210px] grid-cols-2 gap-2">
          {images.map((image) => (
            <div key={image.id} className="aspect-[4/3] overflow-hidden rounded-lg border border-border/80 bg-background/70">
              <SentImage image={image} read={read} />
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {files.map(({ id, name, size }) => (
            <div key={id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
              <FileTextIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="shrink-0 text-muted-foreground text-xs">{sizeLabel(size)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// `read`, keeping its last `limit` answers, newest last: a chat's sent images as
// data: URLs, so one that scrolls back into view is not read again. The chat makes
// one per bot, so leaving the chat (or deleting the bot) lets them all go.
export function recentReads<Id, Value>(read: (id: Id) => Promise<Value>, limit: number) {
  const recent = new Map<Id, Promise<Value>>();
  return (id: Id) => {
    const value = recent.get(id) ?? read(id);
    recent.delete(id);
    recent.set(id, value);
    for (const oldest of recent.keys()) {
      if (recent.size <= limit) break;
      recent.delete(oldest);
    }
    value.catch(() => recent.get(id) === value && recent.delete(id));
    return value;
  };
}

// The image while it is in view, read when it comes into view; its name
// otherwise, or if it cannot be read. Out of view it lets the image go, so a
// long chat holds only the images in view and `read`'s recent ones.
function SentImage({ image, read }: { image: SentAttachment; read: (id: SentAttachment["id"]) => Promise<unknown> }) {
  const box = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!inView) {
      setSrc(null);
      return;
    }
    let current = true;
    read(image.id).then(
      (value) => current && typeof value === "string" && setSrc(value),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [inView, image.id, read]);
  return (
    <div ref={box} className="size-full">
      {src ? (
        <img src={src} alt={image.name} decoding="async" className="block size-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center px-2 text-center text-muted-foreground text-xs">{image.name}</div>
      )}
    </div>
  );
}
