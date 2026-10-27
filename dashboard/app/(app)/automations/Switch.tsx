"use client";
import { Switch as S } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Page-local until P0 ships one. 40x24 track, 28px+ hit area via the after: pseudo, thumb moves with transform only. */
export function Switch({ className, ...p }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root data-ui="switch" className={cn(
      "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-border-strong bg-surface-3 p-0.5 transition-colors duration-[var(--dur-fast)] after:absolute after:-inset-1.5 after:content-[''] " +
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-7 pointer-coarse:w-12", className)} {...p}>
      <S.Thumb className="block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-fast)] ease-out data-[state=checked]:translate-x-4 pointer-coarse:size-5 pointer-coarse:data-[state=checked]:translate-x-5" />
    </S.Root>
  );
}
