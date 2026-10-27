import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { FlashToast, Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_COOKIE } from "@/components/shell/theme-toggle";
import "./globals.css";

export const metadata = { title: "mailcraft", description: "Agent-native email: transactional + lifecycle automations" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = (await cookies()).get(THEME_COOKIE)?.value;
  return (
    <html lang="en" data-theme={t === "light" || t === "dark" ? t : undefined} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
        <FlashToast />
      </body>
    </html>
  );
}
