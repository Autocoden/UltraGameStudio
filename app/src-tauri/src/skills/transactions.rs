use super::catalog::Root;
use super::service::{hash, opaque_id, package_hash, read_package, Snapshot};
use super::state::{write_synced, RootGuard, SkillMetadata};
use super::types::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PackageChange {
    pub relative_path: String,
    pub skill_id: String,
    pub name: String,
    pub before: Snapshot,
    pub after: Snapshot,
    pub before_metadata: SkillMetadata,
    pub after_metadata: SkillMetadata,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Batch {
    pub version: u8,
    pub root_id: String,
    pub result: SkillMutationResult,
    pub packages: Vec<PackageChange>,
    pub evidence: Vec<SkillEvidence>,
    pub proposal: Option<SkillProposal>,
}

pub(super) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn result(origin: &SkillOrigin, lesson: &str) -> Result<SkillMutationResult, String> {
    Ok(SkillMutationResult {
        status: "failed".into(),
        batch_id: opaque_id()?,
        origin: origin.clone(),
        lesson: lesson.into(),
        operations_applied: 0,
        changes: vec![],
        risk_reasons: vec![],
        revision: None,
        rollback_id: None,
        error: None,
        created_at: Some(now()),
    })
}

pub(super) fn directory(root: &Root, id: &str) -> Result<PathBuf, String> {
    if id.len() != 48
        || !id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("invalid opaque batch id".into());
    }
    let path = root.path.join(".state/transactions").join(id);
    super::validation::safe_chain(&path)?;
    Ok(path)
}

pub(super) fn validate_batch(batch: &Batch, root: &Root) -> Result<(), String> {
    if batch.version != 1 || batch.root_id != root.root_id || batch.packages.is_empty() {
        return Err("invalid frozen transaction/root".into());
    }
    let mut names = std::collections::BTreeSet::new();
    for p in &batch.packages {
        super::validation::component(&p.relative_path)?;
        if p.relative_path.starts_with('.') || !names.insert(p.relative_path.to_lowercase()) {
            return Err("reserved or duplicate package path".into());
        }
        package_path(root, &p.relative_path)?;
        for snapshot in [&p.before, &p.after] {
            for path in snapshot.keys() {
                for part in path.split('/') {
                    super::validation::component(part)?;
                }
            }
            if !snapshot.is_empty() && !snapshot.contains_key("SKILL.md") {
                return Err("snapshot missing SKILL.md".into());
            }
        }
    }
    Ok(())
}

pub(super) fn package_path(root: &Root, relative: &str) -> Result<PathBuf, String> {
    super::validation::component(relative)?;
    if relative.starts_with('.') {
        return Err("reserved package path".into());
    }
    if root.path.is_dir() {
        for entry in std::fs::read_dir(&root.path).map_err(|e| e.to_string())? {
            let name = entry
                .map_err(|e| e.to_string())?
                .file_name()
                .to_string_lossy()
                .into_owned();
            if name.to_lowercase() == relative.to_lowercase() && name != relative {
                return Err("case-insensitive package alias rejected".into());
            }
        }
    }
    let path = root.path.join(relative);
    super::validation::safe_chain(&path)?;
    Ok(path)
}

pub(super) fn write_snapshot(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    super::validation::safe_chain(path)?;
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    for (relative, bytes) in snapshot {
        for component in relative.split('/') {
            super::validation::component(component)?;
        }
        write_synced(&path.join(relative), bytes)?;
    }
    if read_package(path)? != *snapshot {
        return Err("staging readback/hash mismatch".into());
    }
    Ok(())
}

fn marker(path: &Path, name: &str, value: &[u8]) -> Result<(), String> {
    let path = path.join(name);
    if path.exists() {
        return Ok(());
    }
    write_synced(&path, value)
}

pub(super) fn save_batch(root: &Root, batch: &Batch) -> Result<PathBuf, String> {
    validate_batch(batch, root)?;
    let dir = directory(root, &batch.result.batch_id)?;
    super::validation::safe_chain(&dir)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_synced(
        &dir.join("intent.json"),
        &serde_json::to_vec(batch).map_err(|e| e.to_string())?,
    )?;
    for p in &batch.packages {
        write_snapshot(&dir.join("before").join(&p.relative_path), &p.before)?;
        write_snapshot(&dir.join("after").join(&p.relative_path), &p.after)?;
        write_snapshot(&dir.join("stage").join(&p.relative_path), &p.after)?;
    }
    marker(&dir, "prepared", b"all snapshots validated and synced")?;
    Ok(dir)
}

fn replace(root: &Root, dir: &Path, p: &PackageChange) -> Result<(), String> {
    let target = package_path(root, &p.relative_path)?;
    let backup = dir.join("backup").join(&p.relative_path);
    super::validation::safe_chain(&backup)?;
    if target.exists() {
        std::fs::create_dir_all(backup.parent().ok_or("missing backup parent")?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&target, &backup)
            .map_err(|e| format!("package backup rename failed: {e}"))?;
    }
    if !p.after.is_empty() {
        let stage = dir.join("stage").join(&p.relative_path);
        super::validation::safe_chain(&stage)?;
        std::fs::rename(stage, &target)
            .map_err(|e| format!("package publish rename failed: {e}"))?;
    }
    Ok(())
}

fn restore_before(root: &Root, dir: &Path, batch: &Batch) -> Result<(), String> {
    // CAS every recovery target before restoring any: do not erase manual edits.
    for p in &batch.packages {
        let current = read_package(&package_path(root, &p.relative_path)?)?;
        if !current.is_empty() && current != p.before && current != p.after {
            return Err("recovery CAS conflict: unexpected external edit; backups retained".into());
        }
        if read_package(&dir.join("before").join(&p.relative_path))? != p.before {
            return Err("recovery before snapshot hash mismatch; backups retained".into());
        }
    }
    for p in &batch.packages {
        let target = package_path(root, &p.relative_path)?;
        if read_package(&target)? == p.before {
            continue;
        }
        let restore = dir
            .join(format!("restore-{}", opaque_id()?))
            .join(&p.relative_path);
        if !p.before.is_empty() {
            write_snapshot(&restore, &p.before)?;
        }
        if target.exists() {
            let removed = dir.join(format!("discard-{}", opaque_id()?));
            super::validation::safe_chain(&removed)?;
            std::fs::rename(&target, removed)
                .map_err(|e| format!("recovery rename failed: {e}; backups retained"))?;
        }
        if !p.before.is_empty() {
            std::fs::rename(restore, &target)
                .map_err(|e| format!("recovery publish failed: {e}; backups retained"))?;
        }
        if read_package(&target)? != p.before {
            return Err("recovery readback mismatch; backups retained".into());
        }
    }
    Ok(())
}

pub(super) fn execute(guard: &RootGuard, mut batch: Batch) -> Result<SkillMutationResult, String> {
    validate_batch(&batch, &guard.root)?;
    for p in &batch.packages {
        if read_package(&package_path(&guard.root, &p.relative_path)?)? != p.before {
            return Err("CAS conflict: package changed before commit".into());
        }
    }
    let existing = directory(&guard.root, &batch.result.batch_id)?;
    let dir = if existing.join("intent.json").exists() {
        if existing.join("applying").exists() || existing.join("rejected.json").exists() {
            return Err("transaction already started or rejected".into());
        }
        for p in &batch.packages {
            if read_package(&existing.join("stage").join(&p.relative_path))? != p.after
                || read_package(&existing.join("before").join(&p.relative_path))? != p.before
            {
                return Err("frozen approval snapshots changed".into());
            }
        }
        existing
    } else {
        save_batch(&guard.root, &batch)?
    };
    // Approval can refresh host policy after the pending intent was saved.
    // Persist the exact committed metadata before the first package publish.
    let committed = serde_json::to_vec(&batch).map_err(|e| e.to_string())?;
    let committed_path = dir.join("commit.json");
    super::validation::safe_chain(&committed_path)?;
    if committed_path.exists() {
        if std::fs::read(&committed_path).map_err(|e| e.to_string())? != committed {
            return Err("frozen commit metadata differs; explicit recovery required".into());
        }
    } else {
        write_synced(&committed_path, &committed)?;
    }
    marker(&dir, "applying", b"commit critical section started")?;
    let applied = (|| {
        for (index, p) in batch.packages.iter().enumerate() {
            replace(&guard.root, &dir, p)?;
            // Test-only process checkpoint: the parent kills a genuine
            // service writer mid-batch while another service reader waits.
            #[cfg(test)]
            if index == 0
                && matches!(
                    std::env::var("UGS_SKILL_PROCESS_MODE").as_deref(),
                    Ok("crash-writer" | "revoke-after-commit")
                )
            {
                if let Some(base) = std::env::var_os("UGS_SKILL_PROCESS_FIXTURE") {
                    let base = PathBuf::from(base);
                    if base.starts_with("C:/Users/fengwei/AppData/Local/hermes/cache/scratch/ugs-autoskill-build-20261009") {
                        write_synced(&base.join("published-first"), b"first package published; root gate still held")?;
                        while !base.join("release-writer").exists() {
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                    }
                }
            }
            #[cfg(not(test))]
            let _ = index;
        }
        for p in &batch.packages {
            if read_package(&package_path(&guard.root, &p.relative_path)?)? != p.after {
                return Err("committed package readback/hash mismatch".into());
            }
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = applied {
        batch.result.error = Some(error);
        batch.result.operations_applied = 0;
        match restore_before(&guard.root, &dir, &batch) {
            Ok(()) => {
                batch.result.status = "failed".into();
                marker(
                    &dir,
                    "restored.json",
                    &serde_json::to_vec(&batch.result).map_err(|e| e.to_string())?,
                )?;
            }
            Err(recovery) => {
                batch.result.status = "needs_recovery".into();
                batch.result.error = Some(format!(
                    "{}; {recovery}",
                    batch.result.error.as_deref().unwrap_or("commit failed")
                ));
                marker(
                    &dir,
                    "needs-recovery.json",
                    &serde_json::to_vec(&batch.result).map_err(|e| e.to_string())?,
                )?;
            }
        }
    } else {
        batch.result.status = "applied".into();
        batch.result.operations_applied = batch
            .proposal
            .as_ref()
            .map_or(batch.packages.len(), |p| p.operations.len());
        batch.result.rollback_id = Some(batch.result.batch_id.clone());
        batch.result.revision = Some(hash(
            batch
                .packages
                .iter()
                .map(|p| package_hash(&p.after))
                .collect::<String>()
                .as_bytes(),
        ));
        marker(
            &dir,
            "applied.json",
            &serde_json::to_vec(&batch.result).map_err(|e| e.to_string())?,
        )?;
        for p in &batch.packages {
            guard.save_metadata(&p.skill_id, &p.after_metadata)?;
        }
    }
    guard.save_result(&batch.result)?;
    guard.commit()?;
    Ok(batch.result)
}

/// Called while the root gate is held, before any catalog/file reader.
pub(super) fn recover(guard: &RootGuard) -> Result<(), String> {
    let base = guard.root.path.join(".state/transactions");
    super::validation::safe_chain(&base)?;
    if !base.exists() {
        return Ok(());
    }
    let mut dirs = std::fs::read_dir(base)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    dirs.sort_by_key(|e| e.file_name());
    for entry in dirs {
        let dir = entry.path();
        super::validation::safe_chain(&dir)?;
        if !dir.join("intent.json").is_file() {
            continue;
        }
        super::validation::safe_chain(&dir.join("intent.json"))?;
        let batch: Batch = serde_json::from_slice(
            &std::fs::read(dir.join("intent.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        validate_batch(&batch, &guard.root)?;
        for terminal in ["applied.json", "restored.json", "rejected.json"] {
            if dir.join(terminal).exists() {
                super::validation::safe_chain(&dir.join(terminal))?;
                let r: SkillMutationResult = serde_json::from_slice(
                    &std::fs::read(dir.join(terminal)).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                use rusqlite::OptionalExtension;
                let prior: Option<String> = guard
                    .conn
                    .query_row(
                        "SELECT value FROM batches WHERE id=?1",
                        [&r.batch_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let indexed_status = prior
                    .as_deref()
                    .map(serde_json::from_str::<SkillMutationResult>)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .map(|value| value.status);
                if indexed_status.as_deref() != Some(r.status.as_str()) {
                    if r.status == "applied" {
                        let committed_path = dir.join("commit.json");
                        super::validation::safe_chain(&committed_path)?;
                        let committed = if committed_path.is_file() {
                            let value: Batch = serde_json::from_slice(
                                &std::fs::read(committed_path).map_err(|e| e.to_string())?,
                            )
                            .map_err(|e| e.to_string())?;
                            validate_batch(&value, &guard.root)?;
                            if value.result.batch_id != batch.result.batch_id
                                || value.result.origin != batch.result.origin
                            {
                                return Err("committed intent identity mismatch".into());
                            }
                            value
                        } else {
                            batch.clone()
                        };
                        for p in &committed.packages {
                            guard.save_metadata(&p.skill_id, &p.after_metadata)?;
                        }
                    }
                    guard.save_result(&r)?;
                }
            }
        }
        if dir.join("applied.json").exists() || dir.join("restored.json").exists() {
            continue;
        }
        if dir.join("applying").exists() {
            if let Err(error) = restore_before(&guard.root, &dir, &batch) {
                let mut r = batch.result.clone();
                r.status = "needs_recovery".into();
                r.operations_applied = 0;
                r.error = Some(format!("needs_recovery: {error}"));
                marker(
                    &dir,
                    "needs-recovery.json",
                    &serde_json::to_vec(&r).map_err(|e| e.to_string())?,
                )?;
                guard.save_result(&r)?;
                // The caller cannot expose this root, but its failed recovery
                // record must survive the failing open and connection drop.
                guard.commit()?;
                return Err(r.error.unwrap_or(error));
            }
            let mut r = batch.result.clone();
            r.status = "failed".into();
            r.operations_applied = 0;
            r.error = Some("interrupted transaction restored before state".into());
            marker(
                &dir,
                "restored.json",
                &serde_json::to_vec(&r).map_err(|e| e.to_string())?,
            )?;
            guard.save_result(&r)?;
        }
    }
    Ok(())
}
