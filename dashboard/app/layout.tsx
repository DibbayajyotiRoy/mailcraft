import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "mailcraft", description: "Agent-native email: transactional + lifecycle automations" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
