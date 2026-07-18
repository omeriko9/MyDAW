# common/ — design system reference (F4)

Import the theme ONCE from App: `import "./lib/theme.css";` (resets live in `theme-base.css`,
already imported by main.tsx). All components below: `import { X } from "./components/common/X";`
No deps beyond react/react-dom.

## Components

- **Icon** (`icons.tsx`) — `<Icon name="play" size={16} />` inline 16x16 SVG, stroke 1.5, currentColor; ~48 names + aliases (see list below), `ICON_NAMES` exported.
- **IconButton** — `<IconButton icon="trash" tooltip="Delete" onClick={...} active danger size={24} />` square icon button, delayed tooltip, `active` lights accent via `[data-on]`.
- **Toggle** — `<Toggle on={mute} onChange={...} variant="danger">M</Toggle>` toggle button (`.btn-toggle`); variants accent|danger|warn|ok recolor the lit state (use danger=rec/mute, warn=solo, ok=monitor).
- **Knob** — `<Knob value={pan} min={-1} max={1} bipolar label="Pan" format={v=>...} onChange={transient} onCommit={final} />` vertical drag (Shift=fine), dbl-click reset, wheel, Esc cancels; caption shows value while hovered/dragging.
- **Fader** — `<Fader value={track.volume} onChange={transient} onCommit={final} height={140} />` value is LINEAR gain; dB taper `db = pos*72-60` (0 dB marker at 0.833); dbl-click=0 dB, wheel ±1 dB, Shift=fine. Helpers exported: `gainToDb/dbToGain/gainToPos/posToGain/gainToDbText`.
- **Meter** — `<Meter getLevels={() => metersBus.last?.tracks[id] ?? null} />` canvas peak/RMS meter, pulls per frame (only while visible), peak-hold line, clip latch (click resets), green/yellow/red at -12/0 dB; `horizontal` for mini meters, `channels={1}` mono.
- **NumberDrag** — `<NumberDrag value={bpm} min={20} max={300} step={0.5} precision={1} units="BPM" onChange={...} onCommit={...} />` drag vertically (Shift=fine), dbl-click to type (Enter/blur commit, Esc cancel), wheel steps.
- **Select** — `<Select value={v} onChange={setV} options={[{value:"a",label:"A",group?:"Grp"}]} width={120} />` styled native select (`.select`), optgroups via `group`.
- **TextInput** — `<TextInput value={name} onCommit={rename} placeholder="Track name" />` commit-on-Enter/blur, Esc reverts (rename ergonomics); plain live mode with just `onChange`.
- **Tooltip** — `<Tooltip content="Snap to grid"><button .../></Tooltip>` delayed (500ms) title-like tooltip, viewport-clamped; child must be a single element.
- **ContextMenu** — imperative: `openContextMenu(e.clientX, e.clientY, items)` / `closeContextMenu()` / `contextMenuHandler(() => items)` for onContextMenu props. Items: `{label, icon?, shortcut?, disabled?, danger?, checked?, submenu?, onClick?}` or `"separator"`. Keyboard nav + submenu flip + viewport clamp built in.
- **Modal** — `<Modal open={o} onClose={...} title="Audio Settings" footer={<><button className="btn">Cancel</button><button className="btn primary">OK</button></>} width={520}>...</Modal>` portal, Esc/overlay close, focus trap-lite.
- **Tabs** — `<Tabs tabs={[{id:"mixer",label:"Mixer",icon:"mixer"}]} active={tab} onChange={setTab} right={<IconButton .../>} />` controlled tab bar only (render content yourself); arrow-key nav.
- **Resizer** — `<Resizer dir="v" onResize={(delta,total)=>setW(w=>w+delta)} onReset={...} />` 5px invisible drag handle between panels; `dir:"v"`=col-resize (x deltas), `"h"`=row-resize (y deltas); positive = right/down; dbl-click → onReset.
- **VirtualList** — `<VirtualList itemCount={n} itemHeight={22} renderItem={i => <Row .../>} scrollToIndex={sel} />` fixed-row-height windowed list (plugin registry / file lists); fills parent height by default.

## lib/canvas.ts

- `useCanvas(onResize?)` → `{ ref, ctxRef, ctx, size }` — dpr-aware canvas; attach `ref` to `<canvas>` sized by CSS; draw in CSS pixels (transform pre-applied). `onResize(ctx,size)` for static redraw.
- `rafLoop(fn, win?)` → unsubscribe; shared RAF loop per window, pauses when that window is hidden. Canvases in a popped-out window pass `canvas.ownerDocument.defaultView`. Hook form `useRafLoop(fn, active, win?)`.
- `crisp(v)` half-pixel snap; `lineH/lineV(ctx,...)` crisp 1px lines; `roundRect(ctx,x,y,w,h,r)` path.
- `TRACK_COLORS` (12 hex) + `trackColor(index)` — mirrors `--track-color-1..12`.

## Theme (lib/theme.css)

CSS vars: `--bg --panel --panel2 --panel3 --border --border-light --text --text-dim --text-faint
--accent --accent-hover --accent-soft --danger --danger-soft --warn --warn-soft --ok --ok-soft
--meter-green --meter-yellow --meter-red --selection --playhead --shadow --shadow-sm --radius
--radius-sm --track-color-1..12` (camelCase aliases exist for `--textDim --meterGreen --meterYellow --meterRed`).

Utility classes: `.row .col .gap0/1/2/3 .grow .dim .faint .mono .ellipsis .panel
.btn .btn.primary .btn.danger .btn-icon .btn-toggle` (lit via `data-on="true"`, variant via
`data-variant="danger|warn|ok"`), `.input .select .badge(.accent/.danger/.warn/.ok) .tabs .tab`.
Range inputs (`<input type="range">`) are restyled globally. Scrollbars + `:focus-visible` ring global.

## Icon names

play stop record pause loop metronome magnet(snap) undo redo save export plus trash x(close) check
pencil eraser pointer scissors(split) glue chevronUp chevronDown chevronLeft chevronRight folder
audioWave midiNote piano mixer sliders plug(plugin) power(bypass) search settings(gear) warning
error refresh lock zoomIn zoomOut marker(flag) mic headphones mute solo dot dragHandle
snowflake(freeze) link(relink)
