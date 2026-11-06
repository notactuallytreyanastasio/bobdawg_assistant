// The page's few icons, drawn inline so they take the text colour and cost no request.

import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PlusIcon = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>;
export const MenuIcon = () => <Icon><path d="M4 7h16M4 12h16M4 17h16" /></Icon>;
export const TrashIcon = () => <Icon><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></Icon>;
export const CopyIcon = () => <Icon><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></Icon>;
export const CheckIcon = () => <Icon><path d="m5 12 5 5L20 7" /></Icon>;
export const RetryIcon = () => <Icon><path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6" /></Icon>;
export const SendIcon = () => <Icon><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;
export const StopIcon = () => <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>;
export const DownIcon = () => <Icon><path d="M12 5v14M6 13l6 6 6-6" /></Icon>;
export const BulbIcon = () => <Icon><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3Z" /></Icon>;
export const ChartIcon = () => <Icon><path d="M4 20V4M4 20h16M8 16v-5M12.5 16V8M17 16v-3" /></Icon>;
export const CodeIcon = () => <Icon><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></Icon>;
export const ExpandIcon = () => <Icon><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>;
export const CloseIcon = () => <Icon><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const LeftIcon = () => <Icon><path d="m15 5-7 7 7 7" /></Icon>;
export const RightIcon = () => <Icon><path d="m9 5 7 7-7 7" /></Icon>;
export const PlayIcon = () => <Icon><path d="M7 5v14l11-7Z" /></Icon>;
