use crate::token::Token;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextSpan {
    pub start: usize,
    pub length: usize,
}
#[derive(Debug, Clone)]
pub enum Node {
    Literal(Token),
    Property {
        token: Token,
        name: String,
    },
    ExternalProperty {
        token: Token,
        key: String,
    },
    ParentProperty {
        token: Token,
        name: String,
    },
    Binary {
        left: Box<Node>,
        op: Token,
        right: Box<Node>,
    },
    UnaryMinus {
        op: Token,
        operand: Box<Node>,
    },
    Group {
        inner: Box<Node>,
        span: TextSpan,
    },
    In {
        operand: Box<Node>,
        values: Vec<Token>,
        span: TextSpan,
    },
}
impl Node {
    pub fn span(&self) -> TextSpan {
        match self {
            Node::Literal(t)
            | Node::Property { token: t, .. }
            | Node::ExternalProperty { token: t, .. }
            | Node::ParentProperty { token: t, .. } => TextSpan {
                start: t.position,
                length: t.length,
            },
            Node::Binary { left, right, .. } => {
                let l = left.span();
                let r = right.span();
                TextSpan {
                    start: l.start,
                    length: r.start + r.length - l.start,
                }
            }
            Node::UnaryMinus { op, operand } => {
                let o = operand.span();
                TextSpan {
                    start: op.position,
                    length: o.start + o.length - op.position,
                }
            }
            Node::Group { span, .. } | Node::In { span, .. } => *span,
        }
    }
}
