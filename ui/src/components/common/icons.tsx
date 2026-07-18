/**
 * components/common/icons.tsx — inline SVG icon set (owned by F4).
 *
 * Hand-authored 16x16 paths, stroke 1.5, currentColor (SPEC §9: Lucide-like, no deps).
 * Transport glyphs (play/stop/record/pause/dot/dragHandle) are filled shapes.
 * Usage: <Icon name="play" /> — size via prop, color via CSS `color`.
 */

import React from "react";

type P = React.ReactElement;

/* Shorthand builders ------------------------------------------------------ */
const path = (d: string, key?: string | number, extra?: React.SVGProps<SVGPathElement>): P => (
  <path key={key} d={d} {...extra} />
);
const fill = (d: string, key?: string | number): P => (
  <path key={key} d={d} fill="currentColor" stroke="none" />
);
const dotEl = (cx: number, cy: number, r: number, key?: string | number): P => (
  <circle key={key} cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

/* ============================================================================
 * Glyphs (16x16 viewBox, drawn for strokeWidth 1.5)
 * ========================================================================= */

const BASE = {
  /* ---- transport ---- */
  play: fill("M5 3.2 12.6 8 5 12.8Z"),
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
  record: <circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="4" y="3.5" width="3" height="9" rx="0.75" fill="currentColor" stroke="none" />
      <rect x="9" y="3.5" width="3" height="9" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  loop: (
    <>
      {path("M12.5 6.5v-1a2 2 0 0 0-2-2h-7", 0)}
      {path("M5.5 1.5 3.5 3.5l2 2", 1)}
      {path("M3.5 9.5v1a2 2 0 0 0 2 2h7", 2)}
      {path("m10.5 14.5 2-2-2-2", 3)}
    </>
  ),
  metronome: (
    <>
      {path("M6.3 2.5h3.4l2.3 10.2a.8.8 0 0 1-.78 1.05H4.78A.8.8 0 0 1 4 12.7Z", 0)}
      {path("M8 9.2 12 3.4", 1)}
      {dotEl(8, 9.6, 0.9, 2)}
    </>
  ),
  magnet: (
    <>
      {path("M4 2.5v5.5a4 4 0 0 0 8 0V2.5h-3v5.5a1 1 0 0 1-2 0V2.5Z", 0)}
      {path("M4 5.25h3M9 5.25h3", 1)}
    </>
  ),

  /* ---- edit / file ---- */
  undo: (
    <>
      {path("M3 6h7a3.5 3.5 0 0 1 0 7H6.5", 0)}
      {path("M5.5 3.5 3 6l2.5 2.5", 1)}
    </>
  ),
  redo: (
    <>
      {path("M13 6H6a3.5 3.5 0 0 0 0 7h3.5", 0)}
      {path("M10.5 3.5 13 6l-2.5 2.5", 1)}
    </>
  ),
  save: (
    <>
      {path("M3.5 3.5h7.2l1.8 1.8v7.2a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z", 0)}
      {path("M5.5 3.5v2.8h5V3.6", 1)}
      {path("M5.5 13.5V9.8h5v3.7", 2)}
    </>
  ),
  export: (
    <>
      {path("M8 10V2.8", 0)}
      {path("M5 5.5 8 2.5l3 3", 1)}
      {path("M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3", 2)}
    </>
  ),
  import: (
    <>
      {path("M8 2.5v7.2", 0)}
      {path("M5 6.8 8 9.8l3-3", 1)}
      {path("M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3", 2)}
    </>
  ),
  plus: path("M8 3.5v9M3.5 8h9"),
  trash: (
    <>
      {path("M3 4.5h10", 0)}
      {path("M5.5 4.5v-1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1", 1)}
      {path("m4.5 4.5.5 8a1 1 0 0 0 1 .95h4a1 1 0 0 0 1-.95l.5-8", 2)}
      {path("M6.7 7v4.2M9.3 7v4.2", 3)}
    </>
  ),
  x: path("m4 4 8 8M12 4l-8 8"),
  check: path("m3 8.5 3.4 3.4L13 5"),
  pencil: (
    <>
      {path("m2.5 13.5.6-2.7 7.5-7.5a1.3 1.3 0 0 1 1.84 0l.26.26a1.3 1.3 0 0 1 0 1.84l-7.5 7.5Z", 0)}
      {path("m9.8 4.1 2.1 2.1", 1)}
    </>
  ),
  eraser: (
    <>
      {path("M6.8 13.3 2.9 9.4a1 1 0 0 1 0-1.4l5.3-5.3a1 1 0 0 1 1.4 0l3.4 3.4a1 1 0 0 1 0 1.4l-5.8 5.8a1 1 0 0 1-.7.3H4.5", 0)}
      {path("M5.2 6.4 9.6 10.8", 1)}
      {path("M9 13.3h4.5", 2)}
    </>
  ),
  pointer: path("M4.5 2.3 11.9 9.1l-3.3.5 2 3.5-1.74 1-2-3.5-2.36 2.3Z"),
  scissors: (
    <>
      <circle key="a" cx="4" cy="4.4" r="1.9" />
      <circle key="b" cx="4" cy="11.6" r="1.9" />
      {path("M5.55 5.55 13.5 13.2", 2)}
      {path("M5.55 10.45 13.5 2.8", 3)}
    </>
  ),
  glue: (
    <>
      {path("m3 4 3.5 4L3 12", 0)}
      {path("m13 4-3.5 4L13 12", 1)}
      {path("M8 2.8v10.4", 2)}
    </>
  ),

  /* ---- chevrons ---- */
  chevronUp: path("m4 10 4-4 4 4"),
  chevronDown: path("m4 6 4 4 4-4"),
  chevronLeft: path("M10 4 6 8l4 4"),
  chevronRight: path("m6 4 4 4-4 4"),

  /* ---- browser / media ---- */
  folder: path(
    "M2.5 4a1 1 0 0 1 1-1h3.1l1.4 1.8h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z",
  ),
  audioWave: path("M2.5 6.5v3M5.25 4.2v7.6M8 2.5v11M10.75 5v6M13.5 6.5v3"),
  midiNote: (
    <>
      <circle key="a" cx="6" cy="11.3" r="2" />
      {path("M8 11.3V3.2l4 1.3v3", 1)}
    </>
  ),
  piano: (
    <>
      <rect key="r" x="2.5" y="3.5" width="11" height="9" rx="1" />
      {path("M5.83 8.5v4M10.17 8.5v4", 1)}
      {path("M5.83 3.5v5M10.17 3.5v5", 2, { strokeWidth: 2.4 })}
    </>
  ),
  mixer: (
    <>
      {path("M4 2.5v11M8 2.5v11M12 2.5v11", 0)}
      {path("M2.4 9.5h3.2M6.4 5.5h3.2M10.4 11h3.2", 1)}
    </>
  ),
  sliders: (
    <>
      {path("M2.5 4.5h11M2.5 8h11M2.5 11.5h11", 0)}
      {path("M10 2.9v3.2M5 6.4v3.2M8 9.9v3.2", 1)}
    </>
  ),
  /* perspective room floor (mixer Room View) */
  stage: (
    <>
      {path("M2.2 13.2 5.6 4h4.8l3.4 9.2Z", 0)}
      {path("M3.5 9.7h9M8 4v9.2", 1, { strokeWidth: 1.1 })}
    </>
  ),
  plug: (
    <>
      {path("M5.5 1.8v3.4M10.5 1.8v3.4", 0)}
      {path("M4 5.2h8v2.3a4 4 0 0 1-8 0Z", 1)}
      {path("M8 11.5v2.7", 2)}
    </>
  ),
  power: (
    <>
      {path("M8 1.8v6", 0)}
      {path("M11.3 4.2a5 5 0 1 1-6.6 0", 1)}
    </>
  ),

  /* ---- status / app ---- */
  search: (
    <>
      <circle key="c" cx="7" cy="7" r="4.5" />
      {path("M10.4 10.4 14 14", 1)}
    </>
  ),
  settings: (
    <>
      <circle key="c" cx="8" cy="8" r="2" />
      {path(
        "M8 1.3v2.4M8 12.3v2.4M1.3 8h2.4M12.3 8h2.4M3.26 3.26l1.7 1.7M11.04 11.04l1.7 1.7M12.74 3.26l-1.7 1.7M4.96 11.04l-1.7 1.7",
        1,
      )}
    </>
  ),
  sparkles: (
    <>
      {path("M8 1.5l1.3 3.4L12.7 6.2 9.3 7.5 8 10.9 6.7 7.5 3.3 6.2 6.7 4.9Z", 0)}
      {path("M12.5 9.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6Z", 0)}
    </>
  ),
  scriptList: (
    <>
      {path("M3.5 2.5h9v11h-9z", 0)}
      {path("M5.5 5.5h5M5.5 8h5M5.5 10.5h3", 1)}
    </>
  ),
  eye: (
    <>
      {path("M1 8s2.6-4.6 7-4.6S15 8 15 8s-2.6 4.6-7 4.6S1 8 1 8Z", 0)}
      <circle key="c" cx="8" cy="8" r="1.9" />
    </>
  ),
  layers: (
    <>
      {path("M8 1.8l6.2 3.1L8 8 1.8 4.9Z", 0)}
      {path("M2.4 8L8 10.8 13.6 8", 1)}
      {path("M2.4 11L8 13.8 13.6 11", 1)}
    </>
  ),
  help: (
    <>
      <circle key="c" cx="8" cy="8" r="6.4" />
      {path("M6.1 6.2a1.9 1.9 0 1 1 2.5 1.8c-.6.25-.9.7-.9 1.35v.25", 1)}
      {path("M8 11.7h.01", 1)}
    </>
  ),
  warning: (
    <>
      {path("M7.14 2.6a1 1 0 0 1 1.72 0l5.6 9.9a1 1 0 0 1-.86 1.5H2.4a1 1 0 0 1-.86-1.5Z", 0)}
      {path("M8 6v3.4", 1)}
      {dotEl(8, 11.7, 0.8, 2)}
    </>
  ),
  error: (
    <>
      <circle key="c" cx="8" cy="8" r="5.5" />
      {path("m6 6 4 4M10 6l-4 4", 1)}
    </>
  ),
  refresh: (
    <>
      {path("M13.5 8a5.5 5.5 0 1 1-1.46-3.73", 0)}
      {path("M13.7 2.2v3.3h-3.3", 1)}
    </>
  ),
  lock: (
    <>
      <rect key="r" x="3.5" y="7" width="9" height="6.5" rx="1" />
      {path("M5.5 7V5a2.5 2.5 0 0 1 5 0v2", 1)}
    </>
  ),
  zoomIn: (
    <>
      <circle key="c" cx="7" cy="7" r="4.5" />
      {path("M10.4 10.4 14 14", 1)}
      {path("M7 5.2v3.6M5.2 7h3.6", 2)}
    </>
  ),
  zoomOut: (
    <>
      <circle key="c" cx="7" cy="7" r="4.5" />
      {path("M10.4 10.4 14 14", 1)}
      {path("M5.2 7h3.6", 2)}
    </>
  ),
  marker: (
    <>
      {path("M4 14V2.5", 0)}
      {path("M4 3h7.3l-2 2.9 2 2.9H4", 1)}
    </>
  ),
  mic: (
    <>
      <rect key="r" x="6" y="1.8" width="4" height="7.2" rx="2" />
      {path("M3.5 7.5a4.5 4.5 0 0 0 9 0", 1)}
      {path("M8 12v2.3", 2)}
    </>
  ),
  headphones: (
    <>
      {path("M2.5 11.5V8a5.5 5.5 0 0 1 11 0v3.5", 0)}
      <rect key="l" x="2.5" y="9.5" width="2.8" height="4" rx="1" />
      <rect key="r" x="10.7" y="9.5" width="2.8" height="4" rx="1" />
    </>
  ),
  mute: (
    <>
      {path("M2.8 6.3h2L8.3 3.6v8.8L4.8 9.7h-2Z", 0)}
      {path("m10.7 6.5 3 3M13.7 6.5l-3 3", 1)}
    </>
  ),
  solo: (
    <>
      <circle key="c" cx="8" cy="8" r="5.7" />
      {path("M9.9 5.7c-.4-.7-1.1-1-1.9-1-1.1 0-2 .6-2 1.6 0 2.2 4 1.2 4 3.4 0 1-.9 1.6-2 1.6-.9 0-1.6-.4-2-1.1", 1)}
    </>
  ),
  dot: dotEl(8, 8, 3),
  dragHandle: (
    <>
      {dotEl(6, 4, 1.1, 0)}
      {dotEl(10, 4, 1.1, 1)}
      {dotEl(6, 8, 1.1, 2)}
      {dotEl(10, 8, 1.1, 3)}
      {dotEl(6, 12, 1.1, 4)}
      {dotEl(10, 12, 1.1, 5)}
    </>
  ),
  snowflake: (
    <>
      {path("M8 1.5v13M2.37 4.75l11.26 6.5M13.63 4.75 2.37 11.25", 0)}
      {path("M6.2 2.9 8 4.7l1.8-1.8M6.2 13.1 8 11.3l1.8 1.8", 1)}
    </>
  ),
  link: (
    <>
      {path("m6.5 9.5 3-3", 0)}
      {path("m7.3 4.6 1.1-1.1a2.55 2.55 0 0 1 3.6 3.6l-1.1 1.1", 1)}
      {path("m8.7 11.4-1.1 1.1a2.55 2.55 0 0 1-3.6-3.6l1.1-1.1", 2)}
    </>
  ),
};

/* Aliases — SPEC / common DAW terms map onto the same glyphs. */
const PATHS = {
  ...BASE,
  snap: BASE.magnet,
  gear: BASE.settings,
  plugin: BASE.plug,
  bypass: BASE.power,
  split: BASE.scissors,
  freeze: BASE.snowflake,
  relink: BASE.link,
  flag: BASE.marker,
  close: BASE.x,
} as const;

export type IconName = keyof typeof PATHS;

/** All icon names (handy for galleries / debugging). */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps {
  name: IconName;
  /** Rendered square size in px (default 16; paths are drawn on a 16x16 grid). */
  size?: number;
  /** Stroke width (default 1.5). */
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible label; omitted → aria-hidden decorative icon. */
  title?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.5, className, style, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: "0 0 auto", display: "block", ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
