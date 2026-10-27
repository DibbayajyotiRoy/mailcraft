"use client";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { Slot } from "radix-ui";
import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium select-none " +
    "transition-[transform,background-color,border-color,color] duration-[var(--dur-fast)] ease-out active:scale-[.97] " +
    "disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress " +
    "after:absolute after:-inset-1 after:content-[''] [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:brightness-110",
        secondary: "border border-border-strong bg-surface text-fg hover:bg-surface-2",
        ghost: "text-fg hover:bg-surface-2",
        "danger-outline": "border border-bad text-bad hover:bg-bad-bg",
        danger: "bg-bad text-on-bad hover:brightness-110",
        approve: "bg-ok text-on-ok hover:brightness-110",
      },
      size: {
        sm: "h-8 px-3 text-sm pointer-coarse:h-11",
        md: "h-8 px-3 text-sm pointer-coarse:h-11",
        lg: "h-10 px-4 text-base pointer-coarse:h-11",
        icon: "size-8 pointer-coarse:size-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean };

/** `loading` swaps in a spinner but keeps the width (children stay laid out, just hidden). */
export function Button({ className, variant, size, asChild, loading, children, disabled, ...p }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp data-ui="button" className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading}
      aria-busy={loading || undefined} {...(!asChild && { type: p.type ?? "button" })} {...p}>
      {asChild ? children : (
        <>
          <span className={cn("inline-flex items-center gap-2", loading && "invisible")}>{children}</span>
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
