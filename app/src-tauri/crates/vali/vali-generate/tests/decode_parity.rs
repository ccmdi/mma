use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use vali_core::Location;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn ulp_diff(a: f64, b: f64) -> u64 {
    if a == b {
        return 0;
    }
    if a.is_nan() || b.is_nan() {
        return u64::MAX;
    }
    let map = |bits: u64| {
        if bits & (1 << 63) != 0 {
            !bits
        } else {
            bits | (1 << 63)
        }
    };
    let (a, b) = (map(a.to_bits()), map(b.to_bits()));
    a.abs_diff(b)
}

fn compare(
    prefix: &str,
    live: &Value,
    oracle: &Value,
    hard: &mut Vec<String>,
    soft: &mut Vec<(String, u64)>,
) {
    match (live, oracle) {
        (Value::Object(l), Value::Object(o)) => {
            for (k, lv) in l {
                let ov = o.get(k).unwrap_or(&Value::Null);
                compare(&format!("{prefix}.{k}"), lv, ov, hard, soft);
            }
        }
        (Value::Array(l), Value::Array(o)) => {
            if l.len() != o.len() {
                hard.push(format!("{prefix}.len {} vs {}", l.len(), o.len()));
            }
            for (i, (lv, ov)) in l.iter().zip(o).enumerate() {
                compare(&format!("{prefix}[{i}]"), lv, ov, hard, soft);
            }
        }
        (Value::Number(l), Value::Number(o)) => {
            if l.is_f64() || o.is_f64() {
                let d = ulp_diff(l.as_f64().unwrap(), o.as_f64().unwrap());
                if d != 0 {
                    soft.push((prefix.to_string(), d));
                }
            } else if l != o {
                hard.push(format!("{prefix} {l} vs {o}"));
            }
        }
        _ => {
            if live != oracle {
                hard.push(format!("{prefix} {live} vs {oracle}"));
            }
        }
    }
}

#[test]
fn decoded_records_are_bit_exact_against_oracle() {
    let oracle_path = fixture("ru-al.csharp.json");
    let bin_path = fixture("ru-al-1000.bin");

    let oracle: Vec<Location> = serde_json::from_slice(
        &std::fs::read(&oracle_path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", oracle_path.display())),
    )
    .expect("parse oracle dump");
    let live = vali_data::decode_file(&bin_path).expect("decode fixture bin");

    assert!(!oracle.is_empty(), "oracle dump was empty");
    assert!(
        live.len() >= oracle.len(),
        "live decoded {} records but oracle has {}",
        live.len(),
        oracle.len()
    );

    let mut hard_records: Vec<String> = Vec::new();
    let mut max_ulp = 0u64;
    let mut soft_by_field: BTreeMap<String, (usize, u64)> = BTreeMap::new();

    for (i, exp) in oracle.iter().enumerate() {
        let lv = serde_json::to_value(&live[i]).unwrap();
        let ov = serde_json::to_value(exp).unwrap();
        let mut hard = Vec::new();
        let mut soft = Vec::new();
        compare("", &lv, &ov, &mut hard, &mut soft);

        if !hard.is_empty() && hard_records.len() < 5 {
            hard_records.push(format!("record {i}: {}", hard.join("; ")));
        }
        for (field, d) in soft {
            let e = soft_by_field.entry(field).or_insert((0, 0));
            e.0 += 1;
            e.1 = e.1.max(d);
            max_ulp = max_ulp.max(d);
        }
    }

    let floats: Vec<String> = soft_by_field
        .iter()
        .map(|(f, (c, u))| format!("  {f}: {c} records, max {u} ULP"))
        .collect();

    assert!(
        hard_records.is_empty() && max_ulp == 0,
        "decode diverged over {} records (max float ULP {max_ulp}; a 1-ULP diff means serde_json's float_roundtrip feature is off)\n{}\n{}",
        oracle.len(),
        hard_records.join("\n"),
        floats.join("\n")
    );
}
