//! Signed unsubscribe tokens (RFC 8058) and the POST one-click / GET confirm handler.
//!
//! Token = `b64(tenant|contact|cat-code|exp-hex)` `.` `b64(HMAC-SHA256(secret, payload)[..12])`.
//! Compact on purpose: with short tenant/contact ids it fits a 64-char mailto local-part.
//! No cookies/auth needed: the token identifies the recipient and the category.
use crate::token::{b64, mac_trunc, mac_verify, unb64};
use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    /// Receipts, password resets. Can never be unsubscribed.
    Transactional,
    Product,
    Digest,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transactional => "transactional",
            Self::Product => "product",
            Self::Digest => "digest",
        }
    }
    fn code(self) -> &'static str {
        match self {
            Self::Transactional => "t",
            Self::Product => "p",
            Self::Digest => "d",
        }
    }
    fn from_code(s: &str) -> Option<Self> {
        Some(match s {
            "t" => Self::Transactional,
            "p" => Self::Product,
            "d" => Self::Digest,
            _ => return None,
        })
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "transactional" => Self::Transactional,
            "product" => Self::Product,
            "digest" => Self::Digest,
            _ => return None,
        })
    }
    pub fn unsubscribable(self) -> bool {
        self != Self::Transactional
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsubToken {
    pub tenant: String,
    /// Opaque contact id (keep it short: it can also go in a mailto local-part, max 64 chars).
    pub contact: String,
    pub category: Category,
    /// Unix seconds.
    pub exp: u64,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    #[error("malformed token")]
    Malformed,
    #[error("bad signature")]
    BadSignature,
    #[error("expired")]
    Expired,
    #[error("category cannot be unsubscribed")]
    NotUnsubscribable,
}

const TAG_LEN: usize = 12;

pub fn issue(secret: &[u8], t: &UnsubToken) -> Result<String, TokenError> {
    if !t.category.unsubscribable() {
        return Err(TokenError::NotUnsubscribable);
    }
    if [&t.tenant, &t.contact].iter().any(|s| s.contains('|')) {
        return Err(TokenError::Malformed);
    }
    let payload = format!(
        "{}|{}|{}|{:x}",
        t.tenant,
        t.contact,
        t.category.code(),
        t.exp
    );
    let tag = mac_trunc(secret, payload.as_bytes(), TAG_LEN);
    Ok(format!("{}.{}", b64(payload.as_bytes()), b64(&tag)))
}

pub fn verify(secret: &[u8], token: &str, now: u64) -> Result<UnsubToken, TokenError> {
    let (p, tag) = token.split_once('.').ok_or(TokenError::Malformed)?;
    let payload = unb64(p).ok_or(TokenError::Malformed)?;
    let tag = unb64(tag).ok_or(TokenError::Malformed)?;
    if tag.len() != TAG_LEN || !mac_verify(secret, &payload, &tag) {
        return Err(TokenError::BadSignature);
    }
    let s = String::from_utf8(payload).map_err(|_| TokenError::Malformed)?;
    let f: Vec<&str> = s.split('|').collect();
    let [tenant, contact, cat, exp] = f[..] else {
        return Err(TokenError::Malformed);
    };
    let category = Category::from_code(cat).ok_or(TokenError::Malformed)?;
    if !category.unsubscribable() {
        return Err(TokenError::NotUnsubscribable);
    }
    let exp = u64::from_str_radix(exp, 16).map_err(|_| TokenError::Malformed)?;
    if now > exp {
        return Err(TokenError::Expired);
    }
    Ok(UnsubToken {
        tenant: tenant.into(),
        contact: contact.into(),
        category,
        exp,
    })
}

/// Inbound mailto unsubscribe (RFC 2369 `mailto:unsub+TOKEN@host`). `rcpt` is the SMTP RCPT TO,
/// `mailbox` the local part we advertise (`unsub`). Returns the token. The sender and body are
/// irrelevant: the signed token alone identifies the contact. Caveat: tokens are case-sensitive
/// base64url, so an MTA that lowercases local parts breaks them (they then fail verification).
pub fn parse_mailto_rcpt<'a>(rcpt: &'a str, mailbox: &str) -> Option<&'a str> {
    let addr = rcpt.trim().trim_start_matches('<').trim_end_matches('>');
    let (local, _domain) = addr.rsplit_once('@')?;
    let (name, token) = local.split_once('+')?;
    (name.eq_ignore_ascii_case(mailbox) && !token.is_empty()).then_some(token)
}

/// Process an inbound mailto unsubscribe end to end. Same effect as the one-click POST.
pub fn handle_mailto(
    rcpt: &str,
    mailbox: &str,
    secret: &[u8],
    now: u64,
    store: &dyn PreferenceStore,
) -> Result<UnsubToken, TokenError> {
    let token = parse_mailto_rcpt(rcpt, mailbox).ok_or(TokenError::Malformed)?;
    let t = verify(secret, token, now)?;
    store.unsubscribe(&t.tenant, &t.contact, t.category, now);
    Ok(t)
}

/// Where unsubscribes land. Must be idempotent and take effect before the next send.
pub trait PreferenceStore {
    fn unsubscribe(&self, tenant: &str, contact: &str, category: Category, now: u64);
}

#[derive(Default)]
pub struct MemoryPrefs(pub Mutex<HashSet<(String, String, Category)>>);

impl PreferenceStore for MemoryPrefs {
    fn unsubscribe(&self, tenant: &str, contact: &str, category: Category, _now: u64) {
        self.0
            .lock()
            .unwrap()
            .insert((tenant.into(), contact.into(), category));
    }
}
impl MemoryPrefs {
    pub fn is_unsubscribed(&self, tenant: &str, contact: &str, category: Category) -> bool {
        self.0
            .lock()
            .unwrap()
            .contains(&(tenant.into(), contact.into(), category))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

fn html(status: u16, body: String) -> Response {
    Response {
        status,
        content_type: "text/html; charset=utf-8",
        body,
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `POST /u/{token}`: one-click (200, never a redirect). `GET /u/{token}`: confirm page only,
/// state-neutral so link scanners / bot clicks cannot unsubscribe anyone.
/// `body` is the raw request body (form-encoded or multipart); it must carry `List-Unsubscribe=One-Click`.
pub fn handle(
    method: Method,
    token: &str,
    body: &str,
    secret: &[u8],
    now: u64,
    store: &dyn PreferenceStore,
) -> Response {
    let t = match verify(secret, token, now) {
        Ok(t) => t,
        Err(TokenError::Expired) => {
            return html(410, "<p>This unsubscribe link has expired.</p>".into());
        }
        Err(_) => return html(400, "<p>Invalid unsubscribe link.</p>".into()),
    };
    match method {
        Method::Get => html(
            200,
            format!(
                "<form method=\"post\" action=\"\"><p>Unsubscribe from {} emails?</p>\
                 <input type=\"hidden\" name=\"List-Unsubscribe\" value=\"One-Click\">\
                 <button type=\"submit\">Unsubscribe</button></form>",
                esc(t.category.as_str())
            ),
        ),
        Method::Post => {
            if !body.contains("List-Unsubscribe=One-Click") {
                return html(400, "<p>Missing List-Unsubscribe=One-Click.</p>".into());
            }
            store.unsubscribe(&t.tenant, &t.contact, t.category, now);
            html(
                200,
                format!(
                    "<p>You have been unsubscribed from {} emails.</p>",
                    esc(t.category.as_str())
                ),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const K: &[u8] = b"unsub-secret";
    fn tok(cat: Category, exp: u64) -> UnsubToken {
        UnsubToken {
            tenant: "t1".into(),
            contact: "c42".into(),
            category: cat,
            exp,
        }
    }

    #[test]
    fn roundtrip_tamper_expiry() {
        let t = issue(K, &tok(Category::Digest, 1000)).unwrap();
        assert_eq!(verify(K, &t, 999).unwrap(), tok(Category::Digest, 1000));
        assert_eq!(verify(K, &t, 1001), Err(TokenError::Expired));
        assert_eq!(verify(b"nope", &t, 1), Err(TokenError::BadSignature));
        // swap the payload for a different contact, keep the tag
        let forged = format!("{}.{}", b64(b"t1|c43|d|3e8"), t.split_once('.').unwrap().1);
        assert_eq!(verify(K, &forged, 1), Err(TokenError::BadSignature));
        assert_eq!(verify(K, "garbage", 1), Err(TokenError::Malformed));
    }

    #[test]
    fn transactional_cannot_be_unsubscribed() {
        assert_eq!(
            issue(K, &tok(Category::Transactional, 1000)),
            Err(TokenError::NotUnsubscribable)
        );
        // a hand-signed transactional token is rejected as well
        let payload = b"t1|c42|t|3e8";
        let forged = format!("{}.{}", b64(payload), b64(&mac_trunc(K, payload, TAG_LEN)));
        assert_eq!(verify(K, &forged, 1), Err(TokenError::NotUnsubscribable));
        let p = MemoryPrefs::default();
        assert_eq!(
            handle(
                Method::Post,
                &forged,
                "List-Unsubscribe=One-Click",
                K,
                1,
                &p
            )
            .status,
            400
        );
    }

    #[test]
    fn inbound_mailto_unsubscribe() {
        let t = issue(K, &tok(Category::Digest, 1000)).unwrap();
        let rcpt = format!("<unsub+{t}@mx.example.test>");
        assert_eq!(parse_mailto_rcpt(&rcpt, "unsub"), Some(t.as_str()));
        assert_eq!(
            parse_mailto_rcpt("bounces+x@mx.example.test", "unsub"),
            None
        );
        assert_eq!(parse_mailto_rcpt("unsub@mx.example.test", "unsub"), None);
        let p = MemoryPrefs::default();
        assert_eq!(
            handle_mailto(&rcpt, "unsub", K, 1, &p).unwrap().contact,
            "c42"
        );
        assert!(p.is_unsubscribed("t1", "c42", Category::Digest));
        let p2 = MemoryPrefs::default();
        assert!(handle_mailto(&format!("unsub+{t}x@h.test"), "unsub", K, 1, &p2).is_err());
        assert_eq!(
            handle_mailto(&rcpt, "unsub", K, 2000, &p2),
            Err(TokenError::Expired)
        );
        assert!(!p2.is_unsubscribed("t1", "c42", Category::Digest));
    }

    #[test]
    fn one_click_post_and_get_confirm() {
        let t = issue(K, &tok(Category::Product, 1000)).unwrap();
        let p = MemoryPrefs::default();
        let g = handle(Method::Get, &t, "", K, 1, &p);
        assert_eq!(g.status, 200);
        assert!(g.body.contains("<form"));
        assert!(
            !p.is_unsubscribed("t1", "c42", Category::Product),
            "GET must not unsubscribe"
        );

        assert_eq!(handle(Method::Post, &t, "nothing", K, 1, &p).status, 400);
        let r = handle(Method::Post, &t, "List-Unsubscribe=One-Click", K, 1, &p);
        assert_eq!(r.status, 200, "no redirect: 200/202 only");
        assert!(p.is_unsubscribed("t1", "c42", Category::Product));
        assert!(
            !p.is_unsubscribed("t1", "c42", Category::Digest),
            "category-scoped"
        );
        // idempotent
        assert_eq!(
            handle(Method::Post, &t, "List-Unsubscribe=One-Click", K, 2, &p).status,
            200
        );
    }
}
