/**
 * Icons — a small, curated, dependency-free set (lucide-style: 24-grid, currentColor, 1.75 stroke).
 *
 * Inline SVG rather than an icon package, for the same reason the rest of the UI avoids
 * dependencies: no runtime cost, no tree-shaking surprises, and every glyph inherits `currentColor`
 * so it themes for free. Only the icons the navigation actually uses live here — add one when a
 * screen needs it, not speculatively.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  dashboard: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </Svg>
  ),
  staff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  ),
  roles: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  ),
  subscription: (p: IconProps) => (
    <Svg {...p}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </Svg>
  ),
  tariff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
      <circle cx="7" cy="7" r="1.2" />
    </Svg>
  ),
  website: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20Z" />
    </Svg>
  ),
  reports: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="0.5" />
      <rect x="12" y="8" width="3" height="10" rx="0.5" />
      <rect x="17" y="5" width="3" height="13" rx="0.5" />
    </Svg>
  ),
  audit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6M9 9h1" />
    </Svg>
  ),
  hospital: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 21h18M5 21V7l7-4 7 4v14" />
      <path d="M12 8v6M9 11h6" />
    </Svg>
  ),
  branches: (p: IconProps) => (
    <Svg {...p}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  ),
  departments: (p: IconProps) => (
    <Svg {...p}>
      <rect x="9" y="2" width="6" height="5" rx="1" />
      <rect x="3" y="17" width="6" height="5" rx="1" />
      <rect x="15" y="17" width="6" height="5" rx="1" />
      <path d="M12 7v5M6 17v-2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2" />
    </Svg>
  ),
  apikeys: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.5 12.5 8-8M17 5l2 2M14.5 7.5l2 2" />
    </Svg>
  ),
  reception: (p: IconProps) => (
    <Svg {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </Svg>
  ),
  myPatients: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4.8 3A2 2 0 0 0 3 5v2a6 6 0 0 0 12 0V5a2 2 0 0 0-1.8-2" />
      <path d="M9 13v3a5 5 0 0 0 10 0v-1" />
      <circle cx="20" cy="14" r="2" />
    </Svg>
  ),
  worklist: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 2v6l-5 9a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3l-5-9V2" />
      <path d="M8 2h8M6.5 15h11" />
    </Svg>
  ),
  pharmacy: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10.5 20.5a4.95 4.95 0 0 1-7-7l7-7a4.95 4.95 0 0 1 7 7Z" />
      <path d="m8.5 8.5 7 7" />
    </Svg>
  ),
  medicines: (p: IconProps) => (
    <Svg {...p}>
      <path d="m7.5 4.3 9 9M21 12l-8.5 8.5a3.5 3.5 0 0 1-5-5L16 7a3.5 3.5 0 0 1 5 5Z" />
    </Svg>
  ),
  ward: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 4v16M2 10h13a4 4 0 0 1 4 4v6M22 20v-6" />
      <circle cx="8" cy="8" r="1.6" />
    </Svg>
  ),
  patients: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M6 21v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1" />
    </Svg>
  ),
  appointments: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
      <path d="m9 16 2 2 4-4" />
    </Svg>
  ),
  beds: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="8" height="7" rx="1" />
      <rect x="13" y="4" width="8" height="7" rx="1" />
      <rect x="3" y="13" width="8" height="7" rx="1" />
      <rect x="13" y="13" width="8" height="7" rx="1" />
    </Svg>
  ),
  theatres: (p: IconProps) => (
    <Svg {...p}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </Svg>
  ),
  ambulance: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10 10H6M8 8v4" />
      <path d="M2 8a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v8h-2" />
      <path d="M15 9h4l3 4v3h-2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
      <path d="M9 18h6" />
    </Svg>
  ),
  billing: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1Z" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </Svg>
  ),
  receipts: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 2h12a1 1 0 0 1 1 1v18l-3-2-2 2-2-2-2 2-2-2-3 2V3a1 1 0 0 1 1-1Z" />
      <path d="M9 8h6M9 12h6" />
    </Svg>
  ),
  chevron: (p: IconProps) => (
    <Svg {...p}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  ),
  menu: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12h18M3 6h18M3 18h18" />
    </Svg>
  ),
  close: (p: IconProps) => (
    <Svg {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  ),
  sidebar: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </Svg>
  ),
  logout: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </Svg>
  ),
  lock: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  ),
  monitor: (p: IconProps) => (
    <Svg {...p}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Svg>
  ),
} as const;

export type IconName = keyof typeof Icons;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Glyph = Icons[name];
  return <Glyph className={className} />;
}
