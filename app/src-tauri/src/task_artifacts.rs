use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const TASK_ARTIFACT_DIR_NAME: &str = "tasks";
const MAX_TASK_ARTIFACT_FILES: usize = 24;
const MAX_TASK_ARTIFACT_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TASK_ARTIFACT_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const ALLOWED_TASK_ARTIFACT_FILES: &[&str] = &[
    "requirements.md",
    "spec.md",
    "design.md",
    "tasks.md",
    "implementation_plan.md",
    "task_logs.jsonl",
    "task_metadata.json",
    "direct_summary.md",
    "direct_session.json",
    "critique_report.md",
    "qa_report.md",
];

static TASK_ARTIFACT_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskArtifactFileInput {
    name: String,
    content: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskArtifactSyncResult {
    root_path: String,
    files_written: usize,
}

fn validate_task_id(task_id: &str) -> Result<&str, String> {
    let task_id = task_id.trim();
    if task_id.is_empty() || task_id.len() > 128 {
        return Err("任务 ID 无效".to_string());
    }
    if !task_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("任务 ID 只能包含字母、数字、连字符和下划线".to_string());
    }
    Ok(task_id)
}

fn validate_artifact_files(files: &[TaskArtifactFileInput]) -> Result<(), String> {
    if files.len() > MAX_TASK_ARTIFACT_FILES {
        return Err(format!("任务文件数量不能超过 {MAX_TASK_ARTIFACT_FILES} 个"));
    }

    let mut total_bytes = 0usize;
    for file in files {
        if !ALLOWED_TASK_ARTIFACT_FILES.contains(&file.name.as_str()) {
            return Err(format!("不支持的任务文件：{}", file.name));
        }
        let file_bytes = file.content.len();
        if file_bytes > MAX_TASK_ARTIFACT_FILE_BYTES {
            return Err(format!("任务文件过大：{}", file.name));
        }
        total_bytes = total_bytes.saturating_add(file_bytes);
        if total_bytes > MAX_TASK_ARTIFACT_TOTAL_BYTES {
            return Err("任务文件总大小超过限制".to_string());
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!("{extension}."))
            .unwrap_or_default()
    ));
    std::fs::write(&tmp, content.as_bytes())
        .map_err(|error| format!("写入任务文件失败：{error}"))?;
    std::fs::rename(&tmp, path)
        .or_else(|_| {
            std::fs::remove_file(path).ok();
            std::fs::rename(&tmp, path)
        })
        .map_err(|error| format!("替换任务文件失败：{error}"))
}

fn task_artifact_root(root_path: &str, task_id: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root_path.trim());
    if root.as_os_str().is_empty() {
        return Err("项目工作区不可用".to_string());
    }
    if !root.is_dir() {
        return Err("项目工作区不是目录".to_string());
    }
    Ok(root
        .join(crate::storage_paths::PROJECT_ROOT_DIR_NAME)
        .join(TASK_ARTIFACT_DIR_NAME)
        .join(validate_task_id(task_id)?))
}

fn sync_task_artifacts_blocking(
    root_path: String,
    task_id: String,
    files: Vec<TaskArtifactFileInput>,
) -> Result<TaskArtifactSyncResult, String> {
    validate_artifact_files(&files)?;
    let artifact_root = task_artifact_root(&root_path, &task_id)?;
    let _guard = TASK_ARTIFACT_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "任务文件写入锁不可用".to_string())?;

    std::fs::create_dir_all(&artifact_root)
        .map_err(|error| format!("创建任务目录失败：{error}"))?;
    for file in &files {
        atomic_write(&artifact_root.join(&file.name), &file.content)?;
    }

    Ok(TaskArtifactSyncResult {
        root_path: artifact_root.to_string_lossy().to_string(),
        files_written: files.len(),
    })
}

#[tauri::command]
pub(crate) async fn sync_task_artifacts(
    root_path: String,
    task_id: String,
    files: Vec<TaskArtifactFileInput>,
) -> Result<TaskArtifactSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sync_task_artifacts_blocking(root_path, task_id, files)
    })
    .await
    .map_err(|error| format!("任务文件同步失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ugs-task-artifacts-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp workspace");
        root
    }

    #[test]
    fn writes_only_inside_the_task_artifact_directory() {
        let workspace = temp_workspace("write");
        let result = sync_task_artifacts_blocking(
            workspace.to_string_lossy().to_string(),
            "task-123".to_string(),
            vec![TaskArtifactFileInput {
                name: "requirements.md".to_string(),
                content: "# Task\n".to_string(),
            }],
        )
        .expect("sync task files");

        let expected = workspace
            .join(crate::storage_paths::PROJECT_ROOT_DIR_NAME)
            .join("tasks")
            .join("task-123");
        assert_eq!(PathBuf::from(result.root_path), expected);
        assert_eq!(result.files_written, 1);
        assert_eq!(
            std::fs::read_to_string(expected.join("requirements.md")).unwrap(),
            "# Task\n"
        );
        std::fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn rejects_task_ids_and_file_names_that_can_escape_the_directory() {
        let workspace = temp_workspace("escape");
        let invalid_id = sync_task_artifacts_blocking(
            workspace.to_string_lossy().to_string(),
            "../other".to_string(),
            vec![],
        );
        assert!(invalid_id.is_err());

        let invalid_file = sync_task_artifacts_blocking(
            workspace.to_string_lossy().to_string(),
            "task-123".to_string(),
            vec![TaskArtifactFileInput {
                name: "../outside.md".to_string(),
                content: "bad".to_string(),
            }],
        );
        assert!(invalid_file.is_err());
        std::fs::remove_dir_all(workspace).ok();
    }
}
