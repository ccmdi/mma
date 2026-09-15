// Data lives in resources/tables/names.json; see tables.rs.

use crate::tables::tables;

pub fn country_names() -> &'static [(&'static str, &'static str)] {
    tables().countries
}
pub fn country_name(code: &str) -> &'static str {
    tables().country_name(code)
}
pub fn subdivision_name(country_code: &str, subdivision_code: &str) -> Option<&'static str> {
    tables().subdivision_name(country_code, subdivision_code)
}
