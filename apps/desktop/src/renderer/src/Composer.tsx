// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/chat/ChatComposer.tsx
// and ComposerSurface.tsx: the composer card, its prompt, its footer of controls and its send button, and its
// attachments (paste, drop or the paperclip; the tray; a chip in the prompt).
import { PaperclipIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { AttachmentTray, ChipText } from "./Attachments.tsx";
import { chipFor, isImage, readInto, reserve, typeOf, type DraftAttachment } from "./composerAttachments.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

// The prompt's box, shared by the textarea and the chips drawn under its letters.
const promptBox = "block max-h-52 min-h-12 w-full text-sm leading-relaxed";

// T3 Code's composer: a rounded card pinned under the lane. The prompt is on top
// and grows with its text; under it the footer has the controls (`children`, such
// as the model, effort and access pickers) on the left and the round send button
// on the right. Enter sends, Shift+Enter adds a line. `error` shows under the
// prompt, and `notice` (a note that is not an error) under that.
// The card is a container (`@container/composer`), so its controls can fold into
// one menu when it is narrow, as T3's do.
// With `attachments` it takes files, as T3 Code's does: pasted, dropped on it or
// picked with the paperclip, up to the limits (composerAttachments.ts). Images show
// as thumbnails above the prompt, other files as rows. A file's chip ([name]) goes
// where the cursor is: always for a document, and for an image when the prompt
// already has text. The prompt draws each chip as a chip. A file is in the
// composer (counted, named, chipped) as soon as it is picked, and read after;
// the owner keeps send off until every one is read (composerAttachments uploads).
// `locked` (while a message is being sent) keeps the prompt and its files as they are.
export function Composer({
  placeholder,
  draft,
  onDraft,
  onSend,
  canSend,
  locked = false,
  error,
  notice = null,
  attachments,
  children,
}: {
  placeholder: string;
  draft: string;
  onDraft: Dispatch<SetStateAction<string>>;
  onSend: () => void;
  canSend: boolean;
  locked?: boolean;
  error: string | null;
  notice?: string | null;
  attachments?: { items: DraftAttachment[]; onChange: Dispatch<SetStateAction<DraftAttachment[]>> };
  children?: ReactNode;
}) {
  const prompt = useRef<HTMLTextAreaElement>(null);
  const chipLayer = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const files = attachments?.items ?? [];
  // The files as of the last attach, before React shows them: what the next attach counts.
  const latest = useRef(files);
  useLayoutEffect(() => {
    latest.current = files;
  });

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  function send() {
    setAttachError(null);
    onSend();
  }

  // Adds the files that fit at once, then reads each into its place (readInto).
  function attach(picked: File[]) {
    if (!attachments || locked || picked.length === 0) return;
    const { reserved, error } = reserve(picked, latest.current);
    setAttachError(error);
    if (reserved.length === 0) return;
    const added = reserved.map(({ attachment }) => attachment);
    latest.current = [...latest.current, ...added];
    attachments.onChange((items) => [...items, ...added]);
    readInto(reserved, {
      files: () => latest.current,
      setFiles: attachments.onChange,
      onFailed: (attachment) => {
        setAttachError(`'${attachment.name}' is empty or could not be read.`);
        remove(attachment);
      },
    });
    const element = prompt.current;
    if (!element) return;
    const { value, selectionStart, selectionEnd } = element;
    const chips = added.filter(({ mimeType }) => !isImage(mimeType) || value.trim() !== "").map(({ name }) => chipFor(name));
    if (chips.length === 0) return;
    const before = value.slice(0, selectionStart);
    const inserted = `${before === "" || /\s$/.test(before) ? "" : " "}${chips.join(" ")} `;
    onDraft(before + inserted + value.slice(selectionEnd));
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  }

  // Removing a file takes its chip out of the prompt too: its name is its own among the files.
  function remove(file: DraftAttachment) {
    attachments?.onChange((items) => items.filter((item) => item.id !== file.id));
    const chip = chipFor(file.name);
    onDraft((text) => text.replaceAll(`${chip} `, "").replaceAll(chip, ""));
  }

  // T3 Code's rule: a paste is files when one is an image or nothing came as text.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length === 0) return;
    if (!pasted.some((file) => isImage(typeOf(file))) && event.clipboardData.getData("text/plain") !== "") return;
    event.preventDefault();
    attach(pasted);
  }

  const shown = attachError ?? error;
  return (
    <div className="shrink-0 px-5 pb-4">
      <form
        className={cn(
          "@container/composer mx-auto w-full max-w-3xl rounded-3xl border border-black/8 bg-card shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] transition-colors focus-within:border-black/14 dark:border-white/6 dark:shadow-[inset_0_1px_rgb(255_255_255/3%)] dark:focus-within:border-white/10",
          dragOver && "bg-accent/45 ring-1 ring-primary/70 ring-inset",
        )}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (!attachments || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragOver(false);
        }}
        onDrop={(event) => {
          if (!attachments) return;
          event.preventDefault();
          setDragOver(false);
          attach(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="px-4 pt-4 pb-2">
          <AttachmentTray
            attachments={files}
            onRemove={(file) => {
              if (locked) return;
              setAttachError(null);
              remove(file);
            }}
          />
          <div className="relative">
            {/* With files, the textarea's letters turn transparent and this layer draws them, chips and all. */}
            {files.length > 0 && (
              <div
                ref={chipLayer}
                aria-hidden="true"
                className={cn(promptBox, "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words [scrollbar-gutter:stable]")}
              >
                <ChipText text={draft} attachments={files} />
              </div>
            )}
            <textarea
              ref={prompt}
              rows={2}
              aria-label="Message"
              className={cn(
                promptBox,
                "resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-muted-foreground/72",
                files.length > 0 && "text-transparent caret-foreground [scrollbar-gutter:stable]",
              )}
              placeholder={placeholder}
              value={draft}
              readOnly={locked}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onScroll={(event) => {
                if (chipLayer.current) chipLayer.current.scrollTop = event.currentTarget.scrollTop;
              }}
            />
          </div>
        </div>
        {shown && (
          <p role="alert" className="px-4 pb-1 text-destructive-foreground text-xs">
            {shown}
          </p>
        )}
        {notice && <p className="px-4 pb-1 text-warning-foreground text-xs">{notice}</p>}
        <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3">
          <div className="-my-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {children}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {attachments && (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    const picked = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    attach(picked);
                  }}
                />
                <Button variant="ghost" size="icon-sm" aria-label="Attach files" title="Attach files" disabled={locked} onClick={() => picker.current?.click()}>
                  <PaperclipIcon />
                </Button>
              </>
            )}
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 hover:bg-message-action-hover disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
