use crate::mjml_parse::{parse, Node};
use crate::text::decode;
use crate::{Block, RenderError, Template, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};

/// Matches `template_versions.source_format`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceFormat {
    #[serde(rename = "json")]
    Json,
    #[serde(rename = "mjml")]
    Mjml,
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "react-email")]
    ReactEmail,
}

#[derive(Debug, Clone)]
pub struct Imported {
    pub template: Template,
    pub source_format: SourceFormat,
    pub warnings: Vec<String>,
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let l = s.to_ascii_lowercase();
    let a = l.find(open)?;
    let a_end = l[a..].find('>')? + a + 1;
    let b = l[a_end..].find(close)? + a_end;
    Some(&s[a_end..b])
}

/// Resend `{{{NAME}}}` / `{{{NAME|fallback}}}` -> `{{ NAME }}` / `{{ NAME | default('fallback') }}`.
fn convert_triple_braces(s: &str) -> String {
    let (mut out, mut rest) = (String::new(), s);
    while let Some(a) = rest.find("{{{") {
        let Some(b) = rest[a + 3..].find("}}}") else {
            break;
        };
        out.push_str(&rest[..a]);
        let inner = rest[a + 3..a + 3 + b].trim();
        match inner.split_once('|') {
            Some((n, f)) => out.push_str(&format!(
                "{{{{ {} | default('{}') }}}}",
                n.trim(),
                f.trim().replace('\\', "\\\\").replace('\'', "\\'")
            )),
            None => out.push_str(&format!("{{{{ {inner} }}}}")),
        }
        rest = &rest[a + 3 + b + 3..];
    }
    out.push_str(rest);
    out
}

/// Plain HTML becomes one `raw_html` block (always works; variables still render).
pub fn import_html(html: &str, subject: Option<&str>) -> Imported {
    let title = between(html, "<title", "</title>").map(|t| decode(t.trim()));
    let subject = convert_triple_braces(&subject.map(str::to_owned).or(title).unwrap_or_default());
    Imported {
        template: Template::new(
            subject,
            vec![Block::RawHtml {
                html: convert_triple_braces(html),
            }],
        ),
        source_format: SourceFormat::Html,
        warnings: vec![],
    }
}

/// HTML produced by React Email's `render()`: drop the React comment markers and lift the
/// hidden preview div into `preheader`.
pub fn import_react_email(html: &str, subject: Option<&str>) -> Imported {
    let cleaned = html.replace("<!--$-->", "").replace("<!--/$-->", "");
    let mut imp = import_html(&cleaned, subject);
    imp.source_format = SourceFormat::ReactEmail;
    if let Some(p) = cleaned.find("data-skip-in-text=\"true\"") {
        if let Some(gt) = cleaned[p..].find('>') {
            let rest = &cleaned[p + gt + 1..];
            let text = rest.split('<').next().unwrap_or("");
            let text: String = decode(text)
                .chars()
                .filter(|c| !matches!(c, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}'))
                .collect();
            let text = text.trim();
            if !text.is_empty() {
                imp.template.preheader = Some(text.to_owned());
            }
        }
    }
    imp
}

pub fn import_json(src: &str) -> Result<Imported, RenderError> {
    Ok(Imported {
        template: Template::from_json(src)?,
        source_format: SourceFormat::Json,
        warnings: vec![],
    })
}

fn plain(inner: &str) -> Option<String> {
    (!inner.contains('<')).then(|| decode(inner.trim()))
}

fn attrs_are(n: &Node, allowed: &[&str], required: &[&str]) -> bool {
    n.attrs.iter().all(|(k, _)| allowed.contains(&k.as_str()))
        && required.iter().all(|r| n.attrs.iter().any(|(k, _)| k == r))
}

fn attr<'a>(n: &'a Node, k: &str) -> Option<&'a str> {
    n.attrs
        .iter()
        .find(|(a, _)| a == k)
        .map(|(_, v)| v.as_str())
}

/// Map a column's children; an `mc-slot` metadata comment turns the next `mj-text` into a slot.
fn map_children(kids: &[Node], raws: &mut usize) -> Vec<Block> {
    let mut out = vec![];
    let mut iter = kids.iter().peekable();
    while let Some(n) = iter.next() {
        if n.name == "mc-slot" {
            if let (Ok(b @ Block::Slot { .. }), Some(_)) =
                (serde_json::from_str::<Block>(&n.inner), iter.next())
            {
                out.push(b);
            }
            continue;
        }
        out.push(map_leaf(n, raws));
    }
    out
}

fn map_leaf(n: &Node, raws: &mut usize) -> Block {
    let mapped = match n.name.as_str() {
        "mj-text" if n.attrs.is_empty() => plain(&n.inner).map(|text| Block::Paragraph { text }),
        "mj-text"
            if n.attrs.len() == 2
                && attr(n, "font-size") == Some("22px")
                && attr(n, "font-weight") == Some("bold") =>
        {
            plain(&n.inner).map(|text| Block::Heading { text })
        }
        "mj-button" if attrs_are(n, &["href"], &["href"]) => {
            plain(&n.inner).map(|label| Block::Button {
                label,
                url: attr(n, "href").unwrap().to_owned(),
            })
        }
        "mj-image" if attrs_are(n, &["src", "alt", "href", "width"], &["src"]) => {
            Some(Block::Image {
                src: attr(n, "src").unwrap().to_owned(),
                alt: attr(n, "alt").unwrap_or("").to_owned(),
                href: attr(n, "href").map(str::to_owned),
                width: attr(n, "width").map(str::to_owned),
            })
        }
        "mj-divider" if n.attrs.is_empty() => Some(Block::Divider),
        "mj-spacer" if attrs_are(n, &["height"], &[]) => Some(Block::Spacer {
            height: attr(n, "height").unwrap_or("20px").to_owned(),
        }),
        _ => None,
    };
    mapped.unwrap_or_else(|| {
        *raws += 1;
        Block::RawMjml {
            mjml: n.src.clone(),
        }
    })
}

/// MJML -> blocks where the structure is plain, otherwise `raw_mjml` (lossless either way).
pub fn import_mjml(src: &str, subject: Option<&str>) -> Result<Imported, RenderError> {
    let bad = |e: String| RenderError::Invalid(format!("mjml: {e}"));
    let roots = parse(src).map_err(bad)?;
    let root = roots
        .iter()
        .find(|n| n.name == "mjml")
        .ok_or_else(|| bad("no <mjml> root".into()))?;
    let body = root
        .children
        .iter()
        .find(|n| n.name == "mj-body")
        .ok_or_else(|| bad("no <mj-body>".into()))?;
    let (mut title, mut preheader, mut head, mut warnings, mut raws) =
        (None, None, String::new(), vec![], 0usize);
    for n in root.children.iter().filter(|n| n.name == "mj-head") {
        for h in &n.children {
            match h.name.as_str() {
                "mj-title" => title = Some(decode(h.inner.trim())),
                "mj-preview" => preheader = Some(decode(h.inner.trim())),
                _ => head.push_str(&h.src),
            }
        }
    }
    if !head.is_empty() {
        warnings.push("mj-head content kept verbatim in `head`".into());
    }
    let mut blocks = vec![];
    for n in &body.children {
        let plain_section = n.name == "mj-section"
            && n.attrs.is_empty()
            && !n.children.is_empty()
            && n.children
                .iter()
                .all(|c| c.name == "mj-column" && c.attrs.is_empty());
        if plain_section {
            let cols: Vec<Vec<Block>> = n
                .children
                .iter()
                .map(|c| map_children(&c.children, &mut raws))
                .collect();
            if cols.len() == 1 {
                blocks.extend(cols.into_iter().next().unwrap());
            } else {
                blocks.push(Block::Columns { columns: cols });
            }
        } else {
            raws += 1;
            blocks.push(Block::RawMjml {
                mjml: n.src.clone(),
            });
        }
    }
    if raws > 0 {
        warnings.push(format!("{raws} element(s) kept as raw_mjml"));
    }
    Ok(Imported {
        template: Template {
            version: SCHEMA_VERSION,
            subject: subject.map(str::to_owned).or(title).unwrap_or_default(),
            preheader,
            head: (!head.is_empty()).then_some(head),
            blocks,
        },
        source_format: SourceFormat::Mjml,
        warnings,
    })
}
