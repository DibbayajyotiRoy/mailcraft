import type { ApiError } from "@/lib/api";

/** Parses the `?err=code|message|hint` that server actions redirect back with. */
export function parseErr(err?: string): ApiError | null {
  if (!err) return null;
  const [code, message, hint] = err.split("|");
  return { code, message: message ?? code, hint: hint || undefined };
}
