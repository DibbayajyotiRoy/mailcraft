"use client";
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger, Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { EnvChip } from "@/components/ui/env-chip";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EventTimeline } from "@/components/ui/event-timeline";
import { KillSwitchPill } from "@/components/ui/kill-switch-pill";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyValue, StatCard } from "@/components/ui/stat-card";
import { Table, TBody, TD, THead, TH, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";

const S = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="grid gap-3"><h2 className="text-md font-medium">{title}</h2>{children}</section>
);
const row = "flex flex-wrap items-center gap-3";
const STATUSES = ["verified", "delivered", "sent", "pending", "deferred", "queued", "sending", "pending_approval", "failed", "bounced", "revoked", "unknown"];
const now = Date.now();
const iso = (ms: number) => new Date(now - ms).toISOString();

export function Gallery() {
  return (
    <div className="grid gap-10">
      <S title="Button">
        {(["primary", "secondary", "ghost", "danger-outline", "danger", "approve"] as const).map((v) => (
          <div key={v} className={row}>
            <Button variant={v}>{v}</Button>
            <Button variant={v} size="sm">small</Button>
            <Button variant={v} size="lg">large</Button>
            <Button variant={v} disabled>disabled</Button>
            <Button variant={v} loading>loading</Button>
            <Button variant={v} size="icon" aria-label={`${v} icon`}><Plus aria-hidden /></Button>
          </div>
        ))}
      </S>
      <S title="Inputs">
        <div className="grid max-w-md gap-4">
          <Field label="Name" description="Shown in the dashboard only.">{(a) => <Input {...a} placeholder="Production sender" />}</Field>
          <Field label="Mono value">{(a) => <Input {...a} mono defaultValue="mc_test_8f3a91c2" />}</Field>
          <Field label="With error" error="Name is required.">{(a) => <Input {...a} />}</Field>
          <Field label="Disabled">{(a) => <Input {...a} disabled defaultValue="locked" />}</Field>
          <Field label="Stream">{(a) => <Select {...a}><option>transactional</option><option>marketing</option></Select>}</Field>
          <Field label="Message">{(a) => <Textarea {...a} placeholder="Write something" />}</Field>
        </div>
      </S>
      <S title="Badges and status pills">
        <div className={row}>{STATUSES.map((s) => <StatusBadge key={s} status={s} />)}</div>
        <div className={row}><StatusBadge status="pending" pulse /><StatusBadge status="sent" size="sm" /><Badge>neutral</Badge><EnvChip env="live" /><EnvChip env="test" /></div>
        <div className={row}><KillSwitchPill on={false} /><KillSwitchPill on /><KillSwitchPill on={null} /></div>
      </S>
      <S title="Card and stat card">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="Sending domain" description="mail.example.com" action={<StatusBadge status="verified" />} />
            <CardBody><KeyValue items={[["Stream", "transactional"], ["Created", <RelativeTime key="t" value={iso(86400000 * 3)} />]]} /></CardBody>
            <CardFooter><Button variant="secondary" size="sm">Cancel</Button><Button size="sm">Save</Button></CardFooter>
          </Card>
          <dl className="grid grid-cols-2 gap-3">
            <StatCard label="Sent" value="12,408" delta={{ text: "▲ 4.2%", tone: "ok" }} />
            <StatCard label="Bounced" value="31" delta={{ text: "▼ 0.1%", tone: "bad" }} />
          </dl>
        </div>
      </S>
      <S title="Table (stacks to cards under 768px)">
        <Table caption="Recent emails">
          <THead><TR><TH>ID</TH><TH>Recipient</TH><TH>Status</TH><TH className="text-right">Opens</TH><TH>When</TH></TR></THead>
          <TBody>
            {[["em_01HZXYK9QF", "ana@example.com", "delivered", 3, 120000], ["em_01HZXWB2MD", "bo@example.com", "bounced", 0, 3600000], ["em_01HZXV7TPR", "cy@example.com", "queued", 0, 5000]].map(([id, to, st, n, ago]) => (
              <TR key={id as string}>
                <TD label="ID"><code className="text-[12.5px]">{id}</code></TD><TD label="Recipient">{to}</TD>
                <TD label="Status"><StatusBadge status={st as string} /></TD><TD label="Opens" num>{n}</TD>
                <TD label="When"><RelativeTime value={iso(ago as number)} className="text-muted" /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </S>
      <S title="Envelope trail (EventTimeline)">
        <EventTimeline label="Delivery events" events={[
          { status: "queued", at: iso(300000) }, { status: "sent", at: iso(299000), detail: "Handed to smtp.example.net" },
          { status: "delivered", at: iso(298000) }, { status: "bounced", at: iso(60000), detail: "550 mailbox unavailable" },
        ]} />
      </S>
      <S title="Overlays">
        <div className={row}>
          <Dialog>
            <DialogTrigger asChild><Button variant="secondary">Open dialog</Button></DialogTrigger>
            <DialogContent title="Add domain" description="We will show the DNS records to create." footer={<Button>Add domain</Button>}>
              <Field label="Domain">{(a) => <Input {...a} placeholder="mail.example.com" />}</Field>
            </DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="danger-outline"><Trash2 aria-hidden />Revoke key</Button></AlertDialogTrigger>
            <AlertDialogContent title="Revoke this key?" description="Anything using it stops working immediately." confirmLabel="Revoke" />
          </AlertDialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="secondary">Menu</Button></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem>Edit</DropdownMenuItem><DropdownMenuItem>Duplicate</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem destructive>Delete</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content="Tooltips are keyboard reachable"><Button variant="ghost">Hover or focus me</Button></Tooltip>
          <Button variant="secondary" onClick={() => toast.success("Domain added")}>Success toast</Button>
          <Button variant="secondary" onClick={() => toast.error("Could not send: kill switch engaged")}>Error toast</Button>
        </div>
      </S>
      <S title="Tabs">
        <Tabs defaultValue="flow">
          <TabsList aria-label="Automation sections"><TabsTrigger value="flow">Flow</TabsTrigger><TabsTrigger value="runs">Runs</TabsTrigger><TabsTrigger value="settings">Settings</TabsTrigger></TabsList>
          <TabsContent value="flow">Flow panel</TabsContent><TabsContent value="runs">Runs panel</TabsContent><TabsContent value="settings">Settings panel</TabsContent>
        </Tabs>
      </S>
      <S title="Code, copy, relative time">
        <CopyField label="Message ID" value="em_01HZXYK9QF3N8T2W" className="max-w-md" />
        <CodeBlock language="bash" code={'curl https://api.example.com/v1/emails \\\n  -H "Authorization: Bearer mc_test_..."'} />
        <p className="text-sm">Sent <RelativeTime value={iso(7200000)} /> · <RelativeTime value={iso(1000)} /></p>
      </S>
      <S title="Skeleton, empty and error states">
        <div className="grid gap-2 max-w-md"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        <div className="grid gap-4 md:grid-cols-3">
          <EmptyState title="No emails yet" description="Send your first email with the API." action={<Button size="sm">Send test email</Button>} />
          <EmptyState variant="no-results" title="No matches" description="Try clearing a filter." action={<Button size="sm" variant="secondary">Clear filters</Button>} />
          <EmptyState variant="error" title="Could not load" description="The API did not respond." />
        </div>
        <ErrorState error={{ code: "unreachable", message: "Cannot reach the API", hint: "Check the base URL." }} onRetry={() => {}} />
      </S>
      <S title="Page header">
        <PageHeader breadcrumb={[{ label: "Emails", href: "#" }, { label: "em_01HZXYK9QF" }]} title="Email detail" description="Delivery events and message content." action={<Button>Resend</Button>} className="mb-0" />
      </S>
    </div>
  );
}
