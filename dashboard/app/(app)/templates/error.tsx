"use client";
import { RouteError } from "../_p3/RouteError";

export default function Error(p: { error: Error & { digest?: string }; reset: () => void }) { return <RouteError title="Templates" {...p} />; }
