import { get } from "@/lib/api";

export const dynamic = "force-dynamic";

// Server-side proxy so the API key never reaches the browser.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(req.url).searchParams.get("format") ?? "json";
  if (!["json", "html", "mjml"].includes(format)) return new Response("bad format", { status: 400 });
  const r = await get(`/v1/templates/${encodeURIComponent(id)}/export?format=${format}`);
  if (r.error) return new Response(`${r.error.code}: ${r.error.message}`, { status: 502 });
  const type = format === "json" ? "application/json" : "text/plain";
  return new Response(String(r.data.content), {
    headers: { "Content-Type": `${type}; charset=utf-8`, "Content-Disposition": `attachment; filename="${id}.${format}"` },
  });
}
