use super::*;

fn patch_error(input: DeriveInput) -> String {
    expand_patch(&input)
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default()
}

#[test]
fn a_field_declaring_replace_is_an_error_because_fields_replace_unless_they_merge() {
    assert_eq!(
        patch_error(syn::parse_quote! {
            struct Row {
                #[patch(replace)]
                extra: Option<serde_json::Value>,
            }
        }),
        "a field is replaced unless it declares merge"
    );
    assert!(expand_patch(&syn::parse_quote! {
        struct Row {
            #[patch(merge)]
            extra: Option<serde_json::Value>,
        }
    })
    .is_ok());
}

#[test]
fn a_field_override_restating_the_struct_policy_is_an_error() {
    for policy in [quote!(merge), quote!(replace)] {
        assert_eq!(
            patch_error(syn::parse_quote! {
                #[patch(#policy)]
                struct Document {
                    #[patch(#policy)]
                    child: serde_json::Value,
                }
            }),
            "a field override restates the struct's own patch policy"
        );
    }
    assert!(expand_patch(&syn::parse_quote! {
        #[patch(merge)]
        struct Document {
            #[patch(replace)]
            child: serde_json::Value,
        }
    })
    .is_ok());
}

fn fields_error(input: DeriveInput) -> String {
    expand(&input)
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default()
}

#[test]
fn a_virtual_field_names_its_column_with_of_and_a_flag_names_its_bit() {
    assert!(expand(&syn::parse_quote! {
        #[fields(
            derived_len(key = "tagCount", label = "Tag count", of = tags),
            flag(key = "pinned", label = "Pinned", of = flags, bit = PINNED)
        )]
        struct Row {
            #[field(skip)]
            tags: Vec<u32>,
            #[field(skip)]
            flags: u32,
        }
    })
    .is_ok());
    assert_eq!(
        fields_error(syn::parse_quote! {
            #[fields(flag(key = "pinned", label = "Pinned", of = flags))]
            struct Row {}
        }),
        "a flag names its bit"
    );
    assert_eq!(
        fields_error(syn::parse_quote! {
            #[fields(derived_len(key = "tagCount", label = "Tag count", of = tags, bit = X))]
            struct Row {}
        }),
        "unknown key"
    );
}
