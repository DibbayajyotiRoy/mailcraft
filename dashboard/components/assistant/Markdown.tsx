import Link from "next/link";
import { Fragment, type ReactNode } from "react";

/** Minimal, safe Markdown: paragraphs, lists, code, **bold**, `code`, links. Everything is built as React elements, so there is no raw HTML path. */
// A link's URL may hold one level of balanced parentheses: https://en.wikipedia.org/wiki/Foo_(bar)
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\))/g;
const LINK = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/;
const safeHref = (h: string) => (/^https?:\/\//i.test(h) || (h.startsWith("/") && !h.startsWith("//")) ? h : null);

function inline(s: string): ReactNode[] {
  return s.split(INLINE).map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={i} className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[0.92em]">{p.slice(1, -1)}</code>;
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>;
    const m = LINK.exec(p);
    if (m) {
      const href = safeHref(m[2]);
      if (!href) return <Fragment key={i}>{m[1]}</Fragment>;
      const cls = "text-accent underline underline-offset-2";
      return href.startsWith("/") ? <Link key={i} href={href} className={cls}>{m[1]}</Link> : <a key={i} href={href} className={cls} target="_blank" rel="noopener noreferrer">{m[1]}</a>;
    }
    return <Fragment key={i}>{p}</Fragment>;
  });
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n"), out: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.push(<pre key={out.length} className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs leading-5"><code>{code.join("\n")}</code></pre>);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      out.push(<Tag key={out.length} className={`ml-5 space-y-1 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</Tag>);
    } else if (!l.trim()) i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) para.push(lines[i].replace(/^#{1,4}\s+/, ""));
      const heading = /^#{1,4}\s/.test(l);
      out.push(<p key={out.length} className={heading ? "font-semibold" : undefined}>{para.map((t, k) => <Fragment key={k}>{k > 0 && <br />}{inline(t)}</Fragment>)}</p>);
    }
  }
  return <div className="space-y-2 break-words text-base">{out}</div>;
}

/** The model may end with `NEXT: a | b | c` on its own last line: strip it and return the suggestions. A marker still being typed is held back. */
export function splitNext(text: string): { body: string; next: string[] } {
  const m = /(?:^|\n)[ \t]*NEXT:[ \t]*([^\n]*?)\s*$/.exec(text);
  if (!m) return { body: text.replace(/(?:^|\n)[ \t]*N(?:E(?:X(?:T)?)?)?$/, ""), next: [] };
  return { body: text.slice(0, m.index).trimEnd(), next: m[1].split("|").map((s) => s.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean).slice(0, 3) };
}
