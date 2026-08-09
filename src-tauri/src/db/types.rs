use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Per-project domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectMeta {
    pub instance_id: String,
    pub name: String,
    pub app_version: String,
    pub language: Option<String>,
    pub framework: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Piece {
    pub id: i64,
    pub file_path: String,
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub color: Option<String>,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Group {
    pub id: String,
    pub name: String,
    pub folder_path: Option<String>,
    pub is_collapsed: bool,
    pub parent_id: Option<String>,
    pub theme_id: Option<String>,
    pub color: Option<String>,
    // Seed geometry for memberless manual groups (ADR-018 box-first);
    // NULL for folder-backed groups.
    pub seed_x: Option<f64>,
    pub seed_y: Option<f64>,
    pub seed_w: Option<f64>,
    pub seed_h: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupPiece {
    pub group_id: String,
    pub piece_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection {
    pub id: i64,
    pub from_piece_id: i64,
    pub to_piece_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Viewport {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

/// Full project state returned by `open_project` / `bootstrap_project`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectState {
    pub project: ProjectMeta,
    pub pieces: Vec<Piece>,
    pub groups: Vec<Group>,
    pub group_pieces: Vec<GroupPiece>,
    pub connections: Vec<Connection>,
    pub editor_state: HashMap<String, String>,
    pub hidden_paths: Vec<String>,
    pub viewport: Option<Viewport>,
}

// ---------------------------------------------------------------------------
// Command input types (from JavaScript → Rust)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PieceInput {
    pub file_path: String,
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub color: Option<String>,
    pub scale: Option<f64>,
    pub is_hidden: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PieceMove {
    pub id: i64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PieceUpdate {
    pub file_path: Option<String>,
    pub label: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub scale: Option<f64>,
    pub color: Option<String>,
    pub is_hidden: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupInput {
    pub id: String,
    pub name: String,
    pub folder_path: Option<String>,
    pub is_collapsed: Option<bool>,
    pub parent_id: Option<String>,
    pub theme_id: Option<String>,
    pub color: Option<String>,
    pub seed_x: Option<f64>,
    pub seed_y: Option<f64>,
    pub seed_w: Option<f64>,
    pub seed_h: Option<f64>,
}

/// Distinguishes "field absent" (outer None — leave column untouched) from
/// "field explicitly null" (Some(None) — clear the column). A plain
/// `Option<String>` deserializes JSON null to None, silently turning
/// clear-requests into no-ops (found 2026-07-26: un-nest never cleared
/// parent_id).
fn deserialize_explicit_null<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupUpdate {
    pub name: Option<String>,
    pub folder_path: Option<String>,
    pub is_collapsed: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_explicit_null")]
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_explicit_null")]
    pub theme_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_explicit_null")]
    pub color: Option<Option<String>>,
    // Seed geometry (schema v3). Plain Option: senders always supply concrete
    // numbers (drag translation of an empty group); no clear-to-NULL path.
    pub seed_x: Option<f64>,
    pub seed_y: Option<f64>,
}

// ---------------------------------------------------------------------------
// App-level types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: String,
    pub framework: Option<String>,
    pub pinned: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    // The explicit-null wrapper is what makes "clear this column" expressible:
    // a plain Option<String> deserializes {"parentId":null} identically to an
    // absent field, silently dropping clear-requests (un-nest never cleared
    // parent_id until 2026-07-26).
    #[test]
    fn group_update_distinguishes_absent_from_explicit_null() {
        let absent: GroupUpdate = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert!(absent.parent_id.is_none());
        assert!(absent.theme_id.is_none());
        assert!(absent.color.is_none());

        let cleared: GroupUpdate =
            serde_json::from_str(r#"{"parentId":null,"themeId":null,"color":null}"#).unwrap();
        assert!(matches!(cleared.parent_id, Some(None)));
        assert!(matches!(cleared.theme_id, Some(None)));
        assert!(matches!(cleared.color, Some(None)));

        let set: GroupUpdate = serde_json::from_str(r#"{"parentId":"group-1"}"#).unwrap();
        assert!(matches!(set.parent_id, Some(Some(ref s)) if s == "group-1"));
        assert!(set.theme_id.is_none());
    }
}
