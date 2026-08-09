use crate::errors::{CommandError, CommandResult};
use crate::path_guard;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedExecutionBoundary {
    pub(crate) project_id: String,
    pub(crate) project_root: PathBuf,
    pub(crate) executable: String,
}

pub(crate) fn validate_execution_boundary(
    project_id: &str,
    root_path: &str,
    executable: Option<&str>,
    default_executable: &str,
    allowed_executables: &[&str],
    code_prefix: &str,
) -> CommandResult<ValidatedExecutionBoundary> {
    let trimmed_project_id = validate_project_id(project_id, code_prefix)?;
    let project_root = validate_project_root(root_path, code_prefix)?;
    let normalized_executable = validate_allowlisted_executable(
        executable,
        default_executable,
        allowed_executables,
        code_prefix,
    )?;

    Ok(ValidatedExecutionBoundary {
        project_id: trimmed_project_id.to_string(),
        project_root,
        executable: normalized_executable,
    })
}

pub(crate) fn validate_project_id(project_id: &str, code_prefix: &str) -> CommandResult<String> {
    let trimmed_project_id = project_id.trim();
    if trimmed_project_id.is_empty() {
        return Err(CommandError::invalid_path(
            &format!("{code_prefix}.invalid_request"),
            "Project id is required.",
        ));
    }
    Ok(trimmed_project_id.to_string())
}

pub(crate) fn validate_project_root(root_path: &str, code_prefix: &str) -> CommandResult<PathBuf> {
    path_guard::resolve_project_root(root_path).map_err(|error| {
        CommandError::invalid_path(
            &format!("{code_prefix}.project_context_mismatch"),
            format!("Invalid execution project root: {error}"),
        )
    })
}

pub(crate) fn validate_allowlisted_executable(
    executable: Option<&str>,
    default_executable: &str,
    allowed_executables: &[&str],
    code_prefix: &str,
) -> CommandResult<String> {
    let normalized_executable = executable
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .unwrap_or_else(|| default_executable.to_string());

    if allowed_executables
        .iter()
        .any(|allowed| *allowed == normalized_executable)
    {
        return Ok(normalized_executable);
    }

    Err(CommandError::access_denied(
        &format!("{code_prefix}.permission_denied"),
        format!("Executable entry is not allowlisted: {normalized_executable}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_execution_boundary_rejects_empty_project_id() {
        let result = validate_execution_boundary(
            " ",
            &std::env::temp_dir().to_string_lossy(),
            None,
            "pwsh.exe",
            &["pwsh.exe"],
            "terminal",
        );
        assert!(result.is_err());
    }

    #[test]
    fn validate_execution_boundary_rejects_non_allowlisted_executable() {
        let result = validate_execution_boundary(
            "project-a",
            &std::env::temp_dir().to_string_lossy(),
            Some("python.exe"),
            "pwsh.exe",
            &["pwsh.exe", "powershell.exe"],
            "terminal",
        );
        assert!(result.is_err());
    }

    #[test]
    fn validate_execution_boundary_supports_terminal_and_node_runtime_prefixes() {
        let root = std::env::temp_dir().to_string_lossy().to_string();
        let terminal = validate_execution_boundary(
            "project-a",
            &root,
            Some("pwsh.exe"),
            "pwsh.exe",
            &["pwsh.exe", "powershell.exe"],
            "terminal",
        )
        .expect("terminal boundary should validate");
        assert_eq!(terminal.project_id, "project-a");

        let node = validate_execution_boundary(
            "project-a",
            &root,
            Some("node"),
            "node",
            &["node", "bun"],
            "node_graph",
        )
        .expect("node boundary should validate");
        assert_eq!(node.executable, "node");
    }
}
