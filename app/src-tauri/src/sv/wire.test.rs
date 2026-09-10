use serde_json::json;

use super::*;

fn message() -> Vec<u8> {
    let mut out = Vec::new();
    put_varint_field(&mut out, 1, 7);
    put_str(&mut out, 2, "hello");
    put_msg(&mut out, 3, |b| {
        put_varint_field(b, 1, 1);
        put_str(b, 2, "a");
    });
    put_msg(&mut out, 3, |b| {
        put_varint_field(b, 1, 2);
        put_str(b, 2, "b");
    });
    out
}

fn same_message() -> Value {
    json!([7, "hello", [[1, "a"], [2, "b"]]])
}

#[test]
fn both_encodings_answer_the_same_field_numbers() {
    for node in [Node::proto(&message()), Node::json(&same_message())] {
        assert_eq!(node.int(1), 7);
        assert_eq!(node.str(2), "hello");
        let nested: Vec<(i64, &str)> = node.all(3).iter().map(|n| (n.int(1), n.str(2))).collect();
        assert_eq!(nested, [(1, "a"), (2, "b")]);
    }
}

#[test]
fn an_absent_field_reads_as_an_empty_message() {
    for node in [Node::proto(&message()), Node::json(&same_message())] {
        assert!(!node.at(9).present());
        assert_eq!(node.at(9).str(1), "");
        assert_eq!(node.at(9).double(1), 0.0);
        assert_eq!(node.at(9).int(1), 0);
        assert!(node.at(9).all(1).is_empty());
        assert!(!node.at(9).at(1).present());
    }
}

#[test]
fn a_scalar_is_not_a_message() {
    assert!(!Node::proto(&message()).at(1).present());
    assert!(!Node::json(&same_message()).at(1).present());
    assert!(!Node::json(&json!("scalar")).present());
}

#[test]
fn varints_round_trip_at_every_width() {
    for value in [0, 1, 127, 128, 300, u64::from(u32::MAX), u64::MAX] {
        let mut out = Vec::new();
        put_varint_field(&mut out, 4, value);
        assert_eq!(Node::proto(&out).int(4) as u64, value);
    }
}

#[test]
fn fixed_width_numbers_read_as_floats() {
    let mut out = Vec::new();
    out.push((5 << 3) | 5);
    out.extend_from_slice(&1.5f32.to_le_bytes());
    out.push((6 << 3) | 1);
    out.extend_from_slice(&(-2.25f64).to_le_bytes());
    let node = Node::proto(&out);
    assert_eq!(node.double(5), 1.5);
    assert_eq!(node.double(6), -2.25);
    assert_eq!(node.int(6), -2);
}

#[test]
fn a_truncated_message_stops_rather_than_panicking() {
    let full = message();
    for end in 0..full.len() {
        let node = Node::proto(&full[..end]);
        let _ = node.int(1);
        let _ = node.str(2);
        let _ = node.all(3);
    }
}

#[test]
fn the_last_write_of_a_field_wins() {
    let mut out = Vec::new();
    put_str(&mut out, 1, "first");
    put_str(&mut out, 1, "second");
    assert_eq!(Node::proto(&out).str(1), "second");
}
