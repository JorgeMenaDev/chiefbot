// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/alert.tsx.
// Children sort into slots: an icon first, then AlertTitle/AlertDescription, then AlertAction on the right.
import { cva, type VariantProps } from "class-variance-authority";
import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

const alertVariants = cva("relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm", {
  defaultVariants: { variant: "default" },
  variants: {
    variant: {
      default: "bg-transparent dark:bg-input/32 [&_svg]:text-muted-foreground",
      error:
        "border-error/32 bg-error-surface text-error-foreground [&_[data-slot=alert-description]]:text-error-foreground/80 [&_svg]:text-error",
      info: "border-info/32 bg-info/4 [&_svg]:text-info",
      success: "border-success/32 bg-success/4 [&_svg]:text-success",
      warning:
        "border-warning/32 bg-warning-surface text-warning-foreground [&_[data-slot=alert-description]]:text-warning-foreground/80 [&_svg]:text-warning",
    },
  },
});

const slots = new Map<unknown, "content" | "action">();

export function Alert({ className, variant, children, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const icon: ReactNode[] = [];
  const content: ReactNode[] = [];
  const action: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) content.push(child);
    else if (slots.get(child.type) === "action") action.push(child);
    else if (slots.get(child.type) === "content") content.push(child);
    else icon.push(child);
  });

  return (
    <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
      <div className="flex items-start gap-2">
        {icon.length > 0 && <div className="flex h-lh w-4 shrink-0 items-center justify-center [&>svg]:size-4">{icon}</div>}
        {content.length > 0 && <div className="flex min-w-0 flex-1 flex-col gap-0.5">{content}</div>}
        {action.length > 0 && <div className="flex shrink-0 items-center self-center">{action}</div>}
      </div>
    </div>
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("flex flex-col gap-2.5 text-muted-foreground", className)} {...props} />;
}

export function AlertAction({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-action" className={cn("flex gap-1", className)} {...props} />;
}

slots.set(AlertTitle, "content").set(AlertDescription, "content").set(AlertAction, "action");
