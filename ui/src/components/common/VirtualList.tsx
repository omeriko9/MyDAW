/**
 * VirtualList — simple fixed-row-height windowed list (owned by F4).
 *
 * For long flat lists (plugin registry, file browser). Renders only the visible rows
 * (+overscan). Container height comes from `height` or fills the parent (measured via
 * ResizeObserver). Rows are absolutely positioned; give them height: itemHeight.
 */

import React, { useEffect, useRef, useState } from "react";

export interface VirtualListProps {
  itemCount: number;
  /** Fixed row height in px. */
  itemHeight: number;
  /** Render one row. Apply your own row styling; position/size is handled here. */
  renderItem: (index: number) => React.ReactNode;
  /** Stable row key (default: index). */
  itemKey?: (index: number) => React.Key;
  /** Extra rows rendered above/below the viewport (default 4). */
  overscan?: number;
  /** Explicit height; omit to fill the parent (parent needs a resolved height). */
  height?: number | string;
  /** Scroll this index into view when it changes (e.g. keyboard selection). */
  scrollToIndex?: number;
  className?: string;
  style?: React.CSSProperties;
  onScroll?: (scrollTop: number) => void;
}

export function VirtualList({
  itemCount,
  itemHeight,
  renderItem,
  itemKey,
  overscan = 4,
  height,
  scrollToIndex,
  className,
  style,
  onScroll,
}: VirtualListProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep an externally-driven selection in view.
  useEffect(() => {
    if (scrollToIndex === undefined || scrollToIndex < 0) return;
    const el = outerRef.current;
    if (!el) return;
    const top = scrollToIndex * itemHeight;
    const bottom = top + itemHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [scrollToIndex, itemHeight]);

  const totalH = itemCount * itemHeight;
  const first = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const last = Math.min(itemCount - 1, Math.ceil((scrollTop + viewH) / itemHeight) + overscan);

  const rows: React.ReactNode[] = [];
  for (let i = first; i <= last; i++) {
    rows.push(
      <div
        key={itemKey ? itemKey(i) : i}
        style={{ position: "absolute", top: i * itemHeight, left: 0, right: 0, height: itemHeight }}
      >
        {renderItem(i)}
      </div>,
    );
  }

  return (
    <div
      ref={outerRef}
      className={className}
      style={{ overflowY: "auto", overflowX: "hidden", position: "relative", height: height ?? "100%", ...style }}
      onScroll={(e) => {
        const st = e.currentTarget.scrollTop;
        setScrollTop(st);
        onScroll?.(st);
      }}
    >
      <div style={{ position: "relative", height: totalH }}>{rows}</div>
    </div>
  );
}
