use super::*;

#[test]
fn tz_offset_fixed_and_dst() {
    // 2020-03-01 00:00 UTC. Tokyo is +9h year-round; New York is EST (-5h) in winter.
    let winter = 1583020800.0;
    assert_eq!(tz_offset_seconds("Asia/Tokyo", winter), Some(9 * 3600));
    assert_eq!(
        tz_offset_seconds("America/New_York", winter),
        Some(-5 * 3600)
    );
    // 2020-07-01 00:00 UTC: New York is EDT (-4h) under daylight saving.
    let summer = 1593561600.0;
    assert_eq!(
        tz_offset_seconds("America/New_York", summer),
        Some(-4 * 3600)
    );
    assert_eq!(tz_offset_seconds("Not/AZone", winter), None);
}

#[test]
fn hsl_primaries() {
    assert_eq!(Rgb::hsl(0.0, 1.0, 0.5), Rgb([255, 0, 0]));
    assert_eq!(Rgb::hsl(120.0, 1.0, 0.5), Rgb([0, 255, 0]));
    assert_eq!(Rgb::hsl(240.0, 1.0, 0.5), Rgb([0, 0, 255]));
}

#[test]
fn hsl_greys() {
    assert_eq!(Rgb::hsl(0.0, 0.0, 1.0), Rgb([255, 255, 255]));
    assert_eq!(Rgb::hsl(0.0, 0.0, 0.0), Rgb([0, 0, 0]));
    assert_eq!(Rgb::hsl(0.0, 0.0, 0.5), Rgb([128, 128, 128]));
}

#[test]
fn for_name_is_deterministic_and_varies() {
    assert_eq!(Rgb::for_name("hello"), Rgb::for_name("hello"));
    assert_ne!(Rgb::for_name("alpha"), Rgb::for_name("beta"));
}

// Ground-truth fixtures shared with the JS port (app/test/unit/colorForName.test.ts).
// If either side drifts, one of the two suites goes red. Keep both lists identical.
#[test]
fn for_name_parity_fixtures() {
    for (name, hex) in [
        ("red", "#bf9940"),
        ("blue", "#6c40bf"),
        ("urban", "#40acbf"),
        ("test", "#40bfbd"),
        ("hello", "#4fbf40"),
        ("Tag 1", "#bf40ae"),
        ("café", "#9340bf"),
        ("東京", "#bf4071"),
        ("", "#407dbf"),
    ] {
        assert_eq!(Rgb::for_name(name).to_string(), hex, "{name}");
    }
}

#[test]
fn hex_parses_with_or_without_hash_and_in_shorthand() {
    assert_eq!("#ff8800".parse::<Rgb>().unwrap(), Rgb([255, 136, 0]));
    assert_eq!("00ff00".parse::<Rgb>().unwrap(), Rgb([0, 255, 0]));
    assert_eq!("#f80".parse::<Rgb>().unwrap(), Rgb([255, 136, 0]));
}

#[test]
fn hex_rejects_bad_length_and_characters() {
    assert!("#ffff".parse::<Rgb>().is_err());
    assert!("".parse::<Rgb>().is_err());
    assert!("#gggggg".parse::<Rgb>().is_err());
}

#[test]
fn hex_round_trips_and_the_wire_form_is_a_byte_array() {
    let c = Rgb([58, 127, 194]);
    assert_eq!(c.to_string(), "#3a7fc2");
    assert_eq!(c.to_string().parse::<Rgb>().unwrap(), c);
    assert_eq!(serde_json::to_string(&c).unwrap(), "[58,127,194]");
    assert!(serde_json::from_str::<Rgb>("[300,0,0]").is_err());
}

#[test]
fn iso_unix_epoch() {
    assert_eq!(iso_to_unix("1970-01-01T00:00:00Z"), Some(0.0));
}

#[test]
fn iso_known_date() {
    let ts = iso_to_unix("2024-01-01T00:00:00Z").unwrap();
    assert_eq!(ts, 1704067200.0);
}

#[test]
fn iso_invalid_returns_none() {
    assert!(iso_to_unix("not-a-date").is_none());
}

#[test]
fn sha256_hex_deterministic() {
    let a = sha256_hex(b"hello");
    let b = sha256_hex(b"hello");
    assert_eq!(a, b);
}

#[test]
fn sha256_hex_length() {
    let h = sha256_hex(b"test");
    assert_eq!(h.len(), 64);
}

#[test]
fn sha256_hex_known_value() {
    let h = sha256_hex(b"");
    assert_eq!(
        h,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn sha256_hex_differs_for_different_input() {
    assert_ne!(sha256_hex(b"hello"), sha256_hex(b"world"));
}

#[test]
fn a_serial_thread_runs_jobs_in_the_order_given_off_the_calling_thread() {
    let serial = Serial::new("test-serial", Mutex::new(Vec::new()));
    let caller = std::thread::current().id();
    let ran: Vec<_> = (0..50)
        .map(|n| {
            serial.then(move |seen: &Mutex<Vec<u32>>| {
                seen.lock().unwrap().push(n);
                (std::thread::current().id(), seen.lock().unwrap().clone())
            })
        })
        .collect();
    let answers: Vec<_> = futures::executor::block_on(futures::future::join_all(ran))
        .into_iter()
        .map(Result::unwrap)
        .collect();
    assert!(answers.iter().all(|(thread, _)| *thread != caller));
    assert_eq!(answers.last().unwrap().1, (0..50).collect::<Vec<_>>());
}

#[test]
fn a_job_that_panics_fails_alone_and_the_next_still_runs() {
    let serial = Serial::new("test-serial", ());
    let failed = serial.then(|_: &()| -> u32 { panic!("a job gone wrong") });
    let next = serial.then(|_: &()| 7);
    assert!(futures::executor::block_on(failed).is_err());
    assert_eq!(futures::executor::block_on(next).unwrap(), 7);
}
