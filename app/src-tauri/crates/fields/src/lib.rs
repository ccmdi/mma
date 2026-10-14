//! Generate field tables and patch types from struct attributes.
//!
//! `Fields` generates `<struct>_fields!` and `<struct>_columns!` callback macros.
//! The field table describes selectable fields; the column table lists stored fields
//! in declaration order, including skipped fields.
//!
//! Field rows: `{ key, label, type, kind, comparison, interned, category, column, field }`, where
//! `type` is the column's type, or `()` for a virtual field.
//! Column rows: `{ index, field, type }`.
//!
//! `#[field(...)]` configures a struct field; `#[field(skip)]` excludes it from the field table.
//! `#[fields(derived_len(...), flag(...))]` adds virtual fields without separate storage.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{parse_macro_input, Data, DeriveInput, Ident, LitFloat, LitStr, Type};

struct Row {
    key: String,
    label: String,
    ty: TokenStream2,
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
            } else {
                return Err(meta.error("unknown #[field] key"));
            }
            Ok(())
        })?;
        if skip {
            continue;
        }
        let label = label.ok_or_else(|| syn::Error::new_spanned(attr, "#[field] needs a label"))?;

        rows.push(Row {
            key: camel(&ident.to_string()),
            label,
            ty: quote!(#ty),
            kind,
            cmp,
            interned,
            cat: format_ident!("{}", if date { "date" } else { "value" }),
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
            let mut bit: Option<Ident> = None;
            meta.parse_nested_meta(|inner| {
                if inner.path.is_ident("key") {
                    key = Some(inner.value()?.parse::<LitStr>()?.value());
                } else if inner.path.is_ident("label") {
                    label = Some(inner.value()?.parse::<LitStr>()?.value());
                } else if inner.path.is_ident("of") {
                    of = Some(inner.value()?.parse()?);
                } else if is_flag && inner.path.is_ident("bit") {
                    bit = Some(inner.value()?.parse()?);
                } else {
                    return Err(inner.error("unknown key"));
                }
                Ok(())
            })?;
            let (Some(key), Some(label), Some(of)) = (key, label, of) else {
                return Err(meta.error("needs key, label, and of"));
            };
            let field = match (is_flag, bit) {
                (true, Some(bit)) => bit,
                (true, None) => return Err(meta.error("a flag names its bit")),
                (false, _) => of.clone(),
            };
            rows.push(Row {
                key,
                label,
                ty: quote!(()),
                kind: if is_derived {
                    format_ident!("virtual_")
                } else {
                    format_ident!("writable")
                },
                cmp: quote!(none),
                interned: format_ident!("not_interned"),
                cat: format_ident!("{}", if is_derived { "len_of" } else { "flag" }),
                col: of,
                field,
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

/// Generate a struct's patch type and implement `Patchable`.
/// `key` fields are required; `skip` fields are excluded; `merge` fields update key by key,
/// and a non-optional nested value uses its own patch type.
/// `stamp` fields can be written but are ignored when comparing values.
/// A `unique` field's value names at most one row; `sequence` fields are numbered on insert.
/// Other fields are optional; `column` overrides their storage column name.
/// `merge` or `replace` on the struct patches it as one JSON value under that policy, and the
/// other one on a field overrides it there.
#[proc_macro_derive(Patch, attributes(patch, row, field))]
pub fn derive_patch(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand_patch(&input) {
        Ok(ts) => ts.into(),
        Err(e) => e.to_compile_error().into(),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Policy {
    Merge,
    Replace,
}

impl Policy {
    fn parse(path: &syn::Path) -> Option<Self> {
        if path.is_ident("merge") {
            Some(Policy::Merge)
        } else if path.is_ident("replace") {
            Some(Policy::Replace)
        } else {
            None
        }
    }
}

impl quote::ToTokens for Policy {
    fn to_tokens(&self, tokens: &mut TokenStream2) {
        tokens.extend(match self {
            Policy::Merge => quote!(::mma_algebra::Policy::Merge),
            Policy::Replace => quote!(::mma_algebra::Policy::Replace),
        });
    }
}

fn expand_patch(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let mut policy = None;
    for attr in input
        .attrs
        .iter()
        .filter(|attr| attr.path().is_ident("patch"))
    {
        attr.parse_nested_meta(|meta| {
            policy = Some(
                Policy::parse(&meta.path)
                    .ok_or_else(|| meta.error("expected merge or replace patch policy"))?,
            );
            Ok(())
        })?;
    }
    if let Some(policy) = policy {
        let Data::Struct(data) = &input.data else {
            return Err(syn::Error::new_spanned(input, "Patch derives on a struct"));
        };
        let ident = &input.ident;
        let mut overrides = Vec::new();
        for field in &data.fields {
            let mut child = None;
            for attr in field.attrs.iter().filter(|a| a.path().is_ident("patch")) {
                attr.parse_nested_meta(|meta| {
                    child = Some(Policy::parse(&meta.path).ok_or_else(|| {
                        meta.error(
                            "a whole-value patch policy accepts only merge or replace on a field",
                        )
                    })?);
                    Ok(())
                })?;
            }
            if let Some(child) = child {
                if child == policy {
                    return Err(syn::Error::new_spanned(
                        field,
                        "a field override restates the struct's own patch policy",
                    ));
                }
                if field.ident.is_none() || serde_flatten(field) {
                    return Err(syn::Error::new_spanned(
                        field,
                        "field overrides require a named, non-flattened JSON member",
                    ));
                }
                let name = patch_json_name(input, field)?;
                overrides.push(quote!((#name, #child)));
            }
        }
        let merges = policy == Policy::Merge;
        let mut generics = input.generics.clone();
        generics
            .make_where_clause()
            .predicates
            .push(syn::parse_quote!(Self: serde::Serialize + serde::de::DeserializeOwned));
        let (implementation, types, bounds) = generics.split_for_impl();
        return Ok(quote! {
            impl #implementation ::mma_algebra::Patchable for #ident #types #bounds {
                type Patch = ::mma_algebra::JsonWrite;
                fn patched(&self, patch: &Self::Patch) -> Self {
                    ::mma_algebra::json_patched(self, patch, #policy, &[#(#overrides),*])
                }
                fn between(old: &Self, new: &Self) -> Self::Patch {
                    ::mma_algebra::json_between(old, new, #policy, &[#(#overrides),*])
                }
                fn to_patch(&self) -> Self::Patch { ::mma_algebra::JsonWrite::Merge(serde_json::to_value(self).expect("patch target serializes")) }
                fn is_absent(&self) -> bool { #merges && ::mma_algebra::json_is_absent(self) }
            }
        });
    }
    let Data::Struct(data) = &input.data else {
        return Err(syn::Error::new_spanned(input, "Patch derives on a struct"));
    };
    let ident = &input.ident;
    let patch = format_ident!("{ident}Patch");
    let (mut slots, mut writes, mut reads) = (Vec::new(), Vec::new(), Vec::new());
    let (mut keys, mut skips, mut whole) = (Vec::new(), Vec::new(), Vec::new());
    let (mut columns, mut merged, mut same) = (Vec::new(), Vec::new(), Vec::new());
    let (mut clears, mut key_fields) = (Vec::new(), Vec::new());
    let (mut unique_field, mut sequences, mut fills) = (None, Vec::new(), Vec::new());
    let mut nested = Vec::new();
    for f in &data.fields {
        let name = f.ident.as_ref().ok_or_else(|| {
            syn::Error::new_spanned(
                f,
                "tuple structs declare #[patch(merge)] or #[patch(replace)]",
            )
        })?;
        let ty = &f.ty;
        let (mut key, mut skip, mut merge, mut stamp) = (false, false, false, false);
        let (mut unique, mut sequence) = (false, false);
        let mut column = name.to_string();
        for attr in f.attrs.iter().filter(|a| a.path().is_ident("patch")) {
            attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("key") {
                    key = true;
                } else if meta.path.is_ident("skip") {
                    skip = true;
                } else if meta.path.is_ident("merge") {
                    merge = true;
                } else if meta.path.is_ident("replace") {
                    return Err(meta.error("a field is replaced unless it declares merge"));
                } else if meta.path.is_ident("stamp") {
                    stamp = true;
                } else if meta.path.is_ident("unique") {
                    unique = true;
                } else if meta.path.is_ident("sequence") {
                    sequence = true;
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
            key_fields.push((name, ty));
            slots.push(quote! { pub #name: #ty, });
            reads.push(quote! { #name: new.#name.clone(), });
            whole.push(quote! { #name: self.#name.clone(), });
            same.push(quote! { old.#name == new.#name });
            continue;
        }
        if skip {
            skips.push(wire);
            continue;
        }
        let codec = f.attrs.iter().filter(|attr| attr.path().is_ident("serde"));
        columns.push(quote! { (#key_name, #column), });
        if (unique || sequence) && option_inner(ty).is_none() {
            return Err(syn::Error::new_spanned(
                f,
                "unique and sequence fields are optional",
            ));
        }
        if unique && unique_field.replace(name).is_some() {
            return Err(syn::Error::new_spanned(
                f,
                "a row has at most one unique field",
            ));
        }
        if sequence {
            sequences.push(name);
        }
        let flatten = serde_flatten(f);
        let Some(inner) = option_inner(ty) else {
            if merge {
                let skip = (!flatten).then(|| {
                    quote! { #[serde(default, skip_serializing_if = "::mma_algebra::is_default")] }
                });
                slots.push(quote! {
                    #(#codec)*
                    #skip
                    pub #name: ::mma_algebra::Patch<#ty>,
                });
                whole.push(quote! { #name: ::mma_algebra::Patchable::to_patch(&self.#name), });
                fills.push(quote! { out.#name = ::mma_algebra::Patchable::patched(&from.#name, &::mma_algebra::Patchable::to_patch(&out.#name)); });
                writes.push(quote! { out.#name = ::mma_algebra::Patchable::patched(&out.#name, &patch.#name); });
                reads.push(
                    quote! { #name: ::mma_algebra::Patchable::between(&old.#name, &new.#name), },
                );
                same.push(quote! { old.#name == new.#name });
                nested.push((key_name, ty, flatten));
                continue;
            }
            slots.push(quote! {
                #(#codec)*
                #[serde(default, skip_serializing_if = "Option::is_none")] pub #name: Option<#ty>,
            });
            whole.push(quote! { #name: Some(self.#name.clone()), });
            writes.push(quote! { if let Some(v) = &patch.#name { out.#name = v.clone(); } });
            let change = quote! { (old.#name != new.#name).then(|| new.#name.clone()) };
            if stamp {
                reads.push(quote! { #name: None, });
            } else {
                same.push(quote! { (#change).is_none() });
                reads.push(quote! { #name: #change, });
            }
            continue;
        };
        let slot = if merge {
            quote!(::mma_algebra::Patch<#ty>)
        } else {
            quote!(::mma_algebra::Field<#inner>)
        };
        slots.push(quote! {
            #(#codec)*
            #[serde(default, skip_serializing_if = "::mma_algebra::Field::is_keep")]
            pub #name: #slot,
        });
        whole.push(if merge {
            quote!(#name: ::mma_algebra::Patchable::to_patch(&self.#name),)
        } else {
            quote!(#name: ::mma_algebra::Field::from(self.#name.clone()),)
        });
        fills.push(if merge {
            quote! {
                if out.#name.is_some() {
                    out.#name = ::mma_algebra::Patchable::patched(&from.#name, &::mma_algebra::Patchable::to_patch(&out.#name));
                } else {
                    out.#name = from.#name.clone();
                }
            }
        } else {
            quote! { if out.#name.is_none() { out.#name = from.#name.clone(); } }
        });
        let change = if merge {
            merged.push(key_name);
            writes.push(quote! { if !patch.#name.is_keep() { out.#name = ::mma_algebra::Patchable::patched(&out.#name, &patch.#name); } });
            quote! { ::mma_algebra::Patchable::between(&old.#name, &new.#name) }
        } else {
            if !stamp {
                clears.push(key_name);
            }
            writes.push(quote! { if !patch.#name.is_keep() { out.#name = patch.#name.applied(&out.#name); } });
            quote! { ::mma_algebra::Field::between(&old.#name, &new.#name) }
        };
        if stamp {
            reads.push(quote! { #name: ::mma_algebra::Field::Keep, });
        } else {
            same.push(if merge {
                quote!(old.#name == new.#name)
            } else {
                quote!((#change).is_keep())
            });
            reads.push(quote! { #name: #change, });
        }
    }
    let ident_name = ident.to_string();
    let pick = (!keys.is_empty()).then(|| format!(" & Pick<{ident}, {}>", keys.join(" | ")));
    let pick = pick.unwrap_or_default();
    let nested_wire = nested.iter().map(|(key, ty, flatten)| {
        quote! {
            let value = <<#ty as ::mma_algebra::Wire>::Value as specta::Type>::definition(types);
            let patch = <<#ty as ::mma_algebra::Wire>::Patch as specta::Type>::definition(types);
            if patch != value {
                let ts = ::specta_typescript::Typescript::default();
                let child = ::specta_typescript::primitives::inline(&ts, types, &patch)
                    .expect("nested patch types are inlineable");
                if #flatten {
                    let value = ::specta_typescript::primitives::render(&ts, types, &value)
                        .expect("flattened patch values are renderable");
                    hidden.push(format!("keyof {value}"));
                    parts.push(format!("({child})"));
                } else {
                    hidden.push(format!("\"{}\"", #key));
                    parts.push(format!("{{ {}?: {child} }}", #key));
                }
            }
        }
    });
    let serde = input.attrs.iter().filter(|a| a.path().is_ident("serde"));
    let row = expand_row(input)?;
    let keyed = match key_fields.as_slice() {
        [(name, ty)] => quote! {
            impl ::mma_algebra::Keyed for #ident {
                type Key = #ty;
                fn key(&self) -> #ty {
                    self.#name.clone()
                }
            }

            impl ::mma_algebra::Keyed for #patch {
                type Key = #ty;
                fn key(&self) -> #ty {
                    self.#name.clone()
                }
            }
        },
        _ => quote!(),
    };
    let constrained = match (&unique_field, key_fields.as_slice()) {
        (None, _) if sequences.is_empty() => quote!(),
        (_, [(key, key_ty)]) => {
            let unique = match unique_field {
                Some(field) => quote! {
                    self.#field.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_lowercase)
                },
                None => quote!(None),
            };
            quote! {
                impl ::mma_algebra::Constrained for #ident {
                    fn unique(&self) -> Option<String> {
                        #unique
                    }

                    fn sequence<'a>(&mut self, rows: impl Iterator<Item = &'a Self> + Clone)
                    where
                        Self: 'a,
                    {
                        #(
                            if self.#sequences.is_none() {
                                self.#sequences = Some(
                                    rows.clone().filter_map(|row| row.#sequences).max().map_or(1, |max| max + 1),
                                );
                            }
                        )*
                    }

                    fn filled(&self, from: &Self) -> Self {
                        let mut out = self.clone();
                        #(#fills)*
                        out
                    }

                    fn set_key(&mut self, key: #key_ty) {
                        self.#key = key;
                    }
                }
            }
        }
        _ => {
            return Err(syn::Error::new_spanned(
                input,
                "unique and sequence fields need a single key",
            ))
        }
    };
    Ok(quote! {
        #row
        #keyed
        #constrained
        /// A change to some of one value's fields: an absent field is unchanged.
        #[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
        #(#serde)*
        pub struct #patch { #(#slots)* }

        impl PartialEq for #ident {
            fn eq(&self, other: &Self) -> bool {
                let (old, new) = (self, other);
                true #(&& #same)*
            }
        }

        impl specta::Type for #patch {
            fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
                let mut hidden: Vec<String> = vec![#(#skips.to_string()),*];
                let mut parts: Vec<String> = Vec::new();
                #(#nested_wire)*
                let mut wire = if hidden.is_empty() {
                    format!("Partial<{}>", #ident_name)
                } else {
                    format!("Partial<Omit<{}, {}>>", #ident_name, hidden.join(" | "))
                };
                wire.push_str(#pick);
                for part in parts {
                    wire = format!("{wire} & {part}");
                }
                specta::datatype::DataType::Reference(specta_typescript::define(wire))
            }
        }

        impl ::mma_algebra::Wire for #ident {
            type Value = Self;
            type Patch = #patch;
        }

        impl ::mma_algebra::Patchable for #ident {
            type Patch = #patch;
            const WRITES: &'static [(&'static str, &'static str)] = &[#(#columns)*];
            const MERGED: &'static [&'static str] = &[#(#merged),*];
            const CLEARS: &'static [&'static str] = &[#(#clears),*];

            fn patched(&self, patch: &#patch) -> Self {
                let mut out = self.clone();
                #(#writes)*
                out
            }

            fn between(old: &Self, new: &Self) -> #patch {
                #patch { #(#reads)* }
            }

            fn to_patch(&self) -> #patch {
                #patch { #(#whole)* }
            }
        }
    })
}

fn patch_json_name(input: &DeriveInput, field: &syn::Field) -> syn::Result<String> {
    fn setting(attrs: &[syn::Attribute], key: &str) -> syn::Result<Option<String>> {
        for attr in attrs.iter().filter(|a| a.path().is_ident("serde")) {
            let items = attr.parse_args_with(
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
            )?;
            for item in items {
                if let syn::Meta::NameValue(value) = item {
                    if value.path.is_ident(key) {
                        if let syn::Expr::Lit(syn::ExprLit {
                            lit: syn::Lit::Str(value),
                            ..
                        }) = value.value
                        {
                            return Ok(Some(value.value()));
                        }
                    }
                }
            }
        }
        Ok(None)
    }
    if let Some(name) = setting(&field.attrs, "rename")? {
        return Ok(name);
    }
    let name = field
        .ident
        .as_ref()
        .unwrap()
        .to_string()
        .trim_start_matches("r#")
        .to_owned();
    Ok(match setting(&input.attrs, "rename_all")?.as_deref() {
        None | Some("snake_case") | Some("lowercase") => name,
        Some("camelCase") => camel(&name),
        Some("PascalCase") => {
            let mut c = camel(&name).chars().collect::<Vec<_>>();
            if let Some(first) = c.first_mut() {
                first.make_ascii_uppercase();
            }
            c.into_iter().collect()
        }
        Some("UPPERCASE") | Some("SCREAMING_SNAKE_CASE") => name.to_uppercase(),
        Some("kebab-case") => name.replace('_', "-"),
        Some("SCREAMING-KEBAB-CASE") => name.replace('_', "-").to_uppercase(),
        _ => {
            return Err(syn::Error::new_spanned(
                field,
                "unsupported serde rename_all",
            ))
        }
    })
}

fn serde_flatten(field: &syn::Field) -> bool {
    field
        .attrs
        .iter()
        .filter(|attr| attr.path().is_ident("serde"))
        .any(|attr| {
            attr.parse_args_with(
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
            )
            .is_ok_and(|items| {
                items
                    .iter()
                    .any(|item| matches!(item, syn::Meta::Path(path) if path.is_ident("flatten")))
            })
        })
}

fn option_inner(ty: &Type) -> Option<&Type> {
    let Type::Path(path) = ty else {
        return None;
    };
    let last = path.path.segments.last()?;
    let syn::PathArguments::AngleBracketed(args) = &last.arguments else {
        return None;
    };
    match args.args.first()? {
        syn::GenericArgument::Type(inner) if last.ident == "Option" => Some(inner),
        _ => None,
    }
}

fn expand_row(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let Some(attr) = input.attrs.iter().find(|attr| attr.path().is_ident("row")) else {
        return Ok(quote!());
    };
    let mut table = None;
    attr.parse_nested_meta(|meta| {
        if meta.path.is_ident("table") {
            table = Some(meta.value()?.parse::<LitStr>()?);
            Ok(())
        } else {
            Err(meta.error("expected table"))
        }
    })?;
    let table = table.ok_or_else(|| syn::Error::new_spanned(attr, "row requires table"))?;
    let ident = &input.ident;
    let Data::Struct(data) = &input.data else {
        unreachable!()
    };
    let mut reads = Vec::new();
    let mut columns = Vec::new();
    let mut names = Vec::new();
    for field in &data.fields {
        let name = field.ident.as_ref().expect("named row fields");
        let ty = &field.ty;
        let (mut json, mut codec, mut decode, mut default) = (false, None, None, None);
        let mut flattened: Vec<(Ident, LitStr)> = Vec::new();
        for attr in field
            .attrs
            .iter()
            .filter(|attr| attr.path().is_ident("field"))
        {
            attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("json") {
                    json = true;
                } else if meta.path.is_ident("codec") {
                    codec = Some(meta.value()?.parse::<LitStr>()?.parse::<syn::Path>()?);
                } else if meta.path.is_ident("decode") {
                    decode = Some(meta.value()?.parse::<LitStr>()?.parse::<syn::Path>()?);
                } else if meta.path.is_ident("default") {
                    default = Some(meta.value()?.parse::<LitStr>()?);
                } else if meta.path.is_ident("flatten") {
                    meta.parse_nested_meta(|part| {
                        let name = part
                            .path
                            .get_ident()
                            .ok_or_else(|| part.error("expected member name"))?
                            .clone();
                        flattened.push((name, part.value()?.parse::<LitStr>()?));
                        Ok(())
                    })?;
                } else {
                    return Err(meta.error("unknown row field option"));
                }
                Ok(())
            })?;
        }
        let default = default.map_or_else(|| quote!(None), |value| quote!(Some(#value)));
        let mut key = false;
        let mut column = name.to_string();
        for attr in field
            .attrs
            .iter()
            .filter(|attr| attr.path().is_ident("patch"))
        {
            attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("key") {
                    key = true;
                } else if meta.path.is_ident("column") {
                    column = meta.value()?.parse::<LitStr>()?.value();
                }
                Ok(())
            })?;
        }
        if !flattened.is_empty() {
            let mut members = Vec::new();
            for (member, column) in flattened {
                names.push(column.value());
                members.push(quote!(#member: row.get(#column)?));
                columns.push(quote!(crate::store::storage::sql_column(#column, |value: &Self| &value.#name.#member, false, #default)));
            }
            reads.push(quote!(#name: #ty { #(#members,)* }));
            continue;
        }
        names.push(column.clone());
        let read = if let Some(codec) = codec {
            quote!(#codec(row, #column)?)
        } else if let Some(decode) = decode {
            quote!(#decode(&row.get::<_, String>(#column)?))
        } else if json {
            quote!(crate::store::storage::json_col(row, #column)?)
        } else {
            quote!(row.get(#column)?)
        };
        reads.push(quote!(#name: #read));
        columns.push(if json {
            quote!(crate::store::storage::Column { name: #column, sql_type: "TEXT", nullable: false, primary_key: #key, default: #default })
        } else {
            quote!(crate::store::storage::sql_column(#column, |value: &Self| &value.#name, #key, #default))
        });
    }
    let select = names.join(", ");
    Ok(quote! {
        impl #ident {
            pub(crate) const TABLE: &'static str = #table;
            pub(crate) const COLUMNS: &'static [crate::store::storage::Column] = &[#(#columns,)*];
            pub(crate) const SELECT: &'static str = #select;
            pub(crate) fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
                Ok(Self { #(#reads,)* })
            }
        }
    })
}

#[proc_macro_derive(Delta)]
pub fn derive_delta(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let Data::Struct(data) = &input.data else {
        return syn::Error::new_spanned(&input, "Delta derives on a named struct")
            .to_compile_error()
            .into();
    };
    let syn::Fields::Named(fields) = &data.fields else {
        return syn::Error::new_spanned(&input, "Delta requires named fields")
            .to_compile_error()
            .into();
    };
    let name = &input.ident;
    let visibility = &input.vis;
    let key = format_ident!("{}Key", name);
    let variants: Vec<_> = fields
        .named
        .iter()
        .map(|field| {
            let field = camel(&field.ident.as_ref().unwrap().to_string().replace("r#", ""));
            let mut chars = field.chars();
            format_ident!(
                "{}{}",
                chars.next().unwrap().to_uppercase().to_string(),
                chars.as_str()
            )
        })
        .collect();
    let docs: Vec<_> = fields
        .named
        .iter()
        .map(|field| {
            let docs: Vec<_> = field
                .attrs
                .iter()
                .filter(|attr| attr.path().is_ident("doc"))
                .collect();
            if docs.is_empty() {
                let doc = format!(
                    "Changes to {}.",
                    field.ident.as_ref().unwrap().to_string().replace('_', " ")
                );
                quote!(#[doc = #doc])
            } else {
                quote!(#(#docs)*)
            }
        })
        .collect();
    let mut generics = input.generics.clone();
    for field in &fields.named {
        let ty = &field.ty;
        generics
            .make_where_clause()
            .predicates
            .push(syn::parse_quote!(#ty: mma_algebra::Delta));
    }
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
    let names: Vec<_> = fields
        .named
        .iter()
        .map(|field| field.ident.as_ref().unwrap())
        .collect();
    let count = names.len();
    quote! {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, specta::Type)]
        #[serde(rename_all = "camelCase")]
        #visibility enum #key {
            #(#docs #variants),*
        }

        impl #impl_generics #name #ty_generics #where_clause {
            #visibility fn keys(&self) -> impl Iterator<Item = #key> + '_ {
                let fields: [(#key, bool); #count] = [#((#key::#variants, mma_algebra::Delta::is_empty(&self.#names))),*];
                fields.into_iter().filter_map(|(key, empty)| (!empty).then_some(key))
            }
        }

        impl #impl_generics mma_algebra::Delta for #name #ty_generics #where_clause {
            fn inverse(&self) -> Self {
                Self { #(#names: mma_algebra::Delta::inverse(&self.#names)),* }
            }
            fn meets(&self, later: &Self) -> bool {
                true #(&& mma_algebra::Delta::meets(&self.#names, &later.#names))*
            }
            fn compose(self, later: Self) -> Self {
                Self { #(#names: mma_algebra::Delta::compose(self.#names, later.#names)),* }
            }
            fn is_empty(&self) -> bool {
                true #(&& mma_algebra::Delta::is_empty(&self.#names))*
            }
        }
    }
    .into()
}

#[proc_macro_derive(Children, attributes(children))]
pub fn derive_children(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand_children(&input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

fn expand_children(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let Data::Enum(data) = &input.data else {
        return Err(syn::Error::new_spanned(
            input,
            "Children derives on an enum",
        ));
    };
    let name = &input.ident;
    let child = input
        .generics
        .type_params()
        .next()
        .ok_or_else(|| syn::Error::new_spanned(input, "Children needs a child type parameter"))?
        .ident
        .clone();
    let mut refs = Vec::new();
    let mut maps = Vec::new();
    let mut replacements = Vec::new();
    let mut ref_maps = Vec::new();
    let mut ref_replacements = Vec::new();
    for variant in &data.variants {
        let v = &variant.ident;
        if matches!(variant.fields, syn::Fields::Unit) {
            refs.push(quote!(Self::#v => Vec::new()));
            maps.push(quote!(Self::#v => #name::#v));
            replacements.push(quote!(Self::#v => Self::#v));
            ref_maps.push(quote!(Self::#v => #name::#v));
            ref_replacements.push(quote!(Self::#v => #name::#v));
            continue;
        }
        let syn::Fields::Named(fields) = &variant.fields else {
            return Err(syn::Error::new_spanned(
                variant,
                "Children needs named variants",
            ));
        };
        let names: Vec<_> = fields
            .named
            .iter()
            .map(|f| f.ident.as_ref().unwrap())
            .collect();
        let recursive: Vec<_> = fields
            .named
            .iter()
            .filter(|f| f.attrs.iter().any(|a| a.path().is_ident("children")))
            .collect();
        if recursive.len() > 1 {
            return Err(syn::Error::new_spanned(
                variant,
                "one child container per variant",
            ));
        }
        let mut mapped = Vec::new();
        let mut replaced = Vec::new();
        let mut ref_mapped = Vec::new();
        let mut ref_replaced = Vec::new();
        let mut borrowed = quote!(Vec::new());
        for field in &fields.named {
            let f = field.ident.as_ref().unwrap();
            if !field.attrs.iter().any(|a| a.path().is_ident("children")) {
                mapped.push(quote!(#f));
                replaced.push(quote!(#f));
                ref_mapped.push(quote!(#f: #f.clone()));
                ref_replaced.push(quote!(#f: #f.clone()));
                continue;
            }
            let ty = type_name(&field.ty);
            if ty == format!("Vec<{child}>") {
                borrowed = quote!(#f.iter().collect());
                mapped.push(quote!(#f: #f.into_iter().map(&mut map).collect()));
                replaced.push(quote!(#f: children.collect()));
                ref_mapped.push(quote!(#f: #f.iter().map(&mut map).collect()));
                ref_replaced.push(quote!(#f: children.collect()));
            } else if ty == format!("Option<Box<{child}>>") {
                borrowed = quote!(#f.as_deref().into_iter().collect());
                mapped.push(quote!(#f: #f.map(|child| Box::new(map(*child)))));
                replaced.push(quote!(#f: children.next().map(Box::new)));
                ref_mapped.push(quote!(#f: #f.as_deref().map(|child| Box::new(map(child)))));
                ref_replaced.push(quote!(#f: children.next().map(Box::new)));
            } else {
                return Err(syn::Error::new_spanned(
                    field,
                    "children must be Vec<S> or Option<Box<S>>",
                ));
            }
        }
        let container = recursive.first().map(|f| f.ident.as_ref().unwrap());
        refs.push(match container {
            Some(f) => quote!(Self::#v { #f, .. } => #borrowed),
            None => quote!(Self::#v { .. } => Vec::new()),
        });
        maps.push(quote!(Self::#v { #(#names),* } => #name::#v { #(#mapped),* }));
        ref_maps.push(quote!(Self::#v { #(#names),* } => #name::#v { #(#ref_mapped),* }));
        let pattern: Vec<_> = names
            .iter()
            .map(|name| {
                if container.is_some_and(|child| child == *name) {
                    quote!(#name: _)
                } else {
                    quote!(#name)
                }
            })
            .collect();
        ref_replacements
            .push(quote!(Self::#v { #(#pattern),* } => #name::#v { #(#ref_replaced),* }));
        replacements.push(quote!(Self::#v { #(#pattern),* } => Self::#v { #(#replaced),* }));
    }
    Ok(quote! {
        impl<#child> #name<#child> {
            pub fn children(&self) -> Vec<&#child> {
                match self { #(#refs),* }
            }
            pub fn map_children<T>(self, mut map: impl FnMut(#child) -> T) -> #name<T> {
                match self { #(#maps),* }
            }
            pub fn map_children_ref<T>(&self, mut map: impl FnMut(&#child) -> T) -> #name<T> {
                match self { #(#ref_maps),* }
            }
            pub fn with_children_ref<T>(&self, children: Vec<T>) -> #name<T> {
                let mut children = children.into_iter();
                match self { #(#ref_replacements),* }
            }
            pub fn with_children(self, children: Vec<#child>) -> Self {
                let mut children = children.into_iter();
                match self { #(#replacements),* }
            }
        }
    })
}

#[cfg(test)]
#[path = "lib.test.rs"]
mod tests;
