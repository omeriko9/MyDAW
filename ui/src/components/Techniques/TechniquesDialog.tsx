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

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store/store";
import { redo, undo } from "../../store/actions";
import { revealPane } from "../../shell/reveal";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { NumberDrag } from "../common/NumberDrag";
import { IconButton } from "../common/IconButton";
import { Icon } from "../common/icons";
import { showToast } from "../common/ToastHost";
import { confirmDialog } from "../Dialogs/confirm";
import { usePopoutWindow } from "../common/usePopoutWindow";
import { TECHNIQUES, techniqueIcon } from "../../techniques/catalog";
import {
  freshCustomId,
  loadCustomTechniques,
  resolveCustom,
  saveCustomTechniques,
  type CustomStepRef,
  type CustomTechniqueData,
} from "../../techniques/custom";
import {
  loadCatOrder,
  loadTechFavorites,
  moveCategory,
  saveCatOrder,
  toggleTechFavorite,
} from "../../techniques/userPrefs";
import { contextMenuHandler } from "../common/ContextMenu";
import { allAudioClips, allMidiClips, isMixerTrack, makeCtx } from "../../techniques/ops";
import GuideView from "./GuideView";
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
 * Run-session state (ctx comes from ops.makeCtx — shared with GuideView)
 * ========================================================================= */

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

function Wizard({
  technique,
  onBack,
  backLabel = "All techniques",
}: {
  technique: TechniqueDef;
  onBack: () => void;
  backLabel?: string;
}) {
  // Broad subscription on purpose: requirements/params read live project state.
  useStore();
  const ctx = makeCtx();
  const sessionRef = useRef<RunSession | null>(null);
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState<number | null>(null);

  /**
   * A/B audition (Omer, 2026-08-07: "the techniques are a mystery — let me HEAR them").
   * "Without" = undo everything this run applied; "With" = redo the same count. The
   * pair is exact-state symmetric, so nothing is ever lost — but while in Without the
   * stage actions are locked (a new command would truncate the engine's redo tail and
   * strand the With state), and ANY exit (back, close, popout) auto-restores With via
   * the unmount cleanup below. `commands` is the undo depth taken at Without time.
   */
  const auditionRef = useRef<{ mode: "with" | "without"; commands: number }>({
    mode: "with",
    commands: 0,
  });
  /** In-flight toggle batch — the unmount restore chains on it, so an Escape that
   *  lands MID-batch cannot strand the project in the Without state. */
  const auditionOpRef = useRef<Promise<void> | null>(null);
  const inAudition = auditionRef.current.mode === "without";
  useEffect(
    () => () => {
      const pending = auditionOpRef.current;
      void (async () => {
        if (pending) await pending.catch(() => {});
        const a = auditionRef.current;
        if (a.mode !== "without" || a.commands === 0) return;
        auditionRef.current = { mode: "with", commands: 0 };
        for (let k = 0; k < a.commands; k++) await redo();
      })().catch(() => showToast("Audition restore failed — press Ctrl+Y to redo", "error"));
    },
    [],
  );

  const setAuditionMode = (mode: "with" | "without", commands: number) => {
    const a = auditionRef.current;
    if (busy || mode === a.mode || (mode === "without" && commands === 0)) return;
    setBusy(true);
    const op = (async () => {
      try {
        if (mode === "without") {
          for (let k = 0; k < commands; k++) await undo();
          auditionRef.current = { mode: "without", commands };
        } else {
          for (let k = 0; k < a.commands; k++) await redo();
          auditionRef.current = { mode: "with", commands: 0 };
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Audition toggle failed", "error");
      }
    })();
    auditionOpRef.current = op;
    void op.finally(() => {
      auditionOpRef.current = null;
      setBusy(false);
      rerender();
    });
  };

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
          <Icon name="chevronLeft" size={14} /> {backLabel}
        </button>
        <div className="grow" />
        {!allDone && (
          <button
            type="button"
            className="btn primary"
            disabled={busy || inAudition || !reqsOk}
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
                  <button type="button" className="btn" disabled={busy || inAudition} onClick={() => void takeBack(i)}>
                    Take back
                  </button>
                )}
                {(st.kind === "pending" || st.kind === "error") && (
                  <>
                    {stage.optional && (
                      <button type="button" className="btn" disabled={busy || inAudition} onClick={() => markDone(i, "skipped")}>
                        Skip
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || inAudition}
                      onClick={() => setManualOpen(manualOpen === i ? null : i)}
                    >
                      I'll do it myself
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy || inAudition || !reqsOk}
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

      {totalCommands > 0 && (
        <div className={"tech-audition" + (inAudition ? " active" : "")}>
          <span className="tech-ab-label">Audition</span>
          <div className="tech-ab-seg">
            <button
              type="button"
              className={"btn tech-ab-without" + (inAudition ? " primary" : "")}
              disabled={busy}
              title={
                `Temporarily undo the ${totalCommands} edit${totalCommands === 1 ? "" : "s"} ` +
                "this technique applied (plus anything you changed since) so you can hear " +
                "the difference. Nothing is lost — With restores the exact state."
              }
              onClick={() => void setAuditionMode("without", totalCommands)}
            >
              Without
            </button>
            <button
              type="button"
              className={"btn tech-ab-with" + (!inAudition ? " primary" : "")}
              disabled={busy}
              title="Restore everything the technique applied"
              onClick={() => void setAuditionMode("with", 0)}
            >
              With
            </button>
          </div>
          <span className="tech-ab-hint">
            {inAudition
              ? "Hearing your project WITHOUT this technique. Stage actions are paused; " +
                "closing the wizard restores everything automatically."
              : `Play your loop and flip to compare. Listen for: ${technique.tagline}`}
          </span>
        </div>
      )}

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

function Browser({
  onPick,
  onGuide,
  onNewCustom,
  onEditCustom,
  onCustomsChanged,
  customsVersion,
}: {
  onPick: (t: TechniqueDef) => void;
  /** Back to the Production Guide landing view. */
  onGuide: () => void;
  onNewCustom: () => void;
  onEditCustom: (data: CustomTechniqueData) => void;
  onCustomsChanged: () => void;
  /** Bumped by the host after save/delete so the list reloads. */
  customsVersion: number;
}) {
  const [cat, setCat] = useState<(typeof CATEGORY_ORDER)[number] | "all" | "favorites">("all");
  const [query, setQuery] = useState("");
  const [favs, setFavs] = useState<string[]>(() => loadTechFavorites());
  const [catOrder, setCatOrder] = useState(() => loadCatOrder());
  const customs = useMemo(() => loadCustomTechniques(), [customsVersion]);
  const customDefs = useMemo(
    () => customs.map((d) => ({ data: d, ...resolveCustom(d, TECHNIQUES) })),
    [customs],
  );
  const allDefs = useMemo(
    () => [...TECHNIQUES, ...customDefs.map((c) => c.def)],
    [customDefs],
  );
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allDefs.filter(
      (t) =>
        (cat === "all" || (cat === "favorites" ? favs.includes(t.id) : t.category === cat)) &&
        (q === "" ||
          t.title.toLowerCase().includes(q) ||
          t.tagline.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.id.includes(q)),
    );
  }, [allDefs, cat, favs, query]);

  const reorder = (c: (typeof CATEGORY_ORDER)[number], to: "top" | "up" | "down") => {
    const next = moveCategory(catOrder, c, to);
    saveCatOrder(next);
    setCatOrder(next);
  };

  const deleteCustom = (data: CustomTechniqueData) => {
    void confirmDialog({
      title: "Delete custom technique",
      message: `Delete “${data.title}”? Projects it was applied to keep their edits — only the recipe goes.`,
      confirmLabel: "Delete",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      saveCustomTechniques(loadCustomTechniques().filter((d) => d.id !== data.id));
      onCustomsChanged();
    });
  };
  return (
    <div className="tech-browse-wrap">
      <div className="tech-search-row">
        <button type="button" className="btn tech-back" onClick={onGuide}>
          <Icon name="chevronLeft" size={14} /> Guide
        </button>
        <Icon name="search" size={15} />
        <input
          className="tech-search"
          placeholder={`Search all ${TECHNIQUES.length} techniques — name, sound, or what it does…`}
          value={query}
          data-autofocus
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Esc clears the query first; a second Esc reaches the modal and closes.
            if (e.key === "Escape" && query !== "") {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query !== "" && (
          <>
            <span className="tech-search-count">
              {list.length} match{list.length === 1 ? "" : "es"}
            </span>
            <IconButton icon="x" size={18} tooltip="Clear search" onClick={() => setQuery("")} />
          </>
        )}
      </div>
      <div className="tech-browser">
        <div className="tech-cats">
        <button
          type="button"
          className="tech-cat-btn tech-cat-fav"
          data-on={cat === "favorites" ? "true" : undefined}
          onClick={() => setCat("favorites")}
        >
          ★ Favorites ({favs.filter((id) => allDefs.some((t) => t.id === id)).length})
        </button>
        <button
          type="button"
          className="tech-cat-btn"
          data-on={cat === "all" ? "true" : undefined}
          onClick={() => setCat("all")}
        >
          All ({allDefs.length})
        </button>
        {catOrder.map((c) => (
          <button
            key={c}
            type="button"
            className="tech-cat-btn"
            data-cat={c}
            data-on={cat === c ? "true" : undefined}
            onClick={() => setCat(c)}
            title="Right-click to reorder the categories"
            onContextMenu={contextMenuHandler(() => [
              { label: "Move to top", onClick: () => reorder(c, "top") },
              { label: "Move up", onClick: () => reorder(c, "up") },
              { label: "Move down", onClick: () => reorder(c, "down") },
              "separator",
              {
                label: "Reset order",
                onClick: () => {
                  saveCatOrder([...CATEGORY_ORDER]);
                  setCatOrder([...CATEGORY_ORDER]);
                },
              },
            ])}
          >
            {CATEGORY_LABELS[c]} ({allDefs.filter((t) => t.category === c).length})
          </button>
        ))}
      </div>
        <div className="tech-cards">
          {(cat === "custom" || cat === "all") && query === "" && (
            <div
              role="button"
              tabIndex={0}
              className="tech-card tech-card-new"
              data-cat="custom"
              onClick={onNewCustom}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onNewCustom();
                }
              }}
            >
              <span className="tech-card-icon">
                <Icon name="plus" size={20} />
              </span>
              <span className="tech-card-text">
                <span className="tech-card-title">New Custom Technique…</span>
                <span className="tech-card-tag">Compose your own flow from any catalog steps.</span>
                <span className="tech-card-meta">{CATEGORY_LABELS.custom}</span>
              </span>
            </div>
          )}
          {list.length === 0 && query !== "" && (
            <div className="tech-empty">Nothing matches “{query}” — try the category rail.</div>
          )}
          {list.map((t) => {
            const custom = customDefs.find((c) => c.def.id === t.id);
            const fav = favs.includes(t.id);
            return (
              <TechCard
                key={t.id}
                t={t}
                onPick={onPick}
                actions={
                  <>
                    <button
                      type="button"
                      className={"tech-fav" + (fav ? " on" : "")}
                      title={fav ? "Remove from Favorites" : "Add to Favorites"}
                      onClick={() => setFavs(toggleTechFavorite(t.id))}
                    >
                      {fav ? "★" : "☆"}
                    </button>
                    {custom !== undefined && (
                      <>
                        <IconButton
                          icon="pencil"
                          size={17}
                          tooltip="Edit this technique"
                          onClick={() => onEditCustom(custom.data)}
                        />
                        <IconButton
                          icon="trash"
                          size={17}
                          tooltip="Delete this technique"
                          onClick={() => deleteCustom(custom.data)}
                        />
                      </>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Card + its rich hover tooltip: after a short intent delay, a panel with the full
 * description and every stage (title, optional tag, one-line summary). Positioned
 * beside the card, clamped to the card's own window — works in the pop-out too.
 */
function TechCard({
  t,
  onPick,
  actions,
}: {
  t: TechniqueDef;
  onPick: (t: TechniqueDef) => void;
  /** Extra buttons (edit/delete on custom cards) — rendered top-right, clicks stop. */
  actions?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);
  const [hover, setHover] = useState<{ left: number; top: number; flip: boolean } | null>(null);

  const show = () => {
    const el = ref.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    const r = el.getBoundingClientRect();
    const panelW = 340;
    const flip = r.right + 12 + panelW > win.innerWidth;
    setHover({
      left: flip ? Math.max(8, r.left - 12 - panelW) : r.right + 12,
      top: Math.min(Math.max(8, r.top - 8), Math.max(8, win.innerHeight - 380)),
      flip,
    });
  };
  const onEnter = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(show, 260);
  };
  const onLeave = () => {
    window.clearTimeout(timer.current);
    setHover(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <>
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        className="tech-card"
        data-cat={t.category}
        onClick={() => {
          onLeave();
          onPick(t);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onLeave();
            onPick(t);
          }
        }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <span className="tech-card-icon">
          <Icon name={techniqueIcon(t)} size={20} />
        </span>
        <span className="tech-card-text">
          <span className="tech-card-title">{t.title}</span>
          <span className="tech-card-tag">{t.tagline}</span>
          <span className="tech-card-meta">
            {CATEGORY_LABELS[t.category]} · {t.stages.length} stages
          </span>
        </span>
        {actions !== undefined && (
          <span className="tech-card-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {hover !== null &&
        ref.current !== null &&
        createPortal(
          <div
            className="tech-hover"
            data-cat={t.category}
            style={{ left: hover.left, top: hover.top }}
          >
            <div className="tech-hover-head">
              <Icon name={techniqueIcon(t)} size={17} />
              <span className="tech-hover-title">{t.title}</span>
              <span className="tech-hover-cat">{CATEGORY_LABELS[t.category]}</span>
            </div>
            <div className="tech-hover-desc">{t.description}</div>
            <div className="tech-hover-steps-label">Steps</div>
            <ol className="tech-hover-steps">
              {t.stages.map((st) => (
                <li key={st.id}>
                  <span className="tech-hover-step-title">
                    {st.title}
                    {st.optional ? <em> · optional</em> : null}
                  </span>
                  <span className="tech-hover-step-sum">{st.summary}</span>
                </li>
              ))}
            </ol>
          </div>,
          ref.current.ownerDocument.body,
        )}
    </>
  );
}

/**
 * Builder — compose a custom technique from any catalog stages. Each borrowed step
 * keeps its params, manual text and reveal target; the preview line under every
 * step shows what Apply will do so the flow reads before it runs.
 */
function Builder({
  initial,
  onDone,
}: {
  initial: CustomTechniqueData;
  onDone: (saved: boolean) => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [tagline, setTagline] = useState(initial.tagline);
  const [description, setDescription] = useState(initial.description);
  const [steps, setSteps] = useState<CustomStepRef[]>(initial.steps);
  const [pickTech, setPickTech] = useState(TECHNIQUES[0].id);
  const tech = TECHNIQUES.find((t) => t.id === pickTech) ?? TECHNIQUES[0];
  const [pickStage, setPickStage] = useState(tech.stages[0].id);
  const stageOf = (ref: CustomStepRef) => {
    const t = TECHNIQUES.find((x) => x.id === ref.tech);
    return { t, s: t?.stages.find((x) => x.id === ref.stage) };
  };

  const setTech = (id: string) => {
    setPickTech(id);
    const t = TECHNIQUES.find((x) => x.id === id);
    if (t) setPickStage(t.stages[0].id);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };
  const save = () => {
    if (title.trim() === "") {
      showToast("Give the technique a name first.", "error");
      return;
    }
    if (steps.length === 0) {
      showToast("Add at least one step.", "error");
      return;
    }
    const list = loadCustomTechniques();
    const data: CustomTechniqueData = {
      id: initial.id,
      title: title.trim(),
      tagline: tagline.trim(),
      description: description.trim(),
      steps,
    };
    const i = list.findIndex((d) => d.id === data.id);
    if (i >= 0) list[i] = data;
    else list.push(data);
    saveCustomTechniques(list);
    showToast(`“${data.title}” saved — it lives in Custom (and Search).`, "success");
    onDone(true);
  };

  return (
    <div className="tech-builder" data-cat="custom">
      <div className="tech-topline">
        <button type="button" className="btn tech-back" onClick={() => onDone(false)}>
          <Icon name="chevronLeft" size={14} /> Cancel
        </button>
        <div className="grow" />
        <button type="button" className="btn primary" onClick={save}>
          Save technique
        </button>
      </div>

      <div className="tech-head">
        <div className="tech-title">{initial.steps.length === 0 ? "New Custom Technique" : `Edit “${initial.title}”`}</div>
        <div className="tech-cat">{CATEGORY_LABELS.custom}</div>
      </div>

      <div className="tech-builder-fields">
        <label className="tech-builder-field">
          <span>Name</span>
          <input value={title} placeholder="My verse-to-chorus lift" onChange={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <label className="tech-builder-field">
          <span>Tagline (card one-liner)</span>
          <input value={tagline} placeholder="What the listener hears" onChange={(e) => setTagline(e.currentTarget.value)} />
        </label>
        <label className="tech-builder-field">
          <span>Description (tooltip paragraph)</span>
          <textarea
            value={description}
            rows={2}
            placeholder="When to reach for it, what it does…"
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </label>
      </div>

      <div className="tech-builder-add">
        <span className="tech-param-label">Add a step:</span>
        <Select
          value={pickTech}
          options={TECHNIQUES.map((t) => ({ value: t.id, label: `${t.title} (${CATEGORY_LABELS[t.category]})` }))}
          onChange={setTech}
          width={280}
        />
        <Select
          value={pickStage}
          options={tech.stages.map((s) => ({
            value: s.id,
            label: `${s.title}${s.optional ? " (optional)" : ""}`,
          }))}
          onChange={setPickStage}
          width={210}
        />
        <button
          type="button"
          className="btn primary"
          onClick={() => setSteps([...steps, { tech: tech.id, stage: pickStage }])}
        >
          Add
        </button>
      </div>

      <div className="tech-builder-steps">
        {steps.length === 0 && (
          <div className="tech-empty">No steps yet — borrow any stage from the catalog above.</div>
        )}
        {steps.map((ref, i) => {
          const { t, s } = stageOf(ref);
          return (
            <div key={`${i}-${ref.tech}-${ref.stage}`} className="tech-builder-step">
              <span className="tech-builder-step-n">{i + 1}.</span>
              <span className="tech-builder-step-text">
                <span className="tech-hover-step-title">
                  {s?.title ?? ref.stage}
                  <em> — {t?.title ?? `${ref.tech} (missing)`}</em>
                </span>
                <span className="tech-hover-step-sum">{s?.summary ?? "This source stage no longer exists."}</span>
              </span>
              <IconButton icon="chevronUp" size={17} tooltip="Move up" onClick={() => move(i, -1)} />
              <IconButton icon="chevronDown" size={17} tooltip="Move down" onClick={() => move(i, 1)} />
              <IconButton icon="x" size={17} tooltip="Remove step" onClick={() => setSteps(steps.filter((_, k) => k !== i))} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TechniquesDialog() {
  const open = useStore((s) => s.dialogs.techniques);
  const setDialogs = useStore((s) => s.setDialogs);
  const [picked, setPicked] = useState<TechniqueDef | null>(null);
  const [builder, setBuilder] = useState<CustomTechniqueData | null>(null);
  // The Guide is the LANDING view (plan doc §0): orientation first, catalog on demand.
  const [view, setView] = useState<"guide" | "browser">("guide");
  const [customsVersion, setCustomsVersion] = useState(0);
  const [popped, setPopped] = useState(false);
  const pop = usePopoutWindow({
    name: "MyDAW-techniques",
    title: "MyDAW — Production Techniques",
    width: 1020,
    height: 780,
    onClosed: () => setPopped(false),
  });

  // Alt+T / menu while detached: raise the window instead of double-hosting.
  useEffect(() => {
    if (open && popped) {
      pop.focus();
      setDialogs({ techniques: false });
    }
  }, [open, popped, pop, setDialogs]);

  const detach = () => {
    if (pop.open()) {
      setPopped(true);
      setDialogs({ techniques: false });
    } else {
      showToast(
        "Pop-out was blocked by the browser — allow popups for this site, then try again.",
        "error",
      );
    }
  };

  // Wizard/browse/builder state lives HERE (always mounted via DialogsHost), so
  // attach ↔ detach keeps the picked technique and its stage session intact.
  const body =
    builder !== null ? (
      <Builder
        initial={builder}
        onDone={(saved) => {
          setBuilder(null);
          if (saved) setCustomsVersion((n) => n + 1);
        }}
      />
    ) : picked !== null ? (
      <Wizard
        technique={picked}
        onBack={() => setPicked(null)}
        backLabel={view === "guide" ? "Guide" : "All techniques"}
      />
    ) : view === "guide" ? (
      <GuideView onOpenTechnique={setPicked} onBrowseAll={() => setView("browser")} />
    ) : (
      <Browser
        onPick={setPicked}
        onGuide={() => setView("guide")}
        onNewCustom={() =>
          setBuilder({
            id: freshCustomId(loadCustomTechniques()),
            title: "",
            tagline: "",
            description: "",
            steps: [],
          })
        }
        onEditCustom={(data) => setBuilder(data)}
        onCustomsChanged={() => setCustomsVersion((n) => n + 1)}
        customsVersion={customsVersion}
      />
    );

  return (
    <>
      {popped &&
        pop.container !== null &&
        createPortal(
          <div className="tech-popout">
            <div className="tech-popout-head">
              <Icon name="sparkles" size={15} />
              <span className="grow">Production Techniques</span>
              <IconButton
                icon="import"
                size={20}
                tooltip="Dock back into the app"
                onClick={() => {
                  pop.close();
                  setDialogs({ techniques: true });
                }}
              />
            </div>
            <div className="tech-popout-body">{body}</div>
          </div>,
          pop.container,
          "popout-techniques",
        )}
      {!popped && open && (
        <Modal
          open
          onClose={() => {
            setPicked(null);
            setDialogs({ techniques: false });
          }}
          title={
            <span className="row gap1">
              <Icon name="sparkles" size={15} /> Production Techniques
              <IconButton
                icon="export"
                size={18}
                tooltip="Pop out into a separate window"
                onClick={detach}
              />
            </span>
          }
          width={960}
          transportKeys
          closeOnOverlay={false}
          draggable
          className="tech-modal"
        >
          {body}
        </Modal>
      )}
    </>
  );
}
