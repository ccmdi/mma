use crate::ast::Node;
use crate::error::ExprError;
use crate::highway::highway_eq_str;
use crate::props::{self, Prop};
use crate::token::{Token, TokenKind};
use std::borrow::Cow;
use vali_core::Location;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    Bool,
    Int,
    Long,
    Double,
    NInt,
    NLong,
    NDouble,
    Str,
    Highway,
    Null,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumTy {
    Int,
    Long,
    Double,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmpOp {
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArithOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}
#[derive(Debug, Clone)]
pub enum TExpr {
    ConstBool(bool),
    ConstInt(i32),
    ConstLong(i64),
    ConstDouble(f64),
    ConstStr(String),
    ConstNull,
    Prop {
        prop: Prop,
        parent: bool,
    },
    External {
        key: String,
        numeric: bool,
    },
    And(Box<TExpr>, Box<TExpr>),
    Or(Box<TExpr>, Box<TExpr>),
    Arith {
        op: ArithOp,
        ty: NumTy,
        l: Box<TExpr>,
        r: Box<TExpr>,
    },
    Neg {
        ty: NumTy,
        e: Box<TExpr>,
    },
    CmpNum {
        op: CmpOp,
        ty: NumTy,
        l: Box<TExpr>,
        r: Box<TExpr>,
    },
    CmpStr {
        op: CmpOp,
        l: Box<TExpr>,
        r: Box<TExpr>,
    },
    CmpBool {
        neq: bool,
        l: Box<TExpr>,
        r: Box<TExpr>,
    },
    HighwayCmpStr {
        neq: bool,
        hw: Box<TExpr>,
        s: Box<TExpr>,
    },
    HighwayCmpHw {
        neq: bool,
        l: Box<TExpr>,
        r: Box<TExpr>,
    },
    Concat(Box<TExpr>, Box<TExpr>),
}
#[derive(Debug, Clone)]
pub enum Val<'a> {
    Null,
    B(Option<bool>),
    I(Option<i32>),
    L(Option<i64>),
    D(Option<f64>),
    S(Option<Cow<'a, str>>),
    H(u32),
}
pub struct Checker<'e> {
    pub expr: &'e str,
    pub allow_parent: bool,
}
impl<'e> Checker<'e> {
    pub fn check(&self, node: &Node) -> Result<(TExpr, Ty), ExprError> {
        match node {
            Node::Literal(token) => self.check_literal(token),
            Node::Property { token, name } => {
                let prop = self.resolve_prop(token, name)?;
                Ok((
                    TExpr::Prop {
                        prop,
                        parent: false,
                    },
                    props::ty(prop),
                ))
            }
            Node::ParentProperty { token, name } => {
                if !self.allow_parent {
                    return Err(ExprError::new(
                        self.expr,
                        token.position,
                        token.length,
                        "Parent properties (current:) are not allowed in this context.",
                    ));
                }
                let prop = self.resolve_prop(token, name)?;
                Ok((TExpr::Prop { prop, parent: true }, props::ty(prop)))
            }
            Node::ExternalProperty { key, .. } => Ok((
                TExpr::External {
                    key: key.clone(),
                    numeric: false,
                },
                Ty::Str,
            )),
            Node::Group { inner, .. } => self.check(inner),
            Node::UnaryMinus { op, operand } => {
                let (te, ty) = self.check(operand)?;
                let Some(num) = numeric_of(ty) else {
                    return Err(self.op_error(op, ty, ty));
                };
                Ok((
                    TExpr::Neg {
                        ty: num.kind,
                        e: Box::new(te),
                    },
                    make_ty(num.kind, num.nullable),
                ))
            }
            Node::Binary { left, op, right } => self.check_binary(left, op, right),
            Node::In {
                operand, values, ..
            } => {
                let mut result: Option<TExpr> = None;
                for v in values {
                    let l = self.check(operand)?;
                    let r = self.check_literal(v)?;
                    let eq = self.check_cmp(CmpOp::Eq, l, r, operand.span().start, v)?;
                    result = Some(match result {
                        None => eq,
                        Some(acc) => TExpr::Or(Box::new(acc), Box::new(eq)),
                    });
                }
                Ok((result.unwrap(), Ty::Bool))
            }
        }
    }
    fn resolve_prop(&self, token: &Token, name: &str) -> Result<Prop, ExprError> {
        props::resolve(name).ok_or_else(|| {
            let closest = props::closest_match(name);
            ExprError::new(
                self.expr,
                token.position,
                token.length,
                format!("Unknown property '{name}'. Did you mean '{closest}'?"),
            )
        })
    }
    fn check_literal(&self, token: &Token) -> Result<(TExpr, Ty), ExprError> {
        match token.kind {
            TokenKind::IntegerLiteral => {
                let text = &token.value;
                if let Ok(v) = text.parse::<i32>() {
                    return Ok((TExpr::ConstInt(v), Ty::Int));
                }
                if let Some(magnitude) = text.strip_prefix('-') {
                    if let Ok(n) = magnitude.parse::<u64>() {
                        if n <= u32::MAX as u64 {
                            return Ok((TExpr::ConstInt((-(n as i64)) as i32), Ty::Int));
                        }
                    }
                }
                if let Ok(v) = text.parse::<i64>() {
                    Ok((TExpr::ConstLong(v), Ty::Long))
                } else {
                    Err(ExprError::new(
                        self.expr,
                        token.position,
                        token.length,
                        format!(
                            "Failed to compile expression: invalid integer literal '{}'.",
                            token.value
                        ),
                    ))
                }
            }
            TokenKind::DecimalLiteral => {
                if token
                    .value
                    .strip_prefix('-')
                    .unwrap_or(&token.value)
                    .starts_with('.')
                {
                    return Err(ExprError::new(
                        self.expr,
                        token.position,
                        token.length,
                        format!(
                            "Failed to compile expression: invalid number literal '{}'.",
                            token.value
                        ),
                    ));
                }
                match token.value.parse::<f64>() {
                    Ok(v) => Ok((TExpr::ConstDouble(v), Ty::Double)),
                    Err(_) => Err(ExprError::new(
                        self.expr,
                        token.position,
                        token.length,
                        format!(
                            "Failed to compile expression: invalid number literal '{}'.",
                            token.value
                        ),
                    )),
                }
            }
            TokenKind::StringLiteral => Ok((TExpr::ConstStr(token.value.clone()), Ty::Str)),
            TokenKind::BooleanLiteral => Ok((
                TExpr::ConstBool(token.value.to_lowercase() == "true"),
                Ty::Bool,
            )),
            TokenKind::NullLiteral => Ok((TExpr::ConstNull, Ty::Null)),
            _ => Err(ExprError::new(
                self.expr,
                token.position,
                token.length,
                format!(
                    "Failed to compile expression: unexpected literal '{}'.",
                    token.value
                ),
            )),
        }
    }
    fn check_binary(
        &self,
        left: &Node,
        op: &Token,
        right: &Node,
    ) -> Result<(TExpr, Ty), ExprError> {
        match op.kind {
            TokenKind::And | TokenKind::Or => {
                let (lt, lty) = self.check(left)?;
                let (rt, rty) = self.check(right)?;
                if lty != Ty::Bool || rty != Ty::Bool {
                    return Err(self.op_error(op, lty, rty));
                }
                let node = if op.kind == TokenKind::And {
                    TExpr::And(Box::new(lt), Box::new(rt))
                } else {
                    TExpr::Or(Box::new(lt), Box::new(rt))
                };
                Ok((node, Ty::Bool))
            }
            TokenKind::Eq
            | TokenKind::Neq
            | TokenKind::Lt
            | TokenKind::Lte
            | TokenKind::Gt
            | TokenKind::Gte => {
                let numeric_external = (is_external(left) && is_numeric_literal(right))
                    || (is_external(right) && is_numeric_literal(left));
                let l = self.check_operand(left, numeric_external)?;
                let r = self.check_operand(right, numeric_external)?;
                let cmp_op = cmp_op_of(op.kind);
                let node = self.check_cmp(cmp_op, l, r, op.position, op)?;
                Ok((node, Ty::Bool))
            }
            TokenKind::Plus
            | TokenKind::Minus
            | TokenKind::Multiply
            | TokenKind::Divide
            | TokenKind::Modulo => {
                let (lt, lty) = self.check(left)?;
                let (rt, rty) = self.check(right)?;
                if op.kind == TokenKind::Plus && (lty == Ty::Str || rty == Ty::Str) {
                    let concatable = |ty: Ty| !matches!(ty, Ty::Highway);
                    if concatable(lty) && concatable(rty) {
                        return Ok((TExpr::Concat(Box::new(lt), Box::new(rt)), Ty::Str));
                    }
                    return Err(self.op_error(op, lty, rty));
                }
                let (ty, nullable) = self.promote_numeric(op, lty, rty)?;
                let node = TExpr::Arith {
                    op: arith_op_of(op.kind),
                    ty,
                    l: Box::new(lt),
                    r: Box::new(rt),
                };
                Ok((node, make_ty(ty, nullable)))
            }
            _ => Err(ExprError::new(
                self.expr,
                op.position,
                op.length,
                format!(
                    "Failed to compile expression: unexpected operator '{}'.",
                    op.value
                ),
            )),
        }
    }
    fn check_operand(&self, node: &Node, numeric_external: bool) -> Result<(TExpr, Ty), ExprError> {
        if numeric_external {
            if let Node::ExternalProperty { key, .. } = node {
                return Ok((
                    TExpr::External {
                        key: key.clone(),
                        numeric: true,
                    },
                    Ty::Double,
                ));
            }
        }
        self.check(node)
    }
    fn check_cmp(
        &self,
        op: CmpOp,
        (lt, lty): (TExpr, Ty),
        (rt, rty): (TExpr, Ty),
        err_pos: usize,
        err_token: &Token,
    ) -> Result<TExpr, ExprError> {
        let err = || {
            ExprError::new(
                self.expr,
                err_pos,
                err_token.length.max(1),
                format!(
                    "Failed to compile expression: operator '{}' incompatible with operand types {lty:?} and {rty:?}.",
                    err_token.value
                ),
            )
        };
        if lty == Ty::Highway {
            return match (rty, op) {
                (Ty::Str, CmpOp::Eq | CmpOp::Neq) => Ok(TExpr::HighwayCmpStr {
                    neq: op == CmpOp::Neq,
                    hw: Box::new(lt),
                    s: Box::new(rt),
                }),
                (Ty::Highway, CmpOp::Eq | CmpOp::Neq) => Ok(TExpr::HighwayCmpHw {
                    neq: op == CmpOp::Neq,
                    l: Box::new(lt),
                    r: Box::new(rt),
                }),
                _ => Err(err()),
            };
        }
        if rty == Ty::Highway {
            return Err(err());
        }
        if lty == Ty::Str || rty == Ty::Str {
            if !matches!(lty, Ty::Str | Ty::Null) || !matches!(rty, Ty::Str | Ty::Null) {
                return Err(err());
            }
            if !matches!(op, CmpOp::Eq | CmpOp::Neq) && (lty == Ty::Null || rty == Ty::Null) {
                return Err(err());
            }
            return Ok(TExpr::CmpStr {
                op,
                l: Box::new(lt),
                r: Box::new(rt),
            });
        }
        let value_const = |t: &TExpr| {
            matches!(
                t,
                TExpr::ConstInt(_)
                    | TExpr::ConstLong(_)
                    | TExpr::ConstDouble(_)
                    | TExpr::ConstBool(_)
            )
        };
        if (lty == Ty::Null && value_const(&rt)) || (rty == Ty::Null && value_const(&lt)) {
            return Err(err());
        }
        if lty == Ty::Bool || rty == Ty::Bool {
            if !matches!(lty, Ty::Bool | Ty::Null) || !matches!(rty, Ty::Bool | Ty::Null) {
                return Err(err());
            }
            return match op {
                CmpOp::Eq => Ok(TExpr::CmpBool {
                    neq: false,
                    l: Box::new(lt),
                    r: Box::new(rt),
                }),
                CmpOp::Neq => Ok(TExpr::CmpBool {
                    neq: true,
                    l: Box::new(lt),
                    r: Box::new(rt),
                }),
                _ => Err(err()),
            };
        }
        if lty == Ty::Null && rty == Ty::Null && !matches!(op, CmpOp::Eq | CmpOp::Neq) {
            return Err(err());
        }
        let (ty, _) = self.promote_numeric(err_token, lty, rty)?;
        Ok(TExpr::CmpNum {
            op,
            ty,
            l: Box::new(lt),
            r: Box::new(rt),
        })
    }
    fn promote_numeric(&self, op: &Token, lty: Ty, rty: Ty) -> Result<(NumTy, bool), ExprError> {
        let (Some(l), Some(r)) = (numeric_of(lty), numeric_of(rty)) else {
            return Err(self.op_error(op, lty, rty));
        };
        let nullable = l.nullable || r.nullable;
        let ty = if l.is_null && r.is_null {
            NumTy::Int
        } else if l.is_null {
            r.kind
        } else if r.is_null {
            l.kind
        } else {
            if l.kind != r.kind {
                let (int_side, other_kind) = if l.kind == NumTy::Double {
                    (&r, l.kind)
                } else {
                    (&l, r.kind)
                };
                if other_kind == NumTy::Double && int_side.nullable {
                    return Err(self.op_error(op, lty, rty));
                }
            }
            promote(l.kind, r.kind)
        };
        Ok((ty, nullable))
    }
    fn op_error(&self, op: &Token, lty: Ty, rty: Ty) -> ExprError {
        ExprError::new(
            self.expr,
            op.position,
            op.length,
            format!(
                "Failed to compile expression: operator '{}' incompatible with operand types {lty:?} and {rty:?}.",
                op.value
            ),
        )
    }
}
struct NumInfo {
    kind: NumTy,
    nullable: bool,
    is_null: bool,
}
fn numeric_of(ty: Ty) -> Option<NumInfo> {
    let info = |kind, nullable, is_null| {
        Some(NumInfo {
            kind,
            nullable,
            is_null,
        })
    };
    match ty {
        Ty::Int => info(NumTy::Int, false, false),
        Ty::Long => info(NumTy::Long, false, false),
        Ty::Double => info(NumTy::Double, false, false),
        Ty::NInt => info(NumTy::Int, true, false),
        Ty::NLong => info(NumTy::Long, true, false),
        Ty::NDouble => info(NumTy::Double, true, false),
        Ty::Null => info(NumTy::Int, true, true),
        _ => None,
    }
}
fn promote(l: NumTy, r: NumTy) -> NumTy {
    use NumTy::*;
    match (l, r) {
        (Double, _) | (_, Double) => Double,
        (Long, _) | (_, Long) => Long,
        _ => Int,
    }
}
fn make_ty(num: NumTy, nullable: bool) -> Ty {
    match (num, nullable) {
        (NumTy::Int, false) => Ty::Int,
        (NumTy::Long, false) => Ty::Long,
        (NumTy::Double, false) => Ty::Double,
        (NumTy::Int, true) => Ty::NInt,
        (NumTy::Long, true) => Ty::NLong,
        (NumTy::Double, true) => Ty::NDouble,
    }
}
fn cmp_op_of(kind: TokenKind) -> CmpOp {
    match kind {
        TokenKind::Eq => CmpOp::Eq,
        TokenKind::Neq => CmpOp::Neq,
        TokenKind::Lt => CmpOp::Lt,
        TokenKind::Lte => CmpOp::Lte,
        TokenKind::Gt => CmpOp::Gt,
        TokenKind::Gte => CmpOp::Gte,
        _ => unreachable!(),
    }
}
fn arith_op_of(kind: TokenKind) -> ArithOp {
    match kind {
        TokenKind::Plus => ArithOp::Add,
        TokenKind::Minus => ArithOp::Sub,
        TokenKind::Multiply => ArithOp::Mul,
        TokenKind::Divide => ArithOp::Div,
        TokenKind::Modulo => ArithOp::Mod,
        _ => unreachable!(),
    }
}
fn is_external(node: &Node) -> bool {
    matches!(node, Node::ExternalProperty { .. })
}
fn is_numeric_literal(node: &Node) -> bool {
    matches!(
        node, Node::Literal(t) if matches!(t.kind, TokenKind::IntegerLiteral |
        TokenKind::DecimalLiteral)
    )
}
pub fn eval<'a>(e: &'a TExpr, loc: &'a Location, parent: Option<&'a Location>) -> Val<'a> {
    match e {
        TExpr::ConstBool(b) => Val::B(Some(*b)),
        TExpr::ConstInt(v) => Val::I(Some(*v)),
        TExpr::ConstLong(v) => Val::L(Some(*v)),
        TExpr::ConstDouble(v) => Val::D(Some(*v)),
        TExpr::ConstStr(s) => Val::S(Some(Cow::Borrowed(s.as_str()))),
        TExpr::ConstNull => Val::Null,
        TExpr::Prop {
            prop,
            parent: use_parent,
        } => {
            let target = if *use_parent {
                parent.expect("parent expression evaluated without a parent location")
            } else {
                loc
            };
            props::eval(*prop, target)
        }
        TExpr::External { numeric, .. } => {
            if *numeric {
                Val::D(Some(f64::NAN))
            } else {
                Val::S(Some(Cow::Borrowed("")))
            }
        }
        TExpr::And(l, r) => Val::B(Some(
            as_bool(eval(l, loc, parent)) && as_bool(eval(r, loc, parent)),
        )),
        TExpr::Or(l, r) => Val::B(Some(
            as_bool(eval(l, loc, parent)) || as_bool(eval(r, loc, parent)),
        )),
        TExpr::Arith { op, ty, l, r } => {
            let lv = eval(l, loc, parent);
            let rv = eval(r, loc, parent);
            match ty {
                NumTy::Int => Val::I(match (as_i32(lv), as_i32(rv)) {
                    (Some(a), Some(b)) => Some(arith_i32(*op, a, b)),
                    _ => None,
                }),
                NumTy::Long => Val::L(match (as_i64(lv), as_i64(rv)) {
                    (Some(a), Some(b)) => Some(arith_i64(*op, a, b)),
                    _ => None,
                }),
                NumTy::Double => Val::D(match (as_f64(lv), as_f64(rv)) {
                    (Some(a), Some(b)) => Some(arith_f64(*op, a, b)),
                    _ => None,
                }),
            }
        }
        TExpr::Neg { ty, e } => {
            let v = eval(e, loc, parent);
            match ty {
                NumTy::Int => Val::I(as_i32(v).map(i32::wrapping_neg)),
                NumTy::Long => Val::L(as_i64(v).map(i64::wrapping_neg)),
                NumTy::Double => Val::D(as_f64(v).map(|x| -x)),
            }
        }
        TExpr::CmpNum { op, ty, l, r } => {
            let lv = eval(l, loc, parent);
            let rv = eval(r, loc, parent);
            let b = match ty {
                NumTy::Int => cmp_opt(
                    *op,
                    as_i32(lv),
                    as_i32(rv),
                    |a, b| a == b,
                    |a, b| a < b,
                    |a, b| a <= b,
                ),
                NumTy::Long => cmp_opt(
                    *op,
                    as_i64(lv),
                    as_i64(rv),
                    |a, b| a == b,
                    |a, b| a < b,
                    |a, b| a <= b,
                ),
                NumTy::Double => cmp_opt(
                    *op,
                    as_f64(lv),
                    as_f64(rv),
                    |a, b| a == b,
                    |a, b| a < b,
                    |a, b| a <= b,
                ),
            };
            Val::B(Some(b))
        }
        TExpr::CmpStr { op, l, r } => {
            let lv = as_str(eval(l, loc, parent));
            let rv = as_str(eval(r, loc, parent));
            let b = match op {
                CmpOp::Eq => lv == rv,
                CmpOp::Neq => lv != rv,
                _ => {
                    let ord = match (&lv, &rv) {
                        (None, None) => std::cmp::Ordering::Equal,
                        (None, Some(_)) => std::cmp::Ordering::Less,
                        (Some(_), None) => std::cmp::Ordering::Greater,
                        (Some(a), Some(b)) => a.as_ref().cmp(b.as_ref()),
                    };
                    match op {
                        CmpOp::Lt => ord.is_lt(),
                        CmpOp::Lte => ord.is_le(),
                        CmpOp::Gt => ord.is_gt(),
                        CmpOp::Gte => ord.is_ge(),
                        _ => unreachable!(),
                    }
                }
            };
            Val::B(Some(b))
        }
        TExpr::CmpBool { neq, l, r } => {
            let lv = as_bool_opt(eval(l, loc, parent));
            let rv = as_bool_opt(eval(r, loc, parent));
            let eq = lv == rv;
            Val::B(Some(if *neq { !eq } else { eq }))
        }
        TExpr::HighwayCmpStr { neq, hw, s } => {
            let road = as_highway(eval(hw, loc, parent));
            let sv = as_str(eval(s, loc, parent));
            let b = highway_eq_str(road, sv.as_deref());
            Val::B(Some(if *neq { !b } else { b }))
        }
        TExpr::HighwayCmpHw { neq, l, r } => {
            let a = as_highway(eval(l, loc, parent)) as i32;
            let b = as_highway(eval(r, loc, parent)) as i32;
            let res = (a & b) == a;
            Val::B(Some(if *neq { !res } else { res }))
        }
        TExpr::Concat(l, r) => {
            let mut out = String::new();
            stringify_into(&mut out, eval(l, loc, parent));
            stringify_into(&mut out, eval(r, loc, parent));
            Val::S(Some(Cow::Owned(out)))
        }
    }
}
fn stringify_into(out: &mut String, v: Val<'_>) {
    use std::fmt::Write;
    match v {
        Val::Null => {}
        Val::S(None) | Val::B(None) | Val::I(None) | Val::L(None) | Val::D(None) => {}
        Val::S(Some(s)) => out.push_str(&s),
        Val::B(Some(b)) => out.push_str(if b { "True" } else { "False" }),
        Val::I(Some(v)) => {
            let _ = write!(out, "{v}");
        }
        Val::L(Some(v)) => {
            let _ = write!(out, "{v}");
        }
        Val::D(Some(v)) => {
            let _ = write!(out, "{v}");
        }
        Val::H(_) => unreachable!("checker rejected highway concat"),
    }
}
fn cmp_opt<T: Copy>(
    op: CmpOp,
    l: Option<T>,
    r: Option<T>,
    eq: impl Fn(T, T) -> bool,
    lt: impl Fn(T, T) -> bool,
    lte: impl Fn(T, T) -> bool,
) -> bool {
    match op {
        CmpOp::Eq => match (l, r) {
            (None, None) => true,
            (Some(a), Some(b)) => eq(a, b),
            _ => false,
        },
        CmpOp::Neq => !cmp_opt(CmpOp::Eq, l, r, eq, lt, lte),
        _ => match (l, r) {
            (Some(a), Some(b)) => match op {
                CmpOp::Lt => lt(a, b),
                CmpOp::Lte => lte(a, b),
                CmpOp::Gt => lt(b, a),
                CmpOp::Gte => lte(b, a),
                _ => unreachable!(),
            },
            _ => false,
        },
    }
}
fn arith_i32(op: ArithOp, a: i32, b: i32) -> i32 {
    match op {
        ArithOp::Add => a.wrapping_add(b),
        ArithOp::Sub => a.wrapping_sub(b),
        ArithOp::Mul => a.wrapping_mul(b),
        ArithOp::Div => a / b,
        ArithOp::Mod => a % b,
    }
}
fn arith_i64(op: ArithOp, a: i64, b: i64) -> i64 {
    match op {
        ArithOp::Add => a.wrapping_add(b),
        ArithOp::Sub => a.wrapping_sub(b),
        ArithOp::Mul => a.wrapping_mul(b),
        ArithOp::Div => a / b,
        ArithOp::Mod => a % b,
    }
}
fn arith_f64(op: ArithOp, a: f64, b: f64) -> f64 {
    match op {
        ArithOp::Add => a + b,
        ArithOp::Sub => a - b,
        ArithOp::Mul => a * b,
        ArithOp::Div => a / b,
        ArithOp::Mod => a % b,
    }
}
fn as_bool(v: Val<'_>) -> bool {
    match v {
        Val::B(Some(b)) => b,
        _ => unreachable!("checker guaranteed bool"),
    }
}
fn as_bool_opt(v: Val<'_>) -> Option<bool> {
    match v {
        Val::B(b) => b,
        Val::Null => None,
        _ => unreachable!("checker guaranteed bool-or-null"),
    }
}
fn as_i32(v: Val<'_>) -> Option<i32> {
    match v {
        Val::I(x) => x,
        Val::Null => None,
        _ => unreachable!("checker guaranteed int"),
    }
}
fn as_i64(v: Val<'_>) -> Option<i64> {
    match v {
        Val::I(x) => x.map(i64::from),
        Val::L(x) => x,
        Val::Null => None,
        _ => unreachable!("checker guaranteed long"),
    }
}
fn as_f64(v: Val<'_>) -> Option<f64> {
    match v {
        Val::I(x) => x.map(f64::from),
        Val::L(x) => x.map(|v| v as f64),
        Val::D(x) => x,
        Val::Null => None,
        _ => unreachable!("checker guaranteed double"),
    }
}
fn as_str(v: Val<'_>) -> Option<Cow<'_, str>> {
    match v {
        Val::S(s) => s,
        Val::Null => None,
        _ => unreachable!("checker guaranteed string"),
    }
}
fn as_highway(v: Val<'_>) -> u32 {
    match v {
        Val::H(h) => h,
        _ => unreachable!("checker guaranteed highway"),
    }
}
