//! Small HTML -> plain text pass for the `text/plain` alternative part.

fn strip_between(s: &str, open: &str, close: &str) -> String {
    let lower = s.to_ascii_lowercase(); // ASCII lowercasing keeps byte offsets aligned
    let (mut out, mut i) = (String::new(), 0);
    while let Some(a) = lower[i..].find(open) {
        out.push_str(&s[i..i + a]);
        match lower[i + a..].find(close) {
            Some(b) => i = i + a + b + close.len(),
            None => return out,
        }
    }
    out.push_str(&s[i..]);
    out
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(p) = lower[from..].find(name) {
        let at = from + p;
        from = at + name.len();
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = tag[at + name.len()..].trim_start();
        if before_ok && rest.starts_with('=') {
            let v = rest[1..].trim_start();
            return Some(match v.chars().next() {
                Some(q @ ('"' | '\'')) => v[1..].split(q).next().unwrap_or("").to_owned(),
                _ => v
                    .split(|c: char| c.is_whitespace() || c == '>')
                    .next()
                    .unwrap_or("")
                    .to_owned(),
            });
        }
    }
    None
}

pub(crate) fn decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        match rest.find(';').filter(|&e| e <= 10) {
            Some(e) => {
                let ent = &rest[1..e];
                let r = match ent {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ => ent
                        .strip_prefix('#')
                        .and_then(|n| match n.strip_prefix(['x', 'X']) {
                            Some(h) => u32::from_str_radix(h, 16).ok(),
                            None => n.parse().ok(),
                        })
                        .and_then(char::from_u32),
                };
                match r {
                    Some(c) => {
                        out.push(c);
                        rest = &rest[e + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &rest[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Convert rendered HTML to readable plain text. Links become `text (url)`; hidden elements
/// (`display:none`, e.g. preheaders) and head/style/script are dropped.
pub fn html_to_text(html: &str) -> String {
    let s = strip_between(html, "<!--", "-->");
    let s = strip_between(&s, "<head", "</head>");
    let s = strip_between(&s, "<style", "</style>");
    let s = strip_between(&s, "<script", "</script>");
    let (mut out, mut i) = (String::new(), 0);
    let mut hrefs: Vec<(String, usize)> = vec![]; // href, out.len() at link start
    let mut skip: Option<(String, usize)> = None; // hidden element name, depth
    while i < s.len() {
        let Some(lt) = s[i..].find('<') else {
            if skip.is_none() {
                out.push_str(&decode(&s[i..]));
            }
            break;
        };
        if skip.is_none() {
            out.push_str(&decode(&s[i..i + lt]));
        }
        i += lt;
        // find '>' honouring quotes
        let (mut j, mut q) = (i + 1, None::<char>);
        for (k, c) in s[i + 1..].char_indices() {
            j = i + 1 + k;
            match (q, c) {
                (None, '"' | '\'') => q = Some(c),
                (Some(x), c) if c == x => q = None,
                (None, '>') => break,
                _ => {}
            }
        }
        let tag = &s[i + 1..j.min(s.len())];
        i = j + 1;
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if let Some((n, depth)) = &mut skip {
            if *n == name {
                if closing {
                    if *depth == 0 {
                        skip = None;
                    } else {
                        *depth -= 1;
                    }
                } else if !tag.ends_with('/') {
                    *depth += 1;
                }
            }
            continue;
        }
        if !closing {
            let style = attr(tag, "style")
                .unwrap_or_default()
                .replace(' ', "")
                .to_ascii_lowercase();
            if style.contains("display:none") && !tag.ends_with('/') && name != "br" {
                skip = Some((name, 0));
                continue;
            }
        }
        match (name.as_str(), closing) {
            ("a", false) => hrefs.push((attr(tag, "href").unwrap_or_default(), out.len())),
            ("a", true) => {
                if let Some((href, start)) = hrefs.pop() {
                    let label = out[start..].trim().to_owned();
                    let h = decode(&href);
                    if !h.is_empty() && !h.starts_with('#') && label != h {
                        out.push_str(&format!(" ({h})"));
                    }
                }
            }
            ("br", _) => out.push('\n'),
            ("hr", _) => out.push_str("\n---\n"),
            ("li", false) => out.push_str("\n- "),
            ("img", _) => {
                if let Some(alt) = attr(tag, "alt").filter(|a| !a.is_empty()) {
                    out.push_str(&format!("[{}]", decode(&alt)));
                }
            }
            (
                "p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "table" | "ul" | "ol",
                true,
            ) => out.push_str("\n\n"),
            ("tr", true) => out.push('\n'),
            ("td" | "th", true) => out.push(' '),
            _ => {}
        }
    }
    let cleaned: String = out
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}' | '\u{ad}'
            )
        })
        .collect();
    let mut lines: Vec<String> = vec![];
    for l in cleaned.lines() {
        let l = l.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() && lines.last().is_none_or(|p| p.is_empty()) {
            continue;
        }
        lines.push(l);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_entities_hidden() {
        let t = html_to_text(
            "<head><title>x</title></head><div style=\"display:none\">pre<div>nested</div></div>\
             <p>Hi &amp; welcome <a href=\"https://a.test/x\">here</a></p><p>two<br>lines</p>",
        );
        assert_eq!(t, "Hi & welcome here (https://a.test/x)\n\ntwo\nlines");
    }
}
