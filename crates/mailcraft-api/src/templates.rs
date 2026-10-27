//! `/v1/templates`, `/v1/content/lint`: versioned block-tree templates over `mailcraft-templates`.
//! A draft is the newest version; `publish` points `templates.current_version_id` at it (what sends use).
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use mailcraft_core::{auth::Scope, Stream};
use mailcraft_templates as mt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{
        envelope, envelope_list, err, invalid, json_or_default, not_found, ApiJson, ApiResult,
    },
    page,
    state::AppState,
};

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Json,
    Mjml,
    Html,
}

fn stream_of(s: Option<&str>) -> ApiResult<Stream> {
    match s {
        None | Some("transactional") => Ok(Stream::Transactional),
        Some("marketing") => Ok(Stream::Marketing),
        Some(o) => {
            Err(invalid(format!("stream `{o}` is not transactional|marketing")).field("stream"))
        }
    }
}

/// `content` is a string for every format; a JSON object is accepted for `json` too.
fn import(format: Format, content: &Value, subject: Option<&str>) -> ApiResult<mt::Imported> {
    let src = match content {
        Value::String(s) => s.clone(),
        Value::Null => return Err(invalid("content is required").field("content")),
        v => v.to_string(),
    };
    if src.len() > 1_000_000 {
        return Err(invalid("content is over 1 MB").field("content"));
    }
    let bad = |e: mt::RenderError| invalid(e.to_string()).field("content");
    match format {
        Format::Json => mt::import_json(&src).map_err(bad),
        Format::Mjml => mt::import_mjml(&src, subject).map_err(bad),
        Format::Html => Ok(mt::import_html(&src, subject)),
    }
}

fn slug(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    s.split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn source_format(i: &mt::Imported) -> String {
    serde_json::to_value(i.source_format)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "json".into())
}

async fn add_version(
    conn: &mut sqlx::PgConnection,
    template_id: Uuid,
    version: i32,
    i: &mt::Imported,
    raw: Option<&str>,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO template_versions (template_id, version, doc, source_format, source_raw, variables) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(template_id)
        .bind(version)
        .bind(serde_json::to_value(&i.template).unwrap_or_default())
        .bind(source_format(i))
        .bind(raw)
        .bind(json!(mt::variables(&i.template)))
        .execute(conn)
        .await?;
    Ok(())
}

fn raw_of(format: Format, content: &Value) -> Option<String> {
    (format != Format::Json).then(|| content.as_str().unwrap_or_default().to_string())
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateTemplate {
    #[serde(default)]
    pub alias: Option<String>,
    pub name: String,
    #[serde(default)]
    pub stream: Option<String>,
    /// Default `json` (the canonical block tree).
    #[serde(default)]
    pub format: Option<Format>,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub mjml: Option<String>,
    /// Accepted for client compatibility; the plain-text part is generated from the template.
    #[serde(default)]
    pub text: Option<String>,
    /// Accepted for client compatibility; variables are derived from the template.
    #[serde(default)]
    pub variables: Option<Vec<String>>,
    #[serde(default)]
    pub subject: Option<String>,
}

/// `content` (+`format`, default json), else `mjml`, else `html`.
fn source(
    format: Option<Format>,
    content: &Option<Value>,
    mjml: &Option<String>,
    html: &Option<String>,
) -> Option<(Format, Value)> {
    match (content, mjml, html) {
        (Some(c), ..) => Some((format.unwrap_or(Format::Json), c.clone())),
        (None, Some(m), _) => Some((Format::Mjml, json!(m))),
        (None, None, Some(h)) => Some((Format::Html, json!(h))),
        _ => None,
    }
}

const VIEW: &str = "SELECT t.id, t.alias, t.name, t.stream, t.created_at, \
    (SELECT max(version) FROM template_versions v WHERE v.template_id = t.id) AS latest_version, \
    (SELECT v.version FROM template_versions v WHERE v.id = t.current_version_id) AS published_version, \
    (SELECT v.variables FROM template_versions v WHERE v.template_id = t.id ORDER BY version DESC LIMIT 1) AS variables, \
    CASE WHEN t.current_version_id IS NULL THEN 'draft' ELSE 'published' END AS status \
    FROM templates t";

#[derive(sqlx::FromRow, Serialize)]
struct TemplateView {
    id: Uuid,
    alias: String,
    name: String,
    stream: String,
    latest_version: Option<i32>,
    published_version: Option<i32>,
    variables: Option<Value>,
    status: String,
    created_at: DateTime<Utc>,
}

async fn find(st: &AppState, ws: Uuid, id_or_alias: &str) -> ApiResult<TemplateView> {
    sqlx::query_as(&format!(
        "{VIEW} WHERE t.workspace_id = $1 AND (t.id::text = $2 OR t.alias = $2)"
    ))
    .bind(ws)
    .bind(id_or_alias)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("template"))
}

pub async fn create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<CreateTemplate>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    create_from(st, auth, headers, "POST /v1/templates", b).await
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ImportTemplate {
    pub format: Format,
    pub name: String,
    pub content: Value,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub stream: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
}

/// Same as create with `format` required.
pub async fn import_route(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<ImportTemplate>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let c = CreateTemplate {
        alias: b.alias,
        name: b.name,
        stream: b.stream,
        format: Some(b.format),
        content: Some(b.content),
        html: None,
        mjml: None,
        text: None,
        variables: None,
        subject: b.subject,
    };
    create_from(st, auth, headers, "POST /v1/templates/import", c).await
}

async fn create_from(
    st: AppState,
    auth: Auth,
    headers: HeaderMap,
    route: &str,
    b: CreateTemplate,
) -> ApiResult {
    let ws = auth.0.workspace_id;
    let alias = b.alias.clone().unwrap_or_else(|| slug(&b.name));
    if alias.is_empty() || alias.len() > 100 || b.name.trim().is_empty() {
        return Err(
            invalid("name and alias must be non-empty (alias <= 100 chars)").field("alias"),
        );
    }
    let stream = stream_of(b.stream.as_deref())?;
    let (format, content) = source(b.format, &b.content, &b.mjml, &b.html)
        .ok_or_else(|| invalid("provide `content`, `mjml` or `html`").field("content"))?;
    let imp = import(format, &content, b.subject.as_deref())?;
    let mut g = begin!(st, auth, headers, route, b);
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO templates (workspace_id, alias, name, stream) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, alias) DO NOTHING RETURNING id",
    )
    .bind(ws)
    .bind(&alias)
    .bind(&b.name)
    .bind(if stream == Stream::Marketing { "marketing" } else { "transactional" })
    .fetch_optional(&mut *g.tx)
    .await?;
    let id = id.ok_or_else(|| {
        err(
            "template_exists",
            409,
            format!("a template with alias `{alias}` already exists"),
        )
        .field("alias")
        .hint_in("PATCH /v1/templates/{alias} adds a new version")
    })?;
    add_version(&mut g.tx, id, 1, &imp, raw_of(format, &content).as_deref()).await?;
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "template.create",
            args: json!({"template_id": id, "alias": alias}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    g.finish(StatusCode::CREATED, json!({"id": id, "alias": alias, "name": b.name, "subject": imp.template.subject, "status": "draft", "version": 1, "published": false, "warnings": imp.warnings})).await
}

#[derive(Deserialize)]
pub struct ListQ {
    limit: Option<u32>,
    cursor: Option<String>,
}

pub async fn list(State(st): State<AppState>, auth: Auth, Query(q): Query<ListQ>) -> ApiResult {
    auth.require(Scope::Read)?;
    let (at, after) = page::decode(q.cursor.as_deref())?;
    let lim = page::limit(q.limit);
    let mut rows: Vec<TemplateView> = sqlx::query_as(&format!(
        "{VIEW} WHERE t.workspace_id = $1 AND (t.created_at, t.id::text) < ($2, $3) ORDER BY t.created_at DESC, t.id::text DESC LIMIT $4"
    ))
    .bind(auth.0.workspace_id)
    .bind(at)
    .bind(after)
    .bind(lim + 1)
    .fetch_all(&st.db)
    .await?;
    let next = (rows.len() as i64 > lim).then(|| {
        rows.truncate(lim as usize);
        let l = rows.last().unwrap();
        page::encode(l.created_at, l.id)
    });
    Ok(envelope_list(rows, next))
}

/// Newest version's canonical doc (or `version`).
async fn load(
    st: &AppState,
    t: &TemplateView,
    version: Option<i32>,
) -> ApiResult<(i32, mt::Template)> {
    let v = version
        .or(t.latest_version)
        .ok_or_else(|| not_found("template version"))?;
    let doc: Value = sqlx::query_scalar(
        "SELECT doc FROM template_versions WHERE template_id = $1 AND version = $2",
    )
    .bind(t.id)
    .bind(v)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("template version"))?;
    let tpl = mt::Template::from_json(&doc.to_string())
        .map_err(|e| err("template_corrupt", 500, e.to_string()))?;
    Ok((v, tpl))
}

pub async fn get(State(st): State<AppState>, auth: Auth, Path(id): Path<String>) -> ApiResult {
    auth.require(Scope::Read)?;
    let t = find(&st, auth.0.workspace_id, &id).await?;
    let (v, tpl) = load(&st, &t, None).await?;
    let mut out = serde_json::to_value(&t).unwrap_or_default();
    out["version"] = json!(v);
    out["subject"] = json!(tpl.subject);
    out["template"] = serde_json::to_value(tpl).unwrap_or_default();
    Ok(envelope(StatusCode::OK, out))
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct PatchTemplate {
    #[serde(default)]
    pub name: Option<String>,
    /// Adds a new draft version.
    #[serde(default)]
    pub format: Option<Format>,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub mjml: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub variables: Option<Vec<String>>,
    #[serde(default)]
    pub subject: Option<String>,
}

pub async fn patch(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(b): ApiJson<PatchTemplate>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let t = find(&st, ws, &id).await?;
    let src = source(b.format, &b.content, &b.mjml, &b.html);
    if b.name.is_none() && src.is_none() {
        return Err(invalid("send `name` and/or `content`, `mjml` or `html`"));
    }
    let imp = match &src {
        Some((f, c)) => Some(import(*f, c, b.subject.as_deref())?),
        None => None,
    };
    let route = format!("PATCH /v1/templates/{}", t.id);
    let mut g = begin!(st, auth, headers, &route, b);
    if let Some(n) = &b.name {
        sqlx::query("UPDATE templates SET name = $2 WHERE id = $1")
            .bind(t.id)
            .bind(n)
            .execute(&mut *g.tx)
            .await?;
    }
    let mut version = t.latest_version.unwrap_or(0);
    let mut warnings = vec![];
    if let (Some(i), Some((f, c))) = (&imp, &src) {
        version += 1;
        add_version(&mut g.tx, t.id, version, i, raw_of(*f, c).as_deref()).await?;
        warnings = i.warnings.clone();
    }
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "template.update",
            args: json!({"template_id": t.id, "version": version}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    g.finish(StatusCode::OK, json!({"id": t.id, "alias": t.alias, "version": version, "published_version": t.published_version, "warnings": warnings})).await
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct PublishBody {
    #[serde(default)]
    pub version: Option<i32>,
}

pub async fn publish(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let t = find(&st, ws, &id).await?;
    let (v, tpl) = load(&st, &t, json_or_default::<PublishBody>(&body)?.version).await?;
    // Never publish something that cannot render.
    mt::preview(&tpl, &mt::RenderOptions::default(), None).map_err(|e| {
        err("template_render_failed", 422, e.to_string())
            .hint_in("fix the template and publish again")
    })?;
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "UPDATE template_versions SET published_at = now() WHERE template_id = $1 AND version = $2",
    )
    .bind(t.id)
    .bind(v)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE templates SET current_version_id = (SELECT id FROM template_versions WHERE template_id = $1 AND version = $2) WHERE id = $1").bind(t.id).bind(v).execute(&mut *tx).await?;
    audit::append(
        &mut tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "template.publish",
            args: json!({"template_id": t.id, "version": v}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"id": t.id, "alias": t.alias, "published_version": v}),
    ))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct PreviewBody {
    #[serde(default)]
    pub variables: Option<Value>,
    #[serde(default)]
    pub version: Option<i32>,
}

async fn options(st: &AppState, ws: Uuid, stream: Stream) -> ApiResult<mt::RenderOptions> {
    let (name, addr): (String, Option<String>) =
        sqlx::query_as("SELECT name, postal_address FROM workspaces WHERE id = $1")
            .bind(ws)
            .fetch_one(&st.db)
            .await?;
    Ok(mt::RenderOptions {
        stream,
        footer: mt::Footer {
            workspace_name: Some(name),
            postal_address: addr,
        },
    })
}

/// `{rule, severity, message, path}` (`rule` = the lint code).
fn lint_json(issues: &[mt::LintIssue]) -> Value {
    issues.iter().map(|i| json!({"rule": i.code, "severity": i.severity, "message": i.message, "path": i.path})).collect()
}

pub async fn preview(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let b: PreviewBody = json_or_default(&body)?;
    let t = find(&st, auth.0.workspace_id, &id).await?;
    let (_, tpl) = load(&st, &t, b.version).await?;
    let o = options(
        &st,
        auth.0.workspace_id,
        if t.stream == "marketing" {
            Stream::Marketing
        } else {
            Stream::Transactional
        },
    )
    .await?;
    let p = mt::preview(&tpl, &o, b.variables.as_ref())
        .map_err(|e| err("template_render_failed", 422, e.to_string()))?;
    Ok(envelope(
        StatusCode::OK,
        json!({"subject": p.rendered.subject, "html": p.rendered.html, "text": p.rendered.text, "lint": lint_json(&p.issues)}),
    ))
}

#[derive(Deserialize)]
pub struct ExportQ {
    format: Option<Format>,
    version: Option<i32>,
}

pub async fn export(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    Query(q): Query<ExportQ>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let t = find(&st, auth.0.workspace_id, &id).await?;
    let (_, tpl) = load(&st, &t, q.version).await?;
    let f = q.format.unwrap_or(Format::Html);
    let content = match f {
        Format::Json => mt::export_json(&tpl),
        Format::Mjml => mt::export_mjml(&tpl),
        Format::Html => {
            let o = options(
                &st,
                auth.0.workspace_id,
                if t.stream == "marketing" {
                    Stream::Marketing
                } else {
                    Stream::Transactional
                },
            )
            .await?;
            mt::export_html(&tpl, &o, None)
                .map_err(|e| err("template_render_failed", 422, e.to_string()))?
        }
    };
    Ok(envelope(
        StatusCode::OK,
        json!({"format": f, "content": content}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LintBody {
    #[serde(default)]
    pub format: Option<Format>,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub mjml: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
    /// Accepted; the plain-text part is generated.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub stream: Option<String>,
    #[serde(default)]
    pub variables: Option<Value>,
}

/// Lint arbitrary content without saving it (default format `html`).
pub async fn lint(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<LintBody>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let (f, c) = source(
        Some(b.format.unwrap_or(Format::Html)),
        &b.content,
        &b.mjml,
        &b.html,
    )
    .ok_or_else(|| invalid("provide `html`, `mjml` or `content`").field("html"))?;
    let imp = import(f, &c, b.subject.as_deref())?;
    let o = options(&st, auth.0.workspace_id, stream_of(b.stream.as_deref())?).await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"lint": lint_json(&mt::lint(&imp.template, &o, b.variables.as_ref())), "warnings": imp.warnings}),
    ))
}
