use crate::{html_to_text, Block, RenderError, Stream, Template};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

/// Variables the platform supplies at send time (SPEC 11). Everything else must come from the caller.
pub const RESERVED_VARS: &[&str] = &[
    "first_name",
    "last_name",
    "email",
    "unsubscribe_url",
    "preferences_url",
    "workspace.name",
];

const DEFAULT_SLOT_MAX: usize = 600;

/// Sender identity printed in the footer (CAN-SPAM). Marketing sends require `postal_address`.
#[derive(Debug, Clone, Default)]
pub struct Footer {
    pub workspace_name: Option<String>,
    pub postal_address: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub stream: Stream,
    pub footer: Footer,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            stream: Stream::Transactional,
            footer: Footer::default(),
        }
    }
}

impl RenderOptions {
    pub fn marketing(footer: Footer) -> Self {
        Self {
            stream: Stream::Marketing,
            footer,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    pub subject: String,
    pub html: String,
    pub text: String,
    /// Variable-resolved MJML; empty for full-document raw_html templates (they bypass MJML).
    pub mjml: String,
}

fn esc(s: &str) -> String {
    // Escape only literal text. `{{ var }}` is left for minijinja, which autoescapes values.
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) fn esc_attr(s: &str) -> String {
    esc(s).replace('"', "&quot;")
}

fn is_section_level(mjml: &str) -> bool {
    let t = mjml.trim_start();
    ["<mj-section", "<mj-wrapper", "<mj-hero"]
        .iter()
        .any(|p| t.starts_with(p))
}

fn inline(b: &Block, export: bool) -> String {
    match b {
        Block::Heading { text } => format!(
            "<mj-text font-size=\"22px\" font-weight=\"bold\">{}</mj-text>",
            esc(text)
        ),
        Block::Paragraph { text } => format!("<mj-text>{}</mj-text>", esc(text)),
        Block::Button { label, url } => {
            format!(
                "<mj-button href=\"{}\">{}</mj-button>",
                esc_attr(url),
                esc(label)
            )
        }
        Block::Image {
            src,
            alt,
            href,
            width,
        } => {
            let mut s = format!(
                "<mj-image src=\"{}\" alt=\"{}\"",
                esc_attr(src),
                esc_attr(alt)
            );
            if let Some(h) = href {
                s.push_str(&format!(" href=\"{}\"", esc_attr(h)));
            }
            if let Some(w) = width {
                s.push_str(&format!(" width=\"{}\"", esc_attr(w)));
            }
            s.push_str(" />");
            s
        }
        Block::Divider => "<mj-divider />".into(),
        Block::Spacer { height } => format!("<mj-spacer height=\"{}\" />", esc_attr(height)),
        Block::Columns { columns } => columns
            .iter()
            .flatten()
            .map(|b| inline(b, export))
            .collect(),
        Block::RawHtml { html } => format!("<mj-raw>{html}</mj-raw>"),
        Block::RawMjml { mjml } => mjml.clone(),
        Block::Slot { name, .. } => {
            let meta = if export {
                // keeps max_len / instructions / fallback through an MJML round trip
                let j = serde_json::to_string(b)
                    .expect("block serializes")
                    .replace('>', "\\u003e");
                format!("<!--mc-slot:{j}-->")
            } else {
                String::new()
            };
            format!("{meta}<mj-text>{{{{ slots['{name}'] }}}}</mj-text>")
        }
    }
}

fn body(blocks: &[Block], export: bool) -> String {
    fn flush(out: &mut String, group: &mut String) {
        if !group.is_empty() {
            out.push_str("<mj-section><mj-column>");
            out.push_str(group);
            out.push_str("</mj-column></mj-section>");
            group.clear();
        }
    }
    let (mut out, mut group) = (String::new(), String::new());
    for b in blocks {
        match b {
            Block::Columns { columns } => {
                flush(&mut out, &mut group);
                out.push_str("<mj-section>");
                for c in columns {
                    out.push_str("<mj-column>");
                    c.iter().for_each(|b| out.push_str(&inline(b, export)));
                    out.push_str("</mj-column>");
                }
                out.push_str("</mj-section>");
            }
            Block::RawMjml { mjml } if is_section_level(mjml) => {
                flush(&mut out, &mut group);
                out.push_str(mjml);
            }
            _ => group.push_str(&inline(b, export)),
        }
    }
    flush(&mut out, &mut group);
    out
}

const FOOTER_MJML: &str = "<mj-section><mj-column><mj-divider border-color=\"#e5e7eb\" border-width=\"1px\" />\
<mj-text font-size=\"12px\" color=\"#6b7280\" align=\"center\">\
{% if mc_footer.workspace_name %}{{ mc_footer.workspace_name }}<br />{% endif %}\
{% for l in mc_footer.address_lines %}{{ l }}<br />{% endfor %}\
<a href=\"{{ unsubscribe_url }}\" style=\"color:#6b7280\">Unsubscribe</a>\
{% if preferences_url is defined %} | <a href=\"{{ preferences_url }}\" style=\"color:#6b7280\">Manage preferences</a>{% endif %}\
</mj-text></mj-column></mj-section>";

const FOOTER_HTML: &str = "<div style=\"font-size:12px;color:#6b7280;text-align:center;padding:16px\">\
{% if mc_footer.workspace_name %}{{ mc_footer.workspace_name }}<br />{% endif %}\
{% for l in mc_footer.address_lines %}{{ l }}<br />{% endfor %}\
<a href=\"{{ unsubscribe_url }}\" style=\"color:#6b7280\">Unsubscribe</a>\
{% if preferences_url is defined %} | <a href=\"{{ preferences_url }}\" style=\"color:#6b7280\">Manage preferences</a>{% endif %}</div>";

fn validate(t: &Template, o: &RenderOptions) -> Result<(), RenderError> {
    t.check_version()?;
    for s in t.slots() {
        if let Block::Slot { name, .. } = s {
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(RenderError::Slot(
                    name.clone(),
                    "name must be [A-Za-z0-9_-]+".into(),
                ));
            }
        }
    }
    if o.stream == Stream::Marketing
        && o.footer
            .postal_address
            .as_deref()
            .is_none_or(|a| a.trim().is_empty())
    {
        return Err(RenderError::Footer(
            "marketing sends require the workspace postal address (CAN-SPAM)".into(),
        ));
    }
    Ok(())
}

fn passthrough(t: &Template) -> Option<&str> {
    match t.blocks.as_slice() {
        [Block::RawHtml { html }] => {
            let h = html.trim_start().to_ascii_lowercase();
            (h.starts_with("<!doctype") || h.starts_with("<html")).then_some(html.as_str())
        }
        _ => None,
    }
}

fn head(t: &Template) -> String {
    let mut h = String::new();
    h.push_str(&format!("<mj-title>{}</mj-title>", esc(&t.subject)));
    if let Some(p) = &t.preheader {
        h.push_str(&format!("<mj-preview>{}</mj-preview>", esc(p)));
    }
    if let Some(x) = &t.head {
        h.push_str(x);
    }
    format!("<mj-head>{h}</mj-head>")
}

fn build_mjml(t: &Template, footer: bool, export: bool) -> String {
    format!(
        "<mjml>{}<mj-body>{}{}</mj-body></mjml>",
        head(t),
        body(&t.blocks, export),
        if footer { FOOTER_MJML } else { "" }
    )
}

/// Deterministic block tree -> MJML source (still containing `{{ }}` expressions).
/// Marketing templates get the renderer-owned footer appended.
pub fn to_mjml(t: &Template, o: &RenderOptions) -> Result<String, RenderError> {
    validate(t, o)?;
    Ok(build_mjml(t, o.stream == Stream::Marketing, false))
}

fn html_env() -> minijinja::Environment<'static> {
    let mut env = minijinja::Environment::new();
    env.set_undefined_behavior(minijinja::UndefinedBehavior::Strict);
    env.set_auto_escape_callback(|_| minijinja::AutoEscape::Html);
    // Like minijinja's HTML escaping but leaves `/` alone, so URLs stay readable.
    env.set_formatter(|out, state, value| {
        use minijinja::{Error, ErrorKind};
        use std::fmt::Write;
        if value.is_undefined() {
            return Err(Error::new(ErrorKind::UndefinedError, "undefined value"));
        }
        if value.is_safe() {
            return minijinja::escape_formatter(out, state, value);
        }
        for c in value.to_string().chars() {
            match c {
                '&' => out.write_str("&amp;")?,
                '<' => out.write_str("&lt;")?,
                '>' => out.write_str("&gt;")?,
                '"' => out.write_str("&quot;")?,
                '\'' => out.write_str("&#x27;")?,
                c => out.write_char(c)?,
            }
        }
        Ok(())
    });
    env
}

fn vars_obj(vars: &Value) -> Result<Map<String, Value>, RenderError> {
    match vars {
        Value::Null => Ok(Map::new()),
        Value::Object(m) => Ok(m.clone()),
        _ => Err(RenderError::Vars("variables must be a JSON object".into())),
    }
}

/// Variables + resolved slots + footer data.
fn context(t: &Template, vars: &Value, o: &RenderOptions) -> Result<Value, RenderError> {
    let mut ctx = vars_obj(vars)?;
    let given = ctx
        .get("slots")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut slots = Map::new();
    for s in t.slots() {
        if let Block::Slot {
            name,
            max_len,
            fallback,
            ..
        } = s
        {
            let v = given
                .get(name)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .or_else(|| fallback.clone())
                .ok_or_else(|| {
                    RenderError::Slot(name.clone(), "no value and no fallback".into())
                })?;
            let max = max_len.unwrap_or(DEFAULT_SLOT_MAX);
            if v.chars().count() > max {
                return Err(RenderError::Slot(
                    name.clone(),
                    format!("value longer than max_len {max}"),
                ));
            }
            slots.insert(name.clone(), Value::String(v));
        }
    }
    ctx.insert("slots".into(), Value::Object(slots));
    ctx.insert(
        "mc_footer".into(),
        json!({
            "workspace_name": o.footer.workspace_name.clone().unwrap_or_default(),
            "address_lines": o.footer.postal_address.as_deref().unwrap_or("")
                .lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>(),
        }),
    );
    Ok(Value::Object(ctx))
}

fn jinja(env: &minijinja::Environment<'_>, src: &str, ctx: &Value) -> Result<String, RenderError> {
    env.render_str(src, ctx)
        .map_err(|e| RenderError::Vars(format!("{e:#}")))
}

/// Subject line: strict variables, no HTML escaping, single line.
pub fn render_subject(t: &Template, vars: &Value) -> Result<String, RenderError> {
    let mut env = minijinja::Environment::new();
    env.set_undefined_behavior(minijinja::UndefinedBehavior::Strict);
    let s = env
        .render_str(&t.subject, vars_obj(vars)?)
        .map_err(|e| RenderError::Vars(format!("subject: {e:#}")))?;
    Ok(s.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn compile(mjml: &str) -> Result<String, RenderError> {
    let parsed = mrml::parse(mjml).map_err(|e| RenderError::Mjml(e.to_string()))?;
    parsed
        .element
        .render(&mrml::prelude::render::RenderOptions::default())
        .map_err(|e| RenderError::Mjml(e.to_string()))
}

fn inject_footer(doc: &str) -> String {
    match doc.to_ascii_lowercase().rfind("</body>") {
        Some(i) => format!("{}{}{}", &doc[..i], FOOTER_HTML, &doc[i..]),
        None => format!("{doc}{FOOTER_HTML}"),
    }
}

/// Render to subject + HTML + auto plain text. Missing variables are an error ("Hi null" never ships).
pub fn render(t: &Template, vars: &Value, o: &RenderOptions) -> Result<Rendered, RenderError> {
    validate(t, o)?;
    let ctx = context(t, vars, o)?;
    let env = html_env();
    let marketing = o.stream == Stream::Marketing;
    let (mjml, html) = if let Some(doc) = passthrough(t) {
        let src = if marketing {
            inject_footer(doc)
        } else {
            doc.to_owned()
        };
        (String::new(), jinja(&env, &src, &ctx)?)
    } else {
        let mjml = jinja(&env, &build_mjml(t, marketing, false), &ctx)?;
        let html = compile(&mjml)?;
        (mjml, html)
    };
    Ok(Rendered {
        subject: render_subject(t, &ctx)?,
        text: html_to_text(&html),
        html,
        mjml,
    })
}

/// Scaffold-compatible helper: transactional render, HTML only.
pub fn render_html(t: &Template, vars: &Value) -> Result<String, RenderError> {
    Ok(render(t, vars, &RenderOptions::default())?.html)
}

/// Variable paths the template reads (`first_name`, `workspace.name`, ...), reserved ones included.
/// Store in `template_versions.variables`.
pub fn variables(t: &Template) -> Vec<String> {
    let src = match passthrough(t) {
        Some(doc) => doc.to_owned(),
        None => build_mjml(t, false, false),
    };
    let env = html_env();
    let mut out = BTreeSet::new();
    for s in [src.as_str(), t.subject.as_str()] {
        if let Ok(tpl) = env.template_from_str(s) {
            out.extend(tpl.undeclared_variables(true));
        }
    }
    out.into_iter()
        .filter(|v| {
            v != "slots" && !v.starts_with("slots.") && !v.starts_with("slots[") && v != "mc_footer"
        })
        .collect()
}

pub(crate) fn sample_vars(t: &Template, provided: Option<&Value>, fill_missing: bool) -> Value {
    fn put(root: &mut Map<String, Value>, path: &str, v: Value) {
        let mut cur = root;
        let parts: Vec<&str> = path.split('.').collect();
        for p in &parts[..parts.len() - 1] {
            let e = cur.entry(p.to_string()).or_insert_with(|| json!({}));
            if !e.is_object() {
                *e = json!({});
            }
            cur = e.as_object_mut().unwrap();
        }
        cur.entry(parts[parts.len() - 1].to_string()).or_insert(v);
    }
    let mut m = Map::new();
    for (k, v) in [
        ("first_name", "Ana"),
        ("last_name", "Lee"),
        ("email", "ana@example.com"),
        ("unsubscribe_url", "https://example.com/u/sample"),
        ("preferences_url", "https://example.com/p/sample"),
        ("workspace.name", "Example Inc"),
    ] {
        put(&mut m, k, json!(v));
    }
    if fill_missing {
        for v in variables(t) {
            put(&mut m, &v, json!(format!("[{v}]")));
        }
    }
    if let Some(Value::Object(p)) = provided {
        merge(&mut m, p);
    }
    Value::Object(m)
}

fn merge(into: &mut Map<String, Value>, from: &Map<String, Value>) {
    for (k, v) in from {
        match (into.get_mut(k), v) {
            (Some(Value::Object(a)), Value::Object(b)) => merge(a, b),
            _ => {
                into.insert(k.clone(), v.clone());
            }
        }
    }
}

/// Export: HTML compiled with `sample` merged over generated sample data.
pub fn export_html(
    t: &Template,
    o: &RenderOptions,
    sample: Option<&Value>,
) -> Result<String, RenderError> {
    Ok(render(t, &sample_vars(t, sample, true), o)?.html)
}

/// Export: generated MJML (footer excluded: it is renderer-owned). Full-document raw_html
/// templates have no MJML form and are wrapped in `mj-raw`.
pub fn export_mjml(t: &Template) -> String {
    match passthrough(t) {
        Some(doc) => format!("<mjml><mj-body><mj-raw>{}</mj-raw></mj-body></mjml>", doc),
        None => build_mjml(t, false, true),
    }
}

/// Export: canonical JSON.
pub fn export_json(t: &Template) -> String {
    serde_json::to_string_pretty(t).expect("template serializes")
}

/// Published JSON Schema of the canonical block tree.
pub fn json_schema() -> Value {
    serde_json::from_str(include_str!("template.schema.json")).expect("schema is valid json")
}
