import Link from "next/link";
import { SearchX } from "lucide-react";
import { buttonVariants } from "@/components/ui/button-variants";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata = { title: "Not found · mailcraft" };

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      <EmptyState variant="no-results" icon={SearchX} title="Page not found" className="w-full max-w-md border-solid"
        description="That address does not exist, or the thing it pointed to was deleted."
        action={<Link href="/" className={buttonVariants({ variant: "primary" })}>Back to overview</Link>} />
    </main>
  );
}
