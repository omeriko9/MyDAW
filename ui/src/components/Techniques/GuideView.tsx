/**
 * Production Guide (docs/PRODUCTION_TECHNIQUES_PLAN.md §0, step 2) — the landing
 * view of the techniques dialog: the stages a song moves through, each a
 * checklist of plain-language goals, evaluated LIVE against the open project.
 *
 * Balanced emphasis (Omer's pick): the grounded relevance note is always visible
 * on the row; expanding shows why-now + what-you'll-hear up front, then the
 * techniques as means-to-a-goal (one line on when each is the right tool) with
 * one click into the wizard — which carries Apply, by-hand instructions and the
 * A/B audition. Goals without a wizard show their honest by-hand line instead
 * of a dead row (SPEC §10).
 */

import { useState } from "react";
import { useStore } from "../../store/store";
import { Icon } from "../common/icons";
import { techniqueById, techniqueIcon } from "../../techniques/catalog";
import { makeCtx } from "../../techniques/ops";
import { GUIDE_STAGES, suggestedCount, evaluateGuide } from "../../techniques/guide";
import type { GoalStatus } from "../../techniques/guide";
import type { TechniqueDef } from "../../techniques/types";

const STATUS_LABEL: Record<GoalStatus, string> = {
  suggested: "Suggested",
  open: "By ear",
  done: "In place",
  na: "Not yet",
};

const STATUS_TITLE: Record<GoalStatus, string> = {
  suggested: "The project shows the signal for this and the treatment is absent",
  open: "Applicable, but only your ears can judge it",
  done: "The treatment is already present in the project",
  na: "The material this goal is about doesn't exist yet",
};

export default function GuideView({
  onOpenTechnique,
  onBrowseAll,
}: {
  onOpenTechnique: (t: TechniqueDef) => void;
  onBrowseAll: () => void;
}) {
  const [openGoal, setOpenGoal] = useState<string | null>(null);
  useStore(); // relevance reads live project state — re-evaluate on any change
  const ctx = makeCtx();
  if (!ctx) return <div className="tech-empty">No project — connect to the engine first.</div>;
  const evaluated = evaluateGuide(ctx);
  const byGoal = new Map(evaluated.map((e) => [e.goal.id, e.relevance]));
  const nSuggested = suggestedCount(evaluated);

  return (
    <div className="tech-guide">
      <div className="tech-guide-head">
        <div>
          <div className="tech-guide-title">Production Guide</div>
          <div className="tech-guide-sub">
            The stages a song moves through, checked against <b>this</b> project —{" "}
            {nSuggested === 0
              ? "nothing is flagged right now; the “By ear” rows are yours to judge."
              : `${nSuggested} thing${nSuggested === 1 ? "" : "s"} flagged for this song right now.`}
          </div>
        </div>
        <button type="button" className="btn tech-guide-browse" onClick={onBrowseAll}>
          Browse all techniques <Icon name="chevronRight" size={13} />
        </button>
      </div>

      {GUIDE_STAGES.map((stage, si) => (
        <div key={stage.id} className="tech-guide-stage" data-stage={stage.id}>
          <div className="tech-guide-stage-head">
            <span className="tech-guide-stage-n">{si + 1}</span>
            <span className="tech-guide-stage-title">{stage.title}</span>
            <span className="tech-guide-stage-intro">{stage.intro}</span>
          </div>
          {stage.goals.map((goal) => {
            const rel = byGoal.get(goal.id)!;
            const expanded = openGoal === goal.id;
            return (
              <div
                key={goal.id}
                className={"tech-goal" + (expanded ? " open" : "")}
                data-status={rel.status}
                data-goal={goal.id}
              >
                <button
                  type="button"
                  className="tech-goal-row"
                  onClick={() => setOpenGoal(expanded ? null : goal.id)}
                >
                  <span className="tech-goal-badge" title={STATUS_TITLE[rel.status]}>
                    {STATUS_LABEL[rel.status]}
                  </span>
                  <span className="tech-goal-title">{goal.title}</span>
                  <span className="tech-goal-note">{rel.note}</span>
                  <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
                </button>
                {expanded && (
                  <div className="tech-goal-body">
                    <div className="tech-goal-why">{goal.why}</div>
                    <div className="tech-goal-hear">
                      <b>What you'll hear:</b> {goal.hear}
                    </div>
                    {goal.means.length > 0 && (
                      <div className="tech-goal-means">
                        {goal.means.map((m) => {
                          const t = techniqueById(m.techniqueId);
                          if (!t) return null;
                          return (
                            <div key={m.techniqueId} className="tech-goal-mean">
                              <Icon name={techniqueIcon(t)} size={14} />
                              <span className="tech-goal-mean-title">{t.title}</span>
                              <span className="tech-goal-mean-when">{m.when}</span>
                              <button
                                type="button"
                                className="btn primary tech-goal-open"
                                onClick={() => onOpenTechnique(t)}
                              >
                                Open
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {goal.byHand && (
                      <div className="tech-goal-byhand">
                        <b>By hand:</b> {goal.byHand}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
