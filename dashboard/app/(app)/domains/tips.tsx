import { ExternalLink } from "lucide-react";

const GUIDES = [["Cloudflare", "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/"], ["GoDaddy", "https://www.godaddy.com/help/manage-dns-records-680"], ["Namecheap", "https://www.namecheap.com/support/knowledgebase/article.aspx/317/78/how-can-i-set-up-host-records-for-a-domain/"], ["Route 53", "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html"]];

export function Tips() {
  return (
    <details className="rounded-lg border border-border bg-surface p-4 text-sm">
      <summary className="cursor-pointer font-medium">Tips for adding records</summary>
      <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-muted">
        <li><strong className="text-fg">Cloudflare:</strong> set CNAME records to <em>DNS only</em> (grey cloud). A proxied (orange) record hides the target and verification fails.</li>
        <li>Set TTL to <strong className="text-fg">Auto</strong> or 300 seconds so changes show up quickly.</li>
        <li>Some providers append the domain for you. If the name is already <code className="font-mono text-[12.5px]">mail</code>, enter only the part before it.</li>
        <li>Check what the world sees with a <a className="underline" href="https://dnschecker.org" target="_blank" rel="noreferrer">public DNS checker<ExternalLink aria-hidden className="ml-0.5 inline size-3" /><span className="sr-only"> (opens in a new tab)</span></a>.</li>
      </ul>
      <p className="mt-3 text-muted">Provider guides: {GUIDES.map(([n, h], i) => <span key={n}>{i > 0 && ", "}<a className="underline" href={h} target="_blank" rel="noreferrer">{n}<span className="sr-only"> (opens in a new tab)</span></a></span>)}.</p>
    </details>
  );
}
