import { get } from "@/lib/api";
import { ActionError } from "@/components/ui";
import { CodeBlock } from "@/components/ui/copy";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SetupChecklist } from "@/components/onboarding/checklist";
import { RetryError } from "@/components/setup/retry-error";
import { CreateKey } from "./create-key";
import { KeysTable, type Key } from "./keys-table";

export const dynamic = "force-dynamic";

export default async function Keys({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const [r, d] = await Promise.all([get("/v1/keys"), get("/v1/domains")]);
  const keys: Key[] = r.data ?? [];
  return (
    <div className="grid gap-6">
      <PageHeader title="API keys" description="Keys authenticate your app, CLI or agent. Use a test key until you are ready to send for real." action={keys.length ? <CreateKey /> : undefined} />
      <ActionError err={err} />
      {r.error ? <RetryError error={r.error} /> : !keys.length ? (
        <>
          <EmptyState title="No API keys yet" description="Create a test key first. It sends to a sandbox, so nothing reaches a real inbox." action={<CreateKey label="Create your first key" />} />
          <CodeBlock language="bash" code={`curl -X POST $MAILCRAFT_URL/v1/emails \\\n  -H "Authorization: Bearer $MAILCRAFT_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"to":"you@example.com","subject":"Hello","text":"It works"}'`} />
          <SetupChecklist steps={[
            { id: "domain", title: "Add and verify a domain", why: "Receivers only trust mail from a domain with SPF and DKIM.", href: "/domains", cta: "Add domain", done: !!d.data?.some((x: any) => x.status === "verified"), time: "10 minutes" },
            { id: "key", title: "Create an API key", why: "Your app or agent uses it to send.", href: "/keys", cta: "Create key", done: false, time: "1 minute" },
          ]} />
        </>
      ) : <KeysTable keys={keys} />}
    </div>
  );
}
