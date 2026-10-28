//! The dynamic-value syntax the dashboard's "Personalization" button documents
//! (`dashboard/lib/personalization.ts`). If a snippet there stops working, this fails first.
//! Context at send time: `first_name`, `last_name`, `email`, `data.<column>` (broadcasts),
//! `unsubscribe_url`, `preferences_url`, `workspace.name`; minijinja filters apply.
use mailcraft_templates::*;
use serde_json::{json, Value};

fn para(text: &str) -> Template {
    Template::new(
        "s",
        vec![Block::Paragraph {
            text: text.to_owned(),
        }],
    )
}

fn text_of(t: &Template, vars: &Value, o: &RenderOptions) -> Result<String, RenderError> {
    render(t, vars, o).map(|r| r.text)
}

fn marketing() -> RenderOptions {
    RenderOptions::marketing(Footer {
        workspace_name: Some("Acme".into()),
        postal_address: Some("1 Main St".into()),
    })
}

#[test]
fn contact_fields_and_fallback() {
    let t = para("Hi {{ first_name | default(\"there\") }},");
    let o = RenderOptions::default();
    let named = json!({"first_name": "Ada", "data": {}});
    assert!(text_of(&t, &named, &o).unwrap().contains("Hi Ada,"));
    // a missing key falls back; a blank value does not (`default` only checks "defined"), so
    // broadcasts leave blank cells out of the variables instead of sending ""
    let none = json!({"data": {}});
    assert!(text_of(&t, &none, &o).unwrap().contains("Hi there,"));
    let blank = json!({"first_name": "", "data": {}});
    assert!(!text_of(&t, &blank, &o).unwrap().contains("there"));
    let t = para("Hi {{ first_name | default(\"there\", true) }},");
    assert!(text_of(&t, &blank, &o).unwrap().contains("Hi there,"));
    // plain `{{ first_name }}` with no value is an error, never "Hi null"
    assert!(text_of(&para("Hi {{ first_name }}"), &none, &o).is_err());
    // last_name / email
    let t = para("{{ first_name }} {{ last_name }} <{{ email }}>");
    let v = json!({"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com"});
    assert!(text_of(&t, &v, &o)
        .unwrap()
        .contains("Ada Lovelace <ada@example.com>"));
}

#[test]
fn custom_columns_live_under_data() {
    let o = RenderOptions::default();
    let t = para("At {{ data.company }}?");
    let v = json!({"data": {"company": "Analytical Engines"}});
    assert!(text_of(&t, &v, &o)
        .unwrap()
        .contains("At Analytical Engines?"));
    // missing column: error, unless the template gives a fallback
    assert!(text_of(&t, &json!({"data": {}}), &o).is_err());
    let t = para("At {{ data.company | default('your company') }}?");
    assert!(text_of(&t, &json!({"data": {}}), &o)
        .unwrap()
        .contains("At your company?"));
    // filters work on any value
    let t = para("{{ data.company | upper }} {{ first_name | title }}");
    let v = json!({"first_name": "ada", "data": {"company": "acme"}});
    assert!(text_of(&t, &v, &o).unwrap().contains("ACME Ada"));
}

#[test]
fn links_and_workspace_name() {
    // marketing mail gets the footer (unsubscribe link, postal address) from the renderer;
    // `unsubscribe_url` / `workspace.name` can also be placed by hand
    let t = para("Leave: {{ unsubscribe_url }} from {{ workspace.name }}");
    let v = json!({"unsubscribe_url": "https://x.test/u/t", "preferences_url": "https://x.test/u/t", "workspace": {"name": "Acme"}});
    let r = render(&t, &v, &marketing()).unwrap();
    assert!(r.html.contains("Leave: https://x.test/u/t from Acme"));
    assert!(r.html.contains("Unsubscribe"), "footer is automatic");
}

#[test]
fn subject_uses_the_same_syntax() {
    let t = Template::new("Hi {{ first_name | default(\"there\") }}", vec![]);
    assert_eq!(
        render_subject(&t, &json!({"first_name": "Ada"})).unwrap(),
        "Hi Ada"
    );
    assert_eq!(render_subject(&t, &json!({})).unwrap(), "Hi there");
}
