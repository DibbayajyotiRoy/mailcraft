"use client";
import { useEffect, useState } from "react";
import { absoluteTime, relativeTime } from "@/lib/format";

/** <time datetime title=absolute>. SSR renders the absolute date (stable markup, no hydration mismatch), then switches to relative text after mount. */
export function RelativeTime({ value, className }: { value: string | number | Date; className?: string }) {
  const [rel, setRel] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setRel(relativeTime(value));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [value]);
  const iso = new Date(value).toISOString();
  return <time dateTime={iso} title={absoluteTime(value)} className={className} suppressHydrationWarning>{rel ?? absoluteTime(value)}</time>;
}
