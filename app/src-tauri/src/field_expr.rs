//! The bulk set-field expression language: field references, arithmetic, parens and a
//! few functions, one expression wide. The row set belongs to the selector and several
//! assignments are repeat runs. Parsed once per op, evaluated per row in the store.

use crate::types::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Field(String),
    Neg(Box<Expr>),
    Bin(Op, Box<Expr>, Box<Expr>),
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
    Ident(String),
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
            Token::Ident(name) => {
                self.pos += 1;
                if !self.is_op('(') {
                    return Ok(Expr::Field(name));
                }
                let func = Func::named(&name)
                    .ok_or_else(|| AppError(format!("Unknown function \"{name}\"")))?;
                self.pos += 1;
                let mut args = Vec::new();
                if !self.is_op(')') {
                    args.push(self.additive()?);
                    while self.is_op(',') {
                        self.pos += 1;
                        args.push(self.additive()?);
                    }
                }
                self.expect_op(')')?;
                let n = func.arity();
                if args.len() != n {
                    let noun = if n == 1 { "argument" } else { "arguments" };
                    return Err(AppError(format!("{name}() takes {n} {noun}")));
                }
                Ok(Expr::Call(func, args))
            }
            Token::Op('(') => {
                self.pos += 1;
                let inner = self.additive()?;
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
    let expr = p.additive()?;
    if let Some(tok) = p.peek() {
        let text = match tok {
            Token::Num(v) => v.to_string(),
            Token::Ident(s) => s.clone(),
            Token::Op(c) => c.to_string(),
        };
        return Err(AppError(format!("Unexpected \"{text}\" after expression")));
    }
    Ok(expr)
}

/// Evaluate against one row. `None` when a referenced field is missing or not a
/// number, or the result is not finite: that row is skipped.
pub fn eval(expr: &Expr, field: &dyn Fn(&str) -> Option<f64>) -> Option<f64> {
    let v = eval_node(expr, field)?;
    v.is_finite().then_some(v)
}

fn eval_node(expr: &Expr, field: &dyn Fn(&str) -> Option<f64>) -> Option<f64> {
    Some(match expr {
        Expr::Num(v) => *v,
        Expr::Field(name) => field(name)?,
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
#[tauri::command]
#[specta::specta]
pub fn field_expr_error(src: String) -> Option<String> {
    parse(&src).err().map(|e| e.0)
}

#[cfg(test)]
#[path = "field_expr.test.rs"]
mod tests;
