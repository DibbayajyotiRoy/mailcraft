// The "addresses this mailbox sends as" form fields (login name + alias rows) -> the API's `aliases` / `display_names`.
export function mailboxFields(d: FormData, login: string) {
  const names = d.getAll("alias_name");
  const display_names: Record<string, string> = {};
  const aliases: string[] = [];
  const loginName = String(d.get("login_name") ?? "").trim();
  if (loginName) display_names[login.trim().toLowerCase()] = loginName;
  d.getAll("alias_address").forEach((a, i) => {
    const addr = String(a).trim().toLowerCase();
    if (!addr) return;
    aliases.push(addr);
    const n = String(names[i] ?? "").trim();
    if (n) display_names[addr] = n;
  });
  return { aliases, display_names };
}
