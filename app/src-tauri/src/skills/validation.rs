use std::path::{Path, PathBuf};

pub(super) fn document(
    text: &str,
    expected_name: Option<&str>,
) -> Result<(String, String), String> {
    let text = text.replace("\r\n", "\n");
    let rest = text
        .strip_prefix("---\n")
        .ok_or("SKILL.md must start with YAML frontmatter")?;
    let (frontmatter, body) = rest
        .split_once("\n---\n")
        .ok_or("missing frontmatter terminator")?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(frontmatter).map_err(|e| format!("invalid YAML: {e}"))?;
    let mapping = value
        .as_mapping()
        .ok_or("YAML frontmatter must be a mapping")?;
    let name = mapping
        .get(serde_yaml::Value::String("name".into()))
        .and_then(|v| v.as_str())
        .ok_or("YAML name must be a string")?;
    let description = mapping
        .get(serde_yaml::Value::String("description".into()))
        .and_then(|v| v.as_str())
        .ok_or("YAML description must be a string")?;
    if let Some(expected) = expected_name {
        if name != expected {
            return Err("frontmatter name does not match package name".into());
        }
    }
    if name.trim().is_empty() || description.trim().is_empty() || body.trim().is_empty() {
        return Err("name, description and body must be nonempty".into());
    }
    Ok((name.into(), description.into()))
}

pub(super) fn valid_name(name: &str) -> Result<(), String> {
    component(name)?;
    if name.len() > 64
        || !name
            .as_bytes()
            .first()
            .map_or(false, u8::is_ascii_lowercase)
        || name.ends_with('-')
        || name.contains("--")
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("skill name must be lowercase-kebab, at most 64 bytes".into());
    }
    Ok(())
}

pub(super) fn new_document(text: &str, name: &str) -> Result<(String, String), String> {
    valid_name(name)?;
    if text.chars().count() > 100000 || text.contains('\0') {
        return Err("SKILL.md exceeds 100000 characters or contains NUL".into());
    }
    let doc = document(text, Some(name))?;
    if doc.1.chars().count() > 1024 {
        return Err("description exceeds 1024 characters".into());
    }
    Ok(doc)
}

pub(super) fn risks(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut reasons = vec![];
    if [
        "ignore previous instructions",
        "disable permission",
        "skip validation",
        "bypass permission",
        "rm -rf",
        "remove-item -recurse",
        "powershell -enc",
        "| bash",
        "| sh",
        "invoke-expression",
        "curl ",
        "wget ",
        "忽略先前指令",
        "跳过验证",
        "禁用权限",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        reasons.push(
            "content safety heuristic flagged execution or instruction/permission override".into(),
        );
    }
    if [
        "api_key=",
        "api-key:",
        "authorization: bearer ",
        "-----begin private key-----",
        "password=",
        "token=",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        reasons.push(
            "content may contain secrets or personal credentials; explicit review required".into(),
        );
    }
    reasons
}

pub(super) fn links(snapshot: &super::service::Snapshot) -> Result<(), String> {
    for (file, bytes) in snapshot {
        if !file.ends_with(".md") {
            continue;
        }
        let text = std::str::from_utf8(bytes).map_err(|_| "markdown support must be UTF-8")?;
        let mut rest = text;
        while let Some((_, next)) = rest.split_once("](") {
            let (destination, remaining) =
                next.split_once(')').ok_or("unterminated markdown link")?;
            rest = remaining;
            let destination = destination
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(['<', '>']);
            if destination.starts_with('#')
                || destination.contains("://")
                || destination.starts_with("mailto:")
            {
                continue;
            }
            let path = destination.split('#').next().unwrap_or("");
            if path.is_empty() {
                continue;
            }
            if path.contains('%')
                || path.contains('\\')
                || path.starts_with('/')
                || path.contains(':')
            {
                return Err("unsafe support link destination".into());
            }
            let combined = if file == "SKILL.md" {
                path.to_owned()
            } else {
                format!("{}/{}", file.rsplit_once('/').map_or("", |v| v.0), path)
            };
            relative_file(&combined)?;
            if !snapshot.contains_key(&combined) {
                return Err(format!("support link target missing: {combined}"));
            }
        }
    }
    Ok(())
}

pub(super) fn component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("unsafe relative path component".into());
    }
    let device = value.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&device.as_str())
        || ["COM", "LPT"].iter().any(|p| {
            device.strip_prefix(p).map_or(false, |n| {
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)
            })
        })
    {
        return Err("Windows device path rejected".into());
    }
    Ok(())
}

pub(super) fn relative_file(value: &str) -> Result<(), String> {
    if value == "SKILL.md" {
        return Ok(());
    }
    let parts: Vec<&str> = value.split('/').collect();
    if parts.len() < 2 || !["references", "templates", "scripts", "assets"].contains(&parts[0]) {
        return Err("support file must stay under references/templates/scripts/assets".into());
    }
    for part in parts {
        component(part)?;
    }
    Ok(())
}

/// Preserve the literal path; aliases must fail rather than being repaired.
pub(super) fn checked_join(base: &Path, relative: &str) -> Result<PathBuf, String> {
    relative_file(relative)?;
    let mut path = base.to_path_buf();
    for part in relative.split('/') {
        if path.is_dir() {
            for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                let name = entry
                    .map_err(|e| e.to_string())?
                    .file_name()
                    .to_string_lossy()
                    .into_owned();
                if name.to_lowercase() == part.to_lowercase() && name != part {
                    return Err("case-insensitive path alias rejected".into());
                }
            }
        }
        path.push(part);
        safe_chain(&path)?;
    }
    Ok(path)
}

/// Check every existing ancestor before canonicalization or creation.
/// Windows junctions and all reparse points are rejected, not merely symlinks.
pub(super) fn safe_chain(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("absolute host path required".into());
    }
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                let mut redirected = meta.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    redirected |= meta.file_attributes() & 0x400 != 0;
                }
                if redirected {
                    return Err("symlink/junction/reparse path rejected".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("path metadata failed: {e}")),
        }
    }
    Ok(())
}
