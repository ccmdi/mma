//! `#[derive(Fields)]`: the field-system declaration lives on the `Location` struct.
//!
//! Each struct field carries a `#[field(...)]` attribute (or `#[field(skip)]`); the
//! derive turns the whole set into one `location_fields!` table macro. Consumers hand
//! it a callback macro and expand the table where their context lives - the field
//! table, `is_builtin_field`, and both resolvers all come from this one declaration
//! site, so a field added to the struct cannot be forgotten by the field system.
//!
//! Row shape handed to the callback, one per field:
//! `{ key, label, type-ident, kind-ident, comparison-tt, interned-ident, category-ident,
//!    column-ident, field-ident }`
//! - `type` names a `FieldType` variant, inferred from the Rust type (`f64`/`u32` ->
//!   `Number`, `Vec<u32>` -> `Array`, `Option<CompactString>` -> `String`) unless
//!   overridden by `date`.
//! - `kind` is `identity` / `virtual_` / `writable` / `readonly` (the picker taxonomy).
//! - `comparison` is `none` or `(circular <period>)`.
//! - `category` picks the resolver body: how the value reads off a `Location` and off an
//!   Arrow column. Residual quirks are categories, not closures: `absent_when_empty`
//!   turns a string into `opt_str_empty` and a list into `u32_list_empty`.
//! - `column` is the `LocView` cache field (defaults to `<ident>s`).
//!
//! Struct-level `#[fields(...)]` declares the rows with no struct field of their own:
//! `derived_len(key, label, of = <field>)` (a list's length as a virtual field) and
//! `flag(key, label, bit = <CONST>)` (a `LocationFlags` bit read as a 0/1 number).

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{parse_macro_input, Data, DeriveInput, Ident, LitFloat, LitStr, Type};

struct Row {
    key: String,
    label: String,
    ty: Ident,
    kind: Ident,
    cmp: TokenStream2,
    interned: Ident,
    cat: Ident,
    col: Ident,
    field: Ident,
}

fn camel(ident: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in ident.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn type_name(ty: &Type) -> String {
    quote!(#ty).to_string().replace(' ', "")
}

#[proc_macro_derive(Fields, attributes(field, fields))]
pub fn derive_fields(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand(&input) {
        Ok(ts) => ts.into(),
        Err(e) => e.to_compile_error().into(),
    }
}

fn expand(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let Data::Struct(data) = &input.data else {
        return Err(syn::Error::new_spanned(input, "Fields derives on a struct"));
    };

    let mut rows: Vec<Row> = Vec::new();

    for f in &data.fields {
        let ident = f.ident.clone().expect("named fields");
        let attr = f.attrs.iter().find(|a| a.path().is_ident("field"));
        let Some(attr) = attr else {
            return Err(syn::Error::new_spanned(
                f,
                "every field declares #[field(...)] or #[field(skip)]",
            ));
        };

        let mut skip = false;
        let mut label: Option<String> = None;
        let mut kind = format_ident!("readonly");
        let mut cmp = quote!(none);
        let mut interned = format_ident!("not_interned");
        let mut date = false;
        let mut absent_when_empty = false;
        let mut column: Option<Ident> = None;

        attr.parse_nested_meta(|meta| {
            let p = &meta.path;
            if p.is_ident("skip") {
                skip = true;
            } else if p.is_ident("label") {
                label = Some(meta.value()?.parse::<LitStr>()?.value());
            } else if p.is_ident("kind") {
                let k: Ident = meta.value()?.parse()?;
                kind = if k == "virtual" {
                    format_ident!("virtual_")
                } else {
                    k
                };
            } else if p.is_ident("circular") {
                let period: LitFloat = meta.value()?.parse()?;
                cmp = quote!((circular #period));
            } else if p.is_ident("interned") {
                interned = format_ident!("interned");
            } else if p.is_ident("date") {
                date = true;
            } else if p.is_ident("absent_when_empty") {
                absent_when_empty = true;
            } else if p.is_ident("column") {
                column = Some(meta.value()?.parse()?);
            } else {
                return Err(meta.error("unknown #[field] key"));
            }
            Ok(())
        })?;
        if skip {
            continue;
        }
        let label = label.ok_or_else(|| syn::Error::new_spanned(attr, "#[field] needs a label"))?;

        let (ty, cat) = match (type_name(&f.ty).as_str(), date, absent_when_empty) {
            ("f64", false, false) => ("Number", "f64"),
            ("u32", false, false) => ("Number", "u32"),
            ("u32", true, false) => ("Date", "date_u32"),
            ("Option<u32>", true, false) => ("Date", "opt_date_u32"),
            ("Option<compact_str::CompactString>", false, true)
            | ("Option<CompactString>", false, true) => ("String", "opt_str_empty"),
            ("Vec<u32>", false, true) => ("Array", "u32_list_empty"),
            (other, ..) => {
                return Err(syn::Error::new_spanned(
                    &f.ty,
                    format!("no field category for type '{other}' with these attributes"),
                ))
            }
        };

        rows.push(Row {
            key: camel(&ident.to_string()),
            label,
            ty: format_ident!("{ty}"),
            kind,
            cmp,
            interned,
            cat: format_ident!("{cat}"),
            col: column.unwrap_or_else(|| format_ident!("{ident}s")),
            field: ident,
        });
    }

    // Struct-level declarations: fields with no struct storage of their own.
    for attr in input.attrs.iter().filter(|a| a.path().is_ident("fields")) {
        attr.parse_nested_meta(|meta| {
            let is_derived = meta.path.is_ident("derived_len");
            let is_flag = meta.path.is_ident("flag");
            if !is_derived && !is_flag {
                return Err(meta.error("unknown #[fields] entry"));
            }
            let mut key: Option<String> = None;
            let mut label: Option<String> = None;
            let mut of: Option<Ident> = None;
            meta.parse_nested_meta(|inner| {
                if inner.path.is_ident("key") {
                    key = Some(inner.value()?.parse::<LitStr>()?.value());
                } else if inner.path.is_ident("label") {
                    label = Some(inner.value()?.parse::<LitStr>()?.value());
                } else if inner.path.is_ident("of") || inner.path.is_ident("bit") {
                    of = Some(inner.value()?.parse()?);
                } else {
                    return Err(inner.error("unknown key"));
                }
                Ok(())
            })?;
            let (Some(key), Some(label), Some(of)) = (key, label, of) else {
                return Err(meta.error("needs key, label, and of/bit"));
            };
            rows.push(Row {
                key,
                label,
                ty: format_ident!("Number"),
                kind: if is_derived {
                    format_ident!("virtual_")
                } else {
                    format_ident!("writable")
                },
                cmp: quote!(none),
                interned: format_ident!("not_interned"),
                cat: format_ident!("{}", if is_derived { "len_of" } else { "flag" }),
                col: if is_derived {
                    of.clone()
                } else {
                    format_ident!("flags")
                },
                field: of,
            });
            Ok(())
        })?;
    }

    let row_tokens: Vec<TokenStream2> = rows
        .iter()
        .map(|r| {
            let Row {
                key,
                label,
                ty,
                kind,
                cmp,
                interned,
                cat,
                col,
                field,
            } = r;
            quote! { { #key, #label, #ty, #kind, #cmp, #interned, #cat, #col, #field } }
        })
        .collect();

    let _ = &input.generics; // Location is not generic; nothing to carry.
    Ok(quote! {
        /// The field table `#[derive(Fields)]` read off the struct: one row per
        /// declared field, handed whole to a callback macro (see `mma-fields`).
        macro_rules! location_fields {
            ($cb:ident) => {
                $cb! { #(#row_tokens),* }
            };
        }
    })
}
