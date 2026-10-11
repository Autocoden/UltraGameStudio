use super::catalog::{FoundSkill, Root};
use super::service::{hash, read_package, Snapshot};
use super::types::SkillOrigin;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::time::Duration;

/// An IMMEDIATE transaction is the single root's cross-process read/write gate.
/// Filesystem intents (not uncommitted SQLite rows) survive a killed process.
pub(super) struct RootGuard {
    pub root: Root,
    pub conn: Connection,
}

impl RootGuard {
    pub fn open(root: &Root) -> Result<Self, String> {
        super::validation::safe_chain(&root.path)?;
        let state = root.path.join(".state");
        super::validation::safe_chain(&state)?;
        std::fs::create_dir_all(&state).map_err(|e| e.to_string())?;
        let db = state.join("index.sqlite");
        super::validation::safe_chain(&db)?;
        let conn = Connection::open(db).map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::from_secs(30))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, origin TEXT NOT NULL, skill_id TEXT NOT NULL, file_path TEXT NOT NULL, revision TEXT NOT NULL, hash TEXT NOT NULL, full_read INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata(skill_id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage_events(id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, origin TEXT NOT NULL, value TEXT NOT NULL);
            BEGIN IMMEDIATE;").map_err(|e| e.to_string())?;
        let guard = Self {
            root: root.clone(),
            conn,
        };
        super::transactions::recover(&guard)?;
        Ok(guard)
    }

    pub fn save_receipt(
        &self,
        id: &str,
        origin: &SkillOrigin,
        skill_id: &str,
        file_path: &str,
        revision: &str,
        file_hash: &str,
    ) -> Result<(), String> {
        self.conn.execute("INSERT INTO receipts(id,origin,skill_id,file_path,revision,hash,full_read) VALUES(?1,?2,?3,?4,?5,?6,1)", params![id, serde_json::to_string(origin).map_err(|e| e.to_string())?, skill_id, file_path, revision, file_hash]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn check_receipt(
        &self,
        origin: &SkillOrigin,
        skill_id: &str,
        file_path: &str,
        expected_hash: &str,
        id: &str,
        snapshot: &Snapshot,
    ) -> Result<(), String> {
        let row: Option<(String,String,String,String,String,bool)> = self.conn.query_row("SELECT origin,skill_id,file_path,revision,hash,full_read FROM receipts WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|e| e.to_string())?;
        let (saved_origin, saved_id, saved_path, revision, saved_hash, full_read) =
            row.ok_or("unknown complete read receipt")?;
        let original: SkillOrigin =
            serde_json::from_str(&saved_origin).map_err(|e| e.to_string())?;
        if &original != origin
            || saved_id != skill_id
            || saved_path != file_path
            || saved_hash != expected_hash
            || !full_read
        {
            return Err("complete read receipt does not match exact origin/target/hash".into());
        }
        let bytes = snapshot.get(file_path).ok_or("CAS target absent")?;
        if hash(bytes) != expected_hash || super::service::package_hash(snapshot) != revision {
            return Err("CAS conflict: content changed since complete read".into());
        }
        Ok(())
    }

    pub fn usage(
        &self,
        origin: &SkillOrigin,
        id: &str,
        revision: &str,
        kind: &str,
        evidence_ids: &[String],
    ) -> Result<SkillMetadata, String> {
        let key = super::catalog::identity(&[
            &serde_json::to_string(origin).map_err(|e| e.to_string())?,
            id,
            revision,
            kind,
            &serde_json::to_string(evidence_ids).map_err(|e| e.to_string())?,
        ]);
        let inserted = self
            .conn
            .execute("INSERT OR IGNORE INTO usage_events(id) VALUES(?1)", [key])
            .map_err(|e| e.to_string())?;
        let mut meta = self.metadata(id)?;
        if inserted > 0 {
            match kind {
                "viewed" => meta.usage.viewed += 1,
                "delivered" => meta.usage.delivered += 1,
                "used-with-evidence" => meta.usage.used_with_evidence += 1,
                _ => return Err("unknown usage kind".into()),
            }
            meta.usage.last_activity_at = Some(super::transactions::now());
            self.save_metadata(id, &meta)?;
        }
        Ok(meta)
    }

    pub fn metadata(&self, id: &str) -> Result<SkillMetadata, String> {
        let value: Option<String> = self
            .conn
            .query_row("SELECT value FROM metadata WHERE skill_id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        value
            .map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .unwrap_or_else(|| Ok(SkillMetadata::default()))
    }

    pub fn save_metadata(&self, id: &str, value: &SkillMetadata) -> Result<(), String> {
        self.conn.execute("INSERT INTO metadata(skill_id,value) VALUES(?1,?2) ON CONFLICT(skill_id) DO UPDATE SET value=excluded.value", params![id, serde_json::to_string(value).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_result(&self, value: &super::types::SkillMutationResult) -> Result<(), String> {
        self.conn.execute("INSERT INTO batches(id,origin,value) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value", params![value.batch_id, serde_json::to_string(&value.origin).map_err(|e| e.to_string())?, serde_json::to_string(value).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn commit(&self) -> Result<(), String> {
        self.conn.execute_batch("COMMIT").map_err(|e| e.to_string())
    }
}

impl Drop for RootGuard {
    fn drop(&mut self) {
        let _ = self.conn.execute_batch("ROLLBACK");
    }
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub(super) struct SkillMetadata {
    pub auto_editable: bool,
    pub content_locked: bool,
    pub pinned: bool,
    pub usage: super::types::SkillUsage,
    pub archived: bool,
    pub entry: Option<super::types::SkillEntry>,
    pub imported_from: Option<String>,
    #[serde(default)]
    pub archive_batch_id: Option<String>,
}

pub(super) fn target_snapshot(found: &FoundSkill) -> Result<Snapshot, String> {
    read_package(&found.root.path.join(&found.relative_path))
}

pub(super) fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    super::validation::safe_chain(path)?;
    if let Some(parent) = path.parent() {
        super::validation::safe_chain(parent)?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
