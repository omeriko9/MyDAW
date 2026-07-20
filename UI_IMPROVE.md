# MyDAW UI/UX Improvement Plan

*Scope: UI layer only (`ui/src`). No engine/backend changes assumed. Written 2026-07-20 after a full inventory of the shell, panes, interaction patterns, and CSS/animation surface.*

## How this plan is organized

Instead of a flat feature list, improvements are grouped by **user use case** — what a person is actually trying to do during a session. Each use case lists the current friction and one or more improvement options (options for the same problem are labeled **A/B/C** — they are alternatives, not a sequence; some are deliberately unconventional). A cross-cutting section covers the motion/micro-interaction system and personalization, and the last section ranks everything by *goodness delivered per user per session*.

Guiding observations from the audit that shape everything below:

1. **The UI is functionally deep but perceptually flat.** There are exactly 4 CSS transitions and 3 keyframes in the whole app. Nothing eases, lifts, glows, or springs. Feedback exists (color swaps, tooltips, toasts) but the app doesn't *feel* responsive the way modern web apps do.
2. **Power is hidden behind modifiers.** Ctrl+wheel zoom, Alt-drag copy, Shift bypass-snap, middle-drag pan, Ctrl/Alt-click loop locators, marquee union/xor — none of these have any on-screen affordance. A new user sees maybe 40% of what the app can do.
3. **Screen real estate is rationed by a single bottom dock slot** shared by Mixer, Piano Roll, Clip Editor, Sheet Music, and Visualizer. The pop-out escape hatch works but depends on browser popup permissions and OS window juggling.
4. **State that matters is invisible**: which pane owns the keyboard, whether undo has anything to undo, what zoom level you're at, what the current tool will do on click.

---

## Use case 1 — Navigating and arranging a large project

*The user has 30+ tracks, is jumping between song sections, moving/copying clips, and constantly zooming. This is the highest-frequency activity in any DAW session.*

### Friction today
- Zoom is **only** Ctrl/Alt+wheel or G/H keys. No visible zoom control, no zoom-level indicator, no "fit project" button in the arrange view.
- Follow-playhead does hard page-jumps.
- Getting to "bar 57, the bridge" means scrolling or using the minimap; markers exist but there's no fast jump UI.
- Track headers at 30+ tracks are a wall of identical rows; folders help but there's no overview-level navigation.

### Improvements

**1.1 — Navigator pill (Figma/Excalidraw-style zoom control).**
A small floating pill in the bottom-right of the arrange canvas: `[fit] [−] 100% [+]`, where the percentage is click-to-type and scrubbing on it zooms around the playhead. This is the standard solution every canvas web app converged on (Figma, Miro, Excalidraw, tldraw) and it doubles as the *discovery surface* for zoom — hovering it shows a tooltip teaching Ctrl+wheel / G/H. Same pill in Piano Roll and Clip Editor for consistency.

**1.2 — Jump palette (Cmd+K for the timeline).**
A command-palette-style overlay (`Ctrl+G` or `Ctrl+K`): type a bar number → jump; type a marker name → fuzzy-jump; type a track name → scroll to and select it. Web apps proved that fuzzy palettes beat any spatial navigation at scale (VS Code, Linear, Slack). For a DAW this is genuinely novel and cheap: markers, tracks, and bar math are all already in the store. This one control collapses three navigation problems into a single learned gesture.

**1.3 — Section-aware minimap.** The minimap already exists. Upgrade options:
- **A:** Render marker regions as labeled colored bands in the minimap so it reads like a song map ("Verse / Chorus / Bridge"), not just a clip thumbnail. Click a band → frame that section.
- **B (creative):** A **horizontal "song strip"** mode replacing the minimap: chapter-style segments like YouTube's chapter bar, built from markers. Hover a segment → floating preview label + downbeat; click → smooth-animated scroll there. Users already know this idiom from video players.

**1.4 — Smooth scroll & zoom animation (settings-gated: "Animated navigation").**
All programmatic viewport changes (F fit, follow-playhead page jump, minimap click, jump palette) animate over ~180ms with an ease-out instead of teleporting. Spatial continuity is the single biggest "this feels professional" upgrade for canvas apps, and it's purely a UI-side interpolation on the existing viewport store. Follow-playhead gets an optional **smooth-scroll mode** (playhead pinned at 30% width, canvas glides under it) as an alternative to page-jumping — both selectable in Settings.

**1.5 — Track overview rail (option, for very tall projects).**
A 16px-wide vertical strip left of track headers showing one 3px band per track (track color, dimmed when muted). Acts as a scrollbar+overview for the *vertical* axis the way the minimap serves the horizontal. Click to jump; the visible window is a translucent brush. Only appears past ~20 tracks.

---

## Use case 2 — Editing MIDI in the Piano Roll

*The user is drawing, moving, and quantizing notes for minutes at a time. Precision and rhythm of interaction matter more than anywhere else.*

### Friction today
- The mini-toolbar packs ~12 controls into one dense row of 18–24px targets.
- Marquee modes, alt-copy, middle-drag pan are invisible modifiers.
- Velocity editing is functional but pure-utilitarian.

### Improvements

**2.1 — On-canvas ghost hints (the discoverability fix, applies to Timeline too).**
While a modifier is *held*, show a transient hint chip near the cursor: hold Alt over a note → chip says "⧉ copy"; hold Shift while dragging → "snap off". Cursor changes accompany it. This is how Figma/tldraw teach modifiers — at the moment of use, not in a cheat sheet. Settings-gated ("Modifier hints: always / first 30 days / never") so experts can silence it.

**2.2 — Note-drag feedback with meaning.**
While dragging notes, show a floating readout by the cursor: `C#4 · +3 st · bar 5.2`. While resizing: length in beats. The engraving data is already computed. This is the difference between "moving rectangles" and "editing music."

**2.3 — Velocity editing options** (same use case, three alternatives):
- **A: In-note velocity bars.** Render velocity as a fill-level inside each note rectangle (Ableton-style) and allow Ctrl+vertical-drag directly on a note to set velocity without visiting the lane.
- **B: Velocity "heat" coloring** — notes tinted along a per-track color ramp by velocity, with the lane kept for precise edits. Cheap, purely visual, great for reading a performance at a glance.
- **C (creative): Curve tools in the lane** — instead of painting bars one-by-one, drag a ramp/S-curve/random-jitter tool across a selection (like easing-curve editors in motion-design tools such as Rive/After Effects web ports). One gesture shapes a crescendo.

**2.4 — Toolbar diet via progressive disclosure.**
Keep the 5 most-used controls (grid, snap, quantize, tool, audition) visible; fold scale settings, swing, strength, CC-lane choice into a popover ("⚙ Edit settings") that remembers open state. Dense toolbars are a cost paid on *every glance*, not just first run.

**2.5 — Micro-piano hover magnification.**
The 56px key column: on hover, keys near the pointer subtly scale/brighten (the macOS-dock effect the user mentioned — this is its best home in the app, since keys are small, adjacent, and clicked deliberately). Also show the note name on the hovered key. Settings-gated under the motion system (§8).

---

## Use case 3 — Mixing

*The user is balancing levels, panning, and shaping inserts across many channels — mostly small, repeated adjustments while listening.*

### Friction today
- Fader/knob adjustments give no readout beyond the small dB text; no fine-adjust affordance is advertised.
- Narrow-strip mode drops IO/inserts/sends entirely; the only density control is global wide/narrow.
- No way to see just "the strips I care about."

### Improvements

**3.1 — Value HUD on touch.**
The moment a fader/knob/pan is grabbed, show a large transient readout floating above the strip (`−3.2 dB`, `L 24`). Fine mode with Shift (0.1 dB steps) advertised in the HUD itself ("⇧ fine"). This mirrors what every good audio plugin UI does and costs almost nothing.

**3.2 — Channel spotlight (hover magnification, mixer edition).**
In narrow mode, the hovered strip (plus ~half-strip of its neighbors) smoothly widens toward wide-strip layout, revealing inserts/sends/IO, then collapses on leave — the dock-magnification idea applied where it genuinely buys information density, not just delight. Alternative **B:** hover shows a **hover card** (a floating mini-inspector with inserts/sends/IO) instead of animating layout — cheaper, no reflow of neighbors. Both settings-gated; default to B.

**3.3 — Mix views (saved strip filters).**
Chips above the strip rail: `All · Drums · Vocals · Buses · ★` — user-defined saved filters (by track color, folder, or manual pick) plus a star-favorites view. This is the Gmail-labels / Notion-views idiom applied to the mixer, and it's what makes 40-track mixing on one screen tolerable. (UI-only: filtering which strips render.)

**3.4 — A/B ear-training aid (creative, optional).**
A "snapshot chip" row in the mixer header: click 📷 to store the current *visual* fader/pan state as chip A, adjust, store B, then hover A/B to see ghost fader positions overlaid (thin outline at the stored position on each fader). Purely visual diffing of "what did I change since the last snapshot" — no engine state involved, just remembered UI values and ghost rendering. Solves the universal "what did I just touch?" mixing problem.

**3.5 — Room View promotion.** Room View (spatial pan modal) is a hidden gem. Give it a persistent toggle in the mixer toolbar with an icon and a first-use tooltip; consider a docked mini-room in the corner of the mixer as an option, since spatial panning is a differentiator worth surfacing.

---

## Use case 4 — Recording a take

*The user is performing. Their eyes are on an instrument, not the screen. Whatever the UI communicates must be readable from a meter away.*

### Friction today
- Recording state is a red toggle button and nothing else. Count-in exists but is quiet visually.
- Armed-track state is a small "R" glyph in headers.

### Improvements

**4.1 — Recording mode as a *state of the whole UI*, not a button.**
When recording: a 2px animated red border breathes around the arrange canvas; armed track headers get a pulsing red edge; the transport time display enlarges (or a large floating time+bar readout appears, position selectable). Count-in renders as a **full-canvas countdown flash** ("4 · 3 · 2 · 1" ghosted over the arrange view, beat-synced). All gated behind a "Performance mode visuals" setting. This is where boldness pays: nothing else in the app competes for attention at that moment.

**4.2 — Post-take toast with actions.**
When recording stops, a toast: "Take 3 recorded · 8 bars" with inline `[Keep] [Undo] [Open in Piano Roll]`. Action-toasts (the Gmail "Undo send" idiom) fit the moment perfectly — the user decides in 2 seconds without hunting for the clip.

**4.3 — Big Clock overlay (option).**
A borderless, click-through, resizable overlay showing bars·beats (and/or timecode), toggled from the View menu — the "presentation clock" every hardware-studio DAW has and web apps do with picture-in-picture idioms. Useful whenever hands are on instruments.

---

## Use case 5 — Browsing and auditioning (plugins, files, presets)

### Friction today
- The Browser is a competent list, but auditioning/choosing is where users spend real time and current interaction is dbl-click-and-see.

### Improvements

**5.1 — Hover cards for plugins.** Hover a plugin row ~400ms → card with vendor, format, category, bitness, blacklist status, and *recently used on: [track names]*. The Wikipedia/GitHub hover-card pattern; kills the need to widen the panel or click to learn.

**5.2 — Waveform previews inline.** File rows draw a small static waveform strip (the data path exists for clip rendering), with click-to-audition-from-position on the strip itself — SoundCloud's core idiom, universally understood.

**5.3 — Drag ghosts worth the name.** Dragging a plugin/file currently uses the browser default ghost. Custom drag images: a chip with icon+name for plugins, a mini waveform for files; drop targets get an animated pulse outline instead of a static highlight. DnD is one of the app's best features — make it *look* like it.

---

## Use case 6 — Working across panes (the layout problem)

*The user wants Piano Roll and Mixer at once, or arrange + clip editor. Today: one bottom dock slot, or OS pop-out windows.*

### Improvements (alternatives — pick a direction)

**6.1 — A: Split dock.** Allow the bottom dock to split horizontally into two slots (drag one dock tab to the right half — the VS Code editor-split gesture, which users already know). Each half keeps its own tab strip. Solves 90% of the multi-pane need with zero window management.

**6.2 — B: Dockable tabs anywhere (heavier).** Full drag-a-tab-to-any-edge docking (the JetBrains/Blender model). More flexible, much more work, and layout complexity becomes user-facing. Recommended only if A proves insufficient.

**6.3 — Layout presets.** Named layouts on number keys (`Ctrl+Alt+1..4`): "Arrange", "Mix", "Edit", "Perform" — each stores panel visibility/sizes/dock tab. DAW users context-switch constantly; every serious creative tool (Blender, Resolve, Cubase itself) ends up here. Since all layout state is already persisted in `prefs.ts`, this is mostly a matter of snapshotting/restoring that state with a smooth transition (§8).

**6.4 — Focused-pane clarity.** The pane with keyboard focus gets a subtle accent top-border (2px) and its per-pane tint at slightly higher strength. Right now Delete/Ctrl+A route by an *invisible* focus state — the single most dangerous invisible state in the app. Cheap, important, and it dovetails with the existing per-pane tint system.

---

## Use case 7 — Learning the app (first sessions and feature discovery)

### Friction today
- Vertical icon-only menu strip, modifier-heavy interactions, shortcut cheat sheet that drifts from `keyboard.ts`, no onboarding.

### Improvements

**7.1 — Command palette (`Ctrl+K`) — the umbrella fix.**
Fuzzy search over *every menu item and command*, showing its shortcut and executing it. This is the web-app pattern (Linear, Notion, Slack, GitHub) that solves discoverability, the icon-only menu strip, non-remappable shortcuts (you can always palette it), and "where was that setting" in one control. It can share infrastructure with the Jump palette (1.2) — one overlay, two modes. **If only one thing from this plan gets built, it should be this.**

**7.2 — Shortcut data as single source of truth.** Move bindings into a data table consumed by both `keyboard.ts` and `ShortcutsDialog` (killing the documented drift risk), and render shortcut hints in the palette/menus from the same table. This is also the prerequisite for user remapping later — but remapping itself is backend-ish scope; the *table* is pure UI hygiene.

**7.3 — Contextual "what can I do here?"** Press-and-hold `?` (or a small `?` button per pane) → a translucent overlay annotating the hovered pane's hotspots ("drag edge to trim · Alt-drag to copy · Ctrl+wheel to zoom"), keyed to the shortcut table. The keyboard-overlay idiom from Gmail/Trello, done spatially. Far better than a static dialog because it teaches *in place*.

**7.4 — Empty states that teach.** The Piano Roll already has one good empty state. Extend the pattern: empty project → arrange canvas shows three ghost-buttons ("Add audio track · Add instrument track · Import project"); empty mixer → "No tracks yet"; Browser Files empty → drop-zone illustration. Empty states are free real estate for onboarding.

---

## 8 — Cross-cutting: a motion & micro-interaction system

*This is deliberately a **system**, not scattered tweaks — one settings knob, consistent physics, `prefers-reduced-motion` respected everywhere.*

**8.1 — Motion tokens.** Add to `theme.css`: `--ease-out`, `--ease-spring`, `--dur-fast: 120ms`, `--dur-med: 180ms`, and a global `data-motion="full | reduced | off"` attribute driven by a Settings → General → "Interface motion" select (default: `full`, auto-forced to `reduced` when `prefers-reduced-motion` is set — currently the app ignores that media query entirely, an accessibility gap worth closing regardless).

**8.2 — The baseline layer** (applies everywhere, all cheap, all `transform`/`opacity`-only so canvas perf is untouched):
- Buttons/tabs/toggles: 120ms background/color ease on hover; 1px translate-down + slight darken on press ("physical" press).
- Toggle states (loop, metronome, follow, record-arm): a soft 200ms glow-in when engaging, not an instant swap — state *changes* deserve more emphasis than state *being*.
- Popovers/menus/hover-cards: 140ms scale-from-origin (0.96→1) + fade, like Radix/shadcn menus. Menus currently teleport in.
- Modals: 160ms fade + slight rise; overlay fades.
- Toasts already animate in — add an exit animation and a subtle progress ring for the auto-dismiss timer.
- Drop targets: animated dashed-outline "marching" pulse while a compatible drag is over them.

**8.3 — The delight layer** (settings-gated individually or by the motion knob; each maps to an earlier item): dock-tab / mixer hover magnification (2.5, 3.2), smooth viewport animation (1.4), recording pulse (4.1), meter "peak bloom" (a 300ms halo when a channel clips, making the clip latch findable), Save button success tick-morph after a save completes.

**8.4 — Hover magnification, done honestly.** The macOS-dock effect the user cited is best where (a) targets are small and adjacent, and (b) growth reveals *information*, not just size. Best homes found in the audit: piano-roll key column (2.5), narrow mixer strips (3.2), the collapsed Browser rail icons, and the vertical menu strip icons. **Not** recommended for the transport buttons (they're already adequately sized, and motion near the play button during playback is distraction, not delight).

---

## 9 — Cross-cutting: personalization (everything optional)

Consolidate the plan's toggles into **Settings → Appearance** (new tab, splitting from General):

| Setting | Options | Default |
|---|---|---|
| Interface motion | Full / Reduced / Off | Full (auto-Reduced via OS) |
| Hover magnification | On / Off | Off |
| Modifier hint chips | Always / Until dismissed / Never | Until dismissed |
| Follow playhead style | Page jump / Smooth scroll | Page jump |
| Performance-mode record visuals | On / Off | On |
| Velocity display | Lane only / In-note bars / Heat colors | Lane only |
| Accent color | 8 swatches + custom | Theme default |
| Pane tint strength | Off / Subtle / Strong | Subtle |
| UI density | Comfortable / Compact | Comfortable |

Accent color + tint strength are the cheap wins here: the CSS-variable theming contract already exists, so exposing `--accent` and a tint multiplier is nearly free and gives users the "my DAW" feeling that dark/light alone doesn't.

Also: replace the two remaining native `window.confirm` calls (Agent clear / YOLO) with the app's own `confirmDialog` — the last inconsistency in an otherwise unified dialog system.

---

## 10 — Prioritization (goodness per user per use case)

**Tier 1 — build first (high frequency × high impact):** *(all five SHIPPED 2026-07-20)*
1. ✅ **Command palette + jump palette (7.1, 1.2)** — one feature, solves discoverability, navigation, and the icon-menu learning curve at once. *(Ctrl+K; flattens the live menu builders + Transport/Tools groups; bar/marker/track jump with reveal.)*
2. ✅ **Motion system baseline (8.1–8.2)** — transforms perceived quality of *every* interaction; small, systematic, respects reduced-motion. *(--dur-fast/med/move tokens, data-motion full/reduced/off, Settings → General knob.)*
3. ✅ **Navigator pill + smooth viewport animation (1.1, 1.4)** — fixes the invisible-zoom problem. *(All three canvas panes: shared ZoomPill in arrange (+% + eased jumps), Piano Roll (+%), Clip Editor (Fit/−/+).)*
4. ✅ **Focused-pane indicator (6.4)** — removes the most dangerous invisible state (keyboard routing). *(2px accent strip on the pane Delete/Ctrl+A routes to.)*
5. ✅ **Value HUD on faders/knobs + note-drag readout (3.1, 2.2)** — precision feedback at the two highest-frequency edit points. *(Fader/Knob HUD with ⇧-fine hint; piano-roll drag chip with pitch/±st/position/length.)*

**Tier 2 — next (high impact, more work):**
6. ✅ Split dock (6.1) and layout presets (6.3). *(SHIPPED 2026-07-20: split button + per-half tab strips + draggable divider; Ctrl+Alt+1..4 apply / +Shift save, View → Layouts.)*
7. ◐ Modifier hint chips (2.1) + contextual `?` overlay (7.3) + shortcut single-source table (7.2). *(2.1 SHIPPED 2026-07-20 as drag HUDs in timeline + piano roll — position readout with live "copy"/"snap off" hints; the `?` overlay and shortcut table remain open.)*
8. Mix views / strip filtering (3.3).
9. ✅ Recording performance visuals + post-take action toast (4.1, 4.2). *(SHIPPED 2026-07-20: breathing red arrange frame gated by Settings toggle + motion level; post-take toast with Undo / Open-in-Piano-Roll actions.)*
10. Velocity display options (2.3 A or B).

**Tier 3 — differentiators & delight (worth doing, not urgent):**
11. Song-strip / marker minimap (1.3), hover cards (5.1), custom drag ghosts (5.3), waveform previews (5.2).
12. Hover magnification homes (8.4), accent/tint personalization (9).
13. Mixer A/B ghost snapshots (3.4), Big Clock (4.3), track overview rail (1.5), velocity curve tools (2.3 C).

**Deliberately out of scope** (corner cases / backend-coupled): shortcut *remapping* (needs persistence design — but 7.2 prepares it), touch/pinch gestures (no evidence of tablet users yet), full free-docking (6.2) unless split dock proves insufficient, undo/redo *availability* state (needs engine support to know `canUndo` — flagged for the backend pass, since the always-enabled undo buttons violate the app's own "no dead items" policy).
