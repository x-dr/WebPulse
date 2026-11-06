export type WorkspaceIconName =
  | 'overview'
  | 'realtime'
  | 'sources'
  | 'pages'
  | 'visitors'
  | 'settings'
  | 'menu'
  | 'globe'
  | 'logout'
  | 'shield'
  | 'refresh'
  | 'external'
  | 'info';

const paths: Record<WorkspaceIconName, string> = {
  overview: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  realtime:
    'M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2M8 8a5.7 5.7 0 0 0 0 8m8-8a5.7 5.7 0 0 1 0 8M12 10v4',
  sources:
    'm10 13 4-4m-5 7-2 2a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m0 8a4.2 4.2 0 0 0 6 0l4-4a4.2 4.2 0 0 0-6-6l-2 2',
  pages: 'M14 3H5v18h14V8Zm0 0v6h5M8 13h8m-8 4h6',
  visitors:
    'M15 21v-3a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v3m18 0v-3a4 4 0 0 0-3-3.9M16 3.2a4 4 0 0 1 0 7.6M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  settings:
    'm10 2-.6 3-2 .9L4.7 5 2 9.7l2.3 2v1.6L2 15.2 4.7 20l2.7-.9 2 .9.6 2h4l.6-2 2-.9 2.7.9 2.7-4.8-2.3-1.9v-1.6l2.3-2L19.3 5l-2.7.9-2-.9L14 2Zm6 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  globe:
    'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M5 6h14M5 18h14M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
  logout: 'M10 4H4v16h6m5-12 4 4-4 4m-7-4h13',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
  refresh: 'M20 7v5h-5M4 17v-5h5m-4.7-3a8 8 0 0 1 13.3-4L20 8M4 16l2.4 3A8 8 0 0 0 19.7 15',
  external: 'M14 3h7v7m0-7L10 14m0-10H4v16h16v-6',
  info: 'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
};

export function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  return (
    <svg
      className="workspace-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function PulseMark({
  className = '',
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <svg
      className={className}
      viewBox={compact ? '0 0 32 32' : '0 0 160 40'}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={
          compact
            ? 'M3 17h6l3-8 6 15 3-8h8'
            : 'M1 24h37l8-10 7 19 9-12h12l7 4 9-21 6 30 8-14h12l8-9 10 13h25'
        }
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
