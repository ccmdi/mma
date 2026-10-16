use super::*;

#[test]
fn reads_pairs_and_skips_comments_and_blanks() {
    let got =
        parse("# staging\n\nMMA_FEEDBACK_REPO=ccmdi/mma-reference\n  KEY = spaced  \nnot a pair\n");
    assert_eq!(got.len(), 2);
    assert_eq!(got["MMA_FEEDBACK_REPO"], "ccmdi/mma-reference");
    assert_eq!(got["KEY"], "spaced");
}

#[test]
fn drops_one_pair_of_surrounding_quotes() {
    let got = parse("A=\"https://x.dev\"\nB='y'\nC=\"unbalanced\nD=a=b");
    assert_eq!(got["A"], "https://x.dev");
    assert_eq!(got["B"], "y");
    assert_eq!(got["C"], "\"unbalanced");
    assert_eq!(got["D"], "a=b");
}

#[test]
fn the_process_environment_wins() {
    assert_eq!(var("PATH"), std::env::var("PATH").ok());
}
