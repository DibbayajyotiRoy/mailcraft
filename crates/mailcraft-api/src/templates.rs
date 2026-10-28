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
        envelope, envelope_list, err, invalid, json_or_default, not_found, ApiError, ApiJson,
        ApiResult,
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
/// `preheader` overrides the template's own (`""` clears it); `subject` overrides html/mjml titles.
fn import(
    format: Format,
    content: &Value,
    subject: Option<&str>,
    preheader: Option<&str>,
) -> ApiResult<mt::Imported> {
    let src = match content {
        Value::String(s) => s.clone(),
        Value::Null => return Err(invalid("content is required").field("content")),
        v => v.to_string(),
    };
    if src.len() > 1_000_000 {
        return Err(invalid("content is over 1 MB").field("content"));
    }
    let bad = |e: mt::RenderError| invalid(e.to_string()).field("content");
    let mut imp = match format {
        Format::Json => mt::import_json(&src).map_err(bad),
        Format::Mjml => mt::import_mjml(&src, subject).map_err(bad),
        Format::Html => Ok(mt::import_html(&src, subject)),
    }?;
    if let Some(p) = preheader {
        imp.template.preheader = (!p.trim().is_empty()).then(|| p.trim().to_owned());
    }
    Ok(imp)
}

fn stream_str(s: Stream) -> &'static str {
    if s == Stream::Marketing {
        "marketing"
    } else {
        "transactional"
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
    let imp = import(format, &content, b.subject.as_deref(), None)?;
    let mut g = begin!(st, auth, headers, route, b);
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO templates (workspace_id, alias, name, stream) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, alias) DO NOTHING RETURNING id",
    )
    .bind(ws)
    .bind(&alias)
    .bind(&b.name)
    .bind(stream_str(stream))
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

/// What an editor opens: the author's own html/mjml as pasted, else the canonical block tree as JSON.
/// Returns `(source_format, source)`.
fn editable(format: &str, raw: Option<String>, tpl: &mt::Template) -> (String, String) {
    match raw {
        Some(r) if format == "html" || format == "mjml" => (format.to_owned(), r),
        _ => ("json".to_owned(), mt::export_json(tpl)),
    }
}

pub async fn get(State(st): State<AppState>, auth: Auth, Path(id): Path<String>) -> ApiResult {
    auth.require(Scope::Read)?;
    let t = find(&st, auth.0.workspace_id, &id).await?;
    let (v, tpl) = load(&st, &t, None).await?;
    let (format, raw): (String, Option<String>) = sqlx::query_as(
        "SELECT source_format, source_raw FROM template_versions WHERE template_id = $1 AND version = $2",
    )
    .bind(t.id)
    .bind(v)
    .fetch_one(&st.db)
    .await?;
    let (source_format, source) = editable(&format, raw, &tpl);
    let mut out = serde_json::to_value(&t).unwrap_or_default();
    out["version"] = json!(v);
    out["subject"] = json!(tpl.subject);
    out["preheader"] = json!(tpl.preheader);
    out["source_format"] = json!(source_format);
    out["source"] = json!(source);
    out["template"] = serde_json::to_value(tpl).unwrap_or_default();
    Ok(envelope(StatusCode::OK, out))
}

/// Version history, newest first. `published` marks the version sends use right now;
/// `published_at` is when a version was last published (it may since have been superseded).
pub async fn versions(State(st): State<AppState>, auth: Auth, Path(id): Path<String>) -> ApiResult {
    auth.require(Scope::Read)?;
    let t = find(&st, auth.0.workspace_id, &id).await?;
    type Row = (i32, String, Option<DateTime<Utc>>, DateTime<Utc>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT version, source_format, published_at, created_at FROM template_versions \
         WHERE template_id = $1 ORDER BY version DESC",
    )
    .bind(t.id)
    .fetch_all(&st.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(v, f, pa, at)| json!({"version": v, "source_format": f, "created_at": at, "published_at": pa, "published": t.published_version == Some(v)}))
        .collect();
    Ok(envelope_list(items, None))
}

pub async fn version_get(
    State(st): State<AppState>,
    auth: Auth,
    Path((id, version)): Path<(String, i32)>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let t = find(&st, auth.0.workspace_id, &id).await?;
    let (v, tpl) = load(&st, &t, Some(version)).await?;
    type Row = (Option<DateTime<Utc>>, DateTime<Utc>, String, Option<String>);
    let (pa, at, format, raw): Row = sqlx::query_as(
        "SELECT published_at, created_at, source_format, source_raw FROM template_versions WHERE template_id = $1 AND version = $2",
    )
    .bind(t.id)
    .bind(v)
    .fetch_one(&st.db)
    .await?;
    let (source_format, source) = editable(&format, raw, &tpl);
    Ok(envelope(
        StatusCode::OK,
        json!({"id": t.id, "alias": t.alias, "version": v, "subject": tpl.subject, "preheader": tpl.preheader,
               "created_at": at, "published_at": pa, "published": t.published_version == Some(v),
               "source_format": source_format, "source": source, "template": tpl}),
    ))
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct PatchTemplate {
    #[serde(default)]
    pub name: Option<String>,
    /// Sends and automations reference templates by alias: changing it breaks those references.
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub stream: Option<String>,
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
    /// Sets (or, when empty, clears) the preheader of the new version.
    #[serde(default)]
    pub preheader: Option<String>,
}

fn alias_taken(alias: &str) -> ApiError {
    err(
        "template_exists",
        409,
        format!("a template with alias `{alias}` already exists"),
    )
    .field("alias")
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
    if b.name.is_none() && b.alias.is_none() && b.stream.is_none() && src.is_none() {
        return Err(invalid(
            "send `name`, `alias`, `stream` and/or `content`, `mjml` or `html`",
        ));
    }
    if b.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Err(invalid("name must not be empty").field("name"));
    }
    if b.alias
        .as_deref()
        .is_some_and(|a| a.is_empty() || a.len() > 100)
    {
        return Err(invalid("alias must be 1-100 characters").field("alias"));
    }
    let stream = b
        .stream
        .as_deref()
        .map(|s| stream_of(Some(s)))
        .transpose()?;
    let imp = match &src {
        Some((f, c)) => Some(import(*f, c, b.subject.as_deref(), b.preheader.as_deref())?),
        None => None,
    };
    let route = format!("PATCH /v1/templates/{}", t.id);
    let mut g = begin!(st, auth, headers, &route, b);
    let mut fields: Vec<&str> = vec![];
    if b.name.is_some() || b.alias.is_some() || stream.is_some() {
        sqlx::query(
            "UPDATE templates SET name = COALESCE($2, name), alias = COALESCE($3, alias), stream = COALESCE($4, stream) WHERE id = $1",
        )
        .bind(t.id)
        .bind(&b.name)
        .bind(&b.alias)
        .bind(stream.map(stream_str))
        .execute(&mut *g.tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => {
                alias_taken(b.alias.as_deref().unwrap_or_default())
            }
            _ => e.into(),
        })?;
        for (set, f) in [
            (b.name.is_some(), "name"),
            (b.alias.is_some(), "alias"),
            (stream.is_some(), "stream"),
        ] {
            if set {
                fields.push(f);
            }
        }
    }
    let mut version = t.latest_version.unwrap_or(0);
    let mut warnings = vec![];
    if let (Some(i), Some((f, c))) = (&imp, &src) {
        version += 1;
        add_version(&mut g.tx, t.id, version, i, raw_of(*f, c).as_deref()).await?;
        warnings = i.warnings.clone();
        fields.push("content");
    }
    let mut args = json!({"template_id": t.id, "version": version, "fields": fields});
    if b.alias.as_deref().is_some_and(|a| a != t.alias) {
        args["previous_alias"] = json!(t.alias);
        args["alias"] = json!(b.alias);
    }
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "template.update",
            args,
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    g.finish(StatusCode::OK, json!({"id": t.id, "alias": b.alias.as_ref().unwrap_or(&t.alias), "name": b.name.as_ref().unwrap_or(&t.name), "stream": stream.map_or_else(|| t.stream.clone(), |s| stream_str(s).to_owned()), "version": version, "published_version": t.published_version, "warnings": warnings})).await
}

/// Copies an older version into a new draft (history is never rewritten).
pub async fn restore(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    Path((id, version)): Path<(String, i32)>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let t = find(&st, ws, &id).await?;
    let route = format!("POST /v1/templates/{}/versions/{version}/restore", t.id);
    let mut g = begin!(st, auth, headers, &route, json!({}));
    let next = t.latest_version.unwrap_or(0) + 1;
    let copied = sqlx::query(
        "INSERT INTO template_versions (template_id, version, doc, source_format, source_raw, variables) \
         SELECT template_id, $3, doc, source_format, source_raw, variables FROM template_versions \
         WHERE template_id = $1 AND version = $2",
    )
    .bind(t.id)
    .bind(version)
    .bind(next)
    .execute(&mut *g.tx)
    .await?
    .rows_affected();
    if copied == 0 {
        return Err(not_found("template version"));
    }
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "template.restore",
            args: json!({"template_id": t.id, "from_version": version, "version": next}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    g.finish(StatusCode::CREATED, json!({"id": t.id, "alias": t.alias, "version": next, "restored_from": version, "published_version": t.published_version})).await
}

/// Drops the unpublished versions newer than the published one, so the newest version is live again.
/// A version that was ever published stays (it is history, not a draft).
pub async fn discard_draft(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let t = find(&st, ws, &id).await?;
    let Some(published) = t.published_version else {
        return Err(err(
            "no_published_version",
            409,
            "nothing is published to fall back to",
        )
        .hint_in("publish a version first, or restore an older version into a new draft"));
    };
    let route = format!("DELETE /v1/templates/{}/draft", t.id);
    let mut g = begin!(st, auth, headers, &route, json!({}));
    let discarded = sqlx::query(
        "DELETE FROM template_versions WHERE template_id = $1 AND version > $2 AND published_at IS NULL",
    )
    .bind(t.id)
    .bind(published)
    .execute(&mut *g.tx)
    .await?
    .rows_affected();
    if discarded == 0 {
        return Err(err(
            "no_draft",
            409,
            "there are no unpublished changes to discard",
        ));
    }
    let latest: Option<i32> =
        sqlx::query_scalar("SELECT max(version) FROM template_versions WHERE template_id = $1")
            .bind(t.id)
            .fetch_one(&mut *g.tx)
            .await?;
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "template.discard_draft",
            args: json!({"template_id": t.id, "discarded": discarded, "version": latest}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    g.finish(StatusCode::OK, json!({"id": t.id, "alias": t.alias, "discarded": discarded, "version": latest, "published_version": published})).await
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
    /// Unsaved content to render instead of a saved version (the editor's live preview).
    /// Same fields as PATCH; nothing is stored.
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
    #[serde(default)]
    pub preheader: Option<String>,
}

pub(crate) async fn options(
    st: &AppState,
    ws: Uuid,
    stream: Stream,
) -> ApiResult<mt::RenderOptions> {
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
    let (tpl, warnings) = match source(b.format, &b.content, &b.mjml, &b.html) {
        Some((f, c)) => {
            let i = import(f, &c, b.subject.as_deref(), b.preheader.as_deref())?;
            (i.template, i.warnings)
        }
        None => (load(&st, &t, b.version).await?.1, vec![]),
    };
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
        json!({"subject": p.rendered.subject, "html": p.rendered.html, "text": p.rendered.text, "lint": lint_json(&p.issues), "variables": mt::variables(&tpl), "warnings": warnings}),
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
    let imp = import(f, &c, b.subject.as_deref(), None)?;
    let o = options(&st, auth.0.workspace_id, stream_of(b.stream.as_deref())?).await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"lint": lint_json(&mt::lint(&imp.template, &o, b.variables.as_ref())), "warnings": imp.warnings}),
    ))
}
