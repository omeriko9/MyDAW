/**
 * Mixer (U3) — bottom-dock mixer panel (SPEC §9 "Mixer (bottom dock tab)").
 *
 * Horizontal strip rail, ordered: regular tracks (folders' children in model order,
 * folder rows themselves skipped — folders have no audio role, SPEC §7), then buses,
 * then the master strip PINNED at the right behind a separator. Wide (84px) / narrow
 * (56px) strips, persisted in localStorage. With >40 strips the rail windows
 * horizontally (simple scroll-position windowing). Renders a sane empty state when
 * project === null.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadBoolPref, loadPref, oneOf, savePref } from "../../lib/prefs";
import { useStore } from "../../store/store";
import { Icon } from "../common/icons";
import { IconButton } from "../common/IconButton";
import { ChannelStrip } from "./ChannelStrip";
import "./mixer.css";

// loadBoolPref also accepts the legacy raw "1"/"0" this key was written with.
const WIDE_PREF = "mixer.wide";
const SHOW_MIDI_PREF = "mixer.showMidiChannels";
const VIRTUALIZE_THRESHOLD = 40;
const STRIP_GAP = 2;
const OVERSCAN = 4;

/* Mix views (UI_IMPROVE.md §3.3) — kind filters over the strip rail (vertical
   icon toggles in the toolbar; master stays pinned in every view). */
type MixView = "all" | "audio" | "instr" | "buses";
const VIEW_PREF = "mixer.view";
const MIX_VIEWS: Array<{ id: MixView; icon: "mixer" | "audioWave" | "piano" | "layers"; tooltip: string }> = [
  { id: "all", icon: "mixer", tooltip: "Mix view: all channels" },
  { id: "audio", icon: "audioWave", tooltip: "Mix view: audio tracks only" },
  { id: "instr", icon: "piano", tooltip: "Mix view: instrument (and shown MIDI) tracks only" },
  { id: "buses", icon: "layers", tooltip: "Mix view: buses only" },
];

export default function Mixer() {
  const project = useStore((s) => s.project);
  const connected = useStore((s) => s.connected);
  const [wide, setWide] = useState(() => loadBoolPref(WIDE_PREF, true));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(0);

  const hasProject = project !== null;

  // Seed viewport width BEFORE first paint so a >40-strip session windows immediately instead
  // of mounting every strip once (viewW stayed 0 until the post-paint ResizeObserver fired).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) setViewW(el.clientWidth);
  }, [hasProject]);

  // Track viewport width for ongoing resizes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasProject]);

  const toggleWide = () => {
    setWide((w) => {
      const next = !w;
      savePref(WIDE_PREF, next);
      return next;
    });
  };

  // MIDI channels are hidden by default (Cubase-style: they carry no audio — their
  // sound lives on the routed instrument's channel); the toolbar toggle shows them.
  const [showMidi, setShowMidi] = useState<boolean>(() =>
    loadBoolPref(SHOW_MIDI_PREF, false),
  );
  const toggleShowMidi = () => {
    setShowMidi((v) => {
      savePref(SHOW_MIDI_PREF, !v);
      return !v;
    });
  };

  /* mix view (kind filter over the rail; §3.3) */
  const [view, setView] = useState<MixView>(() =>
    loadPref<MixView>(VIEW_PREF, "all", oneOf<MixView>("all", "audio", "instr", "buses")),
  );
  const pickView = (v: MixView) => {
    setView(v);
    savePref(VIEW_PREF, v);
  };

  /* strip order: regular tracks (model order, skip folders), then buses; master pinned */
  const strips = useMemo(() => {
    if (!project) return [];
    const regular = project.tracks.filter(
      (t) =>
        t.kind !== "folder" &&
        t.kind !== "bus" &&
        t.kind !== "master" &&
        (showMidi || t.kind !== "midi") &&
        (view === "all" ||
          (view === "audio" && t.kind === "audio") ||
          (view === "instr" && (t.kind === "instrument" || t.kind === "midi"))),
    );
    const buses =
      view === "all" || view === "buses" ? project.tracks.filter((t) => t.kind === "bus") : [];
    return [...(view === "buses" ? [] : regular), ...buses];
  }, [project, showMidi, view]);

  const midiCount = useMemo(
    () => (project ? project.tracks.filter((t) => t.kind === "midi").length : 0),
    [project],
  );

  const buses = useMemo(
    () => (project ? project.tracks.filter((t) => t.kind === "bus") : []),
    [project],
  );

  // keyboard focus routing (lib/keyboard) — clicking anywhere in the mixer focuses it
  const focusPane = () => useStore.getState().setFocusedPane("mixer");

  if (!project) {
    return (
      <div className="mixer-root" onPointerDownCapture={focusPane}>
        <div className="mixer-empty">
          <Icon name="mixer" size={28} />
          <div className="mixer-empty-title">
            {connected ? "No project loaded" : "Engine disconnected"}
          </div>
          <div className="mixer-empty-sub">
            {connected
              ? "Create or open a project to see its channel strips here."
              : "The mixer will appear once the engine connection is restored."}
          </div>
        </div>
      </div>
    );
  }

  /* horizontal windowing for large sessions */
  const stripW = wide ? 84 : 56;
  const pitch = stripW + STRIP_GAP;
  const useWindow = strips.length > VIRTUALIZE_THRESHOLD && viewW > 0;
  let first = 0;
  let last = strips.length - 1;
  let padLeft = 0;
  let padRight = 0;
  if (useWindow) {
    first = Math.max(0, Math.floor(scrollLeft / pitch) - OVERSCAN);
    last = Math.min(strips.length - 1, Math.ceil((scrollLeft + viewW) / pitch) + OVERSCAN);
    padLeft = first * pitch;
    padRight = (strips.length - 1 - last) * pitch;
  }

  return (
    <div className="mixer-root" onPointerDownCapture={focusPane}>
      <div className="mixer-rail">
        <div className="mixer-rail-inner">
          <div className="mixer-toolbar">
          <IconButton
            icon={wide ? "chevronLeft" : "chevronRight"}
            size={20}
            tooltip={wide ? "Narrow strips" : "Wide strips"}
            onClick={toggleWide}
          />
          <IconButton
            icon="stage"
            size={20}
            tooltip="Room View — place channels in the room (pan / level)"
            onClick={() => useStore.getState().setDialogs({ roomView: true })}
          />
          {midiCount > 0 && (
            <IconButton
              icon="midiNote"
              size={20}
              active={showMidi}
              tooltip={
                showMidi
                  ? `Hide the ${midiCount} MIDI channel${midiCount === 1 ? "" : "s"}`
                  : `Show the ${midiCount} MIDI channel${midiCount === 1 ? "" : "s"} (they carry no audio — their sound is on the routed instrument's channel)`
              }
              onClick={toggleShowMidi}
            />
          )}
          <div className="mixer-views" role="group" aria-label="Mix view">
            {MIX_VIEWS.map((v) => (
              <IconButton
                key={v.id}
                icon={v.icon}
                size={20}
                active={view === v.id}
                tooltip={v.tooltip}
                onClick={() => pickView(v.id)}
              />
            ))}
          </div>
          <div className="mixer-count" title={`${strips.length} strips + master`}>
            {strips.length}
          </div>
        </div>

        <div
          ref={scrollRef}
          className="mixer-scroll"
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        >
          <div
            className="mixer-strips"
            style={{
              paddingLeft: 2 + padLeft,
              paddingRight: 2 + padRight,
            }}
          >
            {strips.length === 0 ? (
              <div className="mixer-empty" style={{ minWidth: 260 }}>
                <div className="mixer-empty-title">No tracks</div>
                <div className="mixer-empty-sub">Add tracks in the arrangement to mix them here.</div>
              </div>
            ) : (
              strips
                .slice(first, last + 1)
                .map((t) => <ChannelStrip key={t.id} track={t} buses={buses} wide={wide} />)
            )}
          </div>
        </div>

          <div className="mixer-master-wrap">
            <ChannelStrip track={project.masterTrack} buses={buses} wide={wide} isMaster />
          </div>
        </div>
      </div>
    </div>
  );
}
