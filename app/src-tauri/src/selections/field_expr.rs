//! The field expression language: field references, arithmetic, comparisons, parens and
//! a few functions, one expression wide. Parsed once per op, evaluated per row in the
//! store. Used to assign a computed value in a bulk set, and to score a location when
//! duplicates are merged or pruned.
//!
//! There is no boolean type. A comparison yields 1 or 0, so a predicate is a term you
//! can add to a score. Comparison semantics are [`compare_filter`]'s, so `>` here means
//! what `>` means in a filter.

use super::{compare_filter, FilterOp};
use crate::types::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Str(String),
    Field(String),
    /// `has(field)`: 1 when the field resolves to a non-null value, 0 otherwise. Never
    /// skips the row, which is the whole point -- absence is an answer, not a failure.
    Has(String),
    Neg(Box<Expr>),
    Bin(Op, Box<Expr>, Box<Expr>),
    Cmp(FilterOp, Box<Expr>, Box<Expr>),
    /// Lazy: only the taken branch is evaluated, so `if(has(x), x * 2, 0)` is safe.
    If(Box<Expr>, Box<Expr>, Box<Expr>),
    Call(Func, Vec<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Func {
    Mod,
    Clamp,
    Abs,
    Min,
    Max,
    Round,
    Floor,
}

impl Func {
    fn named(name: &str) -> Option<Func> {
        Some(match name {
            "mod" => Func::Mod,
            "clamp" => Func::Clamp,
            "abs" => Func::Abs,
            "min" => Func::Min,
            "max" => Func::Max,
            "round" => Func::Round,
            "floor" => Func::Floor,
            _ => return None,
        })
    }

    fn arity(self) -> usize {
        match self {
            Func::Clamp => 3,
            Func::Mod | Func::Min | Func::Max => 2,
            Func::Abs | Func::Round | Func::Floor => 1,
        }
    }

    fn apply(self, a: &[f64]) -> f64 {
        match self {
            Func::Mod => ((a[0] % a[1]) + a[1]) % a[1],
            Func::Clamp => a[0].max(a[1]).min(a[2]),
            Func::Abs => a[0].abs(),
            Func::Min => a[0].min(a[1]),
            Func::Max => a[0].max(a[1]),
            // JS Math.round: halves go up, so -2.5 rounds to -2.
            Func::Round => (a[0] + 0.5).floor(),
            Func::Floor => a[0].floor(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Str(String),
    Ident(String),
    Cmp(FilterOp),
    Op(char),
}

fn tokenize(src: &str) -> AppResult<Vec<Token>> {
    let chars: Vec<char> = src.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || c == '.' {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '.' {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let text: String = chars[start..i].iter().collect();
            match text.parse::<f64>() {
                Ok(v) if chars[i - 1].is_ascii_digit() => tokens.push(Token::Num(v)),
                _ => return Err(AppError(format!("Invalid number at position {start}"))),
            }
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(Token::Ident(chars[start..i].iter().collect()));
        } else if c == '"' {
            i += 1;
            let mut text = String::new();
            loop {
                let Some(&ch) = chars.get(i) else {
                    return Err(AppError("Unterminated string".into()));
                };
                i += 1;
                match ch {
                    '"' => break,
                    '\\' => {
                        let Some(&esc) = chars.get(i) else {
                            return Err(AppError("Unterminated string".into()));
                        };
                        i += 1;
                        text.push(esc);
                    }
                    _ => text.push(ch),
                }
            }
            tokens.push(Token::Str(text));
        } else if let Some((op, width)) = cmp_at(&chars, i) {
            tokens.push(Token::Cmp(op));
            i += width;
        } else if "+-*/%(),".contains(c) {
            tokens.push(Token::Op(c));
            i += 1;
        } else {
            return Err(AppError(format!(
                "Unexpected character \"{c}\" at position {i}"
            )));
        }
    }
    Ok(tokens)
}

/// How a comparison operator spells itself, for error text.
fn cmp_symbol(op: FilterOp) -> &'static str {
    match op {
        FilterOp::Neq => "!=",
        FilterOp::Gt => ">",
        FilterOp::Lt => "<",
        FilterOp::Gte => ">=",
        FilterOp::Lte => "<=",
        _ => "==",
    }
}

/// The comparison operator starting at `i`, with its width. Two-character forms are
/// tried first so `>=` never tokenizes as `>` followed by a stray `=`.
fn cmp_at(chars: &[char], i: usize) -> Option<(FilterOp, usize)> {
    let pair = (chars.get(i)?, chars.get(i + 1));
    match pair {
        ('=', Some('=')) => Some((FilterOp::Eq, 2)),
        ('!', Some('=')) => Some((FilterOp::Neq, 2)),
        ('>', Some('=')) => Some((FilterOp::Gte, 2)),
        ('<', Some('=')) => Some((FilterOp::Lte, 2)),
        ('>', _) => Some((FilterOp::Gt, 1)),
        ('<', _) => Some((FilterOp::Lt, 1)),
        _ => None,
    }
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn is_op(&self, c: char) -> bool {
        matches!(self.peek(), Some(Token::Op(o)) if *o == c)
    }

    fn expect_op(&mut self, c: char) -> AppResult<()> {
        if !self.is_op(c) {
            return Err(AppError(format!("Expected \"{c}\"")));
        }
        self.pos += 1;
        Ok(())
    }

    /// Comma-separated arguments up to and including the closing paren. The opening
    /// paren is already consumed.
    fn arg_list(&mut self) -> AppResult<Vec<Expr>> {
        let mut args = Vec::new();
        if !self.is_op(')') {
            args.push(self.comparison()?);
            while self.is_op(',') {
                self.pos += 1;
                args.push(self.comparison()?);
            }
        }
        self.expect_op(')')?;
        Ok(args)
    }

    /// One comparison, non-associative: `a < b < c` is a mistake, not a chain.
    fn comparison(&mut self) -> AppResult<Expr> {
        let left = self.additive()?;
        let Some(Token::Cmp(op)) = self.peek().cloned() else {
            return Ok(left);
        };
        self.pos += 1;
        let right = self.additive()?;
        if let Some(Token::Cmp(_)) = self.peek() {
            return Err(AppError("Comparisons do not chain; use parentheses".into()));
        }
        Ok(Expr::Cmp(op, Box::new(left), Box::new(right)))
    }

    fn additive(&mut self) -> AppResult<Expr> {
        let mut left = self.multiplicative()?;
        loop {
            let op = if self.is_op('+') {
                Op::Add
            } else if self.is_op('-') {
                Op::Sub
            } else {
                return Ok(left);
            };
            self.pos += 1;
            left = Expr::Bin(op, Box::new(left), Box::new(self.multiplicative()?));
        }
    }

    fn multiplicative(&mut self) -> AppResult<Expr> {
        let mut left = self.unary()?;
        loop {
            let op = if self.is_op('*') {
                Op::Mul
            } else if self.is_op('/') {
                Op::Div
            } else if self.is_op('%') {
                Op::Rem
            } else {
                return Ok(left);
            };
            self.pos += 1;
            left = Expr::Bin(op, Box::new(left), Box::new(self.unary()?));
        }
    }

    fn unary(&mut self) -> AppResult<Expr> {
        if self.is_op('-') {
            self.pos += 1;
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        self.primary()
    }

    fn primary(&mut self) -> AppResult<Expr> {
        let tok = self
            .peek()
            .cloned()
            .ok_or_else(|| AppError("Unexpected end of expression".into()))?;
        match tok {
            Token::Num(v) => {
                self.pos += 1;
                Ok(Expr::Num(v))
            }
            Token::Str(text) => {
                self.pos += 1;
                Ok(Expr::Str(text))
            }
            Token::Cmp(_) => Err(AppError("Expected a value before the comparison".into())),
            Token::Ident(name) => {
                self.pos += 1;
                if !self.is_op('(') {
                    return Ok(Expr::Field(name));
                }
                if name == "has" {
                    self.pos += 1;
                    let Some(Token::Ident(field)) = self.peek().cloned() else {
                        return Err(AppError("has() takes a field name".into()));
                    };
                    self.pos += 1;
                    self.expect_op(')')?;
                    return Ok(Expr::Has(field));
                }
                if name == "if" {
                    self.pos += 1;
                    let args = self.arg_list()?;
                    let [cond, then, otherwise]: [Expr; 3] = args
                        .try_into()
                        .map_err(|_| AppError("if() takes 3 arguments".into()))?;
                    return Ok(Expr::If(
                        Box::new(cond),
                        Box::new(then),
                        Box::new(otherwise),
                    ));
                }
                let func = Func::named(&name)
                    .ok_or_else(|| AppError(format!("Unknown function \"{name}\"")))?;
                self.pos += 1;
                let args = self.arg_list()?;
                let n = func.arity();
                if args.len() != n {
                    let noun = if n == 1 { "argument" } else { "arguments" };
                    return Err(AppError(format!("{name}() takes {n} {noun}")));
                }
                Ok(Expr::Call(func, args))
            }
            Token::Op('(') => {
                self.pos += 1;
                let inner = self.comparison()?;
                self.expect_op(')')?;
                Ok(inner)
            }
            Token::Op(c) => Err(AppError(format!("Unexpected \"{c}\""))),
        }
    }
}

/// Parse an expression such as `mod(sunAzimuth + 180, 360)`.
pub fn parse(src: &str) -> AppResult<Expr> {
    let mut p = Parser {
        tokens: tokenize(src)?,
        pos: 0,
    };
    let expr = p.comparison()?;
    if let Some(tok) = p.peek() {
        let text = match tok {
            Token::Num(v) => v.to_string(),
            Token::Str(s) | Token::Ident(s) => s.clone(),
            Token::Cmp(op) => cmp_symbol(*op).to_string(),
            Token::Op(c) => c.to_string(),
        };
        return Err(AppError(format!("Unexpected \"{text}\" after expression")));
    }
    Ok(expr)
}

/// Resolves a field name to its JSON value for one row. Missing and JSON `null` are
/// both absence.
pub type Resolver<'a> = dyn Fn(&str) -> Option<serde_json::Value> + 'a;

fn present(field: &Resolver, name: &str) -> Option<serde_json::Value> {
    field(name).filter(|v| !v.is_null())
}

/// Evaluate against one row. `None` when a referenced field is missing or not a
/// number, or the result is not finite: that row is skipped.
pub fn eval(expr: &Expr, field: &Resolver) -> Option<f64> {
    let v = eval_node(expr, field)?;
    v.is_finite().then_some(v)
}

/// A comparison operand keeps its JSON type, so `panoId == "abc"` compares strings and
/// `zoom > 1` compares numbers, both under [`compare_filter`]'s rules.
fn operand(expr: &Expr, field: &Resolver) -> Option<serde_json::Value> {
    match expr {
        Expr::Str(text) => Some(serde_json::Value::from(text.clone())),
        Expr::Field(name) => present(field, name),
        other => eval_node(other, field).map(serde_json::Value::from),
    }
}

fn eval_node(expr: &Expr, field: &Resolver) -> Option<f64> {
    Some(match expr {
        Expr::Num(v) => *v,
        // Bare strings are comparison operands; there is nothing numeric to yield.
        Expr::Str(_) => return None,
        Expr::Field(name) => present(field, name)?.as_f64()?,
        Expr::Has(name) => f64::from(u8::from(present(field, name).is_some())),
        Expr::Neg(arg) => -eval_node(arg, field)?,
        Expr::Bin(op, l, r) => {
            let l = eval_node(l, field)?;
            let r = eval_node(r, field)?;
            match op {
                Op::Add => l + r,
                Op::Sub => l - r,
                Op::Mul => l * r,
                Op::Div => l / r,
                Op::Rem => l % r,
            }
        }
        // An operand the row cannot supply makes the comparison false rather than
        // skipping the row: a score term for something absent is 0, not undefined.
        Expr::Cmp(op, l, r) => {
            let held = operand(l, field).zip(operand(r, field));
            let truth = held.is_some_and(|(l, r)| compare_filter(&l, *op, &r, None));
            f64::from(u8::from(truth))
        }
        Expr::If(cond, then, otherwise) => {
            let branch = if eval_node(cond, field)? != 0.0 {
                then
            } else {
                otherwise
            };
            eval_node(branch, field)?
        }
        Expr::Call(func, args) => {
            let mut vals = Vec::with_capacity(args.len());
            for a in args {
                vals.push(eval_node(a, field)?);
            }
            func.apply(&vals)
        }
    })
}

/// The parse error for `src`, or nothing when it parses. For the dialog's live check.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn field_expr_error(src: String) -> Option<String> {
    parse(&src).err().map(|e| e.0)
}

#[cfg(test)]
#[path = "field_expr.test.rs"]
mod tests;
