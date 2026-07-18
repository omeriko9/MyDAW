/**
 * Status bar (owned by U2) — bottom 24 px strip.
 *
 * Left: connection dot, project name + dirty dot. Right: driver/device,
 * SR / buffer / latency, xrun count (warn color when > 0), CPU %, PDC samples.
 * Polls engine/getStatus every 2 s while connected (store.engineStatus mirror).
 */

import { useEffect } from "react";
import { useStore } from "../../store/store";
import { getEngineStatus } from "../../store/actions";
import PositionDisplay from "./PositionDisplay";
import { SnapCluster, TempoSigCluster } from "./TransportBar";
import "./transport.css";

const POLL_MS = 2000;

export default function StatusBar() {
  const connected = useStore((s) => s.connected);
  const engineInfo = useStore((s) => s.engineInfo);
  const status = useStore((s) => s.engineStatus);
  const dirty = useStore((s) => s.dirty);
  const projectName = useStore((s) => s.project?.name ?? null);
  const setEngineStatus = useStore((s) => s.setEngineStatus);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    const poll = () => {
      getEngineStatus()
        .then((st) => {
          if (!stopped) setEngineStatus(st);
        })
        .catch(() => {
          /* transient — next tick retries */
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [connected, setEngineStatus]);

  const driver = status?.driver ?? engineInfo?.driver ?? "—";
  const device = status?.device ?? "";
  const sampleRate = status?.sampleRate ?? engineInfo?.sampleRate ?? 0;
  const bufferSize = status?.bufferSize ?? engineInfo?.blockSize ?? 0;
  const latencyMs = status?.latencyMs ?? engineInfo?.latencyMs ?? 0;
  const xruns = status?.xruns ?? 0;
  const cpu = status?.cpuPercent ?? 0;
  const pdc = status?.pdcSamples ?? 0;

  return (
    <div className="status-bar">
      <span
        className="sb-dot"
        data-ok={connected ? "true" : undefined}
        title={connected ? "Engine connected" : "Engine offline"}
      />
      <span className="sb-item ellipsis" style={{ flexShrink: 1, minWidth: 0 }}>
        <span className="sb-value ellipsis">{projectName ?? "No project"}</span>
        {dirty && <span className="sb-dirty" title="Unsaved changes" />}
      </span>

      {/* transport meta moved down from the top bar; popovers flip upward via .sb-controls */}
      <div className="sb-sep" />
      <div className="sb-controls">
        <PositionDisplay />
        <TempoSigCluster />
        <SnapCluster />
      </div>

      <span className="grow" />

      <span className="sb-item" title="Audio driver / device">
        <span className="sb-value">{driver}</span>
        {device ? <span className="ellipsis" style={{ maxWidth: 180 }}>{device}</span> : null}
      </span>
      <span className="sb-item mono" title="Sample rate · buffer size (samples) · output latency">
        {sampleRate > 0 ? `${sampleRate} Hz` : "— Hz"} ·{" "}
        {bufferSize > 0 ? `${bufferSize} smp` : "— smp"} ·{" "}
        {latencyMs > 0 ? `${latencyMs.toFixed(1)} ms` : "— ms"}
      </span>
      <span className={"sb-item mono" + (xruns > 0 ? " warn" : "")} title="Audio dropouts (xruns)">
        XRun <span className={xruns > 0 ? undefined : "sb-value"}>{xruns}</span>
      </span>
      <span className="sb-item mono" title="Engine DSP load">
        CPU <span className="sb-value">{Math.round(cpu)}%</span>
      </span>
      <span className="sb-item mono" title="Plugin delay compensation">
        PDC <span className="sb-value">{pdc}</span> smp
      </span>
    </div>
  );
}
