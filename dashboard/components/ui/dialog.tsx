"use client";
import { X } from "lucide-react";
import { AlertDialog as Alert, Dialog as D } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { buttonVariants } from "./button-variants";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const AlertDialog = Alert.Root;
export const AlertDialogTrigger = Alert.Trigger;

const overlay = "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-fade-in";
const panel = "fixed z-50 border border-border bg-bg shadow-pop focus:outline-none";

/** Centered modal. Title is required (it names the dialog for screen readers); description is optional. */
export function DialogContent({ title, description, children, className, footer }: {
  title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; footer?: ReactNode;
}) {
  return (
    <D.Portal>
      <D.Overlay className={overlay} />
      <D.Content className={cn(panel, "left-1/2 top-1/2 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg p-5 data-[state=open]:animate-pop-in", className)}>
        <D.Title className="text-md font-medium">{title}</D.Title>
        {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        <D.Close aria-label="Close" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "absolute right-3 top-3")}><X aria-hidden /></D.Close>
      </D.Content>
    </D.Portal>
  );
}

/** Side drawer (mobile nav, peek panels). */
export function DrawerContent({ title, children, side = "left", className }: { title: ReactNode; children: ReactNode; side?: "left" | "right"; className?: string }) {
  return (
    <D.Portal>
      <D.Overlay className={overlay} />
      <D.Content className={cn(panel, "inset-y-0 w-[min(320px,calc(100%-48px))] data-[state=open]:animate-slide-in-left", side === "left" ? "left-0 border-l-0" : "right-0 border-r-0", className)}>
        <D.Title className="sr-only">{title}</D.Title>
        <D.Description className="sr-only">{title}</D.Description>
        {children}
      </D.Content>
    </D.Portal>
  );
}

/** Confirm dialog for destructive/emergency actions. `onConfirm` runs on the action button. */
export function AlertDialogContent({ title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = true, onConfirm }: {
  title: ReactNode; description: ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean; onConfirm?: () => void;
}) {
  return (
    <Alert.Portal>
      <Alert.Overlay className={overlay} />
      <Alert.Content className={cn(panel, "left-1/2 top-1/2 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg p-5 data-[state=open]:animate-pop-in")}>
        <Alert.Title className="text-md font-medium">{title}</Alert.Title>
        <Alert.Description className="mt-1 text-sm text-muted">{description}</Alert.Description>
        <div className="mt-5 flex justify-end gap-2">
          <Alert.Cancel asChild><Button variant="secondary">{cancelLabel}</Button></Alert.Cancel>
          <Alert.Action asChild><Button variant={destructive ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></Alert.Action>
        </div>
      </Alert.Content>
    </Alert.Portal>
  );
}
