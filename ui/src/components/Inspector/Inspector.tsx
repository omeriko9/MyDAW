/**
 * Inspector (U5) — right panel (SPEC §9): selected track props, selected clip props,
 * markers; project overview when nothing is selected. Renders an empty state when
 * the engine is disconnected / no project.
 */

import React from "react";
import "./inspector.css";
import type { Clip, Project, Track } from "../../protocol/types";
import { useStore } from "../../store/store";
import { Section } from "./Section";
import { TrackSection } from "./TrackSection";
import { TakesSection } from "./TakesSection";
import { ClipSection } from "./ClipSection";
import { MarkersSection } from "./MarkersSection";
import { ProjectOverview } from "./ProjectOverview";
import { Icon } from "../common/icons";

function findTrack(project: Project, id: number | undefined): Track | null {
  if (id === undefined) return null;
  if (project.masterTrack.id === id) return project.masterTrack;
  return project.tracks.find((t) => t.id === id) ?? null;
}

function findClip(
  project: Project,
  id: number | undefined,
): { clip: Clip; track: Track } | null {
  if (id === undefined) return null;
  for (const t of project.tracks) {
    const c = t.clips.find((cl) => cl.id === id);
    if (c) return { clip: c, track: t };
  }
  return null;
}

export default function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const connected = useStore((s) => s.connected);

  if (!project) {
    return (
      <div className="inspector">
        <div className="insp-empty">
          <Icon name="sliders" size={22} />
          <div>No project</div>
          <div className="faint">{connected ? "Waiting for project…" : "Engine disconnected"}</div>
        </div>
      </div>
    );
  }

  const clipHit = findClip(project, selection.clipIds[0]);
  // First selected track; fall back to the selected clip's parent track.
  const track = findTrack(project, selection.trackIds[0]) ?? clipHit?.track ?? null;
  const nothingSelected = !track && !clipHit;

  return (
    <div className="inspector">
      {track ? (
        <TrackSection key={`t${track.id}`} track={track} project={project} />
      ) : null}
      {track && track.kind !== "master" && track.kind !== "folder" ? (
        <TakesSection key={`tk${track.id}`} track={track} project={project} />
      ) : null}
      {clipHit ? (
        <ClipSection
          key={`c${clipHit.clip.id}`}
          clip={clipHit.clip}
          track={clipHit.track}
          project={project}
        />
      ) : null}
      {nothingSelected ? <ProjectOverview project={project} /> : null}
      <MarkersSection project={project} />
      {/* spacer keeps the last section border tidy */}
      <div className="grow" />
    </div>
  );
}

// Re-export for siblings that want the collapsible section chrome.
export { Section };
