//! Small RFC 4180 reader behind `broadcasts create --csv` and `contacts import`. Same header and
//! cell rules as the dashboard (`lib/csv.ts`, `contacts/csv.ts`), so a file works in both places.
use crate::client::CliErr;
use serde_json::{json, Map, Value};

/// Rows the API takes per call (`POST /v1/broadcasts`, `POST /v1/contacts/import`).
pub const MAX_ROWS: usize = 5000;

/// Quoted fields (`""` escapes a quote, commas and line breaks allowed inside), CRLF / LF / CR row
/// ends, UTF-8 BOM, blank lines dropped. The delimiter is whichever of `,` `;` tab the header uses most.
pub fn parse(text: &str) -> Vec<Vec<String>> {
    let src = text.strip_prefix('\u{feff}').unwrap_or(text);
    let head = src.lines().next().unwrap_or("");
    let n = |d: char| head.matches(d).count();
    let delim = [';', '\t']
        .into_iter()
        .fold(',', |best, d| if n(d) > n(best) { d } else { best });
    let (mut rows, mut row, mut cell) = (vec![], vec![], String::new());
    let (mut quoted, mut chars) = (false, src.chars().peekable());
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cell.push('"');
                chars.next();
            }
            '"' if quoted => quoted = false,
            '"' if cell.is_empty() => quoted = true,
            _ if quoted => cell.push(c),
            c if c == delim => row.push(std::mem::take(&mut cell)),
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut cell));
                end_row(&mut rows, &mut row);
            }
            _ => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        end_row(&mut rows, &mut row);
    }
    rows
}

fn end_row(rows: &mut Vec<Vec<String>>, row: &mut Vec<String>) {
    let blank = row.len() == 1 && row[0].trim().is_empty();
    let r = std::mem::take(row);
    if !blank {
        rows.push(r);
    }
}

/// "First Name" -> first_name, so `{{ data.<column> }}` is a valid name; a leading digit gets `_`.
fn header_key(h: &str) -> String {
    let mut k = String::new();
    for c in h.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            k.push(c);
        } else if !k.ends_with('_') {
            k.push('_');
        }
    }
    let k = k.trim_matches('_').to_string();
    let k = match k.as_str() {
        "e_mail" | "email_address" | "emailaddress" => "email",
        "firstname" | "first" | "given_name" => "first_name",
        "lastname" | "last" | "surname" | "family_name" => "last_name",
        "time_zone" | "tz" => "timezone",
        _ => &k,
    }
    .to_string();
    if k.starts_with(|c: char| c.is_ascii_digit()) {
        format!("_{k}")
    } else {
        k
    }
}

/// Header keys and the data rows, after the file-level checks: needs an `email` column, no
/// repeated column, at most `MAX_ROWS` rows when `cap` (a contact import chunks instead).
fn table(text: &str, cap: bool) -> Result<(Vec<String>, Vec<Vec<String>>), CliErr> {
    let mut t = parse(text);
    if t.is_empty() {
        return Err(
            CliErr::usage("the CSV is empty").hint("first row: a header with an email column")
        );
    }
    let keys: Vec<String> = t.remove(0).iter().map(|h| header_key(h)).collect();
    if !keys.iter().any(|k| k == "email") {
        return Err(
            CliErr::usage("the CSV has no email column").hint("name a header column `email`")
        );
    }
    if let Some(d) = keys
        .iter()
        .enumerate()
        .find(|(i, k)| !k.is_empty() && keys[..*i].contains(k))
    {
        return Err(CliErr::usage(format!(
            "two CSV columns are both called `{}`",
            d.1
        )));
    }
    if cap && t.len() > MAX_ROWS {
        return Err(CliErr::usage(format!(
            "{} rows is over the limit of {MAX_ROWS} per broadcast",
            t.len()
        ))
        .hint("split the file"));
    }
    Ok((keys, t))
}

/// Broadcast recipients: `email`, `first_name`, `last_name`; every other column becomes `data.<column>`.
/// Blank cells are left out. Invalid and repeated addresses are the server's to report (`skipped`).
pub fn recipients(text: &str) -> Result<Vec<Value>, CliErr> {
    let (keys, rows) = table(text, true)?;
    Ok(rows
        .iter()
        .map(|cells| {
            let (mut r, mut data) = (Map::new(), Map::new());
            for (k, v) in keys.iter().zip(cells) {
                let v = v.trim();
                match k.as_str() {
                    "" => {}
                    "email" => {
                        r.insert(k.clone(), json!(v));
                    }
                    "first_name" | "last_name" if !v.is_empty() => {
                        r.insert(k.clone(), json!(v));
                    }
                    _ if !v.is_empty() => {
                        data.insert(k.clone(), json!(v));
                    }
                    _ => {}
                }
            }
            if !data.is_empty() {
                r.insert("data".into(), Value::Object(data));
            }
            Value::Object(r)
        })
        .collect())
}

/// Numbers and true/false stay typed so segment rules like `seats >= 5` work; the rest is text.
fn infer(s: &str) -> Value {
    if s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false") {
        return json!(s.eq_ignore_ascii_case("true"));
    }
    let digits = s.strip_prefix('-').unwrap_or(s);
    let plain = !digits.is_empty()
        && digits.len() <= 15
        && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        && digits.matches('.').count() <= 1
        && !digits.starts_with('.')
        && !digits.ends_with('.')
        && !(digits.len() > 1 && digits.starts_with('0') && !digits.starts_with("0."));
    match s.parse::<f64>() {
        Ok(n) if plain && n.fract() == 0.0 => json!(n as i64),
        Ok(n) if plain => json!(n),
        _ => json!(s),
    }
}

/// Contacts for `POST /v1/contacts/import`: `email`, `first_name`, `last_name`, `timezone`; every
/// other column becomes a property.
pub fn contacts(text: &str) -> Result<Vec<Value>, CliErr> {
    let (keys, rows) = table(text, false)?;
    Ok(rows
        .iter()
        .map(|cells| {
            let (mut c, mut props) = (Map::new(), Map::new());
            for (k, v) in keys.iter().zip(cells) {
                let v = v.trim();
                match k.as_str() {
                    "" => {}
                    "email" => {
                        c.insert(k.clone(), json!(v));
                    }
                    "first_name" | "last_name" | "timezone" if !v.is_empty() => {
                        c.insert(k.clone(), json!(v));
                    }
                    _ if !v.is_empty() => {
                        props.insert(k.clone(), infer(v));
                    }
                    _ => {}
                }
            }
            if !props.is_empty() {
                c.insert("properties".into(), Value::Object(props));
            }
            Value::Object(c)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quotes_bom_crlf_and_blank_lines() {
        let t = parse("\u{feff}a,b\r\n\"x, \"\"y\"\"\",2\r\n\r\n\"multi\nline\",3");
        assert_eq!(t[0], ["a", "b"]);
        assert_eq!(t[1], ["x, \"y\"", "2"]);
        assert_eq!(t[2], ["multi\nline", "3"]);
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn semicolon_files_from_excel_parse_too() {
        assert_eq!(parse("email;name\na@x.co;Ana\n")[1], ["a@x.co", "Ana"]);
    }

    #[test]
    fn recipients_map_fixed_columns_and_data() {
        let r = recipients(
            "Email,First Name,Last Name,Company,2fa\nana@x.co,Ana,,Acme,yes\nbob@x.co,,Roe,,\n",
        )
        .unwrap();
        assert_eq!(
            r[0],
            json!({"email": "ana@x.co", "first_name": "Ana", "data": {"company": "Acme", "_2fa": "yes"}})
        );
        assert_eq!(r[1], json!({"email": "bob@x.co", "last_name": "Roe"}));
    }

    #[test]
    fn contacts_keep_numbers_and_booleans_typed() {
        let c = contacts("e-mail,tz,seats,paid,zip,ratio\na@x.co,Europe/Berlin,5,TRUE,01234,1.5\n")
            .unwrap();
        assert_eq!(
            c[0],
            json!({"email": "a@x.co", "timezone": "Europe/Berlin", "properties": {"seats": 5, "paid": true, "zip": "01234", "ratio": 1.5}})
        );
    }

    #[test]
    fn file_level_errors() {
        assert!(recipients("").is_err());
        assert!(recipients("name\nAna\n").is_err());
        assert!(recipients("email,Email\na@x.co,b@x.co\n").is_err());
        let big = format!("email\n{}", "a@x.co\n".repeat(MAX_ROWS + 1));
        assert!(recipients(&big).is_err());
        assert_eq!(contacts(&big).unwrap().len(), MAX_ROWS + 1);
    }
}
