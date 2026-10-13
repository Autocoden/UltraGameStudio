use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::{
    is_inside_git_work_tree, run_workspace_status_command_owned_with_timeout,
    workspace_status_error, WorkspaceStatusCommandOutput,
};

const SHORT_TIMEOUT: Duration = Duration::from_secs(20);
const GIT_OPERATION_TIMEOUT: Duration = Duration::from_secs(300);
const REMOTE_OPERATION_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug)]
struct WorktreeContext {
    main_root: PathBuf,
    worktree_root: PathBuf,
    branch: String,
    target_branch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskWorktreeReview {
    pub exists: bool,
    pub main_root: String,
    pub worktree_path: String,
    pub branch: String,
    pub target_branch: String,
    pub files: Vec<String>,
    pub files_changed: usize,
    pub additions: u64,
    pub deletions: u64,
    pub commit_count: u32,
    pub commits_behind: u32,
    pub worktree_dirty: bool,
    pub worktree_dirty_files: Vec<String>,
    pub main_dirty: bool,
    pub main_dirty_files: Vec<String>,
    pub potential_conflicts: Vec<String>,
    pub remote_url: Option<String>,
    pub already_merged: bool,
    pub can_integrate: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskWorktreeIntegrateResult {
    pub success: bool,
    pub staged: bool,
    pub merged: bool,
    pub commit_created: bool,
    pub worktree_cleaned: bool,
    pub branch_deleted: bool,
    pub cleanup_warning: Option<String>,
    pub message: String,
    pub branch: String,
    pub target_branch: String,
    pub files: Vec<String>,
    pub conflicts: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskWorktreePushResult {
    pub success: bool,
    pub branch: String,
    pub commit_created: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskWorktreeCleanupResult {
    pub success: bool,
    pub branch: String,
    pub branch_deleted: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskPullRequestResult {
    pub success: bool,
    pub url: Option<String>,
    pub already_exists: bool,
    pub branch: String,
    pub target_branch: String,
    pub commit_created: bool,
    pub message: String,
}

fn run_git(
    root: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<WorkspaceStatusCommandOutput, String> {
    run_workspace_status_command_owned_with_timeout(root, "git", args, timeout)
        .map_err(|error| format!("Git 命令启动失败: {error}"))
}

fn run_git_ok(root: &Path, args: &[String], label: &str) -> Result<String, String> {
    let output = run_git(root, args, SHORT_TIMEOUT)?;
    if output.timed_out {
        return Err(format!("{label}超时"));
    }
    if !output.success {
        return Err(format!("{label}失败: {}", workspace_status_error(&output)));
    }
    Ok(output.stdout.trim().to_string())
}

fn canonical_git_root(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label}路径为空"));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!("{label}不存在或不是目录"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("读取{label}路径失败: {error}"))?;
    if !is_inside_git_work_tree(&canonical) {
        return Err(format!("{label}不是有效的 Git 工作区"));
    }
    Ok(canonical)
}

fn git_common_dir(root: &Path) -> Result<PathBuf, String> {
    let raw = run_git_ok(
        root,
        &["rev-parse".to_string(), "--git-common-dir".to_string()],
        "读取 Git 公共目录",
    )?;
    let path = PathBuf::from(raw);
    let resolved = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    resolved
        .canonicalize()
        .map_err(|error| format!("解析 Git 公共目录失败: {error}"))
}

fn current_branch(root: &Path, label: &str) -> Result<String, String> {
    let branch = run_git_ok(
        root,
        &["branch".to_string(), "--show-current".to_string()],
        label,
    )?;
    if branch.is_empty() || branch == "HEAD" || branch.starts_with('-') {
        return Err(format!("{label}处于 detached HEAD"));
    }
    Ok(branch)
}

fn validate_branch(root: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return Err("Git 分支名称无效".to_string());
    }
    let output = run_git(
        root,
        &[
            "check-ref-format".to_string(),
            "--branch".to_string(),
            branch.to_string(),
        ],
        SHORT_TIMEOUT,
    )?;
    if !output.success {
        return Err("Git 分支名称无效".to_string());
    }
    Ok(())
}

fn registered_worktree_paths(main_root: &Path) -> Result<Vec<PathBuf>, String> {
    let output = run_git_ok(
        main_root,
        &[
            "worktree".to_string(),
            "list".to_string(),
            "--porcelain".to_string(),
        ],
        "读取 Git worktree 列表",
    )?;
    Ok(output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .filter_map(|path| PathBuf::from(path).canonicalize().ok())
        .collect())
}

fn resolve_context(
    main_root: &str,
    worktree_root: &str,
    target_branch: Option<&str>,
) -> Result<WorktreeContext, String> {
    let main_root = canonical_git_root(main_root, "主项目")?;
    let worktree_root = canonical_git_root(worktree_root, "任务工作树")?;
    if main_root == worktree_root {
        return Err("任务工作树不能与主项目目录相同".to_string());
    }
    if git_common_dir(&main_root)? != git_common_dir(&worktree_root)? {
        return Err("任务工作树不属于当前主项目".to_string());
    }
    if !registered_worktree_paths(&main_root)?
        .iter()
        .any(|path| path == &worktree_root)
    {
        return Err("任务工作树未在当前仓库注册".to_string());
    }

    let branch = current_branch(&worktree_root.as_path(), "读取任务分支")?;
    let checked_out_target = current_branch(main_root.as_path(), "读取主项目分支")?;
    let requested = target_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(checked_out_target.as_str());
    let requested = requested
        .strip_prefix("refs/heads/")
        .or_else(|| requested.strip_prefix("origin/"))
        .unwrap_or(requested)
        .to_string();
    validate_branch(&main_root, &requested)?;
    if requested != checked_out_target {
        return Err(format!(
            "主项目当前位于分支“{checked_out_target}”，请先切换到目标分支“{requested}”"
        ));
    }
    if branch == requested {
        return Err("任务工作树与主项目位于同一分支，无法执行验收合并".to_string());
    }

    Ok(WorktreeContext {
        main_root,
        worktree_root,
        branch,
        target_branch: requested,
    })
}

fn parse_nul_paths(stdout: &str) -> Vec<String> {
    let mut paths: Vec<String> = stdout
        .split('\0')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

fn status_paths(root: &Path) -> Result<Vec<String>, String> {
    let output = run_git(
        root,
        &[
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "-z".to_string(),
            "--untracked-files=all".to_string(),
        ],
        SHORT_TIMEOUT,
    )?;
    if !output.success {
        return Err(format!(
            "读取 Git 工作区状态失败: {}",
            workspace_status_error(&output)
        ));
    }
    let mut paths = Vec::new();
    let records: Vec<&str> = output.stdout.split('\0').collect();
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        if record.len() >= 3 {
            let status = &record.as_bytes()[..2];
            paths.push(record[3..].to_string());
            if matches!(status[0], b'R' | b'C') || matches!(status[1], b'R' | b'C') {
                index = index.saturating_add(1);
                if let Some(path) = records.get(index).filter(|path| !path.is_empty()) {
                    paths.push((*path).to_string());
                }
            }
        }
        index = index.saturating_add(1);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn diff_paths(root: &Path, revision: &str) -> Result<Vec<String>, String> {
    let output = run_git(
        root,
        &[
            "diff".to_string(),
            "--name-only".to_string(),
            "-z".to_string(),
            revision.to_string(),
        ],
        SHORT_TIMEOUT,
    )?;
    if !output.success {
        return Err(format!(
            "读取任务变更文件失败: {}",
            workspace_status_error(&output)
        ));
    }
    Ok(parse_nul_paths(&output.stdout))
}

fn revision_diff_paths(root: &Path, from: &str, to: &str) -> Result<Vec<String>, String> {
    let output = run_git(
        root,
        &[
            "diff".to_string(),
            "--name-only".to_string(),
            "-z".to_string(),
            format!("{from}..{to}"),
        ],
        SHORT_TIMEOUT,
    )?;
    if !output.success {
        return Err(format!(
            "读取分支变更文件失败: {}",
            workspace_status_error(&output)
        ));
    }
    Ok(parse_nul_paths(&output.stdout))
}

fn count_revisions(root: &Path, range: &str) -> Result<u32, String> {
    let value = run_git_ok(
        root,
        &[
            "rev-list".to_string(),
            "--count".to_string(),
            range.to_string(),
        ],
        "读取分支提交数量",
    )?;
    value
        .parse::<u32>()
        .map_err(|_| "Git 返回了无效的提交数量".to_string())
}

fn diff_stats(root: &Path, revision: &str) -> Result<(u64, u64), String> {
    let output = run_git(
        root,
        &[
            "diff".to_string(),
            "--numstat".to_string(),
            revision.to_string(),
        ],
        SHORT_TIMEOUT,
    )?;
    if !output.success {
        return Err(format!(
            "读取任务变更统计失败: {}",
            workspace_status_error(&output)
        ));
    }
    let mut additions = 0u64;
    let mut deletions = 0u64;
    for line in output.stdout.lines() {
        let mut columns = line.split('\t');
        additions =
            additions.saturating_add(columns.next().and_then(|v| v.parse().ok()).unwrap_or(0));
        deletions =
            deletions.saturating_add(columns.next().and_then(|v| v.parse().ok()).unwrap_or(0));
    }
    Ok((additions, deletions))
}

fn optional_git_value(root: &Path, args: &[String]) -> Option<String> {
    run_git(root, args, SHORT_TIMEOUT)
        .ok()
        .filter(|output| output.success && !output.timed_out)
        .map(|output| output.stdout.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn review_for_context(context: &WorktreeContext) -> Result<TaskWorktreeReview, String> {
    let merge_base = run_git_ok(
        &context.main_root,
        &[
            "merge-base".to_string(),
            context.target_branch.clone(),
            context.branch.clone(),
        ],
        "查找分支共同基准",
    )?;
    let worktree_dirty_files = status_paths(&context.worktree_root)?;
    let main_dirty_files = status_paths(&context.main_root)?;
    let mut task_files = diff_paths(&context.worktree_root, &merge_base)?;
    task_files.extend(worktree_dirty_files.iter().cloned());
    task_files.sort();
    task_files.dedup();
    let main_branch_files =
        revision_diff_paths(&context.main_root, &merge_base, &context.target_branch)?;
    let main_set: BTreeSet<&str> = main_branch_files.iter().map(String::as_str).collect();
    let potential_conflicts = task_files
        .iter()
        .filter(|path| main_set.contains(path.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let (additions, deletions) = diff_stats(&context.worktree_root, &merge_base)?;
    let commit_count = count_revisions(
        &context.main_root,
        &format!("{}..{}", context.target_branch, context.branch),
    )?;
    let commits_behind = count_revisions(
        &context.main_root,
        &format!("{}..{}", context.branch, context.target_branch),
    )?;
    let remote_url = optional_git_value(
        &context.main_root,
        &[
            "remote".to_string(),
            "get-url".to_string(),
            "origin".to_string(),
        ],
    );
    let ancestor = run_git(
        &context.main_root,
        &[
            "merge-base".to_string(),
            "--is-ancestor".to_string(),
            context.branch.clone(),
            context.target_branch.clone(),
        ],
        SHORT_TIMEOUT,
    )?;
    if ancestor.timed_out {
        return Err("检查任务分支是否已合并超时".to_string());
    }
    let already_merged = ancestor.success && worktree_dirty_files.is_empty();
    let main_dirty = !main_dirty_files.is_empty();
    Ok(TaskWorktreeReview {
        exists: true,
        main_root: context.main_root.to_string_lossy().to_string(),
        worktree_path: context.worktree_root.to_string_lossy().to_string(),
        branch: context.branch.clone(),
        target_branch: context.target_branch.clone(),
        files_changed: task_files.len(),
        files: task_files,
        additions,
        deletions,
        commit_count,
        commits_behind,
        worktree_dirty: !worktree_dirty_files.is_empty(),
        worktree_dirty_files,
        main_dirty,
        main_dirty_files,
        potential_conflicts: potential_conflicts.clone(),
        remote_url,
        already_merged,
        can_integrate: !main_dirty && potential_conflicts.is_empty() && !already_merged,
    })
}

fn ensure_task_commit(context: &WorktreeContext, message: &str) -> Result<bool, String> {
    if status_paths(&context.worktree_root)?.is_empty() {
        return Ok(false);
    }
    let added = run_git(
        &context.worktree_root,
        &["add".to_string(), "--all".to_string()],
        GIT_OPERATION_TIMEOUT,
    )?;
    if !added.success {
        return Err(format!(
            "暂存任务工作树变更失败: {}",
            workspace_status_error(&added)
        ));
    }
    let mut commit_message = message.trim().replace(['\r', '\n'], " ");
    if commit_message.is_empty() {
        commit_message = format!("Complete task {}", context.branch);
    }
    commit_message = commit_message.chars().take(240).collect();
    let committed = run_git(
        &context.worktree_root,
        &["commit".to_string(), "-m".to_string(), commit_message],
        GIT_OPERATION_TIMEOUT,
    )?;
    if !committed.success {
        return Err(format!(
            "提交任务工作树变更失败: {}",
            workspace_status_error(&committed)
        ));
    }
    Ok(true)
}

fn conflict_files(root: &Path) -> Vec<String> {
    run_git(
        root,
        &[
            "diff".to_string(),
            "--name-only".to_string(),
            "--diff-filter=U".to_string(),
            "-z".to_string(),
        ],
        SHORT_TIMEOUT,
    )
    .ok()
    .map(|output| parse_nul_paths(&output.stdout))
    .unwrap_or_default()
}

fn abort_integration(root: &Path) {
    let aborted = run_git(
        root,
        &["merge".to_string(), "--abort".to_string()],
        GIT_OPERATION_TIMEOUT,
    );
    if aborted.as_ref().is_ok_and(|output| output.success) {
        return;
    }
    let _ = run_git(
        root,
        &[
            "reset".to_string(),
            "--merge".to_string(),
            "HEAD".to_string(),
        ],
        GIT_OPERATION_TIMEOUT,
    );
}

fn integrate_blocking(
    main_root: String,
    worktree_root: String,
    target_branch: Option<String>,
    stage_only: bool,
    commit_message: String,
) -> Result<TaskWorktreeIntegrateResult, String> {
    let context = resolve_context(&main_root, &worktree_root, target_branch.as_deref())?;
    let main_dirty_files = status_paths(&context.main_root)?;
    if !main_dirty_files.is_empty() {
        return Err(format!(
            "主项目存在 {} 个未提交文件，请先提交或暂存这些变更",
            main_dirty_files.len()
        ));
    }
    let commit_created = ensure_task_commit(&context, &commit_message)?;
    let review = review_for_context(&context)?;
    let args = if stage_only {
        vec![
            "merge".to_string(),
            "--squash".to_string(),
            "--no-commit".to_string(),
            context.branch.clone(),
        ]
    } else {
        vec![
            "merge".to_string(),
            "--no-ff".to_string(),
            "--no-edit".to_string(),
            context.branch.clone(),
        ]
    };
    let integrated = run_git(&context.main_root, &args, GIT_OPERATION_TIMEOUT)?;
    if !integrated.success {
        let conflicts = conflict_files(&context.main_root);
        let detail = workspace_status_error(&integrated);
        abort_integration(&context.main_root);
        return Ok(TaskWorktreeIntegrateResult {
            success: false,
            staged: false,
            merged: false,
            commit_created,
            worktree_cleaned: false,
            branch_deleted: false,
            cleanup_warning: None,
            message: if conflicts.is_empty() {
                format!("整合任务分支失败: {detail}")
            } else {
                format!(
                    "检测到 {} 个 Git 冲突，主项目已恢复到整合前状态",
                    conflicts.len()
                )
            },
            branch: context.branch,
            target_branch: context.target_branch,
            files: review.files,
            conflicts,
        });
    }
    let (worktree_cleaned, branch_deleted, cleanup_warning) = if stage_only {
        (false, false, None)
    } else {
        match cleanup_blocking(main_root.clone(), worktree_root.clone(), true, true) {
            Ok(cleanup) => (cleanup.success, cleanup.branch_deleted, None),
            Err(error) => (false, false, Some(error)),
        }
    };
    let message = if stage_only {
        format!(
            "已将 {} 个文件暂存到主项目分支 {}",
            review.files_changed, context.target_branch
        )
    } else if let Some(warning) = cleanup_warning.as_deref() {
        format!(
            "已将任务分支 {} 合并到 {}；工作树自动清理失败: {warning}",
            context.branch, context.target_branch
        )
    } else {
        format!(
            "已将任务分支 {} 合并到 {}",
            context.branch, context.target_branch
        )
    };
    Ok(TaskWorktreeIntegrateResult {
        success: true,
        staged: stage_only,
        merged: !stage_only,
        commit_created,
        worktree_cleaned,
        branch_deleted,
        cleanup_warning,
        message,
        branch: context.branch,
        target_branch: context.target_branch,
        files: review.files,
        conflicts: Vec::new(),
    })
}

fn push_blocking(
    main_root: String,
    worktree_root: String,
    target_branch: Option<String>,
    commit_message: String,
) -> Result<TaskWorktreePushResult, String> {
    let context = resolve_context(&main_root, &worktree_root, target_branch.as_deref())?;
    let commit_created = ensure_task_commit(&context, &commit_message)?;
    let pushed = run_git(
        &context.worktree_root,
        &[
            "push".to_string(),
            "--set-upstream".to_string(),
            "origin".to_string(),
            context.branch.clone(),
        ],
        REMOTE_OPERATION_TIMEOUT,
    )?;
    if !pushed.success {
        return Err(format!(
            "推送任务分支失败: {}",
            workspace_status_error(&pushed)
        ));
    }
    Ok(TaskWorktreePushResult {
        success: true,
        branch: context.branch.clone(),
        commit_created,
        message: format!("任务分支 {} 已推送到 origin", context.branch),
    })
}

fn cleanup_blocking(
    main_root: String,
    worktree_root: String,
    delete_branch: bool,
    force: bool,
) -> Result<TaskWorktreeCleanupResult, String> {
    let context = resolve_context(&main_root, &worktree_root, None)?;
    let dirty_files = status_paths(&context.worktree_root)?;
    if !force && !dirty_files.is_empty() {
        return Err(format!(
            "任务工作树仍有 {} 个未提交文件；确认丢弃后才能强制清理",
            dirty_files.len()
        ));
    }
    let mut args = vec!["worktree".to_string(), "remove".to_string()];
    if force {
        args.push("--force".to_string());
    }
    args.push(context.worktree_root.to_string_lossy().to_string());
    let removed = run_git(&context.main_root, &args, GIT_OPERATION_TIMEOUT)?;
    if !removed.success {
        return Err(format!(
            "清理任务工作树失败: {}",
            workspace_status_error(&removed)
        ));
    }
    let mut branch_deleted = false;
    if delete_branch {
        let deleted = run_git(
            &context.main_root,
            &[
                "branch".to_string(),
                if force { "-D" } else { "-d" }.to_string(),
                context.branch.clone(),
            ],
            GIT_OPERATION_TIMEOUT,
        )?;
        branch_deleted = deleted.success;
    }
    Ok(TaskWorktreeCleanupResult {
        success: true,
        branch: context.branch,
        branch_deleted,
        message: if branch_deleted {
            "任务工作树和任务分支已清理".to_string()
        } else {
            "任务工作树已清理".to_string()
        },
    })
}

fn pull_request_blocking(
    main_root: String,
    worktree_root: String,
    target_branch: Option<String>,
    title: String,
    body: Option<String>,
    draft: bool,
) -> Result<TaskPullRequestResult, String> {
    let context = resolve_context(&main_root, &worktree_root, target_branch.as_deref())?;
    let title = title.trim();
    if title.is_empty() {
        return Err("PR 标题不能为空".to_string());
    }
    let commit_created = ensure_task_commit(&context, title)?;
    let pushed = run_git(
        &context.worktree_root,
        &[
            "push".to_string(),
            "--set-upstream".to_string(),
            "origin".to_string(),
            context.branch.clone(),
        ],
        REMOTE_OPERATION_TIMEOUT,
    )?;
    if !pushed.success {
        return Err(format!(
            "推送任务分支失败: {}",
            workspace_status_error(&pushed)
        ));
    }

    let existing = run_workspace_status_command_owned_with_timeout(
        &context.worktree_root,
        "gh",
        &[
            "pr".to_string(),
            "view".to_string(),
            context.branch.clone(),
            "--json".to_string(),
            "url".to_string(),
            "--jq".to_string(),
            ".url".to_string(),
        ],
        REMOTE_OPERATION_TIMEOUT,
    );
    if let Ok(output) = existing {
        let url = output.stdout.trim();
        if output.success && !url.is_empty() {
            return Ok(TaskPullRequestResult {
                success: true,
                url: Some(url.to_string()),
                already_exists: true,
                branch: context.branch,
                target_branch: context.target_branch,
                commit_created,
                message: "该任务分支已经存在 Pull Request".to_string(),
            });
        }
    }

    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--base".to_string(),
        context.target_branch.clone(),
        "--head".to_string(),
        context.branch.clone(),
        "--title".to_string(),
        title.chars().take(240).collect(),
        "--body".to_string(),
        body.unwrap_or_default(),
    ];
    if draft {
        args.push("--draft".to_string());
    }
    let created = run_workspace_status_command_owned_with_timeout(
        &context.worktree_root,
        "gh",
        &args,
        REMOTE_OPERATION_TIMEOUT,
    )
    .map_err(|error| format!("启动 GitHub CLI 失败: {error}"))?;
    if !created.success {
        return Ok(TaskPullRequestResult {
            success: false,
            url: None,
            already_exists: false,
            branch: context.branch,
            target_branch: context.target_branch,
            commit_created,
            message: format!(
                "创建 Pull Request 失败: {}。请确认已安装并登录 GitHub CLI（gh auth login）",
                workspace_status_error(&created)
            ),
        });
    }
    let url = created
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("https://") || line.starts_with("http://"))
        .map(ToString::to_string);
    Ok(TaskPullRequestResult {
        success: true,
        url,
        already_exists: false,
        branch: context.branch,
        target_branch: context.target_branch,
        commit_created,
        message: "Pull Request 已创建".to_string(),
    })
}

#[tauri::command]
pub(crate) async fn task_worktree_review(
    main_root: String,
    worktree_root: String,
    target_branch: Option<String>,
) -> Result<TaskWorktreeReview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let context = resolve_context(&main_root, &worktree_root, target_branch.as_deref())?;
        review_for_context(&context)
    })
    .await
    .map_err(|error| format!("读取任务工作树验收状态失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn task_worktree_integrate(
    main_root: String,
    worktree_root: String,
    target_branch: Option<String>,
    stage_only: bool,
    commit_message: String,
) -> Result<TaskWorktreeIntegrateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        integrate_blocking(
            main_root,
            worktree_root,
            target_branch,
            stage_only,
            commit_message,
        )
    })
    .await
    .map_err(|error| format!("整合任务工作树失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn task_worktree_push(
    main_root: String,
    worktree_root: String,
    target_branch: Option<String>,
    commit_message: String,
) -> Result<TaskWorktreePushResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        push_blocking(main_root, worktree_root, target_branch, commit_message)
    })
    .await
    .map_err(|error| format!("推送任务工作树失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn task_worktree_cleanup(
    main_root: String,
    worktree_root: String,
    delete_branch: bool,
    force: bool,
) -> Result<TaskWorktreeCleanupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_blocking(main_root, worktree_root, delete_branch, force)
    })
    .await
    .map_err(|error| format!("清理任务工作树失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn task_create_pull_request(
    main_root: String,
    worktree_root: String,
    target_branch: Option<String>,
    title: String,
    body: Option<String>,
    draft: bool,
) -> Result<TaskPullRequestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pull_request_blocking(main_root, worktree_root, target_branch, title, body, draft)
    })
    .await
    .map_err(|error| format!("创建 Pull Request 失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::{Command, Output};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    struct TestRepository {
        container: PathBuf,
        main: PathBuf,
        task: PathBuf,
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.container);
        }
    }

    fn command_output(root: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap_or_else(|error| panic!("failed to run git {args:?}: {error}"))
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = command_output(root, args);
        assert!(
            output.status.success(),
            "git {args:?} failed in {}: {}",
            root.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn write(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn commit_all(root: &Path, message: &str) {
        git(root, &["add", "--all"]);
        git(root, &["commit", "-m", message]);
    }

    fn new_repository() -> TestRepository {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let container = std::env::temp_dir().join(format!(
            "ugs-task-worktree-{}-{nanos}-{id}",
            std::process::id()
        ));
        let main = container.join("main");
        let task = container.join("task");
        fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "--initial-branch=main"]);
        git(&main, &["config", "user.name", "UGS Test"]);
        git(&main, &["config", "user.email", "ugs-test@example.invalid"]);
        git(&main, &["config", "core.autocrlf", "false"]);
        write(&main, "shared.txt", "base\n");
        commit_all(&main, "initial");
        git(
            &main,
            &["worktree", "add", "-b", "task/test", task.to_str().unwrap()],
        );
        TestRepository {
            container,
            main,
            task,
        }
    }

    fn path_text(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn review_keeps_dirty_task_with_no_commits_available_for_integration() {
        let repo = new_repository();
        write(&repo.task, "staged.txt", "staged output\n");
        git(&repo.task, &["add", "staged.txt"]);
        write(&repo.task, "shared.txt", "uncommitted edit\n");
        write(&repo.task, "untracked.txt", "new output\n");

        let context = resolve_context(&path_text(&repo.main), &path_text(&repo.task), None)
            .expect("worktree context");
        let review = review_for_context(&context).expect("worktree review");

        assert_eq!(review.commit_count, 0);
        assert!(review.worktree_dirty);
        assert_eq!(
            review.files,
            vec!["shared.txt", "staged.txt", "untracked.txt"]
        );
        assert!(!review.already_merged);
        assert!(review.can_integrate);
    }

    #[test]
    fn task_commit_preserves_unicode_and_limits_title_to_240_characters() {
        let repo = new_repository();
        let context = resolve_context(&path_text(&repo.main), &path_text(&repo.task), None)
            .expect("worktree context");
        let title = format!("A{}", "中".repeat(80));
        let long_title = format!("A{}", "中".repeat(240));

        for (message, expected) in [
            (title.clone(), title),
            (long_title, format!("A{}", "中".repeat(239))),
        ] {
            write(&repo.task, "output.txt", &message);
            assert!(ensure_task_commit(&context, &message).expect("commit Unicode task title"));
            assert_eq!(git(&repo.task, &["log", "-1", "--format=%s"]), expected);
            assert!(git(&repo.task, &["status", "--porcelain"]).is_empty());
        }
    }

    #[test]
    fn task_commit_uses_default_title_for_empty_message() {
        let repo = new_repository();
        write(&repo.task, "output.txt", "task output\n");
        let context = resolve_context(&path_text(&repo.main), &path_text(&repo.task), None)
            .expect("worktree context");

        assert!(ensure_task_commit(&context, " \r\n ").expect("commit with default task title"));
        assert_eq!(
            git(&repo.task, &["log", "-1", "--format=%s"]),
            "Complete task task/test"
        );
    }

    #[test]
    fn review_reports_dirty_main_and_potential_conflicts() {
        let repo = new_repository();
        write(&repo.task, "shared.txt", "task branch\n");
        commit_all(&repo.task, "task edit");
        write(&repo.main, "shared.txt", "main branch\n");
        commit_all(&repo.main, "main edit");
        write(&repo.main, "local-only.txt", "uncommitted\n");

        let context = resolve_context(&path_text(&repo.main), &path_text(&repo.task), None)
            .expect("worktree context");
        let review = review_for_context(&context).expect("worktree review");

        assert!(review.main_dirty);
        assert!(review
            .main_dirty_files
            .iter()
            .any(|path| path == "local-only.txt"));
        assert!(review
            .potential_conflicts
            .iter()
            .any(|path| path == "shared.txt"));
        assert!(!review.can_integrate);
    }

    #[test]
    fn stage_only_commits_dirty_task_and_stages_main_changes() {
        let repo = new_repository();
        write(&repo.task, "feature.txt", "new feature\n");

        let result = integrate_blocking(
            path_text(&repo.main),
            path_text(&repo.task),
            None,
            true,
            "Implement feature".to_string(),
        )
        .expect("stage task changes");

        assert!(result.success);
        assert!(result.staged);
        assert!(!result.merged);
        assert!(result.commit_created);
        assert!(!result.worktree_cleaned);
        assert!(git(&repo.task, &["status", "--porcelain"]).is_empty());
        assert_eq!(
            git(&repo.main, &["diff", "--cached", "--name-only"]),
            "feature.txt"
        );
        assert_eq!(
            fs::read_to_string(repo.main.join("feature.txt")).unwrap(),
            "new feature\n"
        );
    }

    #[test]
    fn full_merge_commits_changes_and_cleans_registered_worktree() {
        let repo = new_repository();
        write(&repo.task, "merged.txt", "merged content\n");

        let result = integrate_blocking(
            path_text(&repo.main),
            path_text(&repo.task),
            None,
            false,
            "Merge feature".to_string(),
        )
        .expect("merge task changes");

        assert!(result.success);
        assert!(result.merged);
        assert!(result.commit_created);
        assert!(result.worktree_cleaned, "{:?}", result.cleanup_warning);
        assert!(result.branch_deleted);
        assert!(!repo.task.exists());
        assert_eq!(
            fs::read_to_string(repo.main.join("merged.txt")).unwrap(),
            "merged content\n"
        );
        assert!(git(&repo.main, &["branch", "--list", "task/test"]).is_empty());
    }

    #[test]
    fn merge_conflict_restores_clean_main_without_merge_state() {
        let repo = new_repository();
        write(&repo.task, "shared.txt", "task branch\n");
        commit_all(&repo.task, "task conflict");
        write(&repo.main, "shared.txt", "main branch\n");
        commit_all(&repo.main, "main conflict");

        let result = integrate_blocking(
            path_text(&repo.main),
            path_text(&repo.task),
            None,
            false,
            "Conflicting feature".to_string(),
        )
        .expect("conflict result");

        assert!(!result.success);
        assert!(result.conflicts.iter().any(|path| path == "shared.txt"));
        assert!(git(&repo.main, &["status", "--porcelain"]).is_empty());
        assert_eq!(
            fs::read_to_string(repo.main.join("shared.txt")).unwrap(),
            "main branch\n"
        );
        assert!(
            !command_output(&repo.main, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
                .status
                .success()
        );
    }

    #[test]
    fn review_detects_a_branch_that_was_already_merged() {
        let repo = new_repository();
        write(&repo.task, "already-merged.txt", "merged elsewhere\n");
        commit_all(&repo.task, "finished elsewhere");
        git(&repo.main, &["merge", "--no-ff", "--no-edit", "task/test"]);

        let context = resolve_context(&path_text(&repo.main), &path_text(&repo.task), None)
            .expect("worktree context");
        let review = review_for_context(&context).expect("worktree review");

        assert!(review.already_merged);
        assert!(!review.can_integrate);
    }

    #[test]
    fn rejects_a_worktree_from_another_repository() {
        let first = new_repository();
        let second = new_repository();
        let error = resolve_context(&path_text(&first.main), &path_text(&second.task), None)
            .expect_err("unrelated worktree must be rejected");
        assert!(error.contains("不属于当前主项目"), "{error}");
    }

    #[test]
    fn push_commits_dirty_task_before_publishing_branch() {
        let repo = new_repository();
        let remote = repo.container.join("remote.git");
        fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare"]);
        git(
            &repo.main,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&repo.main, &["push", "--set-upstream", "origin", "main"]);
        write(&repo.task, "published.txt", "publish me\n");

        let result = push_blocking(
            path_text(&repo.main),
            path_text(&repo.task),
            None,
            "Publish task".to_string(),
        )
        .expect("push task branch");

        assert!(result.success);
        assert!(result.commit_created);
        assert!(git(&repo.task, &["status", "--porcelain"]).is_empty());
        assert!(
            command_output(&remote, &["rev-parse", "--verify", "refs/heads/task/test"])
                .status
                .success()
        );
    }
}
