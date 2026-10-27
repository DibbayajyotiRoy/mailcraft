import type { ReactNode } from "react";

export const metadata = { title: "mailcraft", description: "Agent-native email: transactional + lifecycle automations" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 720, padding: "0 1rem" }}>{children}</body>
    </html>
  );
}
