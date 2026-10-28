"use client";
import { RouteError } from "@/components/ui/error-state";

export default function Error(p: { error: Error & { digest?: string }; reset: () => void }) { return <RouteError title="Templates" {...p} />; }
