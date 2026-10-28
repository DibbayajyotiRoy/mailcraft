import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

// Server-side proxy (the API key stays in the httpOnly cookie). Always 200 with the {data,error} result.
// With `content` it renders the editor's unsaved text instead of the saved version (nothing is stored).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const variables = body && typeof body.variables === "object" && body.variables ? body.variables : {};
  const inline = typeof body?.content === "string" && ["html", "mjml", "json"].includes(body.format)
    ? { format: body.format, content: body.content, ...(typeof body.subject === "string" && { subject: body.subject }), ...(typeof body.preheader === "string" && { preheader: body.preheader }) }
    : {};
  const r = await api("POST", `/v1/templates/${encodeURIComponent(id)}/preview`, { variables, ...inline });
  return Response.json({ data: r.data, error: r.error });
}
