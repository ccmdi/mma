#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    IntegerLiteral,
    DecimalLiteral,
    StringLiteral,
    BooleanLiteral,
    NullLiteral,
    Property,
    ExternalProperty,
    ParentProperty,
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
    Plus,
    Minus,
    Multiply,
    Divide,
    Modulo,
    In,
    OpenParen,
    CloseParen,
    OpenBracket,
    CloseBracket,
    Comma,
    Wildcard,
    EndOfExpression,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub value: String,
    pub position: usize,
    pub length: usize,
}
impl Token {
    pub fn new(kind: TokenKind, value: impl Into<String>, position: usize, length: usize) -> Token {
        Token {
            kind,
            value: value.into(),
            position,
            length,
        }
    }
}
