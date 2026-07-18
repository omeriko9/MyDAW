/**
 * Settings → AUDIO tab (U5): driver/device/SR/buffer/exclusive + Apply
 * (engine/setAudioConfig), live engine status (latency / xruns / cpu).
 * Unavailable drivers (e.g. ASIO without SDK) appear disabled with their reason (SPEC §10).
 */

import React, { useEffect, useState } from "react";
import type { DriverType } from "../../protocol/types";
import { useStore } from "../../store/store";
import { getDevices, getEngineStatus, setAudioConfig } from "../../store/actions";
import { Select } from "../common/Select";
import type { SelectOption } from "../common/Select";
import { Toggle } from "../common/Toggle";

const SAMPLE_RATES = [44100, 48000, 88200, 96000];
const BUFFER_SIZES = [64, 128, 256, 512, 1024, 2048];

interface Cfg {
  driver: string;
  deviceId: string;
  sampleRate: number;
  bufferSize: number;
  exclusive: boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AudioTab() {
  const audioDevices = useStore((s) => s.audioDevices);
  const engineStatus = useStore((s) => s.engineStatus);
  const engineInfo = useStore((s) => s.engineInfo);
  const connected = useStore((s) => s.connected);
  const setAudioDevices = useStore((s) => s.setAudioDevices);
  const setEngineStatus = useStore((s) => s.setEngineStatus);

  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ msg: string; error: boolean } | null>(null);

  /* refresh devices + poll status while the tab is open */
  useEffect(() => {
    let alive = true;
    getDevices()
      .then((d) => {
        if (alive) setAudioDevices(d);
      })
      .catch(() => {});
    const poll = () => {
      getEngineStatus()
        .then((st) => {
          if (alive) setEngineStatus(st);
        })
        .catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* initialise the form once devices are known */
  useEffect(() => {
    if (cfg || !audioDevices) return;
    const drivers = audioDevices.drivers;
    if (drivers.length === 0) return;
    const st = engineStatus;
    const current = st ? drivers.find((d) => d.type === st.driver && d.available) : undefined;
    const drv = current ?? drivers.find((d) => d.available) ?? drivers[0];
    const dev =
      drv.devices.find((d) => st && (d.id === st.device || d.name === st.device)) ??
      drv.devices.find((d) => d.isDefault) ??
      drv.devices[0];
    setCfg({
      driver: drv.type,
      deviceId: dev?.id ?? "",
      sampleRate: st?.sampleRate || engineInfo?.sampleRate || 48000,
      bufferSize: st?.bufferSize || engineInfo?.blockSize || 256,
      exclusive: false,
    });
  }, [audioDevices, engineStatus, engineInfo, cfg]);

  const drivers = audioDevices?.drivers ?? [];
  const driverOpts: SelectOption[] = drivers.map((d) => ({
    value: d.type,
    label: d.type.toUpperCase() + (d.available ? "" : ` — ${d.reason ?? "unavailable"}`),
    disabled: !d.available,
  }));
  const curDriver = drivers.find((d) => d.type === cfg?.driver);
  const deviceOpts: SelectOption[] = (curDriver?.devices ?? []).map((d) => ({
    value: d.id,
    label: d.name + (d.isDefault ? " (default)" : ""),
  }));

  const onDriverChange = (v: string) => {
    const drv = drivers.find((d) => d.type === v);
    const dev = drv?.devices.find((d) => d.isDefault) ?? drv?.devices[0];
    setCfg((c) => (c ? { ...c, driver: v, deviceId: dev?.id ?? "" } : c));
  };

  const apply = () => {
    if (!cfg) return;
    setBusy(true);
    setResult(null);
    setAudioConfig({
      driver: cfg.driver as DriverType,
      deviceId: cfg.deviceId,
      sampleRate: cfg.sampleRate,
      bufferSize: cfg.bufferSize,
      exclusive: cfg.exclusive,
    })
      .then((r) => {
        setResult({
          msg: `Running at ${r.actual.sampleRate} Hz / ${r.actual.bufferSize} frames — ${r.actual.latencyMs.toFixed(1)} ms latency`,
          error: false,
        });
        return getEngineStatus().then(setEngineStatus);
      })
      .catch((e) => setResult({ msg: errText(e), error: true }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="col gap2">
      {!connected ? <div className="sett-error">Engine disconnected — settings unavailable.</div> : null}

      <div className="sett-grid">
        <span className="sett-label">Driver</span>
        <Select
          value={cfg?.driver ?? ""}
          options={driverOpts.length > 0 ? driverOpts : [{ value: "", label: "—" }]}
          disabled={!cfg}
          onChange={onDriverChange}
        />

        <span className="sett-label">Device</span>
        <Select
          value={cfg?.deviceId ?? ""}
          options={deviceOpts.length > 0 ? deviceOpts : [{ value: "", label: "No devices" }]}
          disabled={!cfg || deviceOpts.length === 0}
          onChange={(v) => setCfg((c) => (c ? { ...c, deviceId: v } : c))}
        />

        <span className="sett-label">Sample rate</span>
        <Select
          value={String(cfg?.sampleRate ?? 48000)}
          options={SAMPLE_RATES.map((sr) => ({ value: String(sr), label: `${sr.toLocaleString()} Hz` }))}
          disabled={!cfg}
          onChange={(v) => setCfg((c) => (c ? { ...c, sampleRate: Number(v) } : c))}
        />

        <span className="sett-label">Buffer size</span>
        <Select
          value={String(cfg?.bufferSize ?? 256)}
          options={BUFFER_SIZES.map((b) => ({ value: String(b), label: `${b} frames` }))}
          disabled={!cfg}
          onChange={(v) => setCfg((c) => (c ? { ...c, bufferSize: Number(v) } : c))}
        />

        <span className="sett-label">Exclusive mode</span>
        <div className="row">
          <Toggle
            on={cfg?.exclusive ?? false}
            onChange={(on) => setCfg((c) => (c ? { ...c, exclusive: on } : c))}
            disabled={!cfg}
            tooltip="WASAPI exclusive mode (lower latency, takes over the device)"
          >
            Exclusive
          </Toggle>
        </div>
      </div>

      <div className="row gap2">
        <button
          type="button"
          className="btn primary"
          disabled={!cfg || busy || !connected}
          onClick={apply}
        >
          {busy ? "Applying…" : "Apply"}
        </button>
        {result ? (
          <span className={result.error ? "sett-error" : "sett-ok"}>{result.msg}</span>
        ) : null}
      </div>

      <div className="sett-status">
        {engineStatus ? (
          <>
            <span>
              <span className="k">Driver</span>
              {engineStatus.driver}
            </span>
            <span className="ellipsis" style={{ maxWidth: 200 }} title={engineStatus.device}>
              <span className="k">Device</span>
              {engineStatus.device}
            </span>
            <span>
              <span className="k">SR</span>
              {engineStatus.sampleRate} Hz
            </span>
            <span>
              <span className="k">Buffer</span>
              {engineStatus.bufferSize}
            </span>
            <span>
              <span className="k">Latency</span>
              {engineStatus.latencyMs.toFixed(1)} ms
            </span>
            <span>
              <span className="k">Xruns</span>
              {engineStatus.xruns}
            </span>
            <span>
              <span className="k">CPU</span>
              {engineStatus.cpuPercent.toFixed(0)}%
            </span>
            <span>
              <span className="k">PDC</span>
              {engineStatus.pdcSamples} smp
            </span>
          </>
        ) : (
          <span className="dim">Engine status unavailable.</span>
        )}
      </div>
    </div>
  );
}
