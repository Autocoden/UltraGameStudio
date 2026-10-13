use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillOrigin {
    pub host_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LearningMode {
    #[serde(rename = "auto-safe")]
    AutoSafe,
    #[serde(rename = "approve-all")]
    ApproveAll,
    #[serde(rename = "off")]
    Off,
}

/// Supplied by trusted Rust orchestration, never a model-controlled field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillActor {
    Background,
    User,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillUsage {
    pub viewed: u64,
    pub delivered: u64,
    pub used_with_evidence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillEntry {
    pub skill_id: String,
    pub root_id: String,
    pub name: String,
    pub description: String,
    pub scope: String,
    pub source: String,
    pub relative_path: String,
    pub revision: String,
    pub hash: String,
    pub read_only: bool,
    pub auto_editable: bool,
    pub content_locked: bool,
    pub pinned: bool,
    pub state: String,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SkillUsage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillEvidence {
    pub evidence_id: String,
    pub origin: SkillOrigin,
    pub occurred_at: u64,
    pub kind: String,
    pub provenance: String,
    pub status: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum SkillOperation {
    #[serde(rename = "create")]
    Create { name: String, content: String },
    #[serde(rename = "patch", rename_all = "camelCase")]
    Patch {
        skill_id: String,
        #[serde(default)]
        file_path: Option<String>,
        old_string: String,
        new_string: String,
        expected_hash: String,
        read_receipt_id: String,
    },
    #[serde(rename = "write_file", rename_all = "camelCase")]
    WriteFile {
        skill_id: String,
        file_path: String,
        content: String,
        #[serde(default)]
        expected_hash: Option<String>,
        #[serde(default)]
        read_receipt_id: Option<String>,
        #[serde(default)]
        absent: Option<bool>,
    },
    #[serde(rename = "remove_file", rename_all = "camelCase")]
    RemoveFile {
        skill_id: String,
        file_path: String,
        expected_hash: String,
        read_receipt_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillProposal {
    pub version: u8,
    pub kind: String,
    pub lesson: String,
    pub evidence_ids: Vec<String>,
    pub operations: Vec<SkillOperation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillDiff {
    pub skill_id: String,
    pub name: String,
    pub file_path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillMutationResult {
    pub status: String,
    pub batch_id: String,
    pub origin: SkillOrigin,
    pub lesson: String,
    pub operations_applied: usize,
    pub changes: Vec<SkillDiff>,
    pub risk_reasons: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_editable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillServiceRequest {
    pub action: String,
    pub origin: SkillOrigin,
    #[serde(default)]
    pub mode: Option<LearningMode>,
    #[serde(default)]
    pub evidence: Vec<SkillEvidence>,
    #[serde(default)]
    pub proposal: Option<SkillProposal>,
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub rollback_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub policy: Option<SkillPolicy>,
    #[serde(default)]
    pub source_skill_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCatalog {
    pub revision: String,
    pub entries: Vec<SkillEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillReadResult {
    pub entry: SkillEntry,
    pub relative_path: String,
    pub content: String,
    pub revision: String,
    pub hash: String,
    pub full_read: bool,
    pub read_receipt_id: String,
    pub files: Vec<String>,
}
