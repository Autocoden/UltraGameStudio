import { useCallback, useState } from 'react';
import WorkspaceListSelect from '@/components/WorkspaceListSelect';
import RemoteWorkspaceDialog from '@/components/RemoteWorkspaceDialog';
import useRemoteWorkspaceStates from '@/hooks/useRemoteWorkspaceStates';
import { pickFolder } from '@/lib/folderPicker';
import { t } from '@/lib/i18n';
import {
  getRemoteWorkspace,
  remoteWorkspaceIdFromPath,
  type RemoteWorkspaceConfig,
} from '@/lib/remoteWorkspace';
import { workspacePathKey } from '@/lib/workspaceHistory';
import { useStore } from '@/store/useStore';
import { historyStore } from '@/store/history/store';

/**
 * CONTRACT: default export, no props. Top bar spanning the full width to the
 * right of the app rail.
 *
 * Left: brand. Then the workspace/project switcher (moved up from the old
 * sidebar) — the project list now lives at the top of the window, and the
 * cloud-project dialog opens from here.
 */
export default function ProjectTopBar() {
  const locale = useStore((s) => s.locale);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const selectedWorkspaceIdRaw = useStore((s) => s.selectedWorkspaceId);
  // The switcher follows an explicit, navigation-only selection that does NOT
  // change when the user opens a session in another workspace. Fall back to
  // the active workspace before history init populates it.
  const selectedWorkspaceId = selectedWorkspaceIdRaw ?? activeWorkspaceId;
  const setWorkspace = useStore((s) => s.setWorkspace);
  const remoteConnectionStates = useRemoteWorkspaceStates(workspaces);
  const [remoteDialog, setRemoteDialog] = useState<{
    existing: RemoteWorkspaceConfig | null;
  } | null>(null);

  const handleBrowseLocalWorkspace = useCallback(async () => {
    const path = await pickFolder(t(locale, 'workspace.chooseFolder'));
    if (!path) return;
    const key = workspacePathKey(path);
    const existing = useStore
      .getState()
      .workspaces.find(
        (workspace) =>
          workspace.path && workspacePathKey(workspace.path) === key,
      );
    if (existing) {
      window.alert(
        t(locale, 'workspaceList.alreadyExists').replace(
          '{name}',
          existing.name,
        ),
      );
    }
    setWorkspace(path);
  }, [locale, setWorkspace]);

  // Open the cloud-project dialog. With a path, edits that existing remote
  // project; without one, creates a new remote project.
  const handleOpenRemoteDialog = useCallback((existingPath?: string) => {
    const id = existingPath ? remoteWorkspaceIdFromPath(existingPath) : '';
    setRemoteDialog({ existing: id ? getRemoteWorkspace(id) : null });
  }, []);

  // After saving a remote project, register/select it like any workspace; its
  // synthetic remote://<id> path flows through the normal selection path.
  const handleRemoteSaved = useCallback(
    (remotePath: string, config: RemoteWorkspaceConfig) => {
      setWorkspace(remotePath);
      void historyStore
        .resolveWorkspaceByPath(remotePath)
        .then((ws) => historyStore.renameWorkspace(ws.id, config.label))
        .catch(() => {
          /* naming is best-effort */
        });
    },
    [setWorkspace],
  );

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-accent-2">◆</span>
        <span className="text-sm font-semibold tracking-tight text-fg">
          UltraGameStudio
        </span>
      </div>
      <div className="w-64 min-w-0 max-w-[40vw]">
        <WorkspaceListSelect
          workspaces={workspaces}
          activeWorkspaceId={selectedWorkspaceId}
          locale={locale}
          onSelect={setWorkspace}
          onBrowseLocal={() => {
            void handleBrowseLocalWorkspace();
          }}
          onAddRemote={handleOpenRemoteDialog}
          remoteConnectionStates={remoteConnectionStates}
        />
      </div>
      <div className="ml-auto min-w-0" />

      {remoteDialog && (
        <RemoteWorkspaceDialog
          locale={locale}
          existing={remoteDialog.existing}
          onClose={() => setRemoteDialog(null)}
          onSaved={handleRemoteSaved}
        />
      )}
    </header>
  );
}
