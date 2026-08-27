use super::*;
use crate::util;
use std::env;

#[test]
fn scrub_redacts_the_windows_home_directory() {
    assert_eq!(
        scrub(r"C:\Users\someone\AppData\Local\mma.log"),
        r"C:\Users\<user>\AppData\Local\mma.log"
    );
}

#[test]
fn scrub_redacts_unix_and_macos_homes() {
    assert_eq!(
        scrub("/home/someone/.config/mma"),
        "/home/<user>/.config/mma"
    );
    assert_eq!(
        scrub("/Users/Someone/Library/mma"),
        "/Users/<user>/Library/mma"
    );
}

#[test]
fn scrub_handles_repeats_and_mixed_separators_in_one_line() {
    assert_eq!(
        scrub(r"copy /home/someone/a.json -> C:\users\someone\b.json"),
        r"copy /home/<user>/a.json -> C:\users\<user>\b.json"
    );
}

#[test]
fn scrub_leaves_unrelated_text_alone() {
    // "users" not at a path boundary, and a bare directory with no name after it.
    for s in [
        "browsers/chrome",
        "the users table",
        "SELECT * FROM users",
        "/home/",
    ] {
        assert_eq!(scrub(s), s, "{s} should be untouched");
    }
}

#[test]
fn scrub_preserves_multibyte_text() {
    let s = "地図 /home/someone/日本.json";
    assert_eq!(scrub(s), "地図 /home/<user>/日本.json");
}

#[test]
fn scrub_survives_text_whose_lowercase_changes_length() {
    // 'İ' (U+0130) lowercases to two chars, so a lowercased copy of the string is longer
    // than the original and byte offsets into it are shifted.
    assert_eq!(
        scrub(r"map İstanbul saved to C:\Users\someone\maps"),
        r"map İstanbul saved to C:\Users\<user>\maps"
    );
}

#[test]
fn solved_nonce_satisfies_the_difficulty() {
    // Low difficulty so the test stays fast; the predicate is what is under test, not the cost.
    let challenge = util::sha256_hex(b"a report body");
    let nonce = solve_pow(&challenge, 12);
    assert!(verify_pow(&challenge, nonce, 12));
}

#[test]
fn a_nonce_is_bound_to_its_own_challenge() {
    let a = util::sha256_hex(b"report a");
    let b = util::sha256_hex(b"report b");
    let nonce = solve_pow(&a, 12);
    // Replaying a solved nonce against different body text must not pass, or the work could be
    // solved once and reused for unlimited submissions.
    assert!(!verify_pow(&b, nonce, 12));
}

#[test]
fn verify_rejects_insufficient_work() {
    let challenge = util::sha256_hex(b"x");
    let nonce = solve_pow(&challenge, 8);
    assert!(verify_pow(&challenge, nonce, 8));
    // The first nonce meeting 8 bits is overwhelmingly unlikely to meet 24.
    assert!(!verify_pow(&challenge, nonce, 24));
}

#[test]
fn leading_zero_bits_counts_across_bytes() {
    assert_eq!(leading_zero_bits(&[0xff; 32]), 0);
    let mut d = [0u8; 32];
    d[1] = 0b0001_0000;
    assert_eq!(leading_zero_bits(&d), 11);
    assert_eq!(leading_zero_bits(&[0u8; 32]), 256);
}

#[test]
fn image_sniffing_ignores_what_the_file_is_called() {
    // The name reaches the issue as alt text, but never decides whether bytes are an image.
    assert!(is_image(&[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0
    ]));
    assert!(is_image(&[0xff, 0xd8, 0xff, 0xe0]));
    assert!(is_image(b"GIF89a...."));
    assert!(is_image(b"RIFF\0\0\0\0WEBPVP8 "));
    assert!(!is_image(b"RIFF\0\0\0\0WAVEfmt "));
    assert!(!is_image(b"<html>hi</html>"));
    assert!(!is_image(b""));
}

#[test]
fn attachment_uploads_only_accept_staged_files() {
    use std::path::Path;
    assert!(!is_staged_upload(Path::new(
        "C:/Users/x/Pictures/photo.png"
    )));
    assert!(!is_staged_upload(Path::new("/etc/passwd")));
    let outside = env::temp_dir().join("not_a_session").join("a.png");
    assert!(!is_staged_upload(&outside));
    let staged = env::temp_dir().join("mma_upload_1_1").join("a.png");
    assert!(is_staged_upload(&staged));
}
