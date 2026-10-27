//! Tiny tolerant MJML tree reader, just enough to map MJML onto blocks.
//! Content-holding tags (`mj-text`, `mj-button`, ...) are opaque: their inner source is kept verbatim.
use crate::text::decode;

#[derive(Debug, Clone)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    /// Source between the open and close tags (empty for self-closing).
    pub inner: String,
    /// Full source of the element.
    pub src: String,
}

const STRUCTURAL: &[&str] = &[
    "mjml",
    "mj-head",
    "mj-body",
    "mj-section",
    "mj-column",
    "mj-wrapper",
    "mj-group",
    "mj-hero",
    "mj-attributes",
];

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let (mut out, mut rest) = (vec![], s.trim());
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim().to_owned();
        let v = rest[eq + 1..].trim_start();
        let Some(q) = v.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            break;
        };
        let Some(end) = v[1..].find(q) else { break };
        out.push((name, decode(&v[1..1 + end])));
        rest = v[end + 2..].trim_start();
    }
    out
}

fn children(s: &str, pos: &mut usize, until: Option<&str>) -> Result<Vec<Node>, String> {
    let mut out = vec![];
    loop {
        let Some(off) = s[*pos..].find('<') else {
            return match until {
                None => Ok(out),
                Some(u) => Err(format!("unclosed <{u}>")),
            };
        };
        let start = *pos + off;
        if s[start..].starts_with("<!--") {
            *pos = s[start..]
                .find("-->")
                .map(|e| start + e + 3)
                .ok_or("unterminated comment")?;
            if let Some(j) = s[start..*pos]
                .strip_prefix("<!--mc-slot:")
                .and_then(|x| x.strip_suffix("-->"))
            {
                out.push(Node {
                    name: "mc-slot".into(),
                    attrs: vec![],
                    children: vec![],
                    inner: j.to_owned(),
                    src: s[start..*pos].to_owned(),
                });
            }
            continue;
        }
        // end of the open/close tag, quote aware
        let mut q = None::<char>;
        let mut end = None;
        for (k, c) in s[start + 1..].char_indices() {
            match (q, c) {
                (None, '"' | '\'') => q = Some(c),
                (Some(x), c) if c == x => q = None,
                (None, '>') => {
                    end = Some(start + 1 + k);
                    break;
                }
                _ => {}
            }
        }
        let end = end.ok_or("unterminated tag")?;
        let tag = &s[start + 1..end];
        *pos = end + 1;
        if let Some(close) = tag.strip_prefix('/') {
            return if until == Some(close.trim()) {
                Ok(out)
            } else {
                Err(format!("unexpected </{}>", close.trim()))
            };
        }
        let self_closing = tag.ends_with('/');
        let tag = tag.trim_end_matches('/');
        let (name, attr_src) = tag.split_once(char::is_whitespace).unwrap_or((tag, ""));
        let name = name.to_owned();
        let attrs = parse_attrs(attr_src);
        let (kids, inner);
        if self_closing {
            kids = vec![];
            inner = String::new();
        } else if STRUCTURAL.contains(&name.as_str()) {
            let inner_start = *pos;
            kids = children(s, pos, Some(&name))?;
            let close_len = name.len() + 3;
            inner = s[inner_start..*pos - close_len].to_owned();
        } else {
            let close = format!("</{name}>");
            let c = s[*pos..]
                .find(&close)
                .ok_or_else(|| format!("unclosed <{name}>"))?;
            inner = s[*pos..*pos + c].to_owned();
            kids = vec![];
            *pos += c + close.len();
        }
        out.push(Node {
            name,
            attrs,
            children: kids,
            inner,
            src: s[start..*pos].to_owned(),
        });
    }
}

pub fn parse(src: &str) -> Result<Vec<Node>, String> {
    let mut pos = 0;
    children(src, &mut pos, None)
}
