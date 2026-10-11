use super::service::SkillService;
use super::types::*;

fn required<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str, String> {
    value
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{name} required"))
}
fn wire<T: serde::Serialize>(value: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

impl SkillService {
    pub fn list(&self, origin: &SkillOrigin) -> Result<SkillCatalog, String> {
        let grant = self.authority(origin)?;
        let mut entries = vec![];
        for root in
            super::catalog::roots_for(&origin.host_id, grant.cwd.as_deref(), &self.global_root)?
        {
            if !root.path.is_dir() {
                continue;
            }
            let guard = if root.scope != "external" {
                Some(super::state::RootGuard::open(&root)?)
            } else {
                None
            };
            for target in
                super::catalog::discover_root(&origin.host_id, &origin.workspace_id, &root)?
            {
                let snapshot = super::state::target_snapshot(&target)?;
                // External packages remain read-only. Their receipts/usage live
                // in the owned global ledger, which discovery must not create.
                let external_guard = if root.scope == "external"
                    && self
                        .global_root
                        .join("skills/.state/index.sqlite")
                        .is_file()
                {
                    Some(self.target_guard(&target)?)
                } else {
                    None
                };
                let meta = guard
                    .as_ref()
                    .or(external_guard.as_ref())
                    .map(|g| g.metadata(&target.skill_id))
                    .transpose()?
                    .unwrap_or_default();
                entries.push(super::service::entry_from(&target, &snapshot, &meta)?);
                if let Some(external_guard) = external_guard {
                    external_guard.commit()?;
                }
            }
            if let Some(guard) = guard {
                let mut statement = guard
                    .conn
                    .prepare("SELECT value FROM metadata ORDER BY skill_id")
                    .map_err(|e| e.to_string())?;
                let values = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                for value in values {
                    let meta: super::state::SkillMetadata =
                        serde_json::from_str(&value).map_err(|e| e.to_string())?;
                    if meta.archived {
                        if let Some(mut entry) = meta.entry {
                            if entry.root_id != root.root_id {
                                continue;
                            }
                            entry.state = "archived".into();
                            entry.usage = Some(meta.usage);
                            entry.pinned = meta.pinned;
                            entry.content_locked = meta.content_locked;
                            entry.auto_editable = meta.auto_editable;
                            entries.push(entry);
                        }
                    }
                }
                drop(statement);
                guard.commit()?;
            }
        }
        let revision =
            super::service::hash(&serde_json::to_vec(&entries).map_err(|e| e.to_string())?);
        Ok(SkillCatalog { revision, entries })
    }
    pub fn set_policy(
        &self,
        origin: &SkillOrigin,
        skill_id: &str,
        policy: &SkillPolicy,
    ) -> Result<SkillEntry, String> {
        let grant = self.authority(origin)?;
        if grant.actor != SkillActor::User {
            return Err("policy changes require trusted user authority".into());
        }
        let target = self
            .discover_bound(origin, &grant)?
            .into_iter()
            .find(|s| s.skill_id == skill_id)
            .ok_or("unknown skillId in origin")?;
        if target.root.scope == "external" {
            return Err("external skill policy is read-only".into());
        }
        let guard = self.target_guard(&target)?;
        let snapshot = super::state::target_snapshot(&target)?;
        let mut meta = guard.metadata(skill_id)?;
        if let Some(v) = policy.auto_editable {
            meta.auto_editable = v;
        }
        if let Some(v) = policy.content_locked {
            meta.content_locked = v;
        }
        if let Some(v) = policy.pinned {
            meta.pinned = v;
        }
        guard.save_metadata(skill_id, &meta)?;
        let entry = super::service::entry_from(&target, &snapshot, &meta)?;
        guard.commit()?;
        Ok(entry)
    }
    pub fn record_usage(
        &self,
        origin: &SkillOrigin,
        skill_id: &str,
        kind: &str,
        evidence_ids: &[String],
    ) -> Result<SkillEntry, String> {
        let grant = self.authority(origin)?;
        if !["viewed", "delivered", "used-with-evidence"].contains(&kind) {
            return Err("invalid usage kind".into());
        }
        let target = self
            .discover_bound(origin, &grant)?
            .into_iter()
            .find(|s| s.skill_id == skill_id)
            .ok_or("unknown skillId in origin")?;
        let guard = self.target_guard(&target)?;
        let snapshot = super::state::target_snapshot(&target)?;
        let revision = super::service::package_hash(&snapshot);
        let has_read:bool=guard.conn.query_row("SELECT EXISTS(SELECT 1 FROM receipts WHERE origin=?1 AND skill_id=?2 AND file_path='SKILL.md' AND revision=?3 AND full_read=1)",rusqlite::params![serde_json::to_string(origin).map_err(|e|e.to_string())?,skill_id,revision],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !has_read {
            return Err("usage needs an actual complete main-file read in this origin".into());
        }
        let mut ids = evidence_ids.to_vec();
        ids.sort();
        ids.dedup();
        if kind == "used-with-evidence" {
            if ids.is_empty()
                || !ids.iter().all(|id| {
                    grant.evidence.get(id).map_or(false, |e| {
                        e.kind == "skill-use"
                            && ["native-tool", "host-check"].contains(&e.provenance.as_str())
                            && e.status == "success"
                            && e.exit_code == Some(0)
                            && e.skill_id.as_deref() == Some(skill_id)
                            && e.revision.as_deref() == Some(&revision)
                            && e.tool_call_id.as_ref().map_or(false, |v| !v.is_empty())
                    })
                })
            {
                return Err("used-with-evidence requires trusted adoption verification for exact skill revision".into());
            }
        } else if !ids.is_empty() {
            return Err("only verified adoption accepts evidence ids".into());
        }
        let meta = guard.usage(origin, skill_id, &revision, kind, &ids)?;
        let entry = super::service::entry_from(&target, &snapshot, &meta)?;
        guard.commit()?;
        Ok(entry)
    }

    pub fn history(&self, origin: &SkillOrigin) -> Result<Vec<SkillMutationResult>, String> {
        let grant = self.authority(origin)?;
        let mut results = vec![];
        for root in
            super::catalog::roots_for(&origin.host_id, grant.cwd.as_deref(), &self.global_root)?
                .into_iter()
                .filter(|r| r.scope != "external")
        {
            if !root.path.is_dir() {
                continue;
            }
            let guard = super::state::RootGuard::open(&root)?;
            let mut statement = guard
                .conn
                .prepare("SELECT value FROM batches WHERE origin=?1")
                .map_err(|e| e.to_string())?;
            let values = statement
                .query_map(
                    [serde_json::to_string(origin).map_err(|e| e.to_string())?],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for value in values {
                results.push(
                    serde_json::from_str::<SkillMutationResult>(&value)
                        .map_err(|e| e.to_string())?,
                );
            }
            drop(statement);
            guard.commit()?;
        }
        results.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then(a.batch_id.cmp(&b.batch_id))
        });
        Ok(results)
    }

    pub fn handle(&self, request: SkillServiceRequest) -> Result<serde_json::Value, String> {
        let grant = self.authority(&request.origin)?;
        if request.mode.map_or(false, |mode| mode != grant.mode) {
            return Err("request mode does not match frozen host policy".into());
        }
        // Caller-carried evidence can reference host facts, not rewrite them.
        for evidence in &request.evidence {
            let trusted = grant
                .evidence
                .get(&evidence.evidence_id)
                .ok_or("request evidence is not registered by the trusted host")?;
            if serde_json::to_value(trusted).map_err(|e| e.to_string())?
                != serde_json::to_value(evidence).map_err(|e| e.to_string())?
            {
                return Err("request evidence differs from host facts".into());
            }
        }
        let origin = &request.origin;
        match request.action.as_str() {
            "list" => wire(self.list(origin)?),
            "view" => wire(self.view(
                origin,
                required(&request.skill_id, "skillId")?,
                request.file_path.as_deref(),
            )?),
            "manage" => wire(self.manage(
                origin,
                request.proposal.as_ref().ok_or("proposal required")?,
            )?),
            "approve" => wire(self.approve(origin, required(&request.batch_id, "batchId")?)?),
            "reject" => wire(self.reject(origin, required(&request.batch_id, "batchId")?)?),
            "rollback" => {
                wire(self.rollback(origin, required(&request.rollback_id, "rollbackId")?)?)
            }
            "history" => Ok(serde_json::json!({"results":self.history(origin)?})),
            "set_policy" => wire(self.set_policy(
                origin,
                required(&request.skill_id, "skillId")?,
                request.policy.as_ref().ok_or("policy required")?,
            )?),
            "usage" => wire(self.record_usage(
                origin,
                required(&request.skill_id, "skillId")?,
                required(&request.kind, "kind")?,
                &request.evidence_ids,
            )?),
            "archive" => wire(self.archive(origin, required(&request.skill_id, "skillId")?)?),
            "restore" => wire(self.restore(origin, required(&request.skill_id, "skillId")?)?),
            "import" => wire(
                self.import_skill(origin, required(&request.source_skill_id, "sourceSkillId")?)?,
            ),
            _ => Err("unknown skills_request action".into()),
        }
    }
}
