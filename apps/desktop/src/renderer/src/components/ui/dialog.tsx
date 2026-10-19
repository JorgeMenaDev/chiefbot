// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/dialog.tsx and
// dialog-styles.ts: the same popup, header, footer and close button, on a native <dialog> portalled to
// <body>. showModal() gives the backdrop, the focus trap and Escape; the glass look is `dialog-glass` in styles.css.
import { XIcon } from "lucide-react";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils.ts";
import { Button } from "./button.tsx";

// A modal, open while mounted. Escape, the close button and a click on the backdrop call onClose.
// Closing it on unmount, before it leaves the page, hands focus back to what had it.
export function Dialog({ onClose, className, children, ...props }: Omit<ComponentProps<"dialog">, "open" | "onClose"> & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // A press that starts inside (say, selecting the name) and ends on the backdrop is not a backdrop click.
  const pressedBackdrop = useRef(false);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      data-slot="dialog-popup"
      className={cn(
        "dialog-glass m-auto w-[calc(100%-2rem)] max-w-lg flex-col rounded-2xl border p-0 text-popover-foreground outline-none open:flex",
        className,
      )}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) onClose();
      }}
      {...props}
    >
      {children}
      <Button aria-label="Close" size="icon" variant="ghost" className="absolute end-2 top-2" onClick={onClose}>
        <XIcon />
      </Button>
    </dialog>,
    document.body,
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-2 p-6", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="dialog-title" className={cn("wrap-anywhere font-semibold text-xl leading-none", className)} {...props} />;
}

export function DialogPanel({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-panel" className={cn("space-y-4 p-6", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t bg-muted/72 px-6 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}
