//! `#[derive(Fields)]`: the field-system declaration lives on the `Location` struct.
//!
//! Each struct field carries a `#[field(...)]` attribute (or `#[field(skip)]`); the
//! derive turns the struct into two table macros named after it, `<struct>_fields!` and
//! `<struct>_columns!`. Consumers hand one a callback macro and expand the table where
//! their context lives, so a field added to the struct cannot be forgotten by anything
//! built from it. The crate knows nothing about what a consumer builds.
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
//! - `column` is the struct field whose storage the row reads: the field itself, the list
//!   a `derived_len` counts, or the flags field a `flag` reads.
//!
//! `<struct>_columns!` has one row per struct field, skipped ones included, in declaration
//! order: `{ index, field-ident, type }`. It is the struct's storage layout, for a
//! columnar encoding to build from.
//!
//! Struct-level `#[fields(...)]` declares the rows with no struct field of their own:
//! `derived_len(key, label, of = <field>)` (a list's length as a virtual field) and
//! `flag(key, label, bit = <CONST>)` (a `LocationFlags` bit read as a boolean).

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

fn snake(ident: &str) -> String {
    let mut out = String::new();
    for (i, c) in ident.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.extend(c.to_lowercase());
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
    let mut columns: Vec<TokenStream2> = Vec::new();

    for (index, f) in data.fields.iter().enumerate() {
        let ident = f.ident.clone().expect("named fields");
        let ty = &f.ty;
        columns.push(quote! { { #index, #ident, #ty } });
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
            col: ident.clone(),
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
                ty: format_ident!("{}", if is_derived { "Number" } else { "Boolean" }),
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

    let name = snake(&input.ident.to_string());
    let fields_macro = format_ident!("{name}_fields");
    let columns_macro = format_ident!("{name}_columns");
    Ok(quote! {
        /// The field table `#[derive(Fields)]` read off the struct: one row per
        /// declared field, handed whole to a callback macro (see `mma-fields`).
        macro_rules! #fields_macro {
            ($cb:ident) => {
                $cb! { #(#row_tokens),* }
            };
        }

        /// The struct's storage layout `#[derive(Fields)]` read off it: one row per
        /// struct field in declaration order, handed whole to a callback macro.
        macro_rules! #columns_macro {
            ($cb:ident) => {
                $cb! { #(#columns),* }
            };
        }
    })
}

/// `#[derive(Patch)]`: implements `Patchable`, generating the struct's patch type.
/// `#[patch(key)]` fields name the row and are required, `#[patch(skip)]` fields are never
/// written, `#[patch(merge)]` fields change key by key through `Merge`, and `#[patch(stamp)]`
/// fields are written but never read as a change. Two values are equal exactly when the patch
/// between them is empty. Every other
/// field is optional, stored in the column `#[patch(column = "...")]` names or its own. The
/// wire type is `Partial<Struct>` narrowed the same way.
#[proc_macro_derive(Patch, attributes(patch))]
pub fn derive_patch(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand_patch(&input) {
        Ok(ts) => ts.into(),
        Err(e) => e.to_compile_error().into(),
    }
}

fn expand_patch(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let Data::Struct(data) = &input.data else {
        return Err(syn::Error::new_spanned(input, "Patch derives on a struct"));
    };
    let ident = &input.ident;
    let patch = format_ident!("{ident}Patch");
    let nullable = format_ident!("{}_patch_nullable", snake(&ident.to_string()));
    let nullable_path = nullable.to_string();
    let (mut slots, mut writes, mut reads) = (Vec::new(), Vec::new(), Vec::new());
    let (mut keys, mut skips) = (Vec::new(), Vec::new());
    let (mut columns, mut merged, mut same) = (Vec::new(), Vec::new(), Vec::new());
    for f in &data.fields {
        let name = f.ident.as_ref().expect("named fields");
        let ty = &f.ty;
        let (mut key, mut skip, mut merge, mut stamp) = (false, false, false, false);
        let mut column = name.to_string();
        for attr in f.attrs.iter().filter(|a| a.path().is_ident("patch")) {
            attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("key") {
                    key = true;
                } else if meta.path.is_ident("skip") {
                    skip = true;
                } else if meta.path.is_ident("merge") {
                    merge = true;
                } else if meta.path.is_ident("stamp") {
                    stamp = true;
                } else if meta.path.is_ident("column") {
                    column = meta.value()?.parse::<LitStr>()?.value();
                } else {
                    return Err(meta.error("unknown #[patch] key"));
                }
                Ok(())
            })?;
        }
        let key_name = camel(&name.to_string());
        let wire = format!("\"{key_name}\"");
        if key {
            keys.push(wire);
            slots.push(quote! { pub #name: #ty, });
            reads.push(quote! { #name: new.#name.clone(), });
            same.push(quote! { old.#name == new.#name });
            continue;
        }
        if skip {
            skips.push(wire);
            continue;
        }
        let de = type_name(ty)
            .starts_with("Option<")
            .then(|| quote!(#[serde(deserialize_with = #nullable_path)]));
        slots.push(quote! {
            #[serde(default, skip_serializing_if = "Option::is_none")] #de pub #name: Option<#ty>,
        });
        columns.push(quote! { (#key_name, #column), });
        let change = if merge {
            merged.push(key_name);
            writes.push(quote! { if let Some(v) = &patch.#name { out.#name = ::mma_algebra::Merge::merged(&out.#name, v); } });
            quote! { ::mma_algebra::Merge::between(&old.#name, &new.#name) }
        } else {
            writes.push(quote! { if let Some(v) = &patch.#name { out.#name = v.clone(); } });
            quote! { (old.#name != new.#name).then(|| new.#name.clone()) }
        };
        if stamp {
            reads.push(quote! { #name: None, });
        } else {
            same.push(quote! { (#change).is_none() });
            reads.push(quote! { #name: #change, });
        }
    }
    let mut wire = format!("Partial<{ident}>");
    if !skips.is_empty() {
        wire = format!("Partial<Omit<{ident}, {}>>", skips.join(" | "));
    }
    if !keys.is_empty() {
        wire = format!("{wire} & Pick<{ident}, {}>", keys.join(" | "));
    }
    let serde = input.attrs.iter().filter(|a| a.path().is_ident("serde"));
    Ok(quote! {
        /// A change to some of one value's fields: an absent field is unchanged.
        #[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
        #(#serde)*
        pub struct #patch { #(#slots)* }

        impl PartialEq for #ident {
            fn eq(&self, other: &Self) -> bool {
                let (old, new) = (self, other);
                true #(&& #same)*
            }
        }

        impl specta::Type for #patch {
            fn definition(_: &mut specta::Types) -> specta::datatype::DataType {
                specta::datatype::DataType::Reference(specta_typescript::define(#wire))
            }
        }

        impl ::mma_algebra::Patchable for #ident {
            type Patch = #patch;
            const WRITES: &'static [(&'static str, &'static str)] = &[#(#columns)*];
            const MERGED: &'static [&'static str] = &[#(#merged),*];

            fn patched(&self, patch: &#patch) -> Self {
                let mut out = self.clone();
                #(#writes)*
                out
            }

            fn between(old: &Self, new: &Self) -> #patch {
                #patch { #(#reads)* }
            }
        }

        fn #nullable<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
        where
            T: serde::Deserialize<'de>,
            D: serde::Deserializer<'de>,
        {
            Ok(Some(<Option<T> as serde::Deserialize>::deserialize(d)?))
        }
    })
}
