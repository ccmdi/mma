use super::{
    append_update_file, downloaded_country_codes, encode_key, outdated, MetadataFile, NetDateTime,
    R2Object,
};

fn time(s: &str) -> NetDateTime {
    NetDateTime::parse(s).expect("valid timestamp")
}

fn remote(key: &str, uploaded: &str) -> R2Object {
    R2Object {
        key: key.to_string(),
        uploaded: time(uploaded),
        size: Some(10),
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn local(name: &str, written: &str) -> MetadataFile {
    MetadataFile {
        name: name.to_string(),
        last_write_time_utc: time(written),
    }
}

#[test]
fn a_missing_local_file_is_outdated() {
    let remote = vec![remote("FR/paris.bin", "2026-01-01T00:00:00Z")];
    assert_eq!(outdated(&remote, &[]).len(), 1);
}

#[test]
fn a_newer_upload_is_outdated_and_an_older_one_is_not() {
    let r = vec![remote("FR/paris.bin", "2026-02-01T00:00:00Z")];
    assert!(outdated(&r, &[local("paris", "2026-01-01T00:00:00Z")]).len() == 1);
    assert!(outdated(&r, &[local("paris", "2026-03-01T00:00:00Z")]).is_empty());
}

#[test]
fn an_identical_timestamp_is_not_outdated() {
    let r = vec![remote("FR/paris.bin", "2026-02-01T00:00:00Z")];
    assert!(outdated(&r, &[local("paris", "2026-02-01T00:00:00Z")]).is_empty());
}

#[test]
fn sub_second_ticks_decide_freshness() {
    let r = vec![remote("FR/paris.bin", "2026-02-01T00:00:00.0000002Z")];
    assert_eq!(
        outdated(&r, &[local("paris", "2026-02-01T00:00:00.0000001Z")]).len(),
        1
    );
    assert!(outdated(&r, &[local("paris", "2026-02-01T00:00:00.0000003Z")]).is_empty());
}

#[test]
fn matching_ignores_the_key_prefix_and_one_extension() {
    // Local metadata records the key stem, which is what `download_file` names the file after.
    let r = vec![remote("FR/paris.bin", "2026-01-01T00:00:00Z")];
    assert!(outdated(&r, &[local("paris", "2026-06-01T00:00:00Z")]).is_empty());
    assert!(outdated(&r, &[local("paris.bin", "2026-06-01T00:00:00Z")]).is_empty());
    assert_eq!(
        outdated(&r, &[local("lyon", "2026-06-01T00:00:00Z")]).len(),
        1
    );
}

#[test]
fn keys_with_spaces_and_accents_become_valid_uris() {
    assert_eq!(
        encode_key("AU/AU+Jervis Bay Territory.zip"),
        "AU/AU+Jervis%20Bay%20Territory.zip"
    );
    assert_eq!(
        encode_key("FR/FR+Île-de-France.zip"),
        "FR/FR+%C3%8Ele-de-France.zip"
    );
}

#[test]
fn encoding_leaves_ordinary_keys_untouched() {
    // Every key that worked before must still produce the byte-identical URL.
    for key in [
        "FR/FR+Paris.bin",
        "US/US+New_York.zip",
        "GB/2026-01-01-GB+Wales.bin",
        "JP/JP+Tokyo(1).zip",
    ] {
        assert_eq!(encode_key(key), key);
    }
}

/// Deltas are fetched concurrently but must land in listing order, since several can target
/// the same data file.
#[test]
fn updates_append_to_their_data_file_in_listing_order() {
    let country = temp_dir("vali-append");
    std::fs::create_dir_all(country.join("updates")).unwrap();
    std::fs::write(country.join("paris.bin"), b"base").unwrap();
    std::fs::write(
        country.join("updates").join("2026-01-01-paris.bin"),
        b"-jan",
    )
    .unwrap();
    std::fs::write(
        country.join("updates").join("2026-02-01-paris.bin"),
        b"-feb",
    )
    .unwrap();

    for key in ["FR/2026-01-01-paris.bin", "FR/2026-02-01-paris.bin"] {
        append_update_file(&country, &remote(key, "2026-03-01T00:00:00Z")).unwrap();
    }

    let out = std::fs::read(country.join("paris.bin")).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "base-jan-feb");
    let _ = std::fs::remove_dir_all(&country);
}

#[test]
fn an_update_with_no_existing_data_file_creates_one() {
    let country = temp_dir("vali-append-new");
    std::fs::create_dir_all(country.join("updates")).unwrap();
    std::fs::write(
        country.join("updates").join("2026-01-01-lyon.bin"),
        b"delta",
    )
    .unwrap();

    append_update_file(
        &country,
        &remote("FR/2026-01-01-lyon.bin", "2026-03-01T00:00:00Z"),
    )
    .unwrap();

    assert_eq!(std::fs::read(country.join("lyon.bin")).unwrap(), b"delta");
    let _ = std::fs::remove_dir_all(&country);
}

#[test]
fn only_countries_holding_data_files_are_scanned() {
    let dir = temp_dir("vali-stale");
    std::fs::create_dir_all(dir.join("FR")).unwrap();
    std::fs::create_dir_all(dir.join("DE")).unwrap();
    std::fs::create_dir_all(dir.join("not-a-country")).unwrap();
    std::fs::write(dir.join("FR").join("paris.bin"), b"x").unwrap();
    std::fs::write(dir.join("DE").join("downloads.json"), b"{}").unwrap();
    std::fs::write(dir.join("not-a-country").join("x.bin"), b"x").unwrap();

    // DE has metadata but no data file; the stray folder is not in Vali's country list.
    assert_eq!(downloaded_country_codes(&dir), vec!["FR".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn interrupted_update_application_records_the_applied_deltas() {
    use super::{apply_update_files, existing_files_in_metadata};
    let country = temp_dir("vali-apply-partial");
    std::fs::create_dir_all(country.join("updates")).unwrap();
    std::fs::write(country.join("paris.bin"), b"base").unwrap();
    // Only the first delta was actually fetched; applying the second fails mid-loop.
    std::fs::write(
        country.join("updates").join("2026-01-01-paris.bin"),
        b"-jan",
    )
    .unwrap();

    let jan = remote("FR/2026-01-01-paris.bin", "2026-03-01T00:00:00Z");
    let feb = remote("FR/2026-02-01-paris.bin", "2026-03-01T00:00:00Z");
    assert!(apply_update_files(&country, &[&jan, &feb]).is_err());

    // The applied delta is recorded, so the next run cannot re-append its bytes.
    let recorded = existing_files_in_metadata(&country);
    assert!(recorded.iter().any(|f| f.name == "2026-01-01-paris"));
    assert!(!recorded.iter().any(|f| f.name == "2026-02-01-paris"));
    assert_eq!(
        std::fs::read(country.join("paris.bin")).unwrap(),
        b"base-jan"
    );
    let _ = std::fs::remove_dir_all(&country);
}
