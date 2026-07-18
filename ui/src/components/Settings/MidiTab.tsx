/**
 * Settings → MIDI tab (U5): input list with enable toggles (midi/setInputEnabled)
 * and a live activity dot fed by midiActivityBus (imperative, outside React state churn).
 */

import React, { useEffect, useRef, useState } from "react";
import { midiActivityBus, useStore } from "../../store/store";
import { getMidiInputs, setMidiInputEnabled } from "../../store/actions";
import { Toggle } from "../common/Toggle";
import { Icon } from "../common/icons";

interface InputRow {
  id: string;
  name: string;
  enabled: boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ActivityDot({ deviceId }: { deviceId: string }) {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = midiActivityBus.subscribe((ev) => {
      if (ev.deviceId !== deviceId) return;
      setOn(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), 160);
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [deviceId]);
  return <span className={"sett-activity" + (on ? " on" : "")} title="MIDI activity" />;
}

export function MidiTab() {
  const setMidiInputsStore = useStore((s) => s.setMidiInputs);
  const [inputs, setInputs] = useState<InputRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getMidiInputs()
      .then((r) => {
        if (!alive) return;
        setInputs(r.inputs);
        setMidiInputsStore(r.inputs);
      })
      .catch((e) => {
        if (alive) {
          setErr(errText(e));
          setInputs([]);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string, enabled: boolean) => {
    setErr(null);
    setMidiInputEnabled(id, enabled)
      .then(() => {
        setInputs((prev) =>
          prev ? prev.map((i) => (i.id === id ? { ...i, enabled } : i)) : prev,
        );
      })
      .catch((e) => setErr(errText(e)));
  };

  return (
    <div className="col gap2">
      <div className="sett-note">
        Enabled inputs feed record-armed MIDI tracks. The dot lights on incoming activity.
      </div>
      {inputs === null ? (
        <div className="dim">Loading MIDI inputs…</div>
      ) : inputs.length === 0 ? (
        <div className="row gap1 dim">
          <Icon name="midiNote" size={14} />
          No MIDI inputs detected.
        </div>
      ) : (
        <div className="sett-list">
          {inputs.map((inp) => (
            <div className="sett-item" key={inp.id}>
              <ActivityDot deviceId={inp.id} />
              <span className="name" title={inp.name}>
                {inp.name}
              </span>
              <Toggle on={inp.enabled} onChange={(on) => toggle(inp.id, on)}>
                {inp.enabled ? "Enabled" : "Disabled"}
              </Toggle>
            </div>
          ))}
        </div>
      )}
      {err ? <div className="sett-error">{err}</div> : null}
    </div>
  );
}
