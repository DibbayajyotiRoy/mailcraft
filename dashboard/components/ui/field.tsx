import { cva } from "class-variance-authority";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const control = cva(
  "block w-full rounded-sm border border-input bg-bg px-3 text-fg placeholder:text-subtle transition-[border-color,box-shadow] duration-[var(--dur-fast)] " +
    "text-[16px] sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-1 aria-[invalid=true]:border-bad disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-surface-2",
  { variants: { mono: { true: "font-mono text-[12.5px] sm:text-[12.5px]", false: "" } }, defaultVariants: { mono: false } },
);

type Common = { mono?: boolean };
export function Input({ className, mono, ...p }: ComponentProps<"input"> & Common) {
  return <input data-ui="input" className={cn(control({ mono }), "h-8 pointer-coarse:h-11", className)} {...p} />;
}
export function Textarea({ className, mono, ...p }: ComponentProps<"textarea"> & Common) {
  return <textarea data-ui="textarea" className={cn(control({ mono }), "min-h-20 resize-y py-2", className)} {...p} />;
}
/** Native <select>: best keyboard/mobile behaviour for free; styled to match. */
export function Select({ className, ...p }: ComponentProps<"select">) {
  return <select data-ui="select" className={cn(control(), "h-8 pointer-coarse:h-11 pr-8", className)} {...p} />;
}

/** Label above, description + error linked via aria-describedby. Pass the control as a render function
 *  so it receives the ids:  <Field label="Name" error={e}>{(a) => <Input {...a} name="name" />}</Field> */
export function Field({ label, description, error, children, className }: {
  label: ReactNode; description?: ReactNode; error?: ReactNode; className?: string;
  children: (a: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const id = useId();
  const d = [description && `${id}-d`, error && `${id}-e`].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label data-ui="label" htmlFor={id} className="text-sm font-medium">{label}</label>
      {children({ id, "aria-describedby": d, "aria-invalid": error ? true : undefined })}
      {description && <p id={`${id}-d`} className="text-xs text-muted">{description}</p>}
      {error && <p id={`${id}-e`} className="text-xs font-medium text-bad">{error}</p>}
    </div>
  );
}
