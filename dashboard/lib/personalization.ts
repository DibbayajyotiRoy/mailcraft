// What a template can use for dynamic values. Every snippet here is exercised by
// crates/mailcraft-templates/tests/personalization.rs, so the list only claims what renders.

export type Snippet = { code: string; what: string };
export const PERSONALIZATION: { group: string; note?: string; items: Snippet[] }[] = [
  { group: "Contact fields", note: "Filled in by Broadcasts. For a single send, pass them as template variables.", items: [
    { code: "{{ first_name }}", what: "First name. Sending to someone without one fails, so prefer the fallback below." },
    { code: '{{ first_name | default("there") }}', what: "First name, or “there” when it is missing or blank." },
    { code: "{{ last_name }}", what: "Last name." },
    { code: "{{ email }}", what: "The recipient’s address." },
  ] },
  { group: "Your CSV columns", note: "Every extra column in an uploaded CSV lives under data. A header “Company Name” becomes data.company_name.", items: [
    { code: "{{ data.company }}", what: "The value of the “company” column." },
    { code: "{{ data.company | default('your team') }}", what: "The same, with a fallback for rows where it is empty." },
  ] },
  { group: "Links and workspace", note: "Marketing emails already get an Unsubscribe footer with your postal address. Use these to place the links yourself.", items: [
    { code: "{{ unsubscribe_url }}", what: "One-click unsubscribe link for this recipient." },
    { code: "{{ preferences_url }}", what: "Manage-preferences link." },
    { code: "{{ workspace.name }}", what: "Your workspace name." },
  ] },
  { group: "Filters", items: [
    { code: "{{ first_name | upper }}", what: "Upper case (also lower and title)." },
  ] },
];
export const EXAMPLE = 'Hi {{ first_name | default("there") }},';
export const TIPS = [
  "Use {{ … }} in the body, button labels and the subject.",
  "A value that is missing and has no fallback is an error: Broadcasts skip that row and tell you which value it needs. Nothing ever sends “Hi null”.",
  "Inside a button link use single quotes for the fallback: {{ data.url | default('https://example.com') }}.",
];
