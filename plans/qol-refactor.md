# QoL Refactor: Deduplication, Emoji Removal, Program Structure

Branch: `feat/qol-refactor`. No physics changes — all tests in `test/verify.js` must keep passing (converted to emoji-free output) plus `node --check` on all JS files.

## 1. Unify duplicate code

### 1a. Fault-mode evaluation (4 copies → 1)
The pattern "evaluate normal + single-fault condition, take the worst" is copy-pasted in:
- `simulator.js updateSimulation()` (~10 lines)
- `simulator.js applyClass1Solver()`
- `simulator.js evalAutoCandidate()`
- `aim.js evalCandidate()` (re-implements `effCurrent` inline with its own DIODE logic)

**Fix** — add to `js/safety.js`:
```js
Sim.Safety.faultCurrentA(p)        // effective drive current under fault (replaces simulator's effCurrent)
Sim.Safety.classifyWithFault(p, tx) // → { pFault, txFault, normal, fault, worstIsFault, worst, view, pWorst, txWorst }
```
All four call sites use it; `effCurrent()` in simulator.js and the inline fault logic in aim.js are deleted.

### 1b. Batched async grid search (2 copies → 1)
`autoSolve()` (simulator.js) and `Aim.solve()` (aim.js) both implement the same `setTimeout`-batched iteration with progress callbacks.

**Fix** — new small module `js/search.js`:
```js
Sim.Search.run(items, visit, { batchSize, onProgress, onDone })
```
`visit(item)` is called per item; callers keep their own best-result tracking. Both solvers rewritten to use it. Loaded before `aim.js` in index.html and added to the test harness file list.

### 1c. Control-visibility toggles (3 copies → 1)
AGC visibility toggle appears in the `agcMode` listener, `applyConfigValues()`, `applyAimWinner()`; weather-custom visibility in `applyValues()` + listener.

**Fix** — single `refreshControlUI()` (optics mode + AGC + weather visibility) used by presets, config apply, aim apply, and the change listeners.

### 1d. Weather `<select>` options (4 HTML copies → 1 JS source)
`weatherPreset`, `aimWeather1/2/3` hardcode the same 6 options (~60 lines of HTML).

**Fix** — empty selects in index.html; populated at init from `Sim.Atmosphere.WEATHER_PRESETS` (main select additionally gets "Custom"). Defaults set in JS (`fog` for aim row 1, `clear` elsewhere). Save/export unaffected (stores values, not options).

### 1e. Small cleanups
- `window._aimLastBest` → module-scoped `let aimLastBest` in simulator.js
- Protocol pulse rate `p.bitsPerFrame * p.framesPerS` computed once per update instead of twice

## 2. Remove emojis
- `test/verify.js`: replace `✅❌🎉💥` with `PASS`/`FAIL`/plain-text summary. Introduce an `expect(cond, okMsg, failMsg)` helper that also collapses ~20 repeated `if (...) { console.log('❌…'); failures++ } else console.log('✅…')` blocks.
- `simulator.js` comment `↔` → `<->`.
- Typographic UI glyphs (`←`/`→` sidebar toggles, chain-flow arrows, `&bull;`) are kept — they're not emojis.

## 3. Program structure
Split the 1335-line `js/simulator.js`:

| File | Contents |
|---|---|
| `js/simulator.js` (~850 lines) | inputs map, `buildParams`, `updateSimulation`, safety panel + chain rendering, presets, auto-solver, aim UI, save/share/import, collapse/sidebar, events, init |
| `js/viz.js` (~450 lines, new) | `Sim.Viz` — Chart.js setup, ray-tracer canvas, spot-profile canvas, time-series + SNR charts. Explicit state API: `init()`, `setSimState()`, `setShooting()`, `redraw()`, `updateCharts(p, tx, rx, worstRatio)` (replaces shared module-level `simState`/`isShooting`/chart globals) |
| `js/search.js` (new) | `Sim.Search.run` batched iteration (see 1b) |

Script load order in index.html: `constants → atmosphere → optics → receiver → safety → search → aim → viz → simulator`.

## 4. Verification
- `node --check` on every js file
- `node test/verify.js` — all checks pass with identical physics results
- Manual smoke test suggestion: load index.html, click presets, Auto-Solve, Define Aim, save/export/import
- Commit on `feat/qol-refactor` (also commit the pending `.gitignore` change adding `.agents/`)
