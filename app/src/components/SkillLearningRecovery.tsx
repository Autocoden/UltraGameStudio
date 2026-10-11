import { useEffect } from 'react';
import { useStore, persistSkillLearningStateForSource, retryPersistedSkillLearning } from '@/store/useStore';
import { historyStore } from '@/store/history/store';
import { createSkillControlHost } from '@/lib/skills';
import { tauriAvailable } from '@/lib/tauri';
import { isSkillReviewLive } from '@/lib/skillLearningDesktop';
import { pendingSkillReview, reconcileInterruptedSkillReview } from '@/lib/skillLearningRecovery';
import { loadSkillLearningConfig } from '@/lib/skillLearningConfig';

let recovery: Promise<void> | undefined;
const startupAt = Date.now();
async function recover(): Promise<void> {
  const workspaces = await historyStore.listWorkspaces();
  for (const workspace of workspaces) {
    const sessions = await historyStore.listSessions(workspace.id);
    for (const session of sessions) {
      const record = await historyStore.getSession(workspace.id, session.id);
      for (const message of record?.messages ?? []) {
        const state = message.skillLearning;
        if (!state || message.createdAt >= startupAt || state.origin.hostId !== 'local' || state.sourceSession || !pendingSkillReview(state) || isSkillReviewLive(state.origin.runId)) continue;
        const host = createSkillControlHost({ origin: state.origin, mode: state.mode ?? 'auto-safe' });
        try {
          const history = await host.history();
          // Recheck after IPC: new live work can begin while history is loading.
          if (isSkillReviewLive(state.origin.runId)) continue;
          const next = reconcileInterruptedSkillReview(state, history.results);
          await persistSkillLearningStateForSource({ workspaceId: workspace.id, sessionId: session.id }, next, message.id);
          const config = loadSkillLearningConfig(workspace.id);
          if (next.error === 'SKILL_REVIEW_INTERRUPTED' && next.resume && config.enabled && config.mode !== 'off') {
            await retryPersistedSkillLearning(next);
          }
        } catch (error) {
          // An unreadable journal cannot be treated as "nothing committed".
          console.warn('[skills] 中断复盘恢复失败', error);
          if (!isSkillReviewLive(state.origin.runId)) await persistSkillLearningStateForSource(
            { workspaceId: workspace.id, sessionId: session.id }, { ...state, status: 'needs_recovery',
              detail: undefined, error: `无法核对中断复盘的写入记录，尚未重跑：${String(error)}` }, message.id,
          ).catch((writeError) => console.warn('[skills] 恢复状态回存失败', writeError));
        } finally { await host.revoke().catch(() => {}); }
      }
    }
  }
}

export default function SkillLearningRecovery() {
  const ready = useStore((state) => state.historyReady);
  useEffect(() => {
    if (!ready || !tauriAvailable()) return;
    recovery ??= recover().catch((error) => console.warn('[skills] 复盘恢复失败', error));
  }, [ready]);
  return null;
}
