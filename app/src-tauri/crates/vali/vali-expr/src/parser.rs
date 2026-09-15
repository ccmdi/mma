use crate::ast::{Node, TextSpan};
use crate::error::ExprError;
use crate::token::{Token, TokenKind};
pub fn parse(tokens: &[Token], original: &str) -> Result<Node, ExprError> {
    if tokens.len() >= 2 && tokens[0].kind == TokenKind::Wildcard {
        return Ok(Node::Literal(tokens[0].clone()));
    }
    let mut pos = 0usize;
    let result = parse_logical_or(tokens, &mut pos, original)?;
    if tokens[pos].kind != TokenKind::EndOfExpression {
        let t = &tokens[pos];
        return Err(ExprError::new(
            original,
            t.position,
            t.length,
            format!("Unexpected token '{}' at position {}.", t.value, t.position),
        ));
    }
    Ok(result)
}
fn parse_logical_or(tokens: &[Token], pos: &mut usize, expr: &str) -> Result<Node, ExprError> {
    let mut left = parse_logical_and(tokens, pos, expr)?;
    while tokens[*pos].kind == TokenKind::Or {
        let op = tokens[*pos].clone();
        *pos += 1;
        let right = parse_logical_and(tokens, pos, expr)?;
        left = Node::Binary {
            left: Box::new(left),
            op,
            right: Box::new(right),
        };
    }
    Ok(left)
}
fn parse_logical_and(tokens: &[Token], pos: &mut usize, expr: &str) -> Result<Node, ExprError> {
    let mut left = parse_comparison(tokens, pos, expr)?;
    while tokens[*pos].kind == TokenKind::And {
        let op = tokens[*pos].clone();
        *pos += 1;
        let right = parse_comparison(tokens, pos, expr)?;
        left = Node::Binary {
            left: Box::new(left),
            op,
            right: Box::new(right),
        };
    }
    Ok(left)
}
fn parse_comparison(tokens: &[Token], pos: &mut usize, expr: &str) -> Result<Node, ExprError> {
    let mut left = parse_addition(tokens, pos, expr)?;
    let kind = tokens[*pos].kind;
    if matches!(
        kind,
        TokenKind::Eq
            | TokenKind::Neq
            | TokenKind::Lt
            | TokenKind::Lte
            | TokenKind::Gt
            | TokenKind::Gte
    ) {
        let op = tokens[*pos].clone();
        *pos += 1;
        let right = parse_addition(tokens, pos, expr)?;
        left = Node::Binary {
            left: Box::new(left),
            op,
            right: Box::new(right),
        };
    } else if kind == TokenKind::In {
        *pos += 1;
        if tokens[*pos].kind != TokenKind::OpenBracket {
            let t = &tokens[*pos];
            return Err(ExprError::new(
                expr,
                t.position,
                t.length,
                format!("Expected '[' after 'in' at position {}.", t.position),
            ));
        }
        *pos += 1;
        let mut values: Vec<Token> = Vec::new();
        loop {
            let t = &tokens[*pos];
            if !matches!(
                t.kind,
                TokenKind::IntegerLiteral
                    | TokenKind::DecimalLiteral
                    | TokenKind::StringLiteral
                    | TokenKind::BooleanLiteral
                    | TokenKind::NullLiteral
            ) {
                return Err(ExprError::new(
                    expr,
                    t.position,
                    t.length,
                    format!(
                        "Expected a literal value in 'in' list at position {}.",
                        t.position
                    ),
                ));
            }
            *pos += 1;
            values.push(t.clone());
            if tokens[*pos].kind == TokenKind::Comma {
                *pos += 1;
                continue;
            }
            break;
        }
        if tokens[*pos].kind != TokenKind::CloseBracket {
            let t = &tokens[*pos];
            return Err(ExprError::new(
                expr,
                t.position,
                t.length,
                format!(
                    "Expected ']' to close 'in' list at position {}.",
                    t.position
                ),
            ));
        }
        let close_pos = tokens[*pos].position;
        *pos += 1;
        let span = TextSpan {
            start: left.span().start,
            length: close_pos + 1 - left.span().start,
        };
        left = Node::In {
            operand: Box::new(left),
            values,
            span,
        };
    }
    Ok(left)
}
fn parse_addition(tokens: &[Token], pos: &mut usize, expr: &str) -> Result<Node, ExprError> {
    let mut left = parse_multiplication(tokens, pos, expr)?;
    while matches!(tokens[*pos].kind, TokenKind::Plus | TokenKind::Minus) {
        let op = tokens[*pos].clone();
        *pos += 1;
        let right = parse_multiplication(tokens, pos, expr)?;
        left = Node::Binary {
            left: Box::new(left),
            op,
            right: Box::new(right),
        };
    }
    Ok(left)
}
fn parse_multiplication(tokens: &[Token], pos: &mut usize, expr: &str) -> Result<Node, ExprError> {
    let mut left = parse_unary(tokens, pos, expr)?;
    while matches!(
        tokens[*pos].kind,
        TokenKind::Multiply | TokenKind::Divide | TokenKind::Modulo
    ) {
        let op = tokens[*pos].clone();
        *pos += 1;
        let right = parse_unary(tokens, pos, expr)?;
        left = Node::Binary {
            left: Box::new(left),
            op,
            right: Box::new(right),
        };
    }
    Ok(left)
}
fn parse_unary(tokens: &[Token], pos: &mut usize, expr: &str) -> Result<Node, ExprError> {
    if tokens[*pos].kind == TokenKind::Minus {
        let op = tokens[*pos].clone();
        *pos += 1;
        let operand = parse_primary(tokens, pos, expr)?;
        return Ok(Node::UnaryMinus {
            op,
            operand: Box::new(operand),
        });
    }
    parse_primary(tokens, pos, expr)
}
fn parse_primary(tokens: &[Token], pos: &mut usize, expr: &str) -> Result<Node, ExprError> {
    let token = tokens[*pos].clone();
    match token.kind {
        TokenKind::OpenParen => {
            let open_pos = token.position;
            *pos += 1;
            let inner = parse_logical_or(tokens, pos, expr)?;
            if tokens[*pos].kind != TokenKind::CloseParen {
                return Err(ExprError::new(
                    expr,
                    open_pos,
                    1,
                    format!("Unmatched '(' at position {open_pos}."),
                ));
            }
            let close = tokens[*pos].clone();
            *pos += 1;
            let span = TextSpan {
                start: open_pos,
                length: close.position + 1 - open_pos,
            };
            Ok(Node::Group {
                inner: Box::new(inner),
                span,
            })
        }
        TokenKind::IntegerLiteral
        | TokenKind::DecimalLiteral
        | TokenKind::StringLiteral
        | TokenKind::BooleanLiteral
        | TokenKind::NullLiteral => {
            *pos += 1;
            Ok(Node::Literal(token))
        }
        TokenKind::Property => {
            *pos += 1;
            let name = token.value.clone();
            Ok(Node::Property { token, name })
        }
        TokenKind::ExternalProperty => {
            *pos += 1;
            let key = token.value["external:".len()..].to_string();
            Ok(Node::ExternalProperty { token, key })
        }
        TokenKind::ParentProperty => {
            *pos += 1;
            let name = token.value["current:".len()..].to_string();
            Ok(Node::ParentProperty { token, name })
        }
        TokenKind::EndOfExpression => Err(ExprError::new(
            expr,
            token.position,
            1,
            "Unexpected end of expression.",
        )),
        _ => Err(ExprError::new(
            expr,
            token.position,
            token.length,
            format!(
                "Expected operand but found '{}' at position {}.",
                token.value, token.position
            ),
        )),
    }
}
