// Reference material the model fetches on demand with get_docs(topic), so the system prompt stays small.
export const DOCS: Record<string, string> = {
  personalization: `Template variables use {{ name }}; a missing variable is an error, never "Hi null". Optional ones need a default: {{ first_name | default("there") }}.
Platform variables: first_name, last_name, email, unsubscribe_url, preferences_url, workspace.name. Broadcast rows add {{ data.<column> }}; event properties are {{ data.<key> }} in automations.
Marketing mail gets the unsubscribe footer automatically; never write the unsubscribe link or postal address yourself. Links must be https. Keep html under ~100 KB.
Formats: mjml (preferred: <mj-title> is the subject, <mj-preview> the preheader), html, json block tree. LLM text goes in a slot block with a fallback. Fix every lint error before proposing.`,
  automations: `An automation = {name, trigger (event name or {event|segment|filter}), entry_rule once|always|after_days:N|if_no_active_run, goal?{event}, approval "first_n:5"|always|never, caps?, steps[]}.
Each step {key, type, config, next}; next is a step key (condition: {true,false}; wait_for_event: {event,timeout}); omit next to end.
Types: delay {duration:"5m|2d"} (max 30d); condition {rule:{field,op,value}} ops eq neq lt lte gt gte in contains exists; wait_for_event {event,timeout}; send_email {template (published alias), from, mode static|llm, subject?, stream?, instructions?}; update_contact {set:{}}; add_to_segment {segment}; exit.
The template must be published first (the assistant never publishes: tell the user). New names create a draft; activating is a separate step. Default approval first_n:5 is right unless the user asks otherwise. Lifecycle mail is capped (1 per 48h) and respects quiet hours on live sends.`,
  broadcasts: `A broadcast sends one published template to a list or explicit recipients (max 5000), paced by the daily cap. The proposal is always a dry run first: audience count, skipped rows (suppressed, unsubscribed, invalid, missing_variable) and the schedule.
Marketing broadcasts need a verified sending domain, an unsubscribe-capable template and a from address. Test keys sandbox everything. Live broadcasts may need approval.`,
  deliverability: `Bounces: 5.1.1 = address does not exist (suppress it); 5.7.x = blocked by policy/reputation; 4.x = temporary, will retry. Complaints and hard bounces are suppressed automatically.
Warm up new domains: start small, ramp over weeks. Never blast a cold or purchased list. Keep SPF/DKIM/DMARC verified (domain list shows status). Always include unsubscribe on marketing mail.`,
  contacts: `Contacts are keyed by email: first_name, last_name, timezone, properties{}. Lists are manual segments; segments can also have a rule filter ({and|or|not} of {field,op,value}; fields: email, first_name, last_name, properties.<k>, event_count:<ev>, days_since:<ev>).
Suppressed contacts (hard bounce, complaint, unsubscribe) stay on lists but receive nothing. Deleting data is out of scope for the assistant.`,
};
export const DOC_TOPICS = Object.keys(DOCS);
