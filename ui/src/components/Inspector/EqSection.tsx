/**
 * Inspector CHANNEL EQ section (U5).
 *
 * Per-track parametric EQ: a bypass toggle, the summed-response curve, and up to 4 bands,
 * each with an enable toggle, type selector, and freq (Hz, log-scaled drag) / gain (dB,
 * hidden for cut+notch) / Q controls. When the track has no EQ yet, an "Add EQ" affordance
 * creates a transparent default 4-band setup (all bands disabled).
 *
 * Editing model: the engine owns the full band list, and cmd/track.setEq REPLACES it. So
 * every edit rebuilds the whole list from the committed bands with one band patched, then
 * streams a transient setTrackEq during a drag and commits non-transiently on release
 * (via dragTrackEq/commitTrackEq, which key the gesture by trackId). Non-drag edits
 * (toggles, type select) commit immediately. All value reads are NaN-safe (sanitizeBand).
 */

import React from "react";
import type { EqBand, Track, TrackEq } from "../../protocol/types";
import { commitTrackEq, dragTrackEq, setTrackEq } from "../../store/actions";
import { useStore } from "../../store/store";
import { Section } from "./Section";
import { useDraftValue } from "./fields";
import { EqCurve } from "./EqCurve";
import { NumberDrag } from "../common/NumberDrag";
import { Select } from "../common/Select";
import { Toggle } from "../common/Toggle";
import { IconButton } from "../common/IconButton";
import { openContextMenu } from "../common/ContextMenu";
import {
  EQ_TYPE_LABELS,
  GAIN_MAX,
  GAIN_MIN,
  Q_MAX,
  Q_MIN,
  bandUsesGain,
  defaultBands,
  freqText,
  freqToNorm,
  normToFreq,
  sanitizeBand,
} from "./eq";

const MAX_BANDS = 4;

/** Effective EQ for display: never undefined, bands clamped to legal ranges. */
function readEq(track: Track): TrackEq {
  const eq = track.eq;
  if (!eq) return { bypass: false, bands: [] };
  return { bypass: !!eq.bypass, bands: (eq.bands ?? []).slice(0, MAX_BANDS).map(sanitizeBand) };
}

/** Replace band `index` in `bands` with a patched copy. */
function patchBands(bands: EqBand[], index: number, patch: Partial<EqBand>): EqBand[] {
  return bands.map((b, i) => (i === index ? sanitizeBand({ ...b, ...patch }) : b));
}

/* ============================================================================
 * Frequency drag (log-scaled): drag maps the pointer over the 20..20k decade range
 * via the same log mapping the curve uses, so a band tracks the cursor 1:1 on the plot.
 * ========================================================================= */

function FreqDrag({
  value,
  onDrag,
  onCommit,
}: {
  value: number;
  onDrag: (hz: number) => void;
  onCommit: (hz: number) => void;
}) {
  const { shown, preview, settle } = useDraftValue(freqToNorm(value));
  return (
    <NumberDrag
      value={shown}
      min={0}
      max={1}
      step={0.0005}
      speed={1 / 260}
      width={62}
      title="Frequency (log)"
      format={(t) => freqText(normToFreq(t))}
      parse={(text) => {
        const s = text.trim().toLowerCase().replace(",", ".");
        const m = parseFloat(s);
        if (!Number.isFinite(m)) return null;
        const hz = s.includes("k") ? m * 1000 : m;
        return freqToNorm(hz);
      }}
      onChange={(t) => {
        preview(t);
        onDrag(Math.round(normToFreq(t)));
      }}
      onCommit={(t) => {
        onCommit(Math.round(normToFreq(t)));
        settle();
      }}
    />
  );
}

function GainDrag({
  value,
  disabled,
  onDrag,
  onCommit,
}: {
  value: number;
  disabled?: boolean;
  onDrag: (db: number) => void;
  onCommit: (db: number) => void;
}) {
  const { shown, preview, settle } = useDraftValue(value);
  return (
    <NumberDrag
      value={shown}
      min={GAIN_MIN}
      max={GAIN_MAX}
      step={0.1}
      precision={1}
      units="dB"
      width={52}
      disabled={disabled}
      title="Gain"
      format={(v) => (v > 0 ? "+" : "") + v.toFixed(1)}
      onChange={(v) => {
        preview(v);
        onDrag(v);
      }}
      onCommit={(v) => {
        onCommit(v);
        settle();
      }}
    />
  );
}

function QDrag({
  value,
  onDrag,
  onCommit,
}: {
  value: number;
  onDrag: (q: number) => void;
  onCommit: (q: number) => void;
}) {
  const { shown, preview, settle } = useDraftValue(value);
  return (
    <NumberDrag
      value={shown}
      min={Q_MIN}
      max={Q_MAX}
      step={0.01}
      precision={2}
      width={48}
      speed={(Q_MAX - Q_MIN) / 300}
      title="Q / bandwidth"
      onChange={(v) => {
        preview(v);
        onDrag(v);
      }}
      onCommit={(v) => {
        onCommit(v);
        settle();
      }}
    />
  );
}

/* ============================================================================
 * One band row
 * ========================================================================= */

function BandRow({
  band,
  index,
  bands,
  apply,
  commit,
}: {
  band: EqBand;
  index: number;
  bands: EqBand[];
  /** transient stream during a drag */
  apply: (next: EqBand[]) => void;
  /** non-transient commit (and immediate edits) */
  commit: (next: EqBand[]) => void;
}) {
  const usesGain = bandUsesGain(band.type);
  const num = index + 1;

  const drag = (patch: Partial<EqBand>) => apply(patchBands(bands, index, patch));
  const done = (patch: Partial<EqBand>) => commit(patchBands(bands, index, patch));

  return (
    <div className={"eq-band" + (band.enabled ? "" : " off")}>
      <div className="eq-band-top">
        <IconButton
          icon="power"
          size={20}
          active={band.enabled}
          tooltip={band.enabled ? "Disable band" : "Enable band"}
          onClick={() => commit(patchBands(bands, index, { enabled: !band.enabled }))}
        />
        <span className="eq-band-num mono">{num}</span>
        <Select
          className="grow"
          value={String(band.type)}
          options={EQ_TYPE_LABELS.map((o) => ({ value: String(o.value), label: o.label }))}
          title="Filter type"
          onChange={(v) => commit(patchBands(bands, index, { type: Number(v) }))}
        />
      </div>
      <div className="eq-band-params">
        <span className="eq-pk">Freq</span>
        <FreqDrag value={band.freqHz} onDrag={(hz) => drag({ freqHz: hz })} onCommit={(hz) => done({ freqHz: hz })} />
        <span className="eq-pk">Gain</span>
        <GainDrag
          value={usesGain ? band.gainDb : 0}
          disabled={!usesGain}
          onDrag={(db) => drag({ gainDb: db })}
          onCommit={(db) => done({ gainDb: db })}
        />
        <span className="eq-pk">Q</span>
        <QDrag value={band.q} onDrag={(q) => drag({ q })} onCommit={(q) => done({ q })} />
      </div>
    </div>
  );
}

/* ============================================================================
 * Section
 * ========================================================================= */

export function EqSection({ track }: { track: Track }) {
  const sampleRate = useStore((s) => s.project?.sampleRate ?? 48000);
  const eq = readEq(track);
  const id = track.id;
  const hasEq = eq.bands.length > 0;

  const apply = (bands: EqBand[]) => dragTrackEq(id, { bands });
  const commit = (bands: EqBand[]) => void commitTrackEq(id, { bands });

  const addEq = () => void setTrackEq(id, { bypass: false, bands: defaultBands() });
  const removeEq = () => void setTrackEq(id, { bypass: false, bands: [] });
  const addBand = () => {
    if (eq.bands.length >= MAX_BANDS) return;
    const next: EqBand = { enabled: true, type: 0, freqHz: 1000, gainDb: 0, q: 1 };
    void commitTrackEq(id, { bands: [...eq.bands, next] });
  };

  /* Right-click on a curve handle (EqCurve stays presentation-only). */
  const onBandMenu = (index: number, x: number, y: number) => {
    const band = eq.bands[index];
    if (!band) return;
    const usesGain = bandUsesGain(band.type);
    openContextMenu(x, y, [
      {
        label: `Band ${index + 1}: Enabled`,
        checked: band.enabled,
        onClick: () => commit(patchBands(eq.bands, index, { enabled: !band.enabled })),
      },
      {
        label: "Reset Gain",
        disabled: !usesGain || band.gainDb === 0,
        title: !usesGain
          ? "This filter type has no gain"
          : band.gainDb === 0
            ? "Gain is already 0 dB"
            : "Set the band gain back to 0 dB",
        onClick: () => commit(patchBands(eq.bands, index, { gainDb: 0 })),
      },
      "separator",
      {
        label: "Remove Band",
        icon: "trash",
        danger: true,
        onClick: () => commit(eq.bands.filter((_, i) => i !== index)),
      },
    ]);
  };

  const enabledCount = eq.bands.filter((b) => b.enabled).length;
  const badge = hasEq ? (
    <span className="row gap1">
      {eq.bypass ? <span className="badge warn">bypassed</span> : null}
      <span className="badge">{enabledCount}/{eq.bands.length} on</span>
    </span>
  ) : null;

  return (
    <Section title="Channel EQ" badge={badge} defaultOpen={false}>
      {!hasEq ? (
        <>
          <div className="insp-hint">No EQ on this track.</div>
          <div className="insp-row">
            <button type="button" className="btn" onClick={addEq}>
              Add EQ
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="insp-row">
            <Toggle
              on={eq.bypass}
              onChange={(on) => void setTrackEq(id, { bypass: on })}
              variant="warn"
              tooltip="Bypass the whole EQ"
            >
              Bypass
            </Toggle>
            <span className="grow" />
            {eq.bands.length < MAX_BANDS ? (
              <IconButton icon="plus" tooltip="Add band" onClick={addBand} />
            ) : null}
            <IconButton icon="trash" danger tooltip="Remove EQ" size={24} onClick={removeEq} />
          </div>

          <div className={"eq-curve-wrap" + (eq.bypass ? " bypassed" : "")}>
            <EqCurve
              bands={eq.bands}
              bypass={eq.bypass}
              sampleRate={sampleRate}
              onDragBand={(i, patch) => apply(patchBands(eq.bands, i, patch))}
              onCommitBand={(i, patch) => commit(patchBands(eq.bands, i, patch))}
              onBandMenu={onBandMenu}
            />
          </div>

          <div className="eq-bands">
            {eq.bands.map((b, i) => (
              <BandRow key={i} band={b} index={i} bands={eq.bands} apply={apply} commit={commit} />
            ))}
          </div>
        </>
      )}
    </Section>
  );
}
