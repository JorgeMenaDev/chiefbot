// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT): the context chip of
// apps/web/src/components/ContextChip.tsx, the composer's attachment tray and file rows in
// apps/web/src/components/chat/ChatComposer.tsx, and a sent message's images and files in MessagesTimeline.tsx.
import type { SentAttachment } from "@chiefbot/contracts";
import { FileTextIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { chipFor, isImage, sizeLabel, type DraftAttachment } from "./composerAttachments.ts";
import { Button } from "./components/ui/button.tsx";
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

// The composer's files above its prompt: images as thumbnails, other files as a
// row each unless the prompt shows their chip, every one with a remove button.
export function AttachmentTray({ attachments, draft, onRemove }: { attachments: DraftAttachment[]; draft: string; onRemove: (id: string) => void }) {
  const images = attachments.filter(({ mimeType }) => isImage(mimeType));
  const files = attachments.filter(({ mimeType, name }) => !isImage(mimeType) && !draft.includes(chipFor(name)));
  return (
    <>
      {images.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {images.map(({ id, name, mimeType, data }) => (
            <div key={id} className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background">
              <img src={`data:${mimeType};base64,${data}`} alt={name} className="h-full w-full object-cover" />
              <RemoveButton name={name} variant="media-close" className="absolute top-1 right-1" onClick={() => onRemove(id)} />
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-3 flex flex-col gap-1">
          {files.map(({ id, name, size }) => (
            <div key={id} className="flex min-w-0 items-center gap-2 py-1 text-foreground text-sm">
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="shrink-0 text-muted-foreground text-xs">{sizeLabel(size)}</span>
              <RemoveButton name={name} variant="ghost" onClick={() => onRemove(id)} />
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

// Each sent image's data: URL, read once per window.
const imageUrls = new Map<string, Promise<unknown>>();

// The image once read; its name until then, or if it cannot be read.
function SentImage({ image, read }: { image: SentAttachment; read: (id: SentAttachment["id"]) => Promise<unknown> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const url = imageUrls.get(image.id) ?? read(image.id);
    imageUrls.set(image.id, url);
    url.then(
      (value) => current && typeof value === "string" && setSrc(value),
      () => imageUrls.delete(image.id),
    );
    return () => {
      current = false;
    };
  }, [image.id, read]);
  if (!src) return <div className="flex h-full items-center justify-center px-2 text-center text-muted-foreground text-xs">{image.name}</div>;
  return <img src={src} alt={image.name} decoding="async" className="block size-full object-cover" />;
}
