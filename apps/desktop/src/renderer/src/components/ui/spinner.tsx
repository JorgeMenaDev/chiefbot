// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT), apps/web/src/components/ui/spinner.tsx.
import { LoaderCircleIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Spinner({ className, ...props }: ComponentProps<typeof LoaderCircleIcon>) {
  return <LoaderCircleIcon aria-label="Loading" role="status" className={cn("animate-spin", className)} {...props} />;
}
