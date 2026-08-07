/**
 * Add Audio Track dialog (Omer, 2026-08-07): adding an audio channel asks
 * mono/stereo and WHICH input (device + channel — e.g. Audio Kontrol In 1/2 as a
 * stereo pair, or mono In 1 / In 2) before the track exists. Mono/stereo drives
 * the option list live via the shared capture-input helper (lib/captureInputs),
 * the same source the mixer strip and the Inspector use. Everything remains
 * editable in the Inspector afterwards (channels included — TrackPatch.channels).
 */

import { useState } from "react";
import { useStore } from "../../store/store";
import { addTrack, setTrack } from "../../store/actions";
import { captureInputOptions, parseCaptureInput } from "../../lib/captureInputs";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { showToast } from "../common/ToastHost";

export default function AddAudioTrackDialog() {
  const open = useStore((s) => s.dialogs.addAudioTrack);
  const setDialogs = useStore((s) => s.setDialogs);
  const audioDevices = useStore((s) => s.audioDevices);
  const engineStatus = useStore((s) => s.engineStatus);
  const engineInfo = useStore((s) => s.engineInfo);
  const [name, setName] = useState("");
  const [stereo, setStereo] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;
  const driverName = (engineStatus?.driver ?? engineInfo?.driver ?? "").toLowerCase();
  const opts = captureInputOptions(audioDevices, driverName, stereo);
  const close = () => {
    setDialogs({ addAudioTrack: null });
    setName("");
    setInput("");
    setStereo(true);
    setBusy(false);
  };
  const create = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      const { track } = await addTrack("audio", {
        channels: stereo ? 2 : 1,
        ...(open.index !== undefined ? { index: open.index } : {}),
        ...(name.trim() !== "" ? { name: name.trim() } : {}),
      });
      if (input !== "") await setTrack(track.id, parseCaptureInput(input));
      close();
    })().catch((e) => {
      setBusy(false);
      showToast(e instanceof Error ? e.message : "Could not add the track", "error");
    });
  };

  return (
    <Modal open title="Add Audio Track" width={380} onClose={close}>
      <div className="aat-body">
        <label className="aat-row">
          <span>Name</span>
          <input
            className="aat-name"
            placeholder="Audio"
            value={name}
            data-autofocus
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </label>
        <div className="aat-row" role="radiogroup" aria-label="Channel configuration">
          <span>Channels</span>
          <div className="aat-seg">
            <button
              type="button"
              className={"btn" + (!stereo ? " primary" : "")}
              onClick={() => {
                setStereo(false);
                setInput(""); // channel encoding differs between mono and pairs
              }}
            >
              Mono
            </button>
            <button
              type="button"
              className={"btn" + (stereo ? " primary" : "")}
              onClick={() => {
                setStereo(true);
                setInput("");
              }}
            >
              Stereo
            </button>
          </div>
        </div>
        <label className="aat-row">
          <span>Input</span>
          <Select value={input} options={opts} width={240} onChange={setInput} />
        </label>
        <div className="aat-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={create}>
            Add Track
          </button>
        </div>
      </div>
    </Modal>
  );
}
