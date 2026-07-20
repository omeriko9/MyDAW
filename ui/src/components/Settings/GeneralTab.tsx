/**
 * Settings → GENERAL tab (U5): appearance (theme — lib/theme, stored per user in
 * localStorage) + autosave interval (settings/get|set, flat object).
 */

import React, { useEffect, useState } from "react";
import type { AppSettings } from "../../protocol/types";
import { applyTheme, THEMES, useThemeName, type ThemeName } from "../../lib/theme";
import {
  applyMotionPref,
  MOTION_OPTIONS,
  useMotionPref,
  type MotionPref,
} from "../../lib/motion";
import { getSettings, setSettings } from "../../store/actions";
import { usePrefState } from "../../lib/prefs";
import {
  RECOVERY_MODE_DEFAULT,
  RECOVERY_MODE_PREF,
  isRecoveryMode,
  type RecoveryMode,
} from "../Transport/projectFlows";
import { NumberDrag } from "../common/NumberDrag";
import { Select } from "../common/Select";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const DEFAULT_AUTOSAVE_MIN = 2;

export function GeneralTab() {
  const [settings, setLocal] = useState<AppSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        if (alive) setLocal(s ?? {});
      })
      .catch((e) => {
        if (alive) {
          setErr(errText(e));
          setLocal({});
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const autosave =
    draft ??
    (typeof settings?.autosaveMinutes === "number"
      ? settings.autosaveMinutes
      : DEFAULT_AUTOSAVE_MIN);

  const commitAutosave = (v: number) => {
    const minutes = Math.max(1, Math.round(v));
    setDraft(null);
    setLocal((s) => ({ ...(s ?? {}), autosaveMinutes: minutes }));
    setErr(null);
    setSettings({ autosaveMinutes: minutes }).catch((e) => setErr(errText(e)));
  };

  const theme = useThemeName();
  const motion = useMotionPref();
  const [recovery, setRecovery] = usePrefState<RecoveryMode>(
    RECOVERY_MODE_PREF,
    RECOVERY_MODE_DEFAULT,
    isRecoveryMode,
  );

  return (
    <div className="col gap2">
      <div className="sett-grid">
        <span className="sett-label">Theme</span>
        <div className="row gap1">
          <Select
            value={theme}
            options={THEMES.map((t) => ({ value: t.value, label: t.label }))}
            onChange={(v) => applyTheme(v as ThemeName)}
            width={140}
          />
          <span className="sett-note">also in View → Theme; saved per user</span>
        </div>
        <span className="sett-label">Interface motion</span>
        <div className="row gap1">
          <Select
            value={motion}
            options={MOTION_OPTIONS.map((m) => ({ value: m.value, label: m.label }))}
            onChange={(v) => applyMotionPref(v as MotionPref)}
            width={140}
          />
          <span className="sett-note">
            hover/press/menu animations; follows the OS reduced-motion setting
          </span>
        </div>
        <span className="sett-label">Autosave interval</span>
        <div className="row gap1">
          <NumberDrag
            value={autosave}
            min={1}
            max={120}
            step={1}
            precision={0}
            units="min"
            width={64}
            disabled={settings === null}
            onChange={(v) => setDraft(v)}
            onCommit={commitAutosave}
          />
          <span className="sett-note">autosaves only while the project is dirty</span>
        </div>
        <span className="sett-label">Crash recovery</span>
        <div className="row gap1">
          <Select
            value={recovery}
            options={[
              { value: "auto", label: "Recover automatically" },
              { value: "ask", label: "Ask every time" },
              { value: "never", label: "Never recover" },
            ]}
            onChange={(v) => setRecovery(v as RecoveryMode)}
            width={180}
          />
          <span className="sett-note">
            after an unclean shutdown; saved per user
          </span>
        </div>
      </div>
      <div className="sett-note">
        Settings are stored in %APPDATA%/MyDAW/settings.json. Autosaves go to the project's
        autosave/ folder (5 kept, round-robin).
      </div>
      {err ? <div className="sett-error">{err}</div> : null}
    </div>
  );
}
