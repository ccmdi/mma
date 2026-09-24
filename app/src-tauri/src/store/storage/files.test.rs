use super::*;

#[test]
fn tmp_paths_are_unique_per_write_and_sweepable() {
    let dest = Path::new("E:/somewhere/map.arrow");
    let a = tmp_path(dest);
    let b = tmp_path(dest);
    assert_ne!(a, b);
    assert!(a.extension().is_some_and(|x| x == "tmp"));
    assert!(b.extension().is_some_and(|x| x == "tmp"));
}

#[test]
fn concurrent_atomic_writes_to_one_destination_leave_one_intact_payload() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.bin");
    let payloads: Vec<Vec<u8>> = (0u8..4).map(|i| vec![i; 4096]).collect();
    std::thread::scope(|s| {
        for p in &payloads {
            s.spawn(|| atomic_write_bytes(&dest, p).unwrap());
        }
    });
    let got = fs::read(&dest).unwrap();
    assert!(payloads.contains(&got));
    assert_eq!(sweep_tmp_under(dir.path()), 0);
}

#[test]
fn atomic_copy_duplicates_the_source() {
    let dir = tempfile::tempdir().unwrap();
    let from = dir.path().join("base.arrow");
    let to = dir.path().join("genesis.arrow");
    fs::write(&from, vec![7u8; 4096]).unwrap();
    atomic_copy(&from, &to).unwrap();
    assert_eq!(fs::read(&to).unwrap(), fs::read(&from).unwrap());
    assert_eq!(sweep_tmp_under(dir.path()), 0);
}

#[test]
fn a_failed_atomic_copy_leaves_no_destination_file() {
    let dir = tempfile::tempdir().unwrap();
    let to = dir.path().join("genesis.arrow");
    assert!(atomic_copy(&dir.path().join("missing.arrow"), &to).is_err());
    assert!(!to.exists());
    assert_eq!(sweep_tmp_under(dir.path()), 0);
}
