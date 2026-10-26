import { SyncStatus } from '@/lib/session-sync';

interface SyncIndicatorProps {
  status: SyncStatus;
  lastSyncAt: number | null;
  code: string;
}

export function SyncIndicator({ status, lastSyncAt, code }: SyncIndicatorProps) {
  const age = lastSyncAt ? Math.floor((Date.now() - lastSyncAt) / 1000) : null;

  const dotColor =
    status === 'synced' ? 'bg-green-500' :
    status === 'syncing' ? 'bg-yellow-400 animate-pulse' :
    status === 'error' ? 'bg-red-500' :
    'bg-muted-foreground';

  const label =
    status === 'synced' && age !== null ? `Synced ${age < 5 ? 'just now' : `${age}s ago`}` :
    status === 'syncing' ? 'Syncing…' :
    status === 'error' ? 'Sync error' :
    'Not syncing';

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none" title={label}>
      <div className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
      <span className="hidden sm:inline font-mono tracking-wider">{code}</span>
      <span className="hidden md:inline text-muted-foreground/70">·</span>
      <span className="hidden md:inline">{label}</span>
    </div>
  );
}
