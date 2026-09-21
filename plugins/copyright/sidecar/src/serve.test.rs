use super::*;

fn done(reply: Reply) -> (u16, String) {
    match reply {
        Reply::Done(status, body) => (status, body),
        Reply::Detect(_) => panic!("expected a finished reply"),
    }
}

#[test]
fn ping_and_unknown_routes() {
    let s = ServeState::new("unused-model-dir");
    assert_eq!(
        done(s.handle("GET", "/ping", "")),
        (200, r#"{"ok":true}"#.into())
    );
    assert_eq!(done(s.handle("GET", "/nope", "")).0, 404);
}

#[test]
fn malformed_detect_input_is_rejected_before_model_load() {
    let s = ServeState::new("nonexistent-model-dir");
    let (status, body) = done(s.handle("POST", "/detect", "{not json"));
    assert_eq!(status, 400);
    assert!(body.contains("bad input"));
}

#[test]
fn detect_input_is_handed_to_the_stream() {
    let s = ServeState::new("unused-model-dir");
    let Reply::Detect(input) = s.handle("POST", "/detect", r#"{"panoIds":["a","b"]}"#) else {
        panic!("expected a detect run");
    };
    assert_eq!(input.pano_ids, ["a", "b"]);
}

#[derive(Default)]
struct Wire {
    bytes: Vec<u8>,
    flushed_at: Vec<usize>,
}

impl Write for Wire {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.flushed_at.push(self.bytes.len());
        Ok(())
    }
}

#[test]
fn each_result_leaves_as_its_own_flushed_chunk() {
    let mut wire = Wire::default();
    write_chunk(&mut wire, r#"{"panoId":"a"}"#).unwrap();
    let first = wire.bytes.len();
    write_chunk(&mut wire, r#"{"panoId":"b"}"#).unwrap();
    end_chunks(&mut wire).unwrap();
    assert_eq!(wire.flushed_at[0], first);
    assert_eq!(
        String::from_utf8(wire.bytes).unwrap(),
        "f\r\n{\"panoId\":\"a\"}\n\r\nf\r\n{\"panoId\":\"b\"}\n\r\n0\r\n\r\n"
    );
}
