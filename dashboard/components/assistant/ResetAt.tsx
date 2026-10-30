"use client";
import { useEffect, useState } from "react";
import { resetLine, utcClock } from "@/lib/assistant/reset";

/** "resets 05:30 · in 9h 12m" in the viewer's time zone. The server render (no zone yet) says the UTC time, and the browser swaps it in. */
export function ResetAt({ at }: { at: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return <time dateTime={new Date(at).toISOString()}>{now == null ? `resets ${utcClock(at)}` : resetLine(at, now)}</time>;
}
