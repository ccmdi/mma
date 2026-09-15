use crate::error::ExprError;
use crate::token::{Token, TokenKind};
pub fn tokenize(expression: &str) -> Result<Vec<Token>, ExprError> {
    if expression == "*" {
        return Ok(vec![
            Token::new(TokenKind::Wildcard, "*", 0, 1),
            Token::new(TokenKind::EndOfExpression, "", 1, 0),
        ]);
    }
    let chars: Vec<char> = expression.chars().collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '\'' {
            tokens.push(read_string(expression, &chars, &mut i)?);
            continue;
        }
        if let Some(kind) = single_char_kind(c) {
            tokens.push(Token::new(kind, c.to_string(), i, 1));
            i += 1;
            continue;
        }
        if c == '-' {
            let is_unary_minus = tokens.last().map_or(true, |t| {
                matches!(
                    t.kind,
                    TokenKind::OpenParen
                        | TokenKind::OpenBracket
                        | TokenKind::Comma
                        | TokenKind::Eq
                        | TokenKind::Neq
                        | TokenKind::Lt
                        | TokenKind::Lte
                        | TokenKind::Gt
                        | TokenKind::Gte
                        | TokenKind::And
                        | TokenKind::Or
                        | TokenKind::Plus
                        | TokenKind::Minus
                        | TokenKind::Multiply
                        | TokenKind::Divide
                        | TokenKind::Modulo
                )
            });
            if is_unary_minus
                && i + 1 < chars.len()
                && (chars[i + 1].is_ascii_digit() || chars[i + 1] == '.')
            {
                tokens.push(read_number(&chars, &mut i));
            } else {
                tokens.push(Token::new(TokenKind::Minus, "-", i, 1));
                i += 1;
            }
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit())
        {
            tokens.push(read_number(&chars, &mut i));
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' {
            tokens.push(read_identifier_or_keyword(&chars, &mut i));
            continue;
        }
        return Err(ExprError::new(
            expression,
            i,
            1,
            format!("Unexpected character '{c}'."),
        ));
    }
    tokens.push(Token::new(TokenKind::EndOfExpression, "", chars.len(), 0));
    Ok(tokens)
}
fn single_char_kind(c: char) -> Option<TokenKind> {
    match c {
        '(' => Some(TokenKind::OpenParen),
        ')' => Some(TokenKind::CloseParen),
        '[' => Some(TokenKind::OpenBracket),
        ']' => Some(TokenKind::CloseBracket),
        ',' => Some(TokenKind::Comma),
        '+' => Some(TokenKind::Plus),
        '/' => Some(TokenKind::Divide),
        '*' => Some(TokenKind::Multiply),
        _ => None,
    }
}
fn read_string(expression: &str, chars: &[char], i: &mut usize) -> Result<Token, ExprError> {
    let start = *i;
    *i += 1;
    let mut value = String::new();
    while *i < chars.len() {
        if chars[*i] == '\\' && *i + 1 < chars.len() && chars[*i + 1] == '\'' {
            value.push('\'');
            *i += 2;
            continue;
        }
        if chars[*i] == '\'' {
            *i += 1;
            return Ok(Token::new(
                TokenKind::StringLiteral,
                value,
                start,
                *i - start,
            ));
        }
        value.push(chars[*i]);
        *i += 1;
    }
    Err(ExprError::new(
        expression,
        start,
        chars.len() - start,
        format!("Unterminated string starting at position {start}."),
    ))
}
fn read_number(chars: &[char], i: &mut usize) -> Token {
    let start = *i;
    let mut has_decimal_point = false;
    if chars[*i] == '-' {
        *i += 1;
    }
    while *i < chars.len() && (chars[*i].is_ascii_digit() || chars[*i] == '.') {
        if chars[*i] == '.' {
            if has_decimal_point {
                break;
            }
            if *i + 1 >= chars.len() || !chars[*i + 1].is_ascii_digit() {
                break;
            }
            has_decimal_point = true;
        }
        *i += 1;
    }
    let value: String = chars[start..*i].iter().collect();
    let kind = if has_decimal_point {
        TokenKind::DecimalLiteral
    } else {
        TokenKind::IntegerLiteral
    };
    Token::new(kind, value, start, *i - start)
}
fn read_identifier_or_keyword(chars: &[char], i: &mut usize) -> Token {
    let start = *i;
    while *i < chars.len() && (chars[*i].is_alphanumeric() || matches!(chars[*i], '_' | ':' | '$'))
    {
        *i += 1;
    }
    let value: String = chars[start..*i].iter().collect();
    let kind = match value.to_lowercase().as_str() {
        "eq" => TokenKind::Eq,
        "neq" => TokenKind::Neq,
        "lt" => TokenKind::Lt,
        "lte" => TokenKind::Lte,
        "gt" => TokenKind::Gt,
        "gte" => TokenKind::Gte,
        "and" => TokenKind::And,
        "or" => TokenKind::Or,
        "modulo" => TokenKind::Modulo,
        "in" => TokenKind::In,
        "true" | "false" => TokenKind::BooleanLiteral,
        "null" => TokenKind::NullLiteral,
        _ if value.starts_with("external:") => TokenKind::ExternalProperty,
        _ if value.starts_with("current:") => TokenKind::ParentProperty,
        _ => TokenKind::Property,
    };
    Token::new(kind, value, start, *i - start)
}
