import type { ReactNode } from 'react';

const paths = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  fit: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></>,
  home: <><path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 21v-8h6v8" /></>,
  undo: <><path d="m8 4-5 5 5 5" /><path d="M3 9h11a6 6 0 0 1 0 12h-3" /></>,
  redo: <><path d="m16 4 5 5-5 5" /><path d="M21 9H10a6 6 0 0 0 0 12h3" /></>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M7 3v6h9V3M7 21v-7h10v7" /></>,
  export: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
  auto: <><path d="m4 20 11-11 3 3L7 23z" transform="translate(0 -2)" /><path d="m15 3 .8 2.2L18 6l-2.2.8L15 9l-.8-2.2L12 6l2.2-.8ZM5 3v4M3 5h4M20 15v4m-2-2h4" /></>,
  tap: <><path d="M9 12V5a2 2 0 0 1 4 0v7m0-2a2 2 0 0 1 4 0v3m0-1a2 2 0 0 1 4 0v4a6 6 0 0 1-6 6h-2a5 5 0 0 1-4-2l-4-5a2 2 0 0 1 3-2l1 1" /></>,
  stretch: <><path d="M5 3v18M9 6h12M9 12h8M9 18h12m-3-3 3 3-3 3m0-18 3 3-3 3" /></>,
  layers: <><path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
  duplicate: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3m3-1h7m-3.5-3.5v7" /></>,
  delete: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  'eye-off': <><path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3 4M6 6.5A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5-1m-7-8a3 3 0 0 0 4 4" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" /></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 7.5-2m-3.5 11v2" /></>,
  straight: <><path d="M4 5h16v14H4zM8 5v14M12 5v14M16 5v14" /></>,
  arc: <><path d="M4 19A15 15 0 0 1 19 4v6a9 9 0 0 0-9 9zM8 8l4 4M13 5l2 6M5 13l6 2" /></>,
  curve: <><path d="M3 17c7 0 3-10 9-10s2 10 9 10" /><circle cx="3" cy="17" r="1.5" /><circle cx="12" cy="7" r="1.5" /><circle cx="21" cy="17" r="1.5" /></>,
  'edit-edges': <><path d="M5 5h14v14H5z" /><path d="m9 15 6-6" /><rect x="3" y="3" width="4" height="4" rx="1" /><rect x="17" y="17" width="4" height="4" rx="1" /></>,
  motion: <><path d="M3 6h14M3 10h18M3 14h11M3 18h16" /></>,
  'over-subject': <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1" /><path d="M13 12h8M13 16h6" /></>,
  smooth: <><path d="M3 6h18M3 10h18M3 14h18M3 18h18" /></>,
  pixels: <><path d="M3 5h8v4H3zM13 5h4v4h-4zM3 11h5v4H3zM10 11h11v4H10zM3 17h12v3H3z" /></>,
  colors: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M15 4v16" /><path d="M4 16h4M10 12h4M16 8h4" /></>,
  'edit-path': <><path d="M4 17C8 4 16 4 20 17M4 17l2-7m14 7-2-7" /><circle cx="4" cy="17" r="2" /><circle cx="20" cy="17" r="2" /><circle cx="12" cy="7" r="2" /></>,
  subject: <><circle cx="12" cy="8" r="3" /><path d="M6 20v-2a6 6 0 0 1 12 0v2M4 7V4h3m10 0h3v3M4 17v3h3m10 0h3v-3" /></>,
  more: <><circle cx="4" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="20" cy="12" r="1" /></>,
  'chevron-up': <path d="m7 14 5-5 5 5" />,
  'chevron-down': <path d="m7 10 5 5 5-5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

/** Shared optical size and stroke weight for every editor control. */
export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
