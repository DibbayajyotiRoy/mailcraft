"use client";
import { LogOut, Menu, ShieldAlert, ShieldCheck, User } from "lucide-react";
import { useRef, useState } from "react";
import { logout, setKill } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, Dialog, DialogTrigger, DrawerContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { EnvChip } from "@/components/ui/env-chip";
import { KillSwitchPill } from "@/components/ui/kill-switch-pill";
import { Nav } from "./nav";
import { ThemeToggle } from "./theme-toggle";

/** Pill + menu: Release submits at once; Engage asks once (emergency control, a single confirm). */
export function KillSwitchControl({ on }: { on: boolean | null }) {
  const form = useRef<HTMLFormElement>(null);
  const [ask, setAsk] = useState(false);
  if (on === null) return <KillSwitchPill on={null} />;
  return (
    <>
      <form ref={form} action={setKill} hidden><input type="hidden" name="on" value={String(!on)} /></form>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button data-ui="kill" type="button" aria-label="Kill switch actions" className="rounded-full pointer-coarse:min-h-11 pointer-coarse:flex pointer-coarse:items-center"><KillSwitchPill on={on} /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>{on ? "All sending is stopped" : "Sending is live"}</DropdownMenuLabel>
          {on
            ? <DropdownMenuItem onSelect={() => form.current?.requestSubmit()}><ShieldCheck aria-hidden />Release kill switch</DropdownMenuItem>
            : <DropdownMenuItem destructive onSelect={() => setAsk(true)}><ShieldAlert aria-hidden />Engage kill switch…</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={ask} onOpenChange={setAsk}>
        <AlertDialogContent title="Engage the kill switch?" description="All sending stops immediately, for every stream. Release it to resume." confirmLabel="Engage kill switch" onConfirm={() => form.current?.requestSubmit()} />
      </AlertDialog>
    </>
  );
}

export function AccountMenu({ name, keyPrefix, theme }: { name?: string; keyPrefix?: string; theme: "system" | "light" | "dark" }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={form} action={logout} hidden />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Account menu"><User aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56">
          <DropdownMenuLabel>{name ?? "Workspace"}{keyPrefix && <span className="block font-mono">{keyPrefix}</span>}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between px-2 py-1.5 text-sm">Theme <ThemeToggle initial={theme} /></div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => form.current?.requestSubmit()}><LogOut aria-hidden />Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function TopBar({ env, killOn, pending, name, keyPrefix, theme }: {
  env: "live" | "test"; killOn: boolean | null; pending: number; name?: string; keyPrefix?: string; theme: "system" | "light" | "dark";
}) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0.5 z-30 flex h-12 items-center gap-2 border-b border-border bg-bg/90 px-3 backdrop-blur md:px-6 lg:px-8">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild><Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu"><Menu aria-hidden /></Button></DialogTrigger>
        <DrawerContent title="Navigation">
          <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
            <span className="px-3 text-md font-semibold">mailcraft</span>
            <Nav label="Mobile" pending={pending} onNavigate={() => setOpen(false)} />
          </div>
        </DrawerContent>
      </Dialog>
      <span className="text-md font-semibold lg:hidden">mailcraft</span>
      <div className="ml-auto flex items-center gap-2">
        <EnvChip env={env} />
        <KillSwitchControl on={killOn} />
        <AccountMenu name={name} keyPrefix={keyPrefix} theme={theme} />
      </div>
    </header>
  );
}
