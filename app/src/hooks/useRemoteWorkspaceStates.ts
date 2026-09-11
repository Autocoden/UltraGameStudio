import { useEffect, useMemo, useState } from 'react';
import { isRemoteWorkspacePath } from '@/lib/remoteWorkspace';
import {
  REMOTE_WORKSPACE_STATUS_CHECK_INTERVAL_MS,
  checkRemoteWorkspaceConnection,
  type RemoteWorkspaceConnectionState,
} from '@/lib/remoteWorkspaceStatus';
import type { WorkspaceSummary } from '@/store/history/types';

/**
 * Polls the connection state of every remote (cloud) workspace on a relaxed
 * interval. Shared by the top project switcher and the sidebar workspace
 * headers, which both render a connection badge.
 */
export default function useRemoteWorkspaceStates(
  workspaces: WorkspaceSummary[],
): Record<string, RemoteWorkspaceConnectionState> {
  const [states, setStates] = useState<
    Record<string, RemoteWorkspaceConnectionState>
  >({});

  const remoteWorkspaceTargets = useMemo(
    () =>
      workspaces
        .filter((workspace) => isRemoteWorkspacePath(workspace.path))
        .map((workspace) => ({
          workspaceId: workspace.id,
          path: workspace.path,
        })),
    [workspaces],
  );

  useEffect(() => {
    if (remoteWorkspaceTargets.length === 0) {
      setStates({});
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const targetIds = new Set(
      remoteWorkspaceTargets.map((target) => target.workspaceId),
    );

    setStates((prev) => {
      const next: Record<string, RemoteWorkspaceConnectionState> = {};
      for (const target of remoteWorkspaceTargets) {
        next[target.workspaceId] =
          prev[target.workspaceId] ?? {
            status: 'checking',
            checkedAt: Date.now(),
          };
      }
      return next;
    });

    const refresh = () => {
      for (const target of remoteWorkspaceTargets) {
        void checkRemoteWorkspaceConnection(target.path, controller.signal)
          .then((result) => {
            if (cancelled || !targetIds.has(target.workspaceId)) return;
            setStates((prev) => ({
              ...prev,
              [target.workspaceId]: result,
            }));
          })
          .catch((err) => {
            if (cancelled || !targetIds.has(target.workspaceId)) return;
            setStates((prev) => ({
              ...prev,
              [target.workspaceId]: {
                status: 'failed',
                detail: err instanceof Error ? err.message : String(err),
                checkedAt: Date.now(),
              },
            }));
          });
      }
    };

    refresh();
    const timer = window.setInterval(
      refresh,
      REMOTE_WORKSPACE_STATUS_CHECK_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [remoteWorkspaceTargets]);

  return states;
}
