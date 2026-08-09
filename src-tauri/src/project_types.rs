use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTreeEntry {
    pub(crate) path: String,
    pub(crate) entry_type: String,
    pub(crate) depth: usize,
}
