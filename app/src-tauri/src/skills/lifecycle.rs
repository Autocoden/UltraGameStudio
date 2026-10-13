use super::service::SkillService;
use super::types::*;

pub(super) fn package_diffs(
    id: &str,
    name: &str,
    before: &super::service::Snapshot,
    after: &super::service::Snapshot,
) -> Vec<SkillDiff> {
    before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter_map(|path| {
            let b = before.get(path);
            let a = after.get(path);
            if b == a {
                return None;
            }
            Some(SkillDiff {
                skill_id: id.into(),
                name: name.into(),
                file_path: path.clone(),
                before: b.map(|v| String::from_utf8_lossy(v).into_owned()),
                after: a.map(|v| String::from_utf8_lossy(v).into_owned()),
                before_hash: b.map(|v| super::service::hash(v)),
                after_hash: a.map(|v| super::service::hash(v)),
            })
        })
        .collect()
}

impl SkillService {
    pub fn archive(&self, origin: &SkillOrigin, id: &str) -> Result<SkillEntry, String> {
        let grant = self.authority(origin)?;
        if grant.actor != SkillActor::User {
            return Err("archive is explicit user opt-in only".into());
        }
        let target = self
            .discover_bound(origin, &grant)?
            .into_iter()
            .find(|s| s.skill_id == id)
            .ok_or("unknown active skillId")?;
        if target.root.scope == "external" {
            return Err("external skill is read-only".into());
        }
        let guard = self.target_guard(&target)?;
        let before = super::state::target_snapshot(&target)?;
        let meta = guard.metadata(id)?;
        if meta.pinned {
            return Err("pinned skill cannot be archived".into());
        }
        let mut entry = super::service::entry_from(&target, &before, &meta)?;
        entry.state = "archived".into();
        let mut result = super::transactions::result(origin, &format!("Archive {}", entry.name))?;
        result.changes = package_diffs(id, &entry.name, &before, &super::service::Snapshot::new());
        let mut archived = meta.clone();
        archived.archived = true;
        archived.entry = Some(entry.clone());
        archived.archive_batch_id = Some(result.batch_id.clone());
        let batch = super::transactions::Batch {
            version: 1,
            root_id: target.root.root_id.clone(),
            result,
            packages: vec![super::transactions::PackageChange {
                relative_path: target.relative_path.clone(),
                skill_id: id.into(),
                name: target.name,
                before,
                after: super::service::Snapshot::new(),
                before_metadata: meta,
                after_metadata: archived,
            }],
            evidence: vec![],
            proposal: None,
        };
        let applied = super::transactions::execute(&guard, batch)?;
        if applied.status != "applied" {
            return Err(applied.error.unwrap_or(applied.status));
        }
        Ok(entry)
    }
    pub fn restore(&self, origin: &SkillOrigin, id: &str) -> Result<SkillEntry, String> {
        let grant = self.authority(origin)?;
        if grant.actor != SkillActor::User {
            return Err("restore requires explicit user authority".into());
        }
        for root in
            super::catalog::roots_for(&origin.host_id, grant.cwd.as_deref(), &self.global_root)?
                .into_iter()
                .filter(|r| r.scope != "external")
        {
            if !root.path.is_dir() {
                continue;
            }
            let guard = super::state::RootGuard::open(&root)?;
            let meta = guard.metadata(id)?;
            if !meta.archived {
                guard.commit()?;
                continue;
            }
            let entry = meta.entry.clone().ok_or("archive metadata missing entry")?;
            if entry.skill_id != id || entry.root_id != root.root_id {
                return Err("archive identity/root mismatch".into());
            }
            let batch_id = meta
                .archive_batch_id
                .as_deref()
                .ok_or("archive snapshot id missing")?;
            let dir = super::transactions::directory(&root, batch_id)?;
            let before = super::service::read_package(&super::transactions::package_path(
                &root,
                &entry.relative_path,
            )?)?;
            if !before.is_empty() || root.path.join(&entry.relative_path).exists() {
                return Err("CAS conflict: restore requires absent active package".into());
            }
            let snapshot =
                super::service::read_package(&dir.join("before").join(&entry.relative_path))?;
            if super::service::package_hash(&snapshot) != entry.revision {
                return Err("archive snapshot hash mismatch".into());
            }
            let mut restored = meta.clone();
            restored.archived = false;
            restored.archive_batch_id = None;
            let mut result =
                super::transactions::result(origin, &format!("Restore {}", entry.name))?;
            result.changes = package_diffs(id, &entry.name, &before, &snapshot);
            let batch = super::transactions::Batch {
                version: 1,
                root_id: root.root_id.clone(),
                result,
                packages: vec![super::transactions::PackageChange {
                    relative_path: entry.relative_path.clone(),
                    skill_id: id.into(),
                    name: entry.name.clone(),
                    before,
                    after: snapshot.clone(),
                    before_metadata: meta,
                    after_metadata: restored.clone(),
                }],
                evidence: vec![],
                proposal: None,
            };
            let applied = super::transactions::execute(&guard, batch)?;
            if applied.status != "applied" {
                return Err(applied.error.unwrap_or(applied.status));
            }
            let target = super::catalog::FoundSkill {
                root,
                skill_id: id.into(),
                relative_path: entry.relative_path,
                name: entry.name,
                description: entry.description,
            };
            return super::service::entry_from(&target, &snapshot, &restored);
        }
        Err("unknown archived skillId in origin".into())
    }
    pub fn import_skill(
        &self,
        origin: &SkillOrigin,
        source_id: &str,
    ) -> Result<SkillEntry, String> {
        let grant = self.authority(origin)?;
        if grant.actor != SkillActor::User {
            return Err("import requires explicit trusted user authority".into());
        }
        let source = self
            .discover_bound(origin, &grant)?
            .into_iter()
            .find(|s| s.skill_id == source_id)
            .ok_or("unknown external source skillId")?;
        if source.root.scope != "external" {
            return Err("only external read-only packages can be imported".into());
        }
        let snapshot = super::state::target_snapshot(&source)?;
        let root = self.create_root(origin, &grant)?;
        let guard = super::state::RootGuard::open(&root)?;
        let path = super::transactions::package_path(&root, &source.relative_path)?;
        if path.exists() {
            return Err("CAS conflict: import target already exists".into());
        }
        let namespace = if root.scope == "global" {
            "global"
        } else {
            &origin.workspace_id
        };
        let id = super::catalog::identity(&[
            &origin.host_id,
            namespace,
            &root.root_id,
            &source.relative_path,
        ]);
        let before_metadata = guard.metadata(&id)?;
        if before_metadata.archived {
            return Err("archived target must be restored, not overwritten by import".into());
        }
        let mut after_metadata = before_metadata.clone();
        after_metadata.auto_editable = false;
        after_metadata.imported_from = Some(source_id.into());
        let mut result = super::transactions::result(origin, &format!("Import {}", source.name))?;
        result.changes = package_diffs(
            &id,
            &source.name,
            &super::service::Snapshot::new(),
            &snapshot,
        );
        let batch = super::transactions::Batch {
            version: 1,
            root_id: root.root_id.clone(),
            result,
            packages: vec![super::transactions::PackageChange {
                relative_path: source.relative_path.clone(),
                skill_id: id.clone(),
                name: source.name.clone(),
                before: super::service::Snapshot::new(),
                after: snapshot.clone(),
                before_metadata,
                after_metadata: after_metadata.clone(),
            }],
            evidence: vec![],
            proposal: None,
        };
        if super::state::target_snapshot(&source)? != snapshot {
            return Err("CAS conflict: external source changed during import".into());
        }
        let applied = super::transactions::execute(&guard, batch)?;
        if applied.status != "applied" {
            return Err(applied.error.unwrap_or(applied.status));
        }
        let target = super::catalog::FoundSkill {
            root,
            skill_id: id,
            relative_path: source.relative_path,
            name: source.name,
            description: source.description,
        };
        super::service::entry_from(&target, &snapshot, &after_metadata)
    }
}
