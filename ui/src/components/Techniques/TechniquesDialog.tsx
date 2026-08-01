/**
 * Production Techniques wizard (docs/PRODUCTION_TECHNIQUES_PLAN.md) — pick a
 * technique, walk its stages: Apply (automatic), "I'll do it myself" (honest manual
 * instructions + Mark done), Take back (stage-granular undo — only the LAST applied
 * stage, since engine undo is a stack), stop anytime (applied stages stay as
 * ordinary undoable edits). Requirements show live with Fix buttons.
 *
 * Modal with transportKeys allowed (play/stop keep working). Targets are PARAMS
 * (track/clip pickers defaulting to the selection at open), so the wizard never
 * forces the user back out to click the timeline mid-flow.
 */

import { useMemo, useRef, useState } from "react";
import { transportBus, useStore } from "../../store/store";
import { undo } from "../../store/actions";
import { revealPane } from "../../shell/reveal";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { NumberDrag } from "../common/NumberDrag";
import { Icon } from "../common/icons";
import { showToast } from "../common/ToastHost";
import { confirmDialog } from "../Dialogs/confirm";
import { TECHNIQUES } from "../../techniques/catalog";
import { allAudioClips, allMidiClips, beatsPerBarOf, bpmOf, isMixerTrack } from "../../techniques/ops";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type ParamDef,
  type ParamValues,
  type StageState,
  type TechniqueCtx,
  type TechniqueDef,
} from "../../techniques/types";
import "./techniques.css";

/* ============================================================================
 * Ctx + run-session state
 * ========================================================================= */

function makeCtx(): TechniqueCtx | null {
  const s = useStore.getState();
  if (!s.project) return null;
  return {
    project: s.project,
    selection: s.selection,
    bpm: bpmOf(s.project),
    beatsPerBar: beatsPerBarOf(s.project),
    playheadBeat: transportBus.last?.beat ?? 0,
  };
}

type StageStatus =
  | { kind: "pending" }
  | { kind: "applied"; commands: number; note?: string }
  | { kind: "manual" }
  | { kind: "skipped" }
  | { kind: "error"; message: string };

interface RunSession {
  techniqueId: string;
  statuses: StageStatus[];
  params: ParamValues[];
  state: StageState;
  /** Indices of applied stages in apply order — take-back pops the last. */
  appliedOrder: number[];
}

function newSession(t: TechniqueDef, ctx: TechniqueCtx): RunSession {
  return {
    techniqueId: t.id,
    statuses: t.stages.map(() => ({ kind: "pending" })),
    params: t.stages.map((st) => {
      const v: ParamValues = {};
      for (const p of st.params ?? []) v[p.key] = p.default(ctx);
      return v;
    }),
    state: {},
    appliedOrder: [],
  };
}

/* ============================================================================
 * Param inputs
 * ========================================================================= */

function ParamInput({
  def,
  value,
  ctx,
  onChange,
}: {
  def: ParamDef;
  value: number | string;
  ctx: TechniqueCtx;
  onChange: (v: number | string) => void;
}) {
  if (def.kind === "number") {
    return (
      <NumberDrag
        value={typeof value === "number" ? value : Number(value) || 0}
        min={def.min ?? 0}
        max={def.max ?? 999}
        step={def.step ?? 1}
        precision={0}
        units={def.unit}
        width={70}
        onChange={onChange}
        onCommit={onChange}
      />
    );
  }
  if (def.kind === "select") {
    return (
      <Select
        value={String(value)}
        options={def.options ?? []}
        onChange={onChange}
        width={190}
      />
    );
  }
  if (def.kind === "track") {
    const filter = def.trackFilter ?? isMixerTrack;
    const tracks = ctx.project.tracks.filter(filter);
    return (
      <Select
        value={String(value)}
        options={
          tracks.length > 0
            ? tracks.map((t) => ({ value: String(t.id), label: t.name }))
            : [{ value: "0", label: "(no matching track)" }]
        }
        onChange={(v) => onChange(Number(v))}
        width={190}
      />
    );
  }
  // clip
  const midi = def.clipKind === "midi";
  const clips = midi ? allMidiClips(ctx) : allAudioClips(ctx);
  return (
    <Select
      value={String(value)}
      options={
        clips.length > 0
          ? clips.map((f) => ({
              value: String(f.clip.id),
              label: `${f.track.name} · ${f.clip.name || (midi ? "MIDI clip" : "audio clip")}`,
            }))
          : [{ value: "0", label: midi ? "(no MIDI clips)" : "(no audio clips)" }]
      }
      onChange={(v) => onChange(Number(v))}
      width={220}
    />
  );
}

/* ============================================================================
 * Wizard body
 * ========================================================================= */

function statusIcon(st: StageStatus) {
  switch (st.kind) {
    case "applied":
      return <Icon name="check" size={14} />;
    case "manual":
      return <Icon name="pencil" size={14} />;
    case "skipped":
      return <Icon name="chevronRight" size={14} />;
    case "error":
      return <Icon name="warning" size={14} />;
    default:
      return <Icon name="dot" size={14} />;
  }
}

function Wizard({ technique, onBack }: { technique: TechniqueDef; onBack: () => void }) {
  // Broad subscription on purpose: requirements/params read live project state.
  useStore();
  const ctx = makeCtx();
  const sessionRef = useRef<RunSession | null>(null);
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState<number | null>(null);

  if (!ctx) return <div className="tech-empty">No project — connect to the engine first.</div>;
  if (sessionRef.current === null || sessionRef.current.techniqueId !== technique.id)
    sessionRef.current = newSession(technique, ctx);
  const session = sessionRef.current;

  const reqs = technique.requirements(ctx);
  const reqsOk = reqs.every((r) => r.ok);
  const nextIdx = session.statuses.findIndex((s) => s.kind === "pending" || s.kind === "error");
  const lastApplied =
    session.appliedOrder.length > 0 ? session.appliedOrder[session.appliedOrder.length - 1] : null;

  /** Run one stage (no busy management — apply/applyAll own that). True on success. */
  const runStage = async (i: number): Promise<boolean> => {
    const stage = technique.stages[i];
    const c = makeCtx();
    if (!c) return false;
    // Reveal where the change will land BEFORE running, so the user watches it
    // happen (shell-aware: dock tab / ribbon category / workspace).
    if (stage.reveal) {
      revealPane(stage.reveal);
      await new Promise((r) => setTimeout(r, 400));
    }
    try {
      const result = await stage.run(makeCtx() ?? c, session.params[i], session.state);
      session.statuses[i] = { kind: "applied", commands: result.commands, note: result.note };
      if (result.commands > 0) session.appliedOrder.push(i);
      if (result.note) showToast(result.note, "success");
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      session.statuses[i] = { kind: "error", message };
      showToast(message, "error");
      return false;
    } finally {
      rerender();
    }
  };

  const apply = async (i: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await runStage(i);
    } finally {
      setBusy(false);
      rerender();
    }
  };

  /** Apply every remaining stage in order (optional ones included); stop on error. */
  const applyAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (let i = 0; i < technique.stages.length; i++) {
        const st = session.statuses[i];
        if (st.kind !== "pending" && st.kind !== "error") continue;
        const ok = await runStage(i);
        if (!ok) break;
        await new Promise((r) => setTimeout(r, 250)); // let each change read on screen
      }
    } finally {
      setBusy(false);
      rerender();
    }
  };

  const takeBack = async (i: number) => {
    const st = session.statuses[i];
    if (st.kind !== "applied" || busy) return;
    if (st.commands > 0) {
      const ok = await confirmDialog({
        title: "Take back stage",
        message:
          `Take back “${technique.stages[i].title}” — undoes its ${st.commands} project ` +
          `edit${st.commands === 1 ? "" : "s"} (plus anything you changed since applying it).`,
        confirmLabel: "Take back",
        danger: true,
      });
      if (!ok) return;
      setBusy(true);
      try {
        for (let n = 0; n < st.commands; n++) await undo();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Undo failed", "error");
      } finally {
        setBusy(false);
      }
      session.appliedOrder.pop();
    }
    session.statuses[i] = { kind: "pending" };
    rerender();
  };

  const markDone = (i: number, kind: "manual" | "skipped") => {
    session.statuses[i] = { kind };
    setManualOpen(null);
    rerender();
  };

  const remaining = session.statuses.filter((s) => s.kind === "pending" || s.kind === "error").length;
  const allDone = remaining === 0;
  const totalCommands = session.statuses.reduce(
    (n, s) => n + (s.kind === "applied" ? s.commands : 0),
    0,
  );

  return (
    <div className="tech-wizard" data-cat={technique.category}>
      <div className="tech-topline">
        <button type="button" className="btn tech-back" onClick={onBack}>
          <Icon name="chevronLeft" size={14} /> All techniques
        </button>
        <div className="grow" />
        {!allDone && (
          <button
            type="button"
            className="btn primary"
            disabled={busy || !reqsOk}
            title={
              reqsOk
                ? "Run every remaining stage in order (optional ones included)"
                : "Fix the requirements below first"
            }
            onClick={() => void applyAll()}
          >
            Apply All ({remaining})
          </button>
        )}
      </div>
      <div className="tech-head">
        <div className="tech-title">{technique.title}</div>
        <div className="tech-cat">{CATEGORY_LABELS[technique.category]}</div>
      </div>
      <div className="tech-desc">{technique.description}</div>

      {reqs.length > 0 && (
        <div className="tech-reqs">
          {reqs.map((r, i) => (
            <div key={i} className={"tech-req" + (r.ok ? " ok" : "")}>
              <Icon name={r.ok ? "check" : "warning"} size={13} />
              <span className="grow">{r.label}</span>
              {!r.ok && r.fix && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => {
                    void r
                      .fix!.run()
                      .then(() => showToast("Done — requirement fixed", "success"))
                      .catch((e) =>
                        showToast(e instanceof Error ? e.message : "Fix failed", "error"),
                      )
                      .finally(rerender);
                  }}
                >
                  {r.fix.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="tech-stages">
        {technique.stages.map((stage, i) => {
          const st = session.statuses[i];
          const isNext = i === nextIdx;
          return (
            <div key={stage.id} className={"tech-stage" + (isNext ? " next" : "") + ` st-${st.kind}`}>
              <div className="tech-stage-head">
                <span className="tech-stage-status">{statusIcon(st)}</span>
                <span className="tech-stage-title">
                  {i + 1}. {stage.title}
                  {stage.optional ? <span className="tech-opt"> optional</span> : null}
                </span>
                <div className="grow" />
                {st.kind === "applied" && i === lastApplied && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void takeBack(i)}>
                    Take back
                  </button>
                )}
                {(st.kind === "pending" || st.kind === "error") && (
                  <>
                    {stage.optional && (
                      <button type="button" className="btn" disabled={busy} onClick={() => markDone(i, "skipped")}>
                        Skip
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setManualOpen(manualOpen === i ? null : i)}
                    >
                      I'll do it myself
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy || !reqsOk}
                      title={reqsOk ? undefined : "Fix the requirements above first"}
                      onClick={() => void apply(i)}
                    >
                      Apply
                    </button>
                  </>
                )}
              </div>
              <div className="tech-stage-sum">{stage.summary}</div>
              {st.kind === "applied" && st.note && <div className="tech-note ok">{st.note}</div>}
              {st.kind === "error" && <div className="tech-note err">{st.message}</div>}
              {st.kind === "manual" && <div className="tech-note">Marked as done by hand.</div>}
              {(stage.params ?? []).length > 0 && (st.kind === "pending" || st.kind === "error") && (
                <div className="tech-params">
                  {stage.params!.map((p) => (
                    <label key={p.key} className="tech-param" title={p.help}>
                      <span className="tech-param-label">{p.label}</span>
                      <ParamInput
                        def={p}
                        value={session.params[i][p.key]}
                        ctx={ctx}
                        onChange={(v) => {
                          session.params[i][p.key] = v;
                          rerender();
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              {manualOpen === i && (st.kind === "pending" || st.kind === "error") && (
                <div className="tech-manual">
                  <div className="tech-manual-text">{stage.manual}</div>
                  <button type="button" className="btn primary" onClick={() => markDone(i, "manual")}>
                    Mark done — I did it by hand
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {allDone && (
        <div className="tech-summary">
          <div className="tech-summary-title">
            <Icon name="check" size={14} /> {technique.title} — done. What happened:
          </div>
          <ul>
            {technique.stages.map((stage, i) => {
              const st = session.statuses[i];
              return (
                <li key={stage.id}>
                  <b>{stage.title}</b>
                  {st.kind === "applied"
                    ? ` — ${st.note ?? stage.summary} (${st.commands} edit${st.commands === 1 ? "" : "s"})`
                    : st.kind === "manual"
                      ? " — done by hand."
                      : " — skipped."}
                </li>
              );
            })}
          </ul>
          <div className="tech-summary-total">
            {totalCommands} project edit{totalCommands === 1 ? "" : "s"} in total — each is a
            normal undo step (Ctrl+Z walks back through them).
          </div>
        </div>
      )}

      <div className="tech-foot dim">
        Stop anytime — applied stages stay as ordinary undoable edits. Take Back undoes the
        most recent applied stage.
      </div>
    </div>
  );
}

/* ============================================================================
 * Browser + dialog shell
 * ========================================================================= */

function Browser({ onPick }: { onPick: (t: TechniqueDef) => void }) {
  const [cat, setCat] = useState<(typeof CATEGORY_ORDER)[number] | "all">("all");
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TECHNIQUES.filter(
      (t) =>
        (cat === "all" || t.category === cat) &&
        (q === "" ||
          t.title.toLowerCase().includes(q) ||
          t.tagline.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.id.includes(q)),
    );
  }, [cat, query]);
  return (
    <div className="tech-browser">
      <div className="tech-cats">
        <input
          className="tech-search"
          placeholder="Search techniques…"
          value={query}
          data-autofocus
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          type="button"
          className="tech-cat-btn"
          data-on={cat === "all" ? "true" : undefined}
          onClick={() => setCat("all")}
        >
          All ({TECHNIQUES.length})
        </button>
        {CATEGORY_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            className="tech-cat-btn"
            data-cat={c}
            data-on={cat === c ? "true" : undefined}
            onClick={() => setCat(c)}
          >
            {CATEGORY_LABELS[c]} ({TECHNIQUES.filter((t) => t.category === c).length})
          </button>
        ))}
      </div>
      <div className="tech-cards">
        {list.length === 0 && (
          <div className="tech-empty">Nothing matches “{query}” — try the category rail.</div>
        )}
        {list.map((t) => (
          <button key={t.id} type="button" className="tech-card" data-cat={t.category} onClick={() => onPick(t)}>
            <div className="tech-card-title">{t.title}</div>
            <div className="tech-card-tag">{t.tagline}</div>
            <div className="tech-card-meta">
              {CATEGORY_LABELS[t.category]} · {t.stages.length} stages
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TechniquesDialog() {
  const open = useStore((s) => s.dialogs.techniques);
  const setDialogs = useStore((s) => s.setDialogs);
  const [picked, setPicked] = useState<TechniqueDef | null>(null);

  if (!open) return null;
  return (
    <Modal
      open
      onClose={() => {
        setPicked(null);
        setDialogs({ techniques: false });
      }}
      title={
        <span className="row gap1">
          <Icon name="sparkles" size={15} /> Production Techniques
        </span>
      }
      width={720}
      transportKeys
      closeOnOverlay={false}
      draggable
      className="tech-modal"
    >
      {picked === null ? (
        <Browser onPick={setPicked} />
      ) : (
        <Wizard technique={picked} onBack={() => setPicked(null)} />
      )}
    </Modal>
  );
}
