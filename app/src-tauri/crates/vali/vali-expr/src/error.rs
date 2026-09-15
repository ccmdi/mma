use std::fmt;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExprError {
    pub expression: String,
    pub position: usize,
    pub length: usize,
    pub message: String,
}
impl ExprError {
    pub fn new(
        expression: &str,
        position: usize,
        length: usize,
        message: impl Into<String>,
    ) -> ExprError {
        ExprError {
            expression: expression.to_string(),
            position,
            length,
            message: message.into(),
        }
    }
}
impl fmt::Display for ExprError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} (at {}..{} in `{}`)",
            self.message,
            self.position,
            self.position + self.length,
            self.expression
        )
    }
}
impl std::error::Error for ExprError {}
