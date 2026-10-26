import { ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  authUrl: string;
  onDismiss: () => void;
}

export function GoogleAuthBanner({ authUrl, onDismiss }: Props) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-yellow-50 dark:bg-yellow-950/30 border-b border-yellow-200 dark:border-yellow-800 text-sm">
      <span className="flex-1 text-yellow-800 dark:text-yellow-200">
        Google Drive authentication required to continue the upload step.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs border-yellow-400 dark:border-yellow-600 shrink-0"
        onClick={() => { window.location.href = authUrl; }}
      >
        <ExternalLink className="h-3 w-3 mr-1" />
        Authorize Google Drive
      </Button>
      <button
        className="text-yellow-600 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-100 shrink-0"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
