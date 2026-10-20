// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/chat/ChatComposer.tsx
// and ComposerSurface.tsx: the composer card, its prompt, its footer of controls and its send button.
import type { KeyboardEvent, ReactNode } from "react";

// T3 Code's composer: a rounded card pinned under the lane. The prompt is on top
// and grows with its text; under it the footer has the controls (`children`, such
// as the model, effort and access pickers) on the left and the round send button
// on the right. Enter sends, Shift+Enter adds a line. `error` shows under the prompt.
// The card is a container (`@container/composer`), so its controls can fold into
// one menu when it is narrow, as T3's do.
export function Composer({
  placeholder,
  draft,
  onDraft,
  onSend,
  canSend,
  error,
  children,
}: {
  placeholder: string;
  draft: string;
  onDraft: (draft: string) => void;
  onSend: () => void;
  canSend: boolean;
  error: string | null;
  children?: ReactNode;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSend();
  }

  return (
    <div className="shrink-0 px-5 pb-4">
      <form
        className="@container/composer mx-auto w-full max-w-3xl rounded-3xl border border-black/8 bg-card shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] transition-colors focus-within:border-black/14 dark:border-white/6 dark:shadow-[inset_0_1px_rgb(255_255_255/3%)] dark:focus-within:border-white/10"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="px-4 pt-4 pb-2">
          <textarea
            rows={2}
            aria-label="Message"
            className="block max-h-52 min-h-12 w-full resize-none bg-transparent text-sm leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/72"
            placeholder={placeholder}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        {error && (
          <p role="alert" className="px-4 pb-1 text-destructive-foreground text-xs">
            {error}
          </p>
        )}
        <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3">
          <div className="-my-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {children}
          </div>
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
      </form>
    </div>
  );
}
