//! Keyset cursors: `<unix micros>_<id>` over `(created_at DESC, id::text DESC)`.
use chrono::{DateTime, TimeZone, Utc};

use crate::error::{invalid, ApiResult};

pub fn encode(at: DateTime<Utc>, id: impl std::fmt::Display) -> String {
    format!("{}_{id}", at.timestamp_micros())
}

/// `None` cursor = first page. Returns the bound pair for `(created_at, id::text) < ($n, $m)`.
pub fn decode(c: Option<&str>) -> ApiResult<(DateTime<Utc>, String)> {
    let Some(c) = c else {
        return Ok((
            Utc.timestamp_opt(32_503_680_000, 0).unwrap(),
            "\u{10FFFF}".into(),
        ));
    };
    c.split_once('_')
        .and_then(|(t, id)| {
            Some((
                Utc.timestamp_micros(t.parse().ok()?).single()?,
                id.to_string(),
            ))
        })
        .ok_or_else(|| invalid("malformed cursor").field("cursor"))
}

pub fn limit(l: Option<u32>) -> i64 {
    i64::from(l.unwrap_or(25).clamp(1, 100))
}
