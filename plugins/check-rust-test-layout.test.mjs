import assert from "node:assert/strict";
import test from "node:test";
import { violations } from "./check-rust-test-layout.mjs";

test("finds test attributes and inline test modules", () => {
  assert.deepEqual(
    violations(
      "#[test]\nfn inline() {}\n#[tokio::test]\nasync fn async_inline() {}\n#[cfg(test)] mod tests { fn check() {} }",
    ),
    [
      { line: 1, reason: "test attribute" },
      { line: 3, reason: "test attribute" },
      { line: 5, reason: "inline cfg(test) module" },
    ],
  );
});

test("allows dedicated test modules and ignores comments and literals", () => {
  const source = String.raw`
// #[test] fn commented() {}
/* #[cfg(test)] mod commented { #[test] fn no() {} } */
const TEXT: &str = r###"#[test] #[cfg(test)] mod string_fake {}"###;
#[cfg(test)]
#[path = "work.test.rs"]
mod tests;
#[cfg(test)]
fn helper_for_external_tests() {}
`;
  assert.deepEqual(violations(source), []);
});

test("finds test attributes inside macro invocations and nested cfg modules", () => {
  assert.deepEqual(
    violations(
      "proptest! { #[test] fn property() {} }\n#[cfg(test)] mod inner { #![allow(dead_code)] }",
    ),
    [
      { line: 1, reason: "test attribute" },
      { line: 2, reason: "inline cfg(test) module" },
    ],
  );
});

test("keeps line locations after non-BMP characters", () => {
  assert.deepEqual(violations("// 🗺️ marker\n#[test]\nfn inline() {}"), [
    { line: 2, reason: "test attribute" },
  ]);
});

for (const attribute of [
  "#[test]",
  '#[tokio::test(flavor = "multi_thread")]',
  "#[rstest::rstest]",
  "#[test_case(1)]",
  '#[cfg_attr(feature = "checks", test)]',
  "#[bench]",
]) {
  test(`rejects ${attribute}`, () => {
    assert.deepEqual(violations(`${attribute}\nfn case() {}`), [
      { line: 1, reason: "test attribute" },
    ]);
  });
}

test("rejects visible test modules with combined cfg conditions", () => {
  assert.deepEqual(violations("#[cfg(all(test, debug_assertions))]\npub(crate) mod checks {}"), [
    { line: 1, reason: "inline cfg(test) module" },
  ]);
});

test("ignores nested comments, escaped strings, byte strings and lifetimes", () => {
  const source = String.raw`
/* outer /* #[test] */ #[tokio::test] */
const NORMAL: &str = "escaped \" #[test]";
const RAW: &[u8] = br##"#[test]"##;
const C: &std::ffi::CStr = c"#[test]";
const CHAR: char = '"';
fn borrowed<'a>(value: &'a str) -> &'a str { value }
#[cfg(not(test))] mod production_only {}
`;
  assert.deepEqual(violations(source), []);
});
