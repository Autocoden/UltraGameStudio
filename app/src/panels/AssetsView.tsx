import { AssetCenterContent } from '@/panels/DownloadsModal';
import { useStore } from '@/store/useStore';

/**
 * CONTRACT: default export, no props. Full-page 资产 view, opened from the
 * app rail's "资产" entry.
 *
 * Renders the shared asset-hub body (header + search + asset sections) as a
 * page instead of a modal. "跳到资产所在会话" dispatches the asset-session
 * jump event; App listens for it to switch back to the 智能终端 view.
 */
export default function AssetsView() {
  const locale = useStore((s) => s.locale);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg">
      <AssetCenterContent locale={locale} />
    </div>
  );
}
