pub mod ast;
pub mod compile;
pub mod decompose;
pub mod error;
pub mod expand;
pub mod highway;
pub mod lexer;
pub mod parser;
pub mod props;
pub mod token;
use compile::{eval, Checker, TExpr, Ty, Val};
pub use decompose::neighbor_only_expression;
use error::ExprError;
pub use expand::expand;
use vali_core::Location;
pub struct CompiledBool {
    texpr: TExpr,
    uses_parent: bool,
}
impl CompiledBool {
    pub fn eval(&self, loc: &Location) -> bool {
        assert!(
            !self.uses_parent,
            "expression uses current:; call eval_with_parent"
        );
        match eval(&self.texpr, loc, None) {
            Val::B(Some(b)) => b,
            _ => unreachable!(),
        }
    }
    pub fn eval_with_parent(&self, loc: &Location, parent: &Location) -> bool {
        match eval(&self.texpr, loc, Some(parent)) {
            Val::B(Some(b)) => b,
            _ => unreachable!(),
        }
    }
}
pub struct CompiledInt {
    texpr: TExpr,
}
impl CompiledInt {
    pub fn eval(&self, loc: &Location) -> i32 {
        match eval(&self.texpr, loc, None) {
            Val::I(Some(v)) => v,
            _ => unreachable!(),
        }
    }
}
pub fn compile_bool(expression: &str) -> Result<CompiledBool, ExprError> {
    compile_bool_inner(expression, false)
}
pub fn compile_bool_with_parent(expression: &str) -> Result<CompiledBool, ExprError> {
    compile_bool_inner(expression, true)
}
fn compile_bool_inner(expression: &str, allow_parent: bool) -> Result<CompiledBool, ExprError> {
    if expression == "*" {
        return Ok(CompiledBool {
            texpr: TExpr::ConstBool(true),
            uses_parent: false,
        });
    }
    let (texpr, ty) = check(expression, allow_parent)?;
    if ty != Ty::Bool {
        return Err(ExprError::new(
            expression,
            0,
            expression.len(),
            format!(
                "Failed to compile expression: expected a boolean expression but found {ty:?}."
            ),
        ));
    }
    Ok(CompiledBool {
        texpr,
        uses_parent: allow_parent,
    })
}
pub fn compile_int(expression: &str) -> Result<CompiledInt, ExprError> {
    if expression == "*" {
        return Ok(CompiledInt {
            texpr: TExpr::ConstInt(0),
        });
    }
    let (texpr, ty) = check(expression, false)?;
    if ty != Ty::Int {
        return Err(ExprError::new(
            expression,
            0,
            expression.len(),
            format!("Failed to compile expression: expected an int expression but found {ty:?}."),
        ));
    }
    Ok(CompiledInt { texpr })
}
fn check(expression: &str, allow_parent: bool) -> Result<(TExpr, Ty), ExprError> {
    let tokens = lexer::tokenize(expression)?;
    let node = parser::parse(&tokens, expression)?;
    let checker = Checker {
        expr: expression,
        allow_parent,
    };
    checker.check(&node)
}
