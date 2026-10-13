use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct Root {
    pub path: PathBuf,
    pub scope: String,
    pub source: String,
    pub root_id: String,
}
#[derive(Debug, Clone)]
pub(super) struct FoundSkill {
    pub root: Root,
    pub skill_id: String,
    pub relative_path: String,
    pub name: String,
    pub description: String,
}

#[cfg(test)]
pub(super) fn discover(
    host: &str,
    workspace: &str,
    cwd: Option<&Path>,
    global: &Path,
) -> Result<Vec<FoundSkill>, String> {
    let mut found = Vec::new();
    for root in roots_for(host, cwd, global)? {
        found.extend(discover_root(host, workspace, &root)?);
    }
    Ok(found)
}

pub(super) fn roots_for(
    host: &str,
    cwd: Option<&Path>,
    global: &Path,
) -> Result<Vec<Root>, String> {
    let mut roots = Vec::new();
    if let Some(cwd) = cwd {
        roots.push((
            cwd.join(".ultragamestudio/skills"),
            "project",
            "ugs-project",
        ));
    }
    roots.push((global.join("skills"), "global", "ugs-global"));
    if let Some(cwd) = cwd {
        for (folder, source) in [
            ("skills", "workspace-skills"),
            (".claude/skills", "claude"),
            (".codex/skills", "codex"),
            (".agents/skills", "agents"),
            (".gemini/skills", "gemini"),
        ] {
            roots.push((cwd.join(folder), "external", source));
        }
    }
    let mut found = Vec::new();
    for (path, scope, source) in roots {
        found.push(owned_root(host, &path, scope, source)?);
    }
    Ok(found)
}

/// Canonicalize the existing ancestor, retaining absent suffixes literally.
/// The identity must not change just because the first transaction creates a
/// previously absent skills root (Windows canonical paths carry a prefix).
pub(super) fn owned_root(
    host: &str,
    path: &Path,
    scope: &str,
    source: &str,
) -> Result<Root, String> {
    super::validation::safe_chain(path)?;
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(
            ancestor
                .file_name()
                .ok_or("root has no existing ancestor")?
                .to_owned(),
        );
        ancestor = ancestor.parent().ok_or("root has no parent")?;
    }
    let mut canonical = std::fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    for part in suffix.into_iter().rev() {
        canonical.push(part);
    }
    let key = canonical.to_string_lossy().into_owned();
    #[cfg(windows)]
    let key = key.to_lowercase();
    Ok(Root {
        root_id: identity(&[host, scope, &key]),
        path: canonical,
        scope: scope.into(),
        source: source.into(),
    })
}

/// Legacy slash discovery keeps owned packages behind the same recovery gate
/// as service reads. It never traverses transaction/archived directories.
pub fn legacy_owned_entries(
    global: &Path,
    cwd: Option<&Path>,
) -> Result<Vec<(PathBuf, super::types::SkillEntry)>, String> {
    let mut entries = Vec::new();
    for root in roots_for("local", cwd, global)?
        .into_iter()
        .filter(|r| r.scope != "external")
    {
        if !root.path.is_dir() {
            continue;
        }
        let guard = super::state::RootGuard::open(&root)?;
        for target in discover_root("local", "legacy-project", &root)? {
            let snapshot = super::state::target_snapshot(&target)?;
            let meta = guard.metadata(&target.skill_id)?;
            let entry = super::service::entry_from(&target, &snapshot, &meta)?;
            entries.push((root.path.join(&target.relative_path), entry));
        }
        guard.commit()?;
    }
    Ok(entries)
}

pub(super) fn discover_root(
    host: &str,
    workspace: &str,
    root: &Root,
) -> Result<Vec<FoundSkill>, String> {
    let mut found = Vec::new();
    if root.path.is_dir() {
        let scope = root.scope.as_str();
        let mut dirs = std::fs::read_dir(&root.path)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        dirs.sort_by_key(|e| e.file_name());
        for dir in dirs {
            let relative_path = dir.file_name().to_string_lossy().into_owned();
            if relative_path.starts_with('.')
                || ["archives", "archive", "staging"]
                    .contains(&relative_path.to_lowercase().as_str())
            {
                continue;
            }
            super::validation::component(&relative_path)?;
            super::validation::safe_chain(&dir.path())?;
            let main = dir.path().join("SKILL.md");
            super::validation::safe_chain(&main)?;
            if !main.is_file() {
                continue;
            }
            let content = std::fs::read_to_string(&main).map_err(|e| e.to_string())?;
            let (name, description) = super::validation::document(&content, None)?;
            let namespace = if scope == "global" {
                "global"
            } else {
                workspace
            };
            found.push(FoundSkill {
                skill_id: identity(&[host, namespace, &root.root_id, &relative_path]),
                root: root.clone(),
                relative_path,
                name,
                description,
            });
        }
    }
    Ok(found)
}

pub(super) fn identity(parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    format!("skill_{}", hex::encode(hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::test_support::{skill, Fixture};

    #[test]
    fn legacy_owned_entries_include_both_owned_roots_and_exclude_transaction_state() {
        let f = Fixture::new("legacy-owned");
        f.write(
            "project/.ultragamestudio/skills/project-rule/SKILL.md",
            &skill("project-rule", "Use project rule."),
        );
        f.write(
            "global/skills/global-rule/SKILL.md",
            &skill("global-rule", "Use global rule."),
        );
        f.write(
            "project/.ultragamestudio/skills/.state/transactions/hidden/SKILL.md",
            &skill("hidden", "Never scan intents."),
        );
        f.write(
            "global/skills/archives/old/SKILL.md",
            &skill("old", "Never scan archives."),
        );
        let entries = legacy_owned_entries(&f.global(), Some(&f.project())).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].1.scope, "project");
        assert_eq!(entries[1].1.scope, "global");
        let (_, entry) = &entries[0];
        let old_id = entry.skill_id.clone();
        let old_revision = entry.revision.clone();
        f.write("project/.ultragamestudio/skills/project-rule/SKILL.md","---\nname: project-rule\ndescription: Use when editing project files.\n---\n\nRead the complete project.\n");
        let next = legacy_owned_entries(&f.global(), Some(&f.project())).unwrap();
        assert_eq!(next[0].1.skill_id, old_id);
        assert_ne!(next[0].1.revision, old_revision);
        assert_eq!(next[0].1.description, "Use when editing project files.");
    }

    #[test]
    fn state_archive_and_redirected_packages_never_become_catalog_skills() {
        let f = Fixture::new("catalog-state");
        f.write(
            "project/.ultragamestudio/skills/.state/SKILL.md",
            &skill("hidden", "State is not a skill"),
        );
        f.write(
            "project/.ultragamestudio/skills/archives/SKILL.md",
            &skill("archived", "Archive is not a skill"),
        );
        f.write(
            "project/.ultragamestudio/skills/visible/SKILL.md",
            &skill("visible", "Actual rule"),
        );
        let found = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "visible");
        f.write(
            "outside/redirected/SKILL.md",
            &skill("redirected", "Never read via package junction"),
        );
        crate::skills::test_support::link_dir(
            &f.0.join("outside/redirected"),
            &f.project().join(".ultragamestudio/skills/redirected"),
        );
        assert!(discover("local", "workspace-a", Some(&f.project()), &f.global()).is_err());
    }

    #[test]
    fn reject_root_escape() {
        let f = Fixture::new("catalog-escape");
        f.write(
            "outside/escaped/SKILL.md",
            &skill("escaped", "Must never read"),
        );
        std::fs::create_dir_all(f.project().join(".ultragamestudio")).unwrap();
        crate::skills::test_support::link_dir(
            &f.0.join("outside"),
            &f.project().join(".ultragamestudio/skills"),
        );
        assert!(
            discover("local", "workspace-a", Some(&f.project()), &f.global()).is_err(),
            "a redirected root must be rejected, not followed"
        );
    }

    #[test]
    fn readonly_external_root() {
        let f = Fixture::new("catalog-external");
        for prefix in [
            "skills",
            ".claude/skills",
            ".codex/skills",
            ".agents/skills",
            ".gemini/skills",
        ] {
            f.write(
                format!("project/{prefix}/external/SKILL.md"),
                &skill("external", "External rule"),
            );
        }
        // Never scan or adopt another agent's user-global store.
        f.write(
            "global/.hermes/skills/hidden/SKILL.md",
            &skill("hidden", "Not UGS owned"),
        );
        let found = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap();
        assert_eq!(
            found.len(),
            5,
            "current-workspace external sources must be discovered read-only"
        );
        assert!(found.iter().all(|s| s.root.scope == "external"));
        assert!(found.iter().all(|s| s.root.source != "ugs-project"));
        assert!(!f.project().join(".ultragamestudio").exists());
        assert!(!f.global().join("skills").exists());
    }

    #[test]
    fn same_name_different_scopes() {
        let f = Fixture::new("catalog-scopes");
        f.write(
            "project/.ultragamestudio/skills/shared/SKILL.md",
            &skill("shared", "Project rule"),
        );
        f.write(
            "global/skills/shared/SKILL.md",
            &skill("shared", "Global rule"),
        );
        let found = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap();
        assert_eq!(
            found.len(),
            2,
            "both independently owned packages must be discovered"
        );
        assert_eq!(found[0].root.scope, "project");
        assert_eq!(found[1].root.scope, "global");
        assert_ne!(found[0].skill_id, found[1].skill_id);
        assert_ne!(found[0].root.root_id, found[1].root.root_id);
        assert_eq!(found[0].name, "shared");
        assert_eq!(
            found[0].skill_id,
            discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap()[0].skill_id
        );
    }
}
