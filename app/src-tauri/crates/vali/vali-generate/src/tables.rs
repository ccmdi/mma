use rustc_hash::FxHashMap;
use serde::Deserialize;
use std::sync::OnceLock;

pub type Weights = &'static [(&'static str, i32)];

const NAMES_JSON: &[u8] = include_bytes!("../resources/tables/names.json");
const SUBDIVISION_WEIGHTS_JSON: &[u8] =
    include_bytes!("../resources/tables/subdivision_weights.json");
const COUNTRY_WEIGHTS_JSON: &[u8] = include_bytes!("../resources/tables/country_weights.json");

#[derive(Deserialize)]
struct NamesFile {
    countries: Vec<(String, String)>,
    subdivisions: Vec<(String, Vec<(String, String)>)>,
}

pub struct Tables {
    pub countries: &'static [(&'static str, &'static str)],
    country_names: FxHashMap<&'static str, &'static str>,
    subdivision_names: FxHashMap<&'static str, FxHashMap<&'static str, &'static str>>,
    subdivision_weights: FxHashMap<&'static str, Weights>,
    presets: FxHashMap<&'static str, Weights>,
}

impl Tables {
    pub fn country_name(&self, code: &str) -> &'static str {
        self.country_names.get(code).copied().unwrap_or("")
    }

    pub fn subdivision_name(&self, country: &str, sub: &str) -> Option<&'static str> {
        self.subdivision_names.get(country)?.get(sub).copied()
    }

    pub fn subdivision_weights(&self, country: &str) -> Option<Weights> {
        self.subdivision_weights.get(country).copied()
    }

    pub fn preset(&self, key: &str) -> Weights {
        self.presets.get(key).copied().unwrap_or(&[])
    }
}

pub fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(load)
}

fn leak_str(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn leak_weights(v: Vec<(String, i32)>) -> Weights {
    let v: Vec<(&'static str, i32)> = v.into_iter().map(|(k, w)| (leak_str(k), w)).collect();
    Box::leak(v.into_boxed_slice())
}

fn load() -> Tables {
    let names: NamesFile = serde_json::from_slice(NAMES_JSON).expect("names.json is malformed");
    let sub_weights: Vec<(String, Vec<(String, i32)>)> =
        serde_json::from_slice(SUBDIVISION_WEIGHTS_JSON)
            .expect("subdivision_weights.json is malformed");
    let presets: Vec<(String, Vec<(String, i32)>)> =
        serde_json::from_slice(COUNTRY_WEIGHTS_JSON).expect("country_weights.json is malformed");

    let countries: Vec<(&'static str, &'static str)> = names
        .countries
        .into_iter()
        .map(|(c, n)| (leak_str(c), leak_str(n)))
        .collect();
    let countries: &'static [(&'static str, &'static str)] =
        Box::leak(countries.into_boxed_slice());

    Tables {
        countries,
        country_names: countries.iter().copied().collect(),
        subdivision_names: names
            .subdivisions
            .into_iter()
            .map(|(country, subs)| {
                let subs = subs
                    .into_iter()
                    .map(|(code, name)| (leak_str(code), leak_str(name)))
                    .collect();
                (leak_str(country), subs)
            })
            .collect(),
        subdivision_weights: sub_weights
            .into_iter()
            .map(|(country, w)| (leak_str(country), leak_weights(w)))
            .collect(),
        presets: presets
            .into_iter()
            .map(|(key, w)| (leak_str(key), leak_weights(w)))
            .collect(),
    }
}

#[cfg(test)]
#[path = "tables.test.rs"]
mod tests;
