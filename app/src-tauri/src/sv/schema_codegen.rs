//! Generates `schema.rs` from `app/src/lib/proto/*.proto`: a typed accessor layer over
//! [`crate::sv::wire::Node`] plus the wire enums, so every field number and enum value
//! exists once, in the proto files. `schema_is_current` gates drift; the ignored
//! `regen_schema` rewrites the file.

use std::fmt::Write as _;
use std::fs;
use std::mem;
use std::path::PathBuf;

const PROTO_FILES: &[&str] = &["streetview.proto", "getmetadata.proto", "singleimagesearch.proto"];

struct Field {
    name: String,
    type_name: String,
    number: u32,
    repeated: bool,
}

struct Message {
    name: String,
    fields: Vec<Field>,
}

struct EnumValue {
    name: String,
    number: u32,
    label: Option<String>,
}

struct Enum {
    name: String,
    doc: Vec<String>,
    values: Vec<EnumValue>,
}

#[derive(Default)]
struct Schema {
    messages: Vec<Message>,
    enums: Vec<Enum>,
}

fn proto_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/lib/proto")
}

fn schema_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/sv/schema.rs")
}

/// The comment tail of a line: its text without `//`, or None.
fn comment(line: &str) -> Option<&str> {
    line.split_once("//").map(|(_, c)| c.trim())
}

fn strip_comment(line: &str) -> &str {
    line.split_once("//").map_or(line, |(code, _)| code).trim()
}

fn parse(source: &str, schema: &mut Schema) {
    let mut doc: Vec<String> = Vec::new();
    let mut message: Option<Message> = None;
    let mut wire_enum: Option<Enum> = None;
    for line in source.lines() {
        let code = strip_comment(line);
        if code.is_empty() {
            if let Some(c) = comment(line) {
                doc.push(c.to_string());
            } else {
                doc.clear();
            }
            continue;
        }
        if let Some(rest) = code.strip_prefix("message ") {
            let name = rest.trim_end_matches(['{', '}', ' ']).to_string();
            let m = Message {
                name,
                fields: Vec::new(),
            };
            // `message Empty {}` opens and closes on its own line.
            if code.ends_with("{}") {
                schema.messages.push(m);
            } else {
                message = Some(m);
            }
            doc.clear();
            continue;
        }
        if let Some(rest) = code.strip_prefix("enum ") {
            wire_enum = Some(Enum {
                name: rest.trim_end_matches(['{', ' ']).to_string(),
                doc: mem::take(&mut doc),
                values: Vec::new(),
            });
            continue;
        }
        if code == "}" {
            if let Some(m) = message.take() {
                schema.messages.push(m);
            }
            if let Some(e) = wire_enum.take() {
                schema.enums.push(e);
            }
            doc.clear();
            continue;
        }
        if let Some(e) = wire_enum.as_mut() {
            let Some((name, number)) = code.trim_end_matches(';').split_once('=') else {
                continue;
            };
            e.values.push(EnumValue {
                name: name.trim().to_string(),
                number: number.trim().parse().expect("enum value"),
                label: comment(line)
                    .and_then(|c| c.strip_prefix("label:"))
                    .map(|l| l.trim().to_string()),
            });
            continue;
        }
        if let Some(m) = message.as_mut() {
            let mut words = code.trim_end_matches(';').split_whitespace();
            let rule = words.next().expect("field rule");
            assert!(
                matches!(rule, "optional" | "repeated"),
                "unsupported field rule {rule}"
            );
            let type_name = words.next().expect("field type").to_string();
            let name = words.next().expect("field name").to_string();
            assert_eq!(words.next(), Some("="), "malformed field: {code}");
            let number = words.next().expect("field number").parse().expect("field number");
            m.fields.push(Field {
                name,
                type_name,
                number,
                repeated: rule == "repeated",
            });
        }
        doc.clear();
    }
}

fn snake(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Reader return type and body, then the owned field type and the conversion that fills
/// it from the reader accessor.
fn scalar(type_name: &str) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    Some(match type_name {
        "string" => ("&'a str", "self.0.str({N})", "String", "self.{m}().to_string()"),
        "int32" => ("i64", "self.0.int({N})", "i32", "self.{m}() as i32"),
        "int64" => ("i64", "self.0.int({N})", "i64", "self.{m}()"),
        "uint64" => ("u64", "self.0.int({N}) as u64", "u64", "self.{m}()"),
        "bool" => ("bool", "self.0.int({N}) != 0", "bool", "self.{m}()"),
        "float" => ("f64", "self.0.float({N})", "f64", "self.{m}()"),
        "double" => ("f64", "self.0.double({N})", "f64", "self.{m}()"),
        _ => return None,
    })
}

fn generate() -> String {
    let mut schema = Schema::default();
    for file in PROTO_FILES {
        let path = proto_dir().join(file);
        let source = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        parse(&source, &mut schema);
    }

    let mut out = String::from(
        "//! GENERATED from `app/src/lib/proto/*.proto` by `sv/schema_codegen.rs` -- do not\n\
         //! edit. Regen: `cargo test -p map-making-app --lib sv::schema_codegen::regen_schema -- --ignored`.\n\
         //!\n\
         //! Each struct reads one wire message through [`Node`] by field number, over binary\n\
         //! protobuf and array-JSON alike; the consts carry the numbers for the encode side,\n\
         //! and `owned` holds the value form every reader copies out through `to_owned`.\n\
         #![allow(dead_code, reason = \"the schema is generated whole; readers use what they need\")]\n\n\
         use crate::sv::wire::Node;\n\
         use crate::types::{wire_enum, wire_names, TsConst};\n",
    );

    for e in &schema.enums {
        out.push_str("\nwire_enum! {\n");
        for d in &e.doc {
            let _ = writeln!(out, "    /// {d}");
        }
        let _ = writeln!(out, "    {}: u8 {{", e.name);
        for v in &e.values {
            match &v.label {
                Some(label) => {
                    let _ = writeln!(out, "        {} = {} => \"{label}\",", v.name, v.number);
                }
                None => {
                    let _ = writeln!(out, "        {} = {},", v.name, v.number);
                }
            }
        }
        out.push_str("    }\n}\n");
    }

    for m in &schema.messages {
        let _ = write!(out, "\npub struct {}<'a>(pub Node<'a>);\n", m.name);
        let _ = writeln!(out, "\nimpl<'a> {}<'a> {{", m.name);
        for f in &m.fields {
            let _ = writeln!(out, "    pub const {}: u32 = {};", snake(&f.name).to_uppercase(), f.number);
        }
        out.push_str("\n    pub fn present(&self) -> bool {\n        self.0.present()\n    }\n");
        for f in &m.fields {
            let method = snake(&f.name);
            let n = f.number;
            match (scalar(&f.type_name), f.repeated) {
                (Some((ty, body, _, _)), false) => {
                    let body = body.replace("{N}", &n.to_string());
                    let _ = write!(
                        out,
                        "\n    pub fn {method}(&self) -> {ty} {{\n        {body}\n    }}\n"
                    );
                }
                // Repeated scalars are write-only in this codebase; the const above is
                // their whole surface.
                (Some(_), true) => {}
                (None, false) => {
                    let ty = &f.type_name;
                    let _ = write!(
                        out,
                        "\n    pub fn {method}(&self) -> {ty}<'a> {{\n        {ty}(self.0.at({n}))\n    }}\n"
                    );
                }
                (None, true) => {
                    let ty = &f.type_name;
                    let _ = write!(
                        out,
                        "\n    pub fn {method}(&self) -> Vec<{ty}<'a>> {{\n        self.0.all({n}).into_iter().map({ty}).collect()\n    }}\n"
                    );
                }
            }
        }
        let _ = writeln!(out, "\n    pub fn to_owned(&self) -> owned::{} {{", m.name);
        let _ = writeln!(out, "        owned::{} {{", m.name);
        for f in &m.fields {
            let method = snake(&f.name);
            match (scalar(&f.type_name), f.repeated) {
                (Some((_, _, _, conv)), false) => {
                    let conv = conv.replace("{m}", &method);
                    let _ = writeln!(out, "            {method}: {conv},");
                }
                (Some(_), true) => {}
                (None, false) => {
                    let _ = writeln!(
                        out,
                        "            {method}: {{\n                let v = self.{method}();\n                v.present().then(|| v.to_owned())\n            }},"
                    );
                }
                (None, true) => {
                    let ty = &f.type_name;
                    let _ = writeln!(
                        out,
                        "            {method}: self.{method}().iter().map({ty}::to_owned).collect(),"
                    );
                }
            }
        }
        out.push_str("        }\n    }\n}\n");
    }

    out.push_str(
        "\npub mod owned {\n\
         \x20   //! Owned value forms of every message: real fields, copied off the wire by the\n\
         \x20   //! matching reader's `to_owned`. Repeated scalars are write-only and not carried.\n\
         \x20   use serde::{Deserialize, Serialize};\n\
         \x20   use specta::Type;\n",
    );
    for m in &schema.messages {
        out.push_str(
            "\n    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]\n\
             \x20   #[serde(rename_all = \"camelCase\")]\n",
        );
        let _ = writeln!(out, "    pub struct {} {{", m.name);
        for f in &m.fields {
            let field = snake(&f.name);
            match (scalar(&f.type_name), f.repeated) {
                (Some((_, _, ty, _)), false) => {
                    let _ = writeln!(out, "        pub {field}: {ty},");
                }
                (Some(_), true) => {}
                (None, false) => {
                    let _ = writeln!(out, "        pub {field}: Option<{}>,", f.type_name);
                }
                (None, true) => {
                    let _ = writeln!(out, "        pub {field}: Vec<{}>,", f.type_name);
                }
            }
        }
        out.push_str("    }\n");
    }
    out.push_str("}\n");
    out
}

#[test]
fn schema_is_current() {
    let on_disk = fs::read_to_string(schema_path())
        .expect("schema.rs missing; run the ignored regen_schema test")
        .replace("\r\n", "\n");
    assert!(
        on_disk == generate(),
        "schema.rs is stale; run: cargo test -p map-making-app --lib sv::schema_codegen::regen_schema -- --ignored"
    );
}

#[test]
#[ignore = "rewrites schema.rs from the proto files"]
fn regen_schema() {
    fs::write(schema_path(), generate()).expect("write schema.rs");
}
