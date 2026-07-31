/**
 * fieldsDialog — imperative small-form modal, like confirmDialog but returning values.
 *
 *   const v = await fieldsDialog({ title: "Velocity — Add", fields: [
 *     { key: "amount", label: "Amount", kind: "number", min: -64, max: 64, value: 10 },
 *   ]});
 *   if (v) applyFn((ns) => MF.scaleVelocity(ns, 1, v.amount as number));
 *
 * Resolves with { key: value } on OK, null on Cancel / Escape / overlay click.
 * Number fields commit as numbers (clamped to min/max), selects as their option
 * value, checkboxes as booleans. Concurrent calls queue (shared root pattern).
 */

import React, { useState } from "react";
import { createRoot, Root } from "react-dom/client";
import "./dialogs.css";
import { Modal } from "../common/Modal";

export type FieldValue = number | string | boolean;

export interface FieldSpec {
  key: string;
  label: string;
  kind: "number" | "select" | "checkbox";
  /** Initial value (number / option value / checked). */
  value: FieldValue;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  /** Grey the field out unless this other (checkbox) field is truthy. */
  enabledBy?: string;
}

export interface FieldsOptions {
  title: string;
  message?: string;
  fields: FieldSpec[];
  confirmLabel?: string;
}

interface PendingFields {
  opts: FieldsOptions;
  resolve: (values: Record<string, FieldValue> | null) => void;
}

let reactRoot: Root | null = null;
const queue: PendingFields[] = [];
let active: PendingFields | null = null;
let seq = 0;

function ensureRoot(): Root {
  if (!reactRoot) {
    const host = document.createElement("div");
    host.id = "mydaw-fields-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  return reactRoot;
}

function pump(): void {
  if (active) return;
  const next = queue.shift();
  if (!next) {
    ensureRoot().render(null);
    return;
  }
  active = next;
  ensureRoot().render(<FieldsModal key={++seq} opts={next.opts} onDone={finish} />);
}

function finish(values: Record<string, FieldValue> | null): void {
  const a = active;
  active = null;
  a?.resolve(values);
  pump();
}

export function fieldsDialog(opts: FieldsOptions): Promise<Record<string, FieldValue> | null> {
  return new Promise((resolve) => {
    queue.push({ opts, resolve });
    pump();
  });
}

function FieldsModal({
  opts,
  onDone,
}: {
  opts: FieldsOptions;
  onDone: (values: Record<string, FieldValue> | null) => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const v: Record<string, FieldValue> = {};
    for (const f of opts.fields) v[f.key] = f.value;
    return v;
  });
  const set = (key: string, value: FieldValue) => setValues((v) => ({ ...v, [key]: value }));
  const commit = () => {
    const out: Record<string, FieldValue> = {};
    for (const f of opts.fields) {
      let v = values[f.key];
      if (f.kind === "number") {
        let n = typeof v === "number" ? v : parseFloat(String(v));
        if (!Number.isFinite(n)) n = typeof f.value === "number" ? f.value : 0;
        if (f.min !== undefined) n = Math.max(f.min, n);
        if (f.max !== undefined) n = Math.min(f.max, n);
        v = n;
      }
      out[f.key] = v;
    }
    onDone(out);
  };
  const onFormKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) {
      e.preventDefault();
      commit();
    }
  };
  return (
    <Modal
      open
      onClose={() => onDone(null)}
      title={opts.title}
      width={360}
      showClose={false}
      footer={
        <>
          <button type="button" className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={commit}>
            {opts.confirmLabel ?? "Apply"}
          </button>
        </>
      }
    >
      <div className="dlg-fields" onKeyDown={onFormKey}>
        {opts.message !== undefined && <div className="dlg-confirm-msg">{opts.message}</div>}
        {opts.fields.map((f, i) => {
          const disabled = f.enabledBy !== undefined && values[f.enabledBy] !== true;
          if (f.kind === "checkbox") {
            return (
              <label key={f.key} className="dlg-check">
                <input
                  type="checkbox"
                  checked={values[f.key] === true}
                  onChange={(e) => set(f.key, e.target.checked)}
                />
                {f.label}
              </label>
            );
          }
          return (
            <label key={f.key} className={"dlg-field" + (disabled ? " disabled" : "")}>
              <span className="dlg-field-label">{f.label}</span>
              {f.kind === "number" ? (
                <input
                  type="number"
                  data-autofocus={i === 0 ? "true" : undefined}
                  disabled={disabled}
                  value={typeof values[f.key] === "boolean" ? "" : String(values[f.key])}
                  min={f.min}
                  max={f.max}
                  step={f.step ?? 1}
                  onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))}
                  // Typing stays unclamped (so a lone "-" or a partial decimal survives), but on
                  // blur the field snaps to the range commit() would apply — otherwise it keeps
                  // showing a number that Apply silently replaces with the clamped one.
                  onBlur={(e) => {
                    if (e.target.value === "") return;
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    let c = n;
                    if (f.min !== undefined) c = Math.max(f.min, c);
                    if (f.max !== undefined) c = Math.min(f.max, c);
                    if (c !== n) set(f.key, c);
                  }}
                />
              ) : (
                <select
                  disabled={disabled}
                  value={String(values[f.key])}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </label>
          );
        })}
      </div>
    </Modal>
  );
}
