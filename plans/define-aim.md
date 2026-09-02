# Plan: "Define Aim" — Target-Current Solver (sub-feature of Class-1 safety calculation)

## Context

The simulator (single-page app: `index.html` + `js/{constants,atmosphere,optics,receiver,safety,simulator}.js`) already has a Class-1 safety section (section 5) with:
- `applyClass1Solver()` — clamps drive current to max Class-1 compliant value
- `autoSolve()` — grid-searches optics presets × drive current for safest Class-1 setup that closes the link

New feature (branch `feat/define-aim`): **Define Aim** — iterate the calculation in the opposite direction. The user defines *target photocurrents* the receiver should see in given scenarios (distance + weather), plus a target spot profile at 200 m. The solver searches settings (drive current, optics, lenses) to hit those targets, subject to Class-1 compliance and a clean RX chain, and ranks candidates by physical efficiency and estimated part cost.

Default anchor targets (user-provided):
| Scenario | Target photocurrent |
|---|---|
| 200 m, fog (500 m vis) | 280 nA |
| 200 m, clear (23 km) | 5.93 µA |
| 5 m, clear (23 km) | 2.5 mA |

Spot target at 200 m: both sides **> 20 cm and < 40 cm**, side-to-side difference **≤ 10 %**.

Save/export must keep working: `snapshotValues()`/`decodeConfig()` iterate over the `inputs` map, so any new UI inputs registered there are persisted automatically.

## User decisions (resolved)

| # | Question | Decision |
|---|---|---|
| 1 | Anchor semantics | **Implement both modes** with a UI toggle: (a) *Exact Target Fit* (minimise log-error to all three anchors) and (b) *Dynamic Range Envelope* (hard bounds: 200 m fog ≥ 280 nA, 5 m clear ≤ 2.5 mA; 200 m clear is a soft nominal). |
| 2 | Fog preset | `fog` (500 m visibility). |
| 3 | Solver freedom | Drive current, optics mode, focal lengths, TX lens diameter, RX lens diameter, TIA gain / AGC. Fixed: diode (emitter size, λ), pulse protocol (width, rate, frame). |
| 4 | Spot @ 200 m | Hard constraint: both sides **> 20 cm and < 40 cm**, side-to-side difference **≤ 10 %** (so roughly circular). |
| 5 | Cost model | EUR, hardcoded lookup table in `js/aim.js`, display total in results. Prefer cheaper parts; cost is secondary to meeting targets. |
| 6 | UI placement | New collapsible sub-panel **inside section 5 (Safety)** directly under the *Auto: Find Safest Class-1 Setup* button. **Also** add a global sidebar collapse toggle so the whole left panel (sections 1‑6) can be retracted to the left. |

## Approach

### 1. New physics module `js/aim.js`

Pure, testable module (`Sim.Aim`) containing:

- **`DEFAULT_ANCHORS`** — 3 rows (distance, weather key, target current in A).
- **`COSTS`** — EUR price lookup (`diode`, `facLens`, `lensTx` by Ø mm, `anamorphicPair`, `lensRx` by Ø mm, `filter` by BW nm, `tia`, `agcCircuit`).
- **`totalCost(p)`** — sums parts for a given parameter bundle.
- **`checkSpot(p, tx)`** — uses `Sim.Optics.spotAtDistance(..., 200)` and validates:
  - `w ∈ [0.20, 0.40] m`, `h ∈ [0.20, 0.40] m`
  - `|w − h| / max(w, h) ≤ 0.10`
- **`evalCandidate(pBase, anchors, mode)`** — builds a full param set, computes TX beam, rejects immediately if spot fails or Class-1 `worstRatio > 1`. Then evaluates every anchor with `Sim.Receiver.linkBudget` + `evalChain`; rejects if any chain is not clean. Computes a score:
  - **Exact Fit:** `score = −RMSE_log − cost·0.01` (accuracy dominates).
  - **Envelope:** `score = −penalty·10 000 − nomError·100 − cost·0.01` where penalty is log-distance from bounds.
- **`solve(pBase, anchors, mode, onProgress, onResult)`** — batched grid search:
  1. Enumerate **optics configs** (`mode` × focal combos × `dMainMm`). For each, run `computeTxBeam` + `checkSpot`; keep only passing configs.
  2. For every passing config, iterate `dRxMm` (5 values) × `iForward` (11 values: 0.3 … 8.0 A) × gain modes (5: 4 manual gains + 1 AGC target).
  3. Evaluate full safety + RX chain for each candidate; track best score.
  4. Batched via `setTimeout(step, 0)` (32 candidates / batch) with progress % callback.

Grid size ≈ 10–20 passing optics configs × 5 × 11 × 5 ≈ **5 000–12 000 candidates** — fast enough for a responsive UI.

### 2. UI changes in `index.html`

**Inside section 5 (Safety)** after `btnAutoSolve`:
- New `.control-group` with `h3` "Define Aim — Target Current Solver" (collapsible via existing `initCollapsibles()`).
- Mode toggle `<select id="aimMode">` (exact / envelope).
- Anchor table (3 fixed rows):
  ```
  | Dist (m) | Weather       | Target | Unit |
  | 200      | fog (500 m)   | 280    | nA   |
  | 200      | clear (23 km) | 5.93   | µA   |
  | 5        | clear (23 km) | 2.5    | mA   |
  ```
  Each cell is an `<input>` or `<select>` with IDs (`aimDist1`, `aimWeather1`, `aimTarget1`, `aimUnit1`, etc.).
- `<button id="btnDefineAim" class="solver-btn">Define Aim: Find Setup</button>`
- `<div id="aimStatus">` for progress / messages.
- `<div id="aimResults" style="display:none">` containing:
  - Applied optics, current, RX lens, gain
  - Spot size at 200 m (`w × h` cm, aspect ratio)
  - Total estimated cost (EUR)
  - Per-anchor table: actual current vs target, weather, distance
  - Class-1 margin, chain verdict
  - `<button id="btnApplyAim">Apply to Simulator</button>`

**Global sidebar collapse**:
- Add `<button id="sidebarToggle">` inside `.sidebar-header` (arrow icon).
- Add a second floating `<button id="sidebarExpand">` fixed to the left edge, visible only when sidebar is collapsed.
- Toggle `.sidebar-collapsed` class on `.app-container`.
- Persist state in `localStorage` key `sim-sidebar-collapsed`.

### 3. Wiring in `js/simulator.js`

- Register new inputs in the `inputs` map (`aimMode`, `aimDist1/2/3`, `aimWeather1/2/3`, `aimTarget1/2/3`, `aimUnit1/2/3`). This automatically includes them in save/export (`snapshotValues` / `decodeConfig`).
- Event listeners: `btnDefineAim` → read anchors from DOM, call `Sim.Aim.solve(...)` with progress callback updating `aimStatus`, result callback populating `aimResults`.
- `btnApplyAim` → call `applyConfigValues(aimWinner.p)` (the existing helper already handles all registered inputs and triggers `updateSimulation`).
- Sidebar toggle: read `localStorage`, set initial class, handle click, store state.

### 4. Styles in `style.css`

- `.aim-table` — compact grid, same font tokens as `.safety-table`.
- `.aim-results` — stat boxes for cost, spot, margins.
- `.sidebar.collapsed` / `.app-container.sidebar-collapsed` — transition `width`, `padding`, `opacity` to 0; floating expand button styling.
- Ensure responsive rules (`@media max-width: 1100px`) still work when sidebar is collapsed.

### 5. Tests in `test/verify.js`

Add Node checks:
- `Sim.Aim.checkSpot` — known config (`fac`, 100 mm, 18 mm) passes/fails correctly.
- `Sim.Aim.totalCost` — FAC + 18 mm TX + 5 mm RX + 370 nm filter = expected EUR.
- `Sim.Aim.solve` exact mode — returns a candidate (`best !== null`), score is finite, spot ok.
- `Sim.Aim.solve` envelope mode — returned candidate satisfies `iSignal_fog ≥ 280 nA` and `iSignal_5m ≤ 2.5 mA` (or reports infeasible if truly impossible with this diode).

## Files to modify

- `index.html` — new UI (anchor table, Define-Aim button, results panel), script tag for `aim.js`, sidebar toggle buttons
- `js/aim.js` — NEW: solver, cost table, scoring
- `js/simulator.js` — wire up inputs/events, apply-winner, results rendering, sidebar toggle
- `style.css` — styles for anchor table / results / sidebar collapse
- `test/verify.js` — solver regression checks

## Reuse

- `Sim.Optics.computeTxBeam(p)` — TX beam for any candidate param set
- `Sim.Optics.spotAtDistance(p, tx, distM)` — spot geometry
- `Sim.Receiver.linkBudget(p, tx, distM)` — photocurrent `iSignal` per anchor
- `Sim.Receiver.evalChain(p, rx)` — clean-chain check
- `Sim.Safety.classify(p, tx)` / `solveMaxClass1` — Class-1 constraint
- `Sim.Atmosphere.WEATHER_PRESETS` — anchor weather choices
- `autoSolve()` batching pattern (`setTimeout(step, 0)`) in `simulator.js`
- Save/export: `snapshotValues()`, `applyConfigValues()`, `encodeConfig()` — automatic once inputs are registered in the `inputs` map
- Existing `initCollapsibles()` handles per-section collapse; we add global sidebar collapse on top.

## Steps

- [ ] `js/aim.js`: `COSTS`, `totalCost`, `checkSpot`, `evalCandidate`, `solve`
- [ ] `index.html`: new script tag, Define Aim sub-panel (mode, table, button, results), sidebar toggle buttons
- [ ] `style.css`: `.aim-table`, `.aim-results`, sidebar collapse transitions + floating expand button
- [ ] `js/simulator.js`: register new inputs, wire `btnDefineAim`/`btnApplyAim`, sidebar toggle logic
- [ ] `test/verify.js`: checks for `checkSpot`, `totalCost`, `solve` in both modes
- [ ] Verify end-to-end in browser: run solver → apply → save → reload → export/import → identical settings

## Verification

- `node test/verify.js` passes (existing + new checks)
- Browser: run Define Aim with defaults → applied setup reproduces the three anchor currents (within tolerance), spot 20–40 cm @200 m, Class 1 holds, chain clean
- Save the resulting config, reload page, load it, export/import share code → identical settings
- Sidebar collapse toggle works, persists across reloads, responsive layout adapts
