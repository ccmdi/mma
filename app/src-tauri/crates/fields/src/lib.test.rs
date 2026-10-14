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
