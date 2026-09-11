import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Boxes, Settings as SettingsGlyph, Terminal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { t } from '@/lib/i18n';
import { useStore } from '@/store/useStore';
import {
  getCliUpdateSnapshot,
  subscribeCliUpdateStatus,
} from '@/lib/cliUpdateStatus';
import {
  assetMatchesWorkspace,
  getAssets,
  subscribeAssets,
  mergeCachedAssetsFromDisk,
} from '@/lib/downloadRegistry';
import { listCachedAssets, tauriAvailable } from '@/lib/tauri';

/**
 * CONTRACT: default export, no slots. Far-left icon rail, full height.
 *
 * Top   : primary views — 智能终端 (sessions/chat/files) and 资产 (asset hub).
 * Bottom: settings gear (opens the global settings modal at App level).
 *
 * Mirrors the Autocode-style app rail: navigation is icon+label, the active
 * view is highlighted with the accent tint.
 */
export type AppView = 'terminal' | 'assets';

export default function AppRail({
  activeView,
  onViewChange,
  onOpenSettings,
}: {
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  onOpenSettings: () => void;
}) {
  const locale = useStore((s) => s.locale);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const assets = useSyncExternalStore(subscribeAssets, getAssets);
  const cliUpdate = useSyncExternalStore(
    subscribeCliUpdateStatus,
    getCliUpdateSnapshot,
  );

  // Keep the asset badge fresh even while the asset view is closed. The
  // registry is otherwise only hydrated from disk when the asset center
  // mounts, which used to make the count read 0 until it was opened.
  const assetBadgeCwd = useMemo(() => {
    const activeWorkspace = activeWorkspaceId
      ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
      : null;
    return activeWorkspace?.path?.trim() || null;
  }, [activeWorkspaceId, workspaces]);

  useEffect(() => {
    if (!tauriAvailable()) return;
    let cancelled = false;
    const refresh = () => {
      void listCachedAssets(assetBadgeCwd)
        .then((files) => {
          if (!cancelled) mergeCachedAssetsFromDisk(files);
        })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [assetBadgeCwd]);

  const scopedAssets = useMemo(
    () =>
      assets.filter((asset) =>
        assetMatchesWorkspace(asset, activeWorkspaceId),
      ),
    [assets, activeWorkspaceId],
  );
  const assetActiveCount = scopedAssets.filter(
    (asset) => asset.status === 'pending',
  ).length;
  const assetTotalCount = scopedAssets.length;

  const navItems: {
    view: AppView;
    label: string;
    icon: typeof Terminal;
    badge?: number;
    badgeTone: 'active' | 'total';
  }[] = [
    {
      view: 'terminal',
      label: t(locale, 'rail.terminal'),
      icon: Terminal,
      badgeTone: 'active',
    },
    {
      view: 'assets',
      label: t(locale, 'rail.assets'),
      icon: Boxes,
      badge: assetTotalCount,
      badgeTone: assetActiveCount > 0 ? 'active' : 'total',
    },
  ];

  return (
    <nav
      aria-label={t(locale, 'rail.label')}
      className="flex h-full w-16 shrink-0 flex-col items-center border-r border-border bg-panel"
    >
      <div className="flex w-full flex-col items-center gap-1 px-0.5 pt-3">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              aria-current={active ? 'page' : undefined}
              title={item.label}
              onClick={() => onViewChange(item.view)}
              className={cn(
                'group relative flex w-full flex-col items-center gap-1 rounded-md px-0.5 py-2 transition-colors',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-fg-faint hover:bg-border-soft hover:text-fg',
              )}
            >
              <span className="relative">
                <Icon size={19} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
                {item.badge ? (
                  <span
                    className={cn(
                      'absolute -right-2 -top-1 min-w-[14px] rounded-full px-1 text-center font-mono text-[9px] leading-[14px] ring-1',
                      item.badgeTone === 'active'
                        ? 'bg-accent text-bg ring-accent'
                        : 'bg-panel-2 text-fg-dim ring-border-soft',
                    )}
                  >
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                ) : null}
              </span>
              <span className="block w-full truncate text-center text-[10px] leading-none">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex w-full flex-col items-center px-0.5 pb-3">
        <button
          type="button"
          onClick={onOpenSettings}
          title={t(locale, 'settings.openHint')}
          className="group relative flex w-full flex-col items-center gap-1 rounded-md px-0.5 py-2 text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
        >
          <span className="relative">
            <SettingsGlyph size={19} strokeWidth={1.8} aria-hidden="true" />
            {cliUpdate.hasUnseenUpdate && (
              <span
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#ef4444] ring-2 ring-panel"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="block w-full truncate text-center text-[10px] leading-none">
            {t(locale, 'settings.open')}
          </span>
          {cliUpdate.hasUnseenUpdate && (
            <span className="sr-only">{t(locale, 'settings.cliUpdate.badgeHint')}</span>
          )}
        </button>
      </div>
    </nav>
  );
}
