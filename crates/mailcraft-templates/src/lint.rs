use crate::render::{render, sample_vars, variables};
use crate::{Block, RenderError, RenderOptions, Rendered, Template, RESERVED_VARS};
use serde::Serialize;
use serde_json::Value;

/// Gmail clips messages whose HTML exceeds ~102 KB.
pub const GMAIL_CLIP_BYTES: usize = 102 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LintIssue {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    /// Block path such as `blocks[2]` or `subject`.
    pub path: String,
}

fn issue(sev: Severity, code: &'static str, path: &str, message: impl Into<String>) -> LintIssue {
    LintIssue {
        severity: sev,
        code,
        message: message.into(),
        path: path.into(),
    }
}

fn check_url(url: &str, path: &str, out: &mut Vec<LintIssue>) {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if u.is_empty() {
        out.push(issue(Severity::Error, "broken_link", path, "link is empty"));
    } else if u.starts_with("{{") || u.starts_with('#') {
        // variable or in-page anchor
    } else if u.contains(char::is_whitespace) {
        out.push(issue(
            Severity::Error,
            "broken_link",
            path,
            format!("link `{u}` contains whitespace"),
        ));
    } else if lower.starts_with("javascript:") || lower.starts_with("data:") {
        out.push(issue(
            Severity::Error,
            "broken_link",
            path,
            format!("link `{u}` uses a blocked scheme"),
        ));
    } else if lower.starts_with("http://") {
        out.push(issue(
            Severity::Warning,
            "insecure_link",
            path,
            format!("`{u}` is not https"),
        ));
    } else if !(lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:"))
    {
        out.push(issue(
            Severity::Error,
            "broken_link",
            path,
            format!("`{u}` has no scheme (relative links break in mail clients)"),
        ));
    }
}

/// Attribute values of `name="..."` in an HTML/MJML fragment.
fn attr_values(s: &str, name: &str) -> Vec<String> {
    let mut out = vec![];
    for q in ['"', '\''] {
        let pat = format!("{name}={q}");
        let mut rest = s;
        while let Some(i) = rest.find(&pat) {
            rest = &rest[i + pat.len()..];
            if let Some(e) = rest.find(q) {
                out.push(rest[..e].to_owned());
                rest = &rest[e..];
            }
        }
    }
    out
}

fn img_tags_without_alt(s: &str) -> usize {
    let l = s.to_ascii_lowercase();
    let (mut n, mut rest) = (0, l.as_str());
    while let Some(i) = rest.find("<img") {
        rest = &rest[i + 4..];
        let end = rest.find('>').unwrap_or(rest.len());
        if !rest[..end].contains("alt=") {
            n += 1;
        }
    }
    n
}

fn walk(blocks: &[Block], prefix: &str, out: &mut Vec<LintIssue>) {
    for (i, b) in blocks.iter().enumerate() {
        let p = format!("{prefix}[{i}]");
        match b {
            Block::Button { url, .. } => check_url(url, &p, out),
            Block::Image { src, alt, href, .. } => {
                if alt.trim().is_empty() {
                    out.push(issue(
                        Severity::Warning,
                        "image_missing_alt",
                        &p,
                        "image has no alt text",
                    ));
                }
                check_url(src, &p, out);
                if let Some(h) = href {
                    check_url(h, &p, out);
                }
            }
            Block::Slot { name, fallback, .. } => {
                if fallback.as_deref().is_none_or(|f| f.trim().is_empty()) {
                    out.push(issue(
                        Severity::Warning,
                        "slot_missing_fallback",
                        &p,
                        format!("slot `{name}` has no fallback copy (required to publish an llm automation)"),
                    ));
                }
            }
            Block::RawHtml { html } | Block::RawMjml { mjml: html } => {
                for h in attr_values(html, "href")
                    .iter()
                    .chain(attr_values(html, "src").iter())
                {
                    check_url(h, &p, out);
                }
                let missing = img_tags_without_alt(html);
                if missing > 0 {
                    out.push(issue(
                        Severity::Warning,
                        "image_missing_alt",
                        &p,
                        format!("{missing} <img> without alt"),
                    ));
                }
            }
            Block::Columns { columns } => {
                for (c, col) in columns.iter().enumerate() {
                    walk(col, &format!("{p}.columns[{c}]"), out);
                }
            }
            _ => {}
        }
    }
}

fn has_path(v: &Value, path: &str) -> bool {
    let mut cur = v;
    for part in path.split('.') {
        match cur.get(part) {
            Some(n) => cur = n,
            None => return false,
        }
    }
    true
}

/// Lint a template. `sample` is the variable set it will be sent with (reserved variables are
/// always assumed present); `None` skips the missing-variable check.
pub fn lint(t: &Template, o: &RenderOptions, sample: Option<&Value>) -> Vec<LintIssue> {
    let mut out = vec![];
    if t.subject.trim().is_empty() {
        out.push(issue(
            Severity::Error,
            "empty_subject",
            "subject",
            "subject is empty",
        ));
    } else if t.subject.chars().count() > 78 {
        out.push(issue(
            Severity::Warning,
            "long_subject",
            "subject",
            "subject is longer than 78 characters",
        ));
    }
    walk(&t.blocks, "blocks", &mut out);

    // Render with the caller's sample (strict) to catch missing variables, then measure.
    let probe = sample_vars(t, sample, sample.is_none());
    if sample.is_some() {
        for v in variables(t) {
            if !RESERVED_VARS.contains(&v.as_str()) && !has_path(&probe, &v) {
                out.push(issue(
                    Severity::Error,
                    "missing_variable",
                    "variables",
                    format!("variable `{v}` is not in the sample data"),
                ));
            }
        }
    }
    match render(t, &probe, o) {
        Ok(r) => size_and_text(&r, &mut out),
        Err(RenderError::Footer(m)) => out.push(issue(
            Severity::Error,
            "missing_postal_address",
            "footer",
            m,
        )),
        Err(e) => {
            if !out.iter().any(|i| i.code == "missing_variable") {
                out.push(issue(
                    Severity::Error,
                    "render_failed",
                    "template",
                    e.to_string(),
                ));
            }
        }
    }
    out
}

fn size_and_text(r: &Rendered, out: &mut Vec<LintIssue>) {
    if r.html.len() > GMAIL_CLIP_BYTES {
        out.push(issue(
            Severity::Warning,
            "gmail_clipping",
            "html",
            format!(
                "HTML is {} bytes; Gmail clips messages over ~{} bytes",
                r.html.len(),
                GMAIL_CLIP_BYTES
            ),
        ));
    }
    if r.text.trim().is_empty() {
        out.push(issue(
            Severity::Warning,
            "missing_plain_text",
            "text",
            "plain-text alternative is empty",
        ));
    }
}

#[derive(Debug, Clone)]
pub struct Preview {
    pub rendered: Rendered,
    pub sample: Value,
    pub issues: Vec<LintIssue>,
}

/// Render with sample data (generated placeholders, overridden by `sample`) plus lint.
pub fn preview(
    t: &Template,
    o: &RenderOptions,
    sample: Option<&Value>,
) -> Result<Preview, RenderError> {
    let vars = sample_vars(t, sample, true);
    let rendered = render(t, &vars, o)?;
    Ok(Preview {
        issues: lint(t, o, sample),
        rendered,
        sample: vars,
    })
}
