import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

// Server-side proxy (the API key stays in the httpOnly cookie). Always 200 with the {data,error} result.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const variables = body && typeof body.variables === "object" && body.variables ? body.variables : {};
  const r = await api("POST", `/v1/templates/${encodeURIComponent(id)}/preview`, { variables });
  return Response.json({ data: r.data, error: r.error });
}
