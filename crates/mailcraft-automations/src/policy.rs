//! Pure send-policy helpers: quiet hours and rolling-window frequency caps.
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

/// Send window in recipient-local time (SPEC 13 gate 4, journeys.md 5.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuietHours {
    pub start_hour: u32,
    pub end_hour: u32,
    pub weekdays_only: bool,
    /// Window for steps flagged `weekend_ok` (any day).
    pub weekend_end_hour: u32,
    /// Used when the contact has no (valid) timezone: daytime in Europe and the Americas.
    pub fallback_start_utc: u32,
    pub fallback_end_utc: u32,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self {
            start_hour: 9,
            end_hour: 18,
            weekdays_only: true,
            weekend_end_hour: 20,
            fallback_start_utc: 13,
            fallback_end_utc: 17,
        }
    }
}

fn local(tz: Tz, d: NaiveDate, hour: u32) -> Option<DateTime<Utc>> {
    let naive = d.and_hms_opt(hour, 0, 0)?;
    tz.from_local_datetime(&naive)
        .earliest()
        .map(|t| t.with_timezone(&Utc))
}

impl QuietHours {
    /// `None` means "inside the window, send now"; otherwise the start of the next window.
    pub fn next_send_time(
        &self,
        tz_name: Option<&str>,
        weekend_ok: bool,
        now: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        let tz: Option<Tz> = tz_name.and_then(|s| s.parse().ok());
        let (tz, start, mut end) = match tz {
            Some(tz) => (tz, self.start_hour, self.end_hour),
            None => (Tz::UTC, self.fallback_start_utc, self.fallback_end_utc),
        };
        let mut weekdays_only = self.weekdays_only;
        if weekend_ok {
            weekdays_only = false;
            if tz_name.and_then(|s| s.parse::<Tz>().ok()).is_some() {
                end = self.weekend_end_hour;
            }
        }
        let today = now.with_timezone(&tz).date_naive();
        for d in 0..9 {
            let date = today + Duration::days(d);
            if weekdays_only && matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
                continue;
            }
            let (Some(s), Some(e)) = (local(tz, date, start), local(tz, date, end)) else {
                continue;
            };
            if d == 0 {
                if now >= s && now < e {
                    return None;
                }
                if now >= e {
                    continue;
                }
            }
            return Some(s);
        }
        None
    }
}

/// Rolling-window cap: when `stamps` (ascending) already holds `max` entries inside `window`,
/// returns when the oldest relevant one expires.
pub fn cap_free_at(
    stamps: &[DateTime<Utc>],
    max: usize,
    window: Duration,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let live: Vec<_> = stamps.iter().filter(|t| **t + window > now).collect();
    if max == 0 {
        return Some(now + window);
    }
    (live.len() >= max).then(|| *live[live.len() - max] + window)
}

/// `5m`, `2d`, `1h30m`, `1w`, `45s`.
pub fn parse_duration(s: &str) -> Option<Duration> {
    let (mut total, mut num, mut any) = (Duration::zero(), String::new(), false);
    for c in s.trim().chars() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: i64 = num.parse().ok()?;
        num.clear();
        total += match c {
            's' => Duration::seconds(n),
            'm' => Duration::minutes(n),
            'h' => Duration::hours(n),
            'd' => Duration::days(n),
            'w' => Duration::weeks(n),
            _ => return None,
        };
        any = true;
    }
    (num.is_empty() && any).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("5m"), Some(Duration::minutes(5)));
        assert_eq!(parse_duration("1d12h"), Some(Duration::hours(36)));
        assert_eq!(parse_duration("5"), None);
        assert_eq!(parse_duration("x"), None);
    }

    #[test]
    fn quiet_hours_local_and_fallback() {
        let q = QuietHours::default();
        // Tue 2026-10-27 12:00 UTC is 21:00 in Tokyo: after 18:00, next window Wed 09:00 JST = 00:00Z
        assert_eq!(
            q.next_send_time(Some("Asia/Tokyo"), false, t("2026-10-27T12:00:00Z")),
            Some(t("2026-10-28T00:00:00Z"))
        );
        // inside the window
        assert_eq!(
            q.next_send_time(Some("Europe/Berlin"), false, t("2026-10-27T10:00:00Z")),
            None
        );
        // before the window
        assert_eq!(
            q.next_send_time(Some("Europe/Berlin"), false, t("2026-10-27T05:00:00Z")),
            Some(t("2026-10-27T08:00:00Z"))
        );
        // unknown tz: UTC 13-17
        assert_eq!(
            q.next_send_time(None, false, t("2026-10-27T09:00:00Z")),
            Some(t("2026-10-27T13:00:00Z"))
        );
        assert_eq!(
            q.next_send_time(None, false, t("2026-10-27T14:00:00Z")),
            None
        );
        assert_eq!(
            q.next_send_time(Some("Not/AZone"), false, t("2026-10-27T18:00:00Z")),
            Some(t("2026-10-28T13:00:00Z"))
        );
        // Saturday rolls to Monday, unless weekend_ok
        assert_eq!(
            q.next_send_time(None, false, t("2026-10-31T14:00:00Z")),
            Some(t("2026-11-02T13:00:00Z"))
        );
        assert_eq!(
            q.next_send_time(None, true, t("2026-10-31T14:00:00Z")),
            None
        );
        assert_eq!(
            q.next_send_time(Some("UTC"), true, t("2026-10-31T19:30:00Z")),
            None
        );
    }

    #[test]
    fn caps() {
        let now = t("2026-10-27T12:00:00Z");
        let w = Duration::days(7);
        let s = [
            t("2026-10-21T13:00:00Z"),
            t("2026-10-25T00:00:00Z"),
            t("2026-10-26T00:00:00Z"),
        ];
        assert_eq!(cap_free_at(&s, 3, w, now), Some(t("2026-10-28T13:00:00Z")));
        assert_eq!(cap_free_at(&s, 4, w, now), None);
        assert_eq!(cap_free_at(&s[1..], 3, w, now), None);
    }
}
