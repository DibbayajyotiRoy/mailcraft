//! Pure validator: no I/O. Every number, host, URL, error code and parameter
//! name in the slots must exist in the context JSON or an allowlist.
use crate::contract::Slots;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Violation {
    pub rule: &'static str,
    pub slot: String,
    pub detail: String,
}
impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}: {}", self.rule, self.slot, self.detail)
    }
}

#[derive(Debug, Clone)]
pub struct ValidatorConfig {
    /// Case-insensitive regexes. Skipped when the match text appears in `context.allowed_terms`.
    pub banned_terms: Vec<String>,
    /// Case-insensitive literal phrases.
    pub spam_phrases: Vec<String>,
    /// Exact hosts, or ".example.com" / "*.example.com" for suffix match.
    pub allowed_hosts: Vec<String>,
    pub allowed_numbers: Vec<String>,
    pub allowed_params: Vec<String>,
    pub allowed_error_codes: Vec<String>,
    pub max_subject_chars: usize,
    pub max_preheader_chars: usize,
    pub max_greeting_chars: usize,
    pub max_cta_chars: usize,
    pub max_body_words: usize,
    pub max_paragraphs: usize,
    pub max_caps_ratio: f32,
    pub allow_exclamation: bool,
}

const SPAM_PHRASES: &[&str] = &[
    "act now",
    "limited time",
    "click here",
    "buy now",
    "100% free",
    "risk free",
    "risk-free",
    "urgent",
    "winner",
    "no obligation",
    "dear friend",
    "once in a lifetime",
    "order now",
    "don't miss",
    "last chance",
    "guaranteed",
    "make money",
    "special promotion",
];

impl Default for ValidatorConfig {
    fn default() -> Self {
        Self {
            banned_terms: vec![],
            spam_phrases: SPAM_PHRASES.iter().map(|s| s.to_string()).collect(),
            allowed_hosts: vec![],
            allowed_numbers: vec!["0".into()],
            allowed_params: vec![],
            allowed_error_codes: vec![],
            max_subject_chars: 60,
            max_preheader_chars: 110,
            max_greeting_chars: 40,
            max_cta_chars: 30,
            max_body_words: 120,
            max_paragraphs: 3,
            max_caps_ratio: 0.3,
            allow_exclamation: false,
        }
    }
}

impl ValidatorConfig {
    /// Spicrawl rules from journeys.md 4.2/4.3.
    pub fn spicrawl() -> Self {
        let banned = [
            r"crawl endpoint",
            r"\bcrawl(s|ing|er)?\b",
            r"search api",
            r"search engine",
            r"\bai[ -]extraction\b",
            r"\bai\b",
            r"\bchromium\b",
            r"\bcamoufox\b",
            r"\bobscura\b",
            // pricing promises
            r"\$\s?\d",
            r"\bdiscounts?\b",
            r"free forever",
            r"\bunlimited\b",
            r"\bguarantee[sd]?\b",
            r"\bpricing\b",
            r"\bcoupon\b",
            r"\bupgrade\b",
        ];
        Self {
            banned_terms: banned.iter().map(|s| s.to_string()).collect(),
            allowed_hosts: vec!["*.spicrawl.com".into(), "spicrawl.com".into()],
            ..Self::default()
        }
    }
}

pub struct Validator {
    cfg: ValidatorConfig,
    banned: Vec<Regex>,
    re_url: Regex,
    re_host: Regex,
    re_num: Regex,
    re_err: Regex,
    re_ident: Regex,
    re_param_eq: Regex,
    re_html: Regex,
    re_emoji: Regex,
    re_placeholder: Regex,
}

/// Facts extracted from the context JSON.
#[derive(Default)]
struct Facts {
    numbers: HashSet<String>,
    hosts: HashSet<String>,
    urls: HashSet<String>,
    errors: HashSet<String>,
    idents: HashSet<String>,
    allowed_terms: Vec<String>,
}

fn norm_num(s: &str) -> String {
    let t = s.replace(',', "");
    let t = t.trim_end_matches('.');
    if t.contains('.') {
        t.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        t.to_string()
    }
}

impl Validator {
    pub fn new(cfg: ValidatorConfig) -> Result<Self, regex::Error> {
        let banned = cfg
            .banned_terms
            .iter()
            .map(|p| Regex::new(&format!("(?i){p}")))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            cfg,
            banned,
            re_url: Regex::new(r#"(?i)\bhttps?://[^\s)>\]"']+|\bwww\.[^\s)>\]"']+"#)?,
            re_host: Regex::new(r"(?i)\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b")?,
            re_num: Regex::new(r"\d[\d,]*(?:\.\d+)?")?,
            re_err: Regex::new(r"ERR::[A-Z_]+(?:::[A-Z_]+)*")?,
            re_ident: Regex::new(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")?,
            re_param_eq: Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)=")?,
            re_html: Regex::new(r"</?[A-Za-z!][^>]*>|&[a-zA-Z]+;|&#\d+;")?,
            re_placeholder: Regex::new(
                r"\{\{|\}\}|\{%|%\}|\$\{|\[[^\]\n]{1,40}\]|<[^>\n]{1,40}>|%[sd]\b|\bundefined\b|\bnull\b|\bNaN\b|(?i:lorem ipsum)",
            )?,
            re_emoji: Regex::new(r"[\x{1F000}-\x{1FFFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]")?,
        })
    }

    fn facts(&self, ctx: &Value) -> Facts {
        let mut f = Facts::default();
        if let Some(a) = ctx.get("allowed_terms").and_then(Value::as_array) {
            f.allowed_terms = a
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_lowercase)
                .collect();
        }
        self.walk(ctx, &mut f);
        f
    }

    fn walk(&self, v: &Value, f: &mut Facts) {
        match v {
            Value::Number(n) => {
                let s = n.to_string();
                f.numbers.insert(norm_num(&s));
                if let Some(x) = n.as_f64() {
                    // ratios are often phrased as percentages (0.44 -> 44%)
                    if x > 0.0 && x <= 1.0 && x.fract() != 0.0 {
                        f.numbers
                            .insert(norm_num(&format!("{}", (x * 100.0).round())));
                    }
                }
            }
            Value::String(s) => self.walk_str(s, f),
            Value::Array(a) => a.iter().for_each(|x| self.walk(x, f)),
            Value::Object(o) => o.values().for_each(|x| self.walk(x, f)),
            _ => {}
        }
    }

    fn walk_str(&self, s: &str, f: &mut Facts) {
        for u in self.re_url.find_iter(s) {
            f.urls
                .insert(u.as_str().trim_end_matches(['.', ',']).to_string());
        }
        for h in self.re_host.find_iter(s) {
            f.hosts.insert(h.as_str().to_lowercase());
        }
        for e in self.re_err.find_iter(s) {
            f.errors.insert(e.as_str().to_string());
        }
        for i in self.re_ident.find_iter(s) {
            f.idents.insert(i.as_str().to_string());
        }
        for c in self.re_param_eq.captures_iter(s) {
            f.idents.insert(c[1].to_string());
        }
        // dates / numbers inside strings ("2026-10-26", "Oct 26") are facts too
        let stripped = self.re_host.replace_all(s, " ");
        for n in self.re_num.find_iter(&stripped) {
            f.numbers.insert(norm_num(n.as_str()));
        }
    }

    fn host_ok(&self, h: &str, f: &Facts) -> bool {
        let h = h.to_lowercase();
        let h = h.strip_prefix("www.").unwrap_or(&h);
        f.hosts
            .iter()
            .any(|x| x.strip_prefix("www.").unwrap_or(x) == h)
            || self.cfg.allowed_hosts.iter().any(|a| {
                let a = a.to_lowercase();
                match a.strip_prefix("*.").or_else(|| a.strip_prefix('.')) {
                    Some(suffix) => h.ends_with(&format!(".{suffix}")),
                    None => a == h,
                }
            })
    }

    /// Empty result means the slots pass.
    pub fn validate(&self, slots: &Slots, context: &Value) -> Vec<Violation> {
        let c = &self.cfg;
        let f = self.facts(context);
        let mut out = vec![];
        let mut v = |rule, slot: &str, detail: String| {
            out.push(Violation {
                rule,
                slot: slot.to_string(),
                detail,
            })
        };

        // structure and length
        if slots.subject.trim().is_empty() {
            v("empty", "subject", "subject is empty".into());
        }
        if slots.cta_label.trim().is_empty() {
            v("empty", "cta_label", "cta_label is empty".into());
        }
        if slots.body_paragraphs.is_empty()
            || slots.body_paragraphs.iter().any(|p| p.trim().is_empty())
        {
            v(
                "empty",
                "body_paragraphs",
                "need 1..=max non-empty paragraphs".into(),
            );
        }
        if slots.body_paragraphs.len() > c.max_paragraphs {
            v(
                "length",
                "body_paragraphs",
                format!(
                    "{} paragraphs, max {}",
                    slots.body_paragraphs.len(),
                    c.max_paragraphs
                ),
            );
        }
        for (name, text, max) in [
            ("subject", &slots.subject, c.max_subject_chars),
            ("preheader", &slots.preheader, c.max_preheader_chars),
            ("greeting", &slots.greeting, c.max_greeting_chars),
            ("cta_label", &slots.cta_label, c.max_cta_chars),
        ] {
            let n = text.chars().count();
            if n > max {
                v("length", name, format!("{n} chars, max {max}"));
            }
        }
        let words: usize = slots
            .body_paragraphs
            .iter()
            .map(|p| p.split_whitespace().count())
            .sum();
        if words > c.max_body_words {
            v(
                "length",
                "body_paragraphs",
                format!("{words} words, max {}", c.max_body_words),
            );
        }

        for (slot, text) in slots.texts() {
            let slot = slot.as_str();
            // placeholders, HTML, emoji, exclamation
            for m in self.re_placeholder.find_iter(text) {
                v(
                    "placeholder",
                    slot,
                    format!("leftover placeholder {:?}", m.as_str()),
                );
            }
            if let Some(m) = self.re_html.find(text) {
                v(
                    "html",
                    slot,
                    format!("markup not allowed: {:?}", m.as_str()),
                );
            }
            if self.re_emoji.is_match(text) {
                v("emoji", slot, "emoji not allowed".into());
            }
            if !c.allow_exclamation && text.contains('!') {
                v("exclamation", slot, "exclamation marks not allowed".into());
            }
            // banned terms
            let lower = text.to_lowercase();
            for re in &self.banned {
                if let Some(m) = re.find(text) {
                    if !f.allowed_terms.contains(&m.as_str().to_lowercase()) {
                        v("banned_term", slot, format!("banned term {:?}", m.as_str()));
                    }
                }
            }
            for p in &c.spam_phrases {
                if lower.contains(&p.to_lowercase()) {
                    v("spam_phrase", slot, format!("spam phrase {p:?}"));
                }
            }
            // shouting (URLs and error codes are legitimately upper-case)
            let plain = self
                .re_err
                .replace_all(&self.re_url.replace_all(text, " "), "")
                .into_owned();
            let letters: Vec<char> = plain.chars().filter(|c| c.is_alphabetic()).collect();
            if letters.len() >= 8 {
                let caps = letters.iter().filter(|c| c.is_uppercase()).count() as f32
                    / letters.len() as f32;
                if caps > c.max_caps_ratio {
                    v("caps", slot, format!("caps ratio {caps:.2}"));
                }
            }

            // facts: URLs, hosts, error codes, params, numbers
            let mut rest = text.to_string();
            for m in self.re_url.find_iter(text) {
                let u = m.as_str().trim_end_matches(['.', ',']);
                if !f.urls.contains(u) {
                    v("url", slot, format!("url not in context: {u}"));
                }
                if u.to_lowercase().starts_with("http://") {
                    v("url", slot, format!("insecure url: {u}"));
                }
            }
            rest = self.re_url.replace_all(&rest, " ").into_owned();
            for m in self.re_host.find_iter(&rest) {
                if !self.host_ok(m.as_str(), &f) {
                    v(
                        "host",
                        slot,
                        format!("host not in context/allowlist: {}", m.as_str()),
                    );
                }
            }
            rest = self.re_host.replace_all(&rest, " ").into_owned();
            for m in self.re_err.find_iter(&rest) {
                if !f.errors.contains(m.as_str())
                    && !c.allowed_error_codes.iter().any(|e| e == m.as_str())
                {
                    v(
                        "error_code",
                        slot,
                        format!("error code not in context: {}", m.as_str()),
                    );
                }
            }
            rest = self.re_err.replace_all(&rest, " ").into_owned();
            let param_ok =
                |p: &str| f.idents.contains(p) || c.allowed_params.iter().any(|a| a == p);
            for m in self.re_ident.find_iter(&rest) {
                if !param_ok(m.as_str()) {
                    v(
                        "param",
                        slot,
                        format!("parameter name not in context: {}", m.as_str()),
                    );
                }
            }
            for cap in self.re_param_eq.captures_iter(&rest) {
                if !param_ok(&cap[1]) {
                    v(
                        "param",
                        slot,
                        format!("parameter name not in context: {}", &cap[1]),
                    );
                }
            }
            for m in self.re_num.find_iter(&rest) {
                let n = norm_num(m.as_str());
                if !f.numbers.contains(&n) && !c.allowed_numbers.iter().any(|a| norm_num(a) == n) {
                    v(
                        "number",
                        slot,
                        format!("number not in context: {}", m.as_str()),
                    );
                }
            }
        }
        out
    }
}

/// Prompt-injection hygiene (journeys.md 4.2 rule 7): strip control chars and
/// cap string lengths (80 for role/company, 200 otherwise) before the context
/// reaches the model.
pub fn sanitize_context(v: &Value) -> Value {
    fn go(key: &str, v: &Value) -> Value {
        match v {
            Value::String(s) => {
                let max = if matches!(key, "role" | "company") {
                    80
                } else {
                    200
                };
                Value::String(s.chars().filter(|c| !c.is_control()).take(max).collect())
            }
            Value::Array(a) => Value::Array(a.iter().map(|x| go(key, x)).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, x)| (k.clone(), go(k, x))).collect())
            }
            x => x.clone(),
        }
    }
    go("", v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok_slots() -> Slots {
        Slots {
            subject: "Your key is waiting".into(),
            preheader: "A short path".into(),
            greeting: "Hi Ana,".into(),
            body_paragraphs: vec!["You have used 800 of 1000 credits.".into()],
            cta_label: "Open the docs".into(),
        }
    }
    fn ctx() -> Value {
        json!({"first_name":"Ana","used":800,"limit":1000,"success_pct_30d":0.44,
            "failures":[{"host":"example.com","error_code":"ERR::UPSTREAM::CHALLENGE","allowed_advice":["js_render=true"],
            "doc_url":"https://docs.spicrawl.com/errors#UPSTREAM_CHALLENGE","last_seen":"2026-10-26T14:03:00Z"}]})
    }
    fn run(s: &Slots) -> Vec<Violation> {
        Validator::new(ValidatorConfig::spicrawl())
            .unwrap()
            .validate(s, &ctx())
    }
    fn rules(s: &Slots) -> Vec<&'static str> {
        run(s).iter().map(|v| v.rule).collect()
    }
    fn with_body(t: &str) -> Slots {
        Slots {
            body_paragraphs: vec![t.into()],
            ..ok_slots()
        }
    }

    #[test]
    fn clean_passes() {
        assert_eq!(run(&ok_slots()), vec![]);
    }
    #[test]
    fn numbers() {
        assert!(rules(&with_body("You used 900 credits.")).contains(&"number"));
        assert!(rules(&with_body("You used 1,000 credits.")).is_empty());
        assert!(rules(&with_body("Success rate was 44%.")).is_empty());
        assert!(rules(&with_body("Success rate was 45%.")).contains(&"number"));
        assert!(rules(&with_body("It costs 0 credits.")).is_empty());
        assert!(rules(&with_body("On 26 October.")).is_empty());
    }
    #[test]
    fn hosts_and_urls() {
        assert!(rules(&with_body("example.com returned a challenge page.")).is_empty());
        assert!(rules(&with_body("Docs at docs.spicrawl.com are handy.")).is_empty());
        assert!(rules(&with_body("Try other-site.io instead.")).contains(&"host"));
        assert_eq!(
            run(&with_body(
                "See https://docs.spicrawl.com/errors#UPSTREAM_CHALLENGE."
            )),
            vec![]
        );
        assert!(rules(&with_body("See https://docs.spicrawl.com/made-up")).contains(&"url"));
        assert!(rules(&with_body("See http://evil.spicrawl.com/x")).contains(&"url"));
        assert!(rules(&with_body("evilspicrawl.com is not ours")).contains(&"host"));
    }
    #[test]
    fn codes_and_params() {
        assert!(rules(&with_body("It returned ERR::UPSTREAM::CHALLENGE.")).is_empty());
        assert!(rules(&with_body("It returned ERR::UPSTREAM::TIMEOUT.")).contains(&"error_code"));
        assert!(rules(&with_body("Try js_render=true.")).is_empty());
        assert!(rules(&with_body("Try premium_proxy=true.")).contains(&"param"));
        assert!(rules(&with_body("Try proxy=on.")).contains(&"param"));
    }
    #[test]
    fn banned_and_spam() {
        for t in [
            "Use the crawl endpoint.",
            "Our search API helps.",
            "Try AI extraction.",
            "Runs on Chromium.",
            "camoufox is great",
            "Obscura engine",
            "Plans from $9 a month.",
            "Unlimited credits.",
            "We guarantee it.",
        ] {
            assert!(rules(&with_body(t)).contains(&"banned_term"), "{t}");
        }
        assert!(rules(&with_body("Act now to continue.")).contains(&"spam_phrase"));
    }
    #[test]
    fn allowed_terms_override() {
        let mut c = ctx();
        c["allowed_terms"] = json!(["unlimited"]);
        let v = Validator::new(ValidatorConfig::spicrawl()).unwrap();
        assert!(v
            .validate(&with_body("Unlimited retries."), &c)
            .iter()
            .all(|x| x.rule != "banned_term"));
    }
    #[test]
    fn placeholders_html_emoji() {
        for g in [
            "Hi {{first_name}},",
            "Hi [Name],",
            "Hi <name>,",
            "Hi null,",
            "Hi undefined,",
            "Hi %s,",
            "Hi {% if x %}",
        ] {
            let s = Slots {
                greeting: g.into(),
                ..ok_slots()
            };
            assert!(rules(&s).contains(&"placeholder"), "{g}");
        }
        assert!(rules(&with_body("<b>Hello</b> there")).contains(&"html"));
        assert!(rules(&with_body("Fish &amp; chips")).contains(&"html"));
        assert!(rules(&with_body("Great job \u{1F680}")).contains(&"emoji"));
        assert!(rules(&with_body("Great job!")).contains(&"exclamation"));
    }
    #[test]
    fn lengths() {
        let s = Slots {
            subject: "x".repeat(61),
            ..ok_slots()
        };
        assert!(rules(&s).contains(&"length"));
        let s = Slots {
            body_paragraphs: vec!["a".into(); 4],
            ..ok_slots()
        };
        assert!(rules(&s).contains(&"length"));
        assert!(rules(&with_body(&"word ".repeat(121))).contains(&"length"));
        let s = Slots {
            subject: "".into(),
            ..ok_slots()
        };
        assert!(rules(&s).contains(&"empty"));
    }
    #[test]
    fn shouting() {
        let s = Slots {
            subject: "YOUR KEY IS WAITING".into(),
            ..ok_slots()
        };
        assert!(rules(&s).contains(&"caps"));
    }
    #[test]
    fn sanitize() {
        let c = sanitize_context(
            &json!({"role": format!("a\u{0007}{}", "x".repeat(200)), "sample_detail": "ok\nline"}),
        );
        assert_eq!(c["role"].as_str().unwrap().len(), 80);
        assert_eq!(c["sample_detail"], "okline");
    }
}
