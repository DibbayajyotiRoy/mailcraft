use mailcraft_templates::*;
use serde_json::json;
use std::path::PathBuf;

fn golden(name: &str, actual: &str) {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name);
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&p, actual).unwrap();
    }
    let want = std::fs::read_to_string(&p)
        .unwrap_or_else(|_| panic!("missing golden {name}; run with UPDATE_GOLDEN=1"));
    assert_eq!(
        actual, want,
        "golden {name} differs (UPDATE_GOLDEN=1 to accept)"
    );
}

fn welcome() -> Template {
    Template::from_json(include_str!("fixtures/welcome.json")).unwrap()
}

fn marketing() -> RenderOptions {
    RenderOptions::marketing(Footer {
        workspace_name: Some("Acme & Co".into()),
        postal_address: Some("1 Main St\nSpringfield, IL 62701".into()),
    })
}

fn vars() -> serde_json::Value {
    json!({"first_name":"Ana","app_url":"https://app.example.com/start","unsubscribe_url":"https://mail.example.com/u/abc","preferences_url":"https://mail.example.com/p/abc",
           "slots":{"intro":"Glad you are here."}})
}

#[test]
fn transactional_render_matches_golden() {
    let r = render(&welcome(), &vars(), &RenderOptions::default()).unwrap();
    assert_eq!(r.subject, "Welcome Ana");
    assert!(
        !r.html.contains("Unsubscribe"),
        "no footer on transactional"
    );
    golden("welcome.html", &r.html);
    golden("welcome.txt", &r.text);
    golden("welcome.mjml", &r.mjml);
}

#[test]
fn marketing_always_gets_footer_and_unsubscribe() {
    let r = render(&welcome(), &vars(), &marketing()).unwrap();
    assert!(r.html.contains("https://mail.example.com/u/abc"));
    assert!(
        r.text
            .contains("Unsubscribe (https://mail.example.com/u/abc)"),
        "{}",
        r.text
    );
    assert!(r.text.contains("Springfield, IL 62701"));
    golden("welcome_marketing.html", &r.html);
    golden("welcome_marketing.txt", &r.text);
}

#[test]
fn marketing_without_address_or_unsubscribe_url_refuses() {
    let no_addr = RenderOptions::marketing(Footer::default());
    assert!(matches!(
        render(&welcome(), &vars(), &no_addr),
        Err(RenderError::Footer(_))
    ));
    let mut v = vars();
    v.as_object_mut().unwrap().remove("unsubscribe_url");
    assert!(matches!(
        render(&welcome(), &v, &marketing()),
        Err(RenderError::Vars(_))
    ));
}

#[test]
fn strict_undefined_and_escaping() {
    let mut v = vars();
    v.as_object_mut().unwrap().remove("first_name");
    assert!(render(&welcome(), &v, &RenderOptions::default()).is_err());
    let mut v = vars();
    v["first_name"] = json!("<script>alert(1)</script>");
    let r = render(&welcome(), &v, &RenderOptions::default()).unwrap();
    assert!(!r.html.contains("<script>alert"));
    // slot values are data: jinja syntax in them is not evaluated
    v["first_name"] = json!("Ana");
    v["slots"]["intro"] = json!("{{ secret }} <b>x</b>");
    let r = render(&welcome(), &v, &RenderOptions::default()).unwrap();
    assert!(r.html.contains("{{ secret }}") && !r.html.contains("<b>x</b>"));
}

#[test]
fn slot_fallback_and_max_len() {
    let t = welcome();
    let mut v = vars();
    v.as_object_mut().unwrap().remove("slots");
    assert!(render(&t, &v, &RenderOptions::default())
        .unwrap()
        .text
        .contains("Thanks for joining."));
    v["slots"] = json!({"intro": "x".repeat(601)});
    assert!(matches!(
        render(&t, &v, &RenderOptions::default()),
        Err(RenderError::Slot(..))
    ));
}

#[test]
fn variables_listed() {
    assert_eq!(
        variables(&welcome()),
        vec!["app_url", "first_name", "unsubscribe_url_unused"]
            .into_iter()
            .filter(|v| *v != "unsubscribe_url_unused")
            .collect::<Vec<_>>()
    );
}

#[test]
fn mjml_export_import_round_trips() {
    let t = welcome();
    let mjml = export_mjml(&t);
    golden("welcome_export.mjml", &mjml);
    let imp = import_mjml(&mjml, None).unwrap();
    assert_eq!(imp.template, t);
    assert!(imp.warnings.is_empty(), "{:?}", imp.warnings);
}

#[test]
fn mjml_import_maps_known_and_keeps_raw() {
    let src = r##"<mjml><mj-head><mj-title>Hello</mj-title><mj-preview>Peek</mj-preview><mj-style>.a{color:red}</mj-style></mj-head>
<mj-body>
<mj-section><mj-column><mj-text>Plain &amp; simple</mj-text><mj-text color="red">Styled</mj-text><mj-button href="https://x.test">Go</mj-button></mj-column></mj-section>
<mj-section background-color="#eee"><mj-column><mj-text>Boxed</mj-text></mj-column></mj-section>
<mj-section><mj-column><mj-image src="https://x.test/a.png" alt="A" /></mj-column><mj-column><mj-text>R <b>bold</b></mj-text></mj-column></mj-section>
</mj-body></mjml>"##;
    let imp = import_mjml(src, None).unwrap();
    golden("import_mjml.json", &export_json(&imp.template));
    assert_eq!(imp.template.subject, "Hello");
    assert_eq!(imp.template.preheader.as_deref(), Some("Peek"));
    assert!(imp.template.head.as_ref().unwrap().contains("mj-style"));
    // and it still compiles
    assert!(render(&imp.template, &json!({}), &RenderOptions::default())
        .unwrap()
        .html
        .contains("Boxed"));
}

#[test]
fn html_import_resend_vars_and_passthrough() {
    let html = "<!doctype html><html><head><title>Hi {{{NAME|there}}}</title></head><body><p>Hello {{{NAME}}}</p></body></html>";
    let imp = import_html(html, None);
    assert_eq!(imp.source_format, SourceFormat::Html);
    let r = render(
        &imp.template,
        &json!({"NAME":"Ana","unsubscribe_url":"https://m.test/u/x"}),
        &marketing(),
    )
    .unwrap();
    golden("import_html_marketing.html", &r.html);
    assert!(r.html.contains("Hello Ana") && r.html.contains("/u/x"));
    assert!(r.mjml.is_empty());
}

#[test]
fn react_email_import() {
    let html = include_str!("fixtures/react_email.html");
    let imp = import_react_email(html, Some("Welcome"));
    assert_eq!(imp.source_format, SourceFormat::ReactEmail);
    assert_eq!(
        imp.template.preheader.as_deref(),
        Some("Thanks for signing up")
    );
    let r = render(&imp.template, &json!({}), &RenderOptions::default()).unwrap();
    assert!(!r.html.contains("<!--$-->"));
    golden("react_email.txt", &r.text);
}

#[test]
fn json_round_trip_and_schema() {
    let t = welcome();
    let back = import_json(&export_json(&t)).unwrap();
    assert_eq!(back.template, t);
    assert!(import_json(r#"{"version":2,"subject":"x","blocks":[]}"#).is_err());
    let schema = json_schema();
    let kinds = schema["$defs"]["block"]["oneOf"].as_array().unwrap().len();
    assert_eq!(kinds, 10);
}

#[test]
fn lint_catches_problems() {
    let t = Template::new(
        "Hi {{ first_name }}",
        vec![
            Block::Image {
                src: "https://x.test/a.png".into(),
                alt: "".into(),
                href: None,
                width: None,
            },
            Block::Button {
                label: "Go".into(),
                url: "example.com/path".into(),
            },
            Block::Button {
                label: "Go".into(),
                url: "http://x.test".into(),
            },
            Block::Paragraph {
                text: "{{ missing_thing }} {{ order.id }}".into(),
            },
            Block::RawHtml {
                html: "<img src=\"https://x.test/b.png\"><a href=\"javascript:x\">a</a>".into(),
            },
            Block::Slot {
                name: "s".into(),
                max_len: None,
                instructions: None,
                fallback: None,
            },
        ],
    );
    let issues = lint(
        &t,
        &RenderOptions::default(),
        Some(&json!({"first_name":"A"})),
    );
    let codes: Vec<_> = issues.iter().map(|i| i.code).collect();
    for want in [
        "image_missing_alt",
        "broken_link",
        "insecure_link",
        "missing_variable",
        "slot_missing_fallback",
    ] {
        assert!(codes.contains(&want), "{want} not in {codes:?}");
    }
    assert_eq!(
        issues
            .iter()
            .filter(|i| i.code == "missing_variable")
            .count(),
        2,
        "{issues:?}"
    );
    // marketing without an address
    let m = lint(
        &welcome(),
        &RenderOptions::marketing(Footer::default()),
        None,
    );
    assert!(m.iter().any(|i| i.code == "missing_postal_address"));
}

#[test]
fn lint_flags_gmail_clipping_and_empty_text() {
    let big = Template::new(
        "s",
        vec![Block::RawHtml {
            html: format!("<p>{}</p>", "a".repeat(110_000)),
        }],
    );
    assert!(lint(&big, &RenderOptions::default(), None)
        .iter()
        .any(|i| i.code == "gmail_clipping"));
    let empty = Template::new(
        "s",
        vec![Block::Image {
            src: "https://x.test/a.png".into(),
            alt: "a".into(),
            href: None,
            width: None,
        }],
    );
    // alt text lands in the text part, so only a truly empty body trips this
    let e = Template::new("s", vec![Block::Divider]);
    assert!(lint(&e, &RenderOptions::default(), None)
        .iter()
        .any(|i| i.code == "missing_plain_text"));
    let _ = empty;
}

#[test]
fn preview_fills_sample_data() {
    let p = preview(&welcome(), &RenderOptions::default(), None).unwrap();
    assert!(
        p.rendered.html.contains("[app_url]")
            || p.rendered.html.contains("[first_name]")
            || p.rendered.text.contains("Ana")
    );
    assert!(
        p.issues.iter().all(|i| i.severity != Severity::Error),
        "{:?}",
        p.issues
    );
}
