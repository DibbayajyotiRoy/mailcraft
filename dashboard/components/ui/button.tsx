"use client";
import type { VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { Slot } from "radix-ui";
import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { buttonVariants } from "./button-variants";

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean };

/** `loading` swaps in a spinner but keeps the width (children stay laid out, just hidden). */
export function Button({ className, variant, size, asChild, loading, children, disabled, ...p }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading}
      aria-busy={loading || undefined} {...(!asChild && { type: p.type ?? "button" })} {...p}>
      {asChild ? children : (
        <>
          <span className={cn("inline-flex items-center gap-2", loading && "opacity-0")}>{children}</span>
          {loading && <Loader2 aria-hidden className="absolute animate-spin" />}
        </>
      )}
    </Comp>
  );
}

/** Submit button for server-action forms: disables itself while the action is pending. */
export function SubmitButton(p: Omit<ButtonProps, "type" | "loading">) {
  const { pending } = useFormStatus();
  return <Button {...p} type="submit" loading={pending} />;
}
