/**
 * Inspector project overview (U5) — shown when nothing is selected.
 */

import React from "react";
import type { Project } from "../../protocol/types";
import { Section } from "./Section";

export function ProjectOverview({ project }: { project: Project }) {
  const counts: Record<string, number> = {};
  let clipCount = 0;
  for (const t of project.tracks) {
    counts[t.kind] = (counts[t.kind] ?? 0) + 1;
    clipCount += t.clips.length;
  }
  const trackSummary =
    (["audio", "midi", "instrument", "bus", "folder"] as const)
      .filter((k) => (counts[k] ?? 0) > 0)
      .map((k) => `${counts[k]} ${k}`)
      .join(" · ") || "none";

  const tempo = project.tempoMap[0]?.bpm ?? 120;
  const sig = project.timeSigMap[0] ?? { num: 4, den: 4 };
  const missing = project.assets.filter((a) => a.missing).length;

  return (
    <Section title="Project">
      <div className="insp-kv">
        <span className="insp-k">Name</span>
        <span className="insp-v" title={project.name}>
          {project.name}
        </span>
        <span className="insp-k">Folder</span>
        <span className="insp-v mono dim" title={`${project.name}.mydaw`}>
          {project.name}.mydaw
        </span>
        <span className="insp-k">Sample rate</span>
        <span className="insp-v">{project.sampleRate.toLocaleString()} Hz</span>
        <span className="insp-k">Tempo</span>
        <span className="insp-v">{tempo} BPM</span>
        <span className="insp-k">Time sig</span>
        <span className="insp-v">
          {sig.num}/{sig.den}
        </span>
        <span className="insp-k">Tracks</span>
        <span className="insp-v" title={trackSummary}>
          {trackSummary}
        </span>
        <span className="insp-k">Clips</span>
        <span className="insp-v">{clipCount}</span>
        <span className="insp-k">Assets</span>
        <span className="insp-v">
          {project.assets.length}
          {missing > 0 ? <span className="badge danger" style={{ marginLeft: 6 }}>{missing} missing</span> : null}
        </span>
      </div>
      <div className="insp-hint">Select a track or clip to edit its properties.</div>
    </Section>
  );
}
