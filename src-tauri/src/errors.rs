use serde::Serialize;
use std::io;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) enum ErrorCategory {
    AccessDenied,
    InvalidPath,
    Conflict,
    NotFound,
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    category: ErrorCategory,
    code: String,
    message: String,
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;

impl CommandError {
    pub(crate) fn category(&self) -> &ErrorCategory {
        &self.category
    }

    pub(crate) fn code(&self) -> &str {
        &self.code
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl CommandError {
    pub(crate) fn invalid_path(code: &str, message: impl Into<String>) -> Self {
        Self {
            category: ErrorCategory::InvalidPath,
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn access_denied(code: &str, message: impl Into<String>) -> Self {
        Self {
            category: ErrorCategory::AccessDenied,
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn conflict(code: &str, message: impl Into<String>) -> Self {
        Self {
            category: ErrorCategory::Conflict,
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn not_found(code: &str, message: impl Into<String>) -> Self {
        Self {
            category: ErrorCategory::NotFound,
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn internal(code: &str, message: impl Into<String>) -> Self {
        Self {
            category: ErrorCategory::Internal,
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn from_io(code_prefix: &str, error: &io::Error, context: impl Into<String>) -> Self {
        let message = context.into();
        let detail = format!("{message}: {error}");
        match error.kind() {
            io::ErrorKind::NotFound => Self::not_found(&format!("{code_prefix}.not_found"), detail),
            io::ErrorKind::PermissionDenied => {
                Self::access_denied(&format!("{code_prefix}.access_denied"), detail)
            }
            io::ErrorKind::AlreadyExists => Self::conflict(&format!("{code_prefix}.already_exists"), detail),
            io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => {
                Self::invalid_path(&format!("{code_prefix}.invalid_input"), detail)
            }
            _ => Self::internal(&format!("{code_prefix}.internal"), detail),
        }
    }

    pub(crate) fn from_text(message: impl Into<String>) -> Self {
        let text = message.into();
        let lower = text.to_lowercase();
        if lower.contains("invalid relative path")
            || lower.contains("path is not within project root")
            || lower.contains("project root path is required")
            || lower.contains("relative path is required")
            || lower.contains("unable to resolve path")
            || lower.contains("file path is required")
        {
            return Self::invalid_path("path.invalid", text);
        }
        if lower.contains("permission denied") || lower.contains("access is denied") {
            return Self::access_denied("io.access_denied", text);
        }
        if lower.contains("already exists") || lower.contains("directory not empty") {
            return Self::conflict("io.conflict", text);
        }
        if lower.contains("not found")
            || lower.contains("cannot find")
            || lower.contains("no such file")
        {
            return Self::not_found("io.not_found", text);
        }
        Self::internal("internal.unclassified", text)
    }
}

impl From<String> for CommandError {
    fn from(value: String) -> Self {
        Self::from_text(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_text_detects_invalid_path() {
        let error = CommandError::from_text("Path is not within project root.");
        assert!(matches!(error.category, ErrorCategory::InvalidPath));
        assert_eq!(error.code(), "path.invalid");
    }

    #[test]
    fn from_io_detects_not_found() {
        let err = io::Error::new(io::ErrorKind::NotFound, "missing");
        let classified = CommandError::from_io("manifest.read", &err, "Unable to read manifest");
        assert!(matches!(classified.category, ErrorCategory::NotFound));
    }
}
