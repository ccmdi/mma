use crate::ast::Node;
use crate::token::TokenKind;
pub fn neighbor_only_expression(expression: &str) -> Option<String> {
    if expression.trim().is_empty() || expression == "*" {
        return None;
    }
    let tokens = crate::lexer::tokenize(expression).ok()?;
    let ast = crate::parser::parse(&tokens, expression).ok()?;
    let mut operands: Vec<&Node> = Vec::new();
    collect_top_level_and_operands(unwrap(&ast), &mut operands);
    let neighbor_only: Vec<&Node> = operands
        .into_iter()
        .filter(|n| !contains_parent(n))
        .collect();
    if neighbor_only.is_empty() {
        return None;
    }
    let mut out = String::new();
    for (i, node) in neighbor_only.iter().enumerate() {
        if i > 0 {
            out.push_str(" and ");
        }
        let span = node.span();
        out.push_str(expression.get(span.start..span.start + span.length)?);
    }
    Some(out)
}
fn unwrap(node: &Node) -> &Node {
    match node {
        Node::Group { inner, .. } => unwrap(inner),
        other => other,
    }
}
fn collect_top_level_and_operands<'a>(node: &'a Node, acc: &mut Vec<&'a Node>) {
    match node {
        Node::Binary { left, op, right } if op.kind == TokenKind::And => {
            collect_top_level_and_operands(left, acc);
            collect_top_level_and_operands(right, acc);
        }
        other => acc.push(other),
    }
}
fn contains_parent(node: &Node) -> bool {
    match node {
        Node::ParentProperty { .. } => true,
        Node::Binary { left, right, .. } => contains_parent(left) || contains_parent(right),
        Node::Group { inner, .. } => contains_parent(inner),
        Node::UnaryMinus { operand, .. } => contains_parent(operand),
        Node::In {
            operand, values, ..
        } => contains_parent(operand) || values.iter().any(|t| t.kind == TokenKind::ParentProperty),
        _ => false,
    }
}
