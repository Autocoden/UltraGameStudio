import { AlertTriangle, Loader2, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { t, type Locale } from '@/lib/i18n';
import type {
  RemoteWorkspaceConnectionState,
  RemoteWorkspaceConnectionStatus,
} from '@/lib/remoteWorkspaceStatus';

export function remoteWorkspaceConnectionLabel(
  locale: Locale,
  status: RemoteWorkspaceConnectionStatus,
): string {
  if (status === 'connected') {
    return t(locale, 'remoteWorkspace.statusConnected');
  }
  if (status === 'failed') return t(locale, 'remoteWorkspace.statusFailed');
  if (status === 'unconfigured') {
    return t(locale, 'remoteWorkspace.statusUnconfigured');
  }
  return t(locale, 'remoteWorkspace.statusChecking');
}

export function remoteWorkspaceConnectionDotClassName(
  status: RemoteWorkspaceConnectionStatus,
): string {
  // The glow ring used to be a literal rgba() sampled from Tailwind's palette
  // (emerald-400/red-400/amber-400/sky-400), so it stayed green/red/amber/sky even
  // when the theme's status colors are teal/pink/violet. Derive it from the same
  // token as the dot instead.
  if (status === 'connected') {
    return 'bg-status-success ring-2 ring-status-success/20';
  }
  if (status === 'failed') {
    return 'bg-status-error ring-2 ring-status-error/20';
  }
  if (status === 'unconfigured') {
    return 'bg-status-warning ring-2 ring-status-warning/20';
  }
  return 'animate-pulse bg-status-info ring-2 ring-status-info/20';
}

function badgeClassName(status: RemoteWorkspaceConnectionStatus): string {
  if (status === 'connected') {
    return 'border-status-success/40 bg-status-success/10 text-status-success';
  }
  if (status === 'failed') {
    return 'border-status-error/50 bg-status-error/10 text-status-error';
  }
  if (status === 'unconfigured') {
    return 'border-status-warning/45 bg-status-warning/10 text-status-warning';
  }
  return 'border-status-info/40 bg-status-info/10 text-status-info';
}

function statusIcon(status: RemoteWorkspaceConnectionStatus) {
  if (status === 'connected') return Wifi;
  if (status === 'failed') return WifiOff;
  if (status === 'unconfigured') return AlertTriangle;
  return Loader2;
}

export default function RemoteWorkspaceStatusBadge({
  state,
  locale,
  showText = true,
  className,
}: {
  state?: RemoteWorkspaceConnectionState;
  locale: Locale;
  showText?: boolean;
  className?: string;
}) {
  const status = state?.status ?? 'checking';
  const label = remoteWorkspaceConnectionLabel(locale, status);
  const Icon = statusIcon(status);

  return (
    <span
      title={state?.detail ? `${label}：${state.detail}` : label}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] font-medium leading-none',
        badgeClassName(status),
        className,
      )}
    >
      <Icon
        size={12}
        aria-hidden="true"
        className={cn('shrink-0', status === 'checking' && 'animate-spin')}
      />
      {showText && <span className="truncate">{label}</span>}
    </span>
  );
}
