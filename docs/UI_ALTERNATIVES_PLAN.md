# UI shell alternatives — plan

Status: **SHIPPED 2026-08-01** (M0+M1+M2 in one pass — `ui/src/shell/`). Two alternative
ways to *organize* the UI. The panes themselves (Timeline, Piano Roll, Mixer, Clip
Editor, Sheet Music, Visualizer, Browser tabs, Agent panel) are **not changed** — only
how they are reached and arranged. The user switches between all three shells from the
UI at any time (View → UI Mode / Settings → General / Ctrl+Alt+M cycle), and each shell
persists its own arrangement (`ui.shellMode`, `ui.shell.ribbon`, `ui.shell.workspaces`)
so switching is lossless.

Deliberate v1 deviations from the plan below (each noted here rather than silently):
- Ribbon: TransportBar stays a full-width row below the ribbon rather than a compact
  in-ribbon cluster (§2.1) — still always visible in every category, less risk.
- Ribbon groups reuse whole existing menu builders (Edit/Project/Audio/MIDI/View/Help
  via the exported `MENUS`) instead of hand-picked per-view controls; pane-local
  toolbars (quantize etc.) stay in the panes, as the panes-unchanged contract requires.
- Workspaces: Browser/Agent flags stay GLOBAL (`panels.browser/agent`), not
  per-workspace (§3.1) — the View-menu toggles keep one meaning in every shell.
- Workspace switching is **Alt+1..9**, not Ctrl+1..9 — Chrome owns Ctrl+digit.
- The agent catalog kept its 14 ui/* ops (no new `ui/shell.set`); `ui/layout.set`'s
  `bottomTab` maps through `shell/reveal.revealPane` in non-classic shells (§3.5).

Verified: ui vitest 415/415 (incl. `shell/shellTypes.test.ts`), ui-smoke 22/22 (new
`shell-modes` walks Classic → Ribbon → Workspaces → Classic through each shell's own
switcher), gate green. SPEC §9 gained the shells bullet.

Complementary docs: SPEC §9 (layout contract), UI_IMPROVE.md (split dock §6.1,
layout presets §6.3), docs/UI_TEST_SUITE.md (ui-smoke).

---

## 0. What we have today ("Classic" shell)

`ui/src/App.tsx` hard-codes one composition (SPEC §9):

```
┌──────────────────────── MenuBar ─────────────────────────────┐
├──────────────────────── TransportBar ────────────────────────┤
│ Browser │           Timeline (center, privileged)  │  Agent  │
├───── bottom dock: 1–2 of Mixer/PianoRoll/ClipEditor/... ─────┤
└──────────────────────── StatusBar ───────────────────────────┘
```

Facts the alternatives must respect (all verified in code):

- **Pane inventory** — dock panes: `mixer`, `pianoRoll`, `clipEditor`, `sheetMusic`,
  `visualizer` (`DOCK_TABS`, App.tsx). Center pane: `Timeline` (always mounted, the only
  pane that cannot currently move). Side panels: Browser (tabs `plugins`/`files`/
  `inspector`, `panels.browserTab`) and Agent. Overlays (DialogsHost, SettingsDialog,
  PluginEditorHost, BigClock, palette) are shell-independent and stay mounted as-is.
- **State**: `PanelsState` in `store.ts` (`browser`, `browserTab`, `bottomTab`,
  `bottomTab2`, `bottomTabPrev`, `poppedOut`, `minimap`, `agent`, `bigClock`), persisted
  via prefs. Sizes (`browserW`, `dockH`, `agentW`, `dockSplit`) are App-local pref state.
- **Invariants**: `bottomTab2 !== bottomTab` (selecting the other half's tab swaps
  halves); each pane is **single-instance** — never render the same pane twice at once
  (pop-out portals + the dock placeholder already enforce this).
- **Pop-outs**: any dock pane can portal into its own browser window
  (`usePopoutWindow` + `createPortal`); the portal render loop at the bottom of App.tsx
  is independent of the dock — it must survive in every shell.
- **Keyboard routing**: `focusedPane` is set by pointerdown on each pane root and routes
  G/H zoom + edit shortcuts (`lib/keyboard.ts`); the key-routing indicator must mirror
  whatever container is active (learned the hard way with `bottomTab2` — see memory
  note in UI_IMPROVE work). Shells change *containers*, not this mechanism.
- **Layout presets** (Ctrl+Alt+1..4, `lib/layouts.ts`) snapshot the *classic* panel
  shape. They stay classic-only in v1 (see §4 open questions).
- **Agent surface**: `ui/layout.set` (catalog) patches `panels` fields. It keeps
  meaning "the classic shell's panels"; in other shells the executor maps what it can
  (see §3.5).
- **Tests**: `scripts/ui-smoke.mjs` drives the classic layout via the store. Default
  shell stays `classic` so the gate is untouched until each shell gets its own checks.

---

## 1. Shared infrastructure (prerequisite for both alternatives)

One refactor enables everything, with zero behavior change on its own:

### 1.1 `shellMode` — the 3-way switch

- Store: `shellMode: "classic" | "ribbon" | "workspaces"` on the UI store, persisted
  (`ui.shellMode` pref), default `"classic"`.
- **Switcher UI (the hard requirement)** — reachable in *every* shell:
  - View menu → **UI Mode** submenu with three radio items (Classic / Ribbon /
    Workspaces). In the Ribbon shell this lives in the View ribbon tab; in the
    Workspaces shell, on the activity bar's gear button.
  - Command palette (Ctrl+K): "UI Mode: Classic / Ribbon / Workspaces" (the palette
    flattens `MENUS`, so the menu entries surface there for free).
  - Settings → General: the same three-way choice, with one-line descriptions.
  - Optional shortcut: `Ctrl+Alt+M` cycles modes (announce via the action toast).
- Switching is instant and lossless: each shell persists its own arrangement under its
  own pref namespace (`ui.panels.*` stays classic's; `ui.shell.ribbon.*`,
  `ui.shell.workspaces.*` are new), so A → B → A restores exactly what A looked like.

### 1.2 Extract from App.tsx into `ui/src/shell/`

- `shell/paneRegistry.tsx` — the single pane table: id → `{ label, icon, component,
  popoutDef }` for the 5 dock panes **plus `timeline`** (Timeline becomes a registered
  pane so non-classic shells can tile it; classic keeps it pinned center). `renderPane`,
  `DOCK_TABS`, `POPOUT_DEFS` collapse into this.
- `shell/PaneHost.tsx` — wraps a pane in `PanelBoundary` + the popped-out placeholder
  logic (extracted from `renderDockHalf`).
- `shell/PopoutHost.tsx` — the portal loop + `usePopoutWindow` instances, mounted once
  in App regardless of shell (pop-outs work identically in all three).
- `shell/ClassicShell.tsx` — today's App.tsx body, moved verbatim.
- App.tsx becomes: global effects (ws connect, keyboard, title, drop guards, recovery,
  offline overlays) + always-mounted hosts + `{shellMode === … ? <RibbonShell/> : …}`.

Pane components are **not touched**. Remount-on-switch is acceptable: pane view state
already lives in the store/prefs (viewports, active clip, follow), which is why
pop-outs and the split dock already work. (Visualizer rebuilds its WebGL context on
remount — it already does on tab switch today.)

---

## 2. Alternative A — **Ribbon shell**

Office-style ribbon replacing MenuBar + the dock tab strip as the primary navigation.
One ribbon **category per main view** plus File/View categories; selecting a category
both (a) makes that view the primary pane and (b) fills the ribbon strip with that
view's own options. Below the ribbon, the work area is a **splitter** that can show two
panes side by side (horizontal or vertical).

```
┌ File │ Arrange │ Edit │ Mix │ Score │ Visualize │ View ──── [transport cluster] ┐
│  ┌──────────── contextual groups for the active category ─────────────┐        │
│  │ Snap/Grid  │ Tools      │ Track ops   │ Panels      │  (Arrange)   │        │
├──┴────────────┴────────────┴─────────────┴─────────────┴──────────────┴────────┤
│ Browser* │        Primary pane        ║   Secondary pane (optional)   │ Agent* │
├────────────────────────────── StatusBar ───────────────────────────────────────┤
```
`*` Browser/Agent stay optional side panels, toggled from the View group. `║` is the
movable splitter; orientation flips between vertical (side-by-side) and horizontal
(stacked).

### 2.1 Ribbon categories

| Category | Primary pane | Contextual groups (all EXISTING commands, no new features) |
|---|---|---|
| **File** | (none — menu) | Office-style backstage or plain dropdown: today's File menu verbatim (New/Open/Save/Import/Export/Recreate/Settings/Exit). |
| **Arrange** | Timeline | Snap/grid selector, toolbox tools, track add/duplicate, punch/loop toggles, minimap toggle, zoom pills. |
| **Edit** | Piano Roll | Quantize, scale highlight, velocity display, CC lane picker, MIDI functions (today's piano-roll toolbar + Edit-menu items). |
| **Mix** | Mixer | View width/narrow strips, sends/EQ/insert section toggles, VCA assign, Room View, loudness/export audio. |
| **Score** | Sheet Music | Print, MusicXML export, follow-playhead, zoom. |
| **Visualize** | Visualizer | Its mode/style controls. |
| **View** | (keeps current primary) | UI Mode (the 3-way switch!), theme, layouts, Browser/Agent/Big Clock/dock toggles, shortcuts, quick help. |

- Clip Editor is not a category: it opens as the **secondary pane** on audio-clip
  double-click (same flow that focuses the dock tab today), and is pickable in either
  slot. Rationale: 7 top-level categories is the ribbon readability ceiling.
- Ribbon buttons call the **same handlers** as MenuBar/palette — implementation reuses
  the exported `MENUS` items (the palette already proves they're callable
  data-driven) plus each pane's existing toolbar actions where they're already
  extracted; where a control is currently inline-only (e.g. piano-roll quantize), v1
  simply *doesn't* lift it into the ribbon (the pane keeps its own toolbar — panes are
  unchanged by contract). Lifting toolbars into the ribbon is a later polish item.
- The **transport cluster** (play/stop/record, position, tempo) is pinned at the
  ribbon's right on every category — transport must never be a click away. Implemented
  by keeping TransportBar mounted, restyled compact, inside the ribbon row; StatusBar
  stays at the bottom. Double-height ribbon on narrow windows.

### 2.2 The split work area

- `shell/SplitPane.tsx` — generalization of today's split dock: two slots, each with a
  pane picker (all 6 registered panes incl. Timeline), a draggable splitter
  (fraction-persisted like `dockSplit`), an **orientation toggle**
  (vertical/horizontal), a swap button, and close-secondary. Single-instance invariant:
  picking the other slot's pane swaps them (exact `setHalfTab` semantics).
- Selecting a ribbon category sets the **primary** slot's pane; the secondary slot is
  sticky (stays whatever the user chose) — so "Mixer + Piano Roll side by side while
  the ribbon shows Mix options" is the natural resting state the user asked for.
- Browser (left) and Agent (right) remain optional flanking panels with the same
  Resizer + rail behavior — code reused from ClassicShell.

### 2.3 Persistence (`ui.shell.ribbon.*`)

`{ category, primaryPane, secondaryPane|null, orientation: "v"|"h", splitFraction,
browser, browserTab, agent, sizes }`.

### 2.4 Why this shape

- Discoverable: every top-level workflow ("I want to mix") is one labeled click; the
  contextual strip surfaces commands that today hide in menus/toolbars.
- Cheap: navigation chrome only. Reuses MENUS, TransportBar, Resizer, split-dock
  semantics, popouts, pane components — the only genuinely new widgets are the ribbon
  strip and SplitPane.

---

## 3. Alternative B — **Workspaces shell** (builds on A's infrastructure)

Blender/Studio One-style: the UI is a set of **named workspaces**; each workspace is a
saved **tiling arrangement** of panes. A slim strip (top) or activity bar (left) lists
them; `Ctrl+1..9` switches. Where the Ribbon shell asks "which view am I in?", this one
asks "which *task* am I doing?" — and unlike classic layout presets, workspaces are the
primary navigation, auto-persist every tweak, and can tile *any* pane anywhere
(Timeline is just a tile).

```
┌ MenuBar (unchanged) ─────────────────────────────────────────────┐
├ TransportBar (unchanged) ────────────────────────────────────────┤
├ ▸ ARRANGE ▾ MIX ▾ EDIT ▾ SCORE ▾ + ────────────────── [gear] ────┤
│ ┌───────────────────────────┬────────────────────────┐           │
│ │         Timeline          │        Mixer           │  ← tiles  │
│ ├───────────────────────────┴────────────────────────┤           │
│ │                     Piano Roll                     │           │
│ └────────────────────────────────────────────────────┘           │
└ StatusBar ───────────────────────────────────────────────────────┘
```

### 3.1 Workspace model

```ts
type Tile = { pane: PaneId } | { dir: "row"|"col"; ratio: number; a: Tile; b: Tile };
interface Workspace { id: string; name: string; root: Tile;
                      browser: boolean; browserTab: BrowserTab; agent: boolean; }
```
- Recursive binary split (SplitPane from §2.2 applied recursively), **max 4 leaf
  panes** — beyond that a DAW turns into an airplane cockpit; the cap also bounds
  remount/perf cost. Single-instance invariant holds *within* a workspace (the pane
  picker greys out panes already tiled); different workspaces freely reuse panes.
- Tile chrome per leaf: pane picker, split-h, split-v, pop-out (reuses PopoutHost; a
  popped-out pane shows the placeholder in its tile), close (neighbor absorbs the
  space). Splitters drag-resize `ratio`.
- Stock workspaces seeded on first run: **Arrange** (Timeline solo), **Mix**
  (Mixer solo), **Edit** (Timeline over Piano Roll), **Score** (Sheet Music). `+` adds,
  right-click renames/duplicates/deletes/reorders. All edits auto-save (no explicit
  "save layout" step — that's the preset-vs-workspace difference).
- MenuBar and TransportBar are kept verbatim (this shell replaces only the middle),
  which keeps it strictly cheaper than the Ribbon shell to build once §1 + SplitPane
  exist.

### 3.2 Switching & routing

- Click, `Ctrl+1..9`, and palette entries ("Workspace: Mix"). Last-used workspace
  persists. `focusedPane` keeps working unchanged — pointerdown on any tile's pane
  root sets it; the key-routing indicator reflects it as today.
- Timeline-as-a-tile checks: `followPlayhead`, minimap, and drop targets are Timeline-
  internal and don't assume center placement (they operate on the pane's own DOM);
  audit `focusedPane` *defaults* ("timeline") for workspaces that don't contain it.

### 3.3 Persistence (`ui.shell.workspaces.*`)

`{ workspaces: Workspace[], activeId }` with a shape validator like `layouts.ts`'s
(malformed storage → reseed stock workspaces).

### 3.4 Why this shape

- It is the power-user complement to A: A optimizes discoverability (labeled
  categories, surfaced options), B optimizes flow (zero-chrome task switching,
  arbitrary tiling). Both stand on the same SplitPane + registry + shellMode base, so
  B is mostly the tiling tree + the strip.

### 3.5 Agent compatibility (both shells)

`ui/layout.set` stays classic-vocabulary. Executor mapping elsewhere: `bottomTab` →
Ribbon: set secondary pane / Workspaces: focus-or-tile that pane in the active
workspace; `browser`/`agent`/`browserTab` → same-named flags in the active shell's
state. Unmappable fields no-op with an honest reply note. A `ui/shell.set {mode}` op is
added to the catalog so the agent can drive the 3-way switch too (counts bump ×3 as
usual).

---

## 4. Delivery plan

- **M0 — shell plumbing** — DONE 2026-08-01 (no visible change): §1 extraction, `shellMode` store/pref,
  switcher UI (menu radio + palette + Settings + `Ctrl+Alt+M`), ClassicShell move.
  Gate must stay green untouched; add a smoke check: flip `shellMode` through all
  three values via the store and assert the shell root `data-shell` attribute (ribbon/
  workspaces roots may be placeholders until M1/M2 land) and that flipping back
  restores classic panels intact.
- **M1 — SplitPane + Ribbon shell** — DONE 2026-08-01: SplitPane first (unit-testable alone), then the
  ribbon strip (categories from the table in §2.1, reusing MENUS items), compact
  transport cluster. Smoke: switch to ribbon, click Mix, assert Mixer is primary;
  open a secondary pane, flip orientation, drag splitter, switch category, assert the
  secondary stayed; pop out and dock back.
- **M2 — Workspaces shell** — DONE 2026-08-01: tiling tree + strip + stock workspaces, reusing SplitPane
  recursively. Smoke: seed check, split a tile, switch workspaces, assert per-workspace
  arrangement isolation, pane-picker greys duplicates.
- Each milestone ends per the standing quality bar: builds green, `node scripts/gate.mjs`
  green, SPEC §9 extended with the shell contract, this doc's status lines updated.

### Open questions (decide at M1/M2 start, defaults proposed)

1. Layout presets (Ctrl+Alt+1..4) in non-classic shells — default: classic-only in v1;
   Workspaces makes them largely redundant.
2. Ribbon File category: full Office "backstage" page vs. plain dropdown — default:
   plain dropdown (backstage is a lot of chrome for 14 items).
3. Does the Ribbon shell keep the split dock's `bottomTabPrev`-style "remember what was
   closed" behavior for the secondary slot — default: yes (sticky secondary, §2.2).
4. `Ctrl+Alt+M` cycle vs. direct-select only — default: ship the cycle, it's one toast.

### Risks

- **Ribbon width** on small windows: 7 categories + transport cluster → overflow menu
  for trailing categories (standard ribbon behavior), double-height fallback.
- **Remount churn** when switching shells/workspaces: acceptable (state is in the
  store), but don't animate shell switches — swap instantly to hide the churn.
- **Keyboard-routing regressions**: every new container must register/propagate
  `focusedPane` exactly like the dock halves do (this bit us in UI_IMPROVE §6.1).
- **Pref migration**: none needed — classic's prefs are untouched; new namespaces only.
