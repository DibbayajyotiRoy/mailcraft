//! Tiny labelled-counter/gauge registry rendered as Prometheus text (SPEC 15 names).
//! The API serves `Metrics::render()` at `/metrics`.
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
pub struct Metrics {
    counters: Mutex<BTreeMap<String, f64>>,
    gauges: Mutex<BTreeMap<String, f64>>,
}

fn series(name: &str, labels: &[(&str, &str)]) -> String {
    if labels.is_empty() {
        return name.into();
    }
    let l: Vec<String> = labels
        .iter()
        .map(|(k, v)| format!("{k}=\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("{name}{{{}}}", l.join(","))
}

impl Metrics {
    pub fn inc(&self, name: &str, labels: &[(&str, &str)]) {
        *self
            .counters
            .lock()
            .unwrap()
            .entry(series(name, labels))
            .or_default() += 1.0;
    }
    pub fn set(&self, name: &str, labels: &[(&str, &str)], v: f64) {
        self.gauges.lock().unwrap().insert(series(name, labels), v);
    }
    pub fn counter(&self, name: &str, labels: &[(&str, &str)]) -> f64 {
        self.counters
            .lock()
            .unwrap()
            .get(&series(name, labels))
            .copied()
            .unwrap_or(0.0)
    }
    pub fn render(&self) -> String {
        let mut out = String::new();
        for (kind, m) in [("counter", &self.counters), ("gauge", &self.gauges)] {
            let g = m.lock().unwrap();
            let mut last = "";
            for (k, v) in g.iter() {
                let base = k.split('{').next().unwrap();
                if base != last {
                    out += &format!("# TYPE {base} {kind}\n");
                    last = base;
                }
                out += &format!("{k} {v}\n");
            }
        }
        out
    }
}
