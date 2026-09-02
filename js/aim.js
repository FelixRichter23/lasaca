/**
 * Define Aim — target-current solver.
 *
 * Given a set of (distance, weather) anchors with target photocurrents,
 * searches drive current, optics, and receiver settings to best match
 * the targets while staying Class-1 compliant, keeping the RX chain clean,
 * and respecting a spot-size constraint at 200 m.
 *
 * Two modes:
 *   "exact"    — minimise RMS log-error to all anchors
 *   "envelope" — hard bounds: anchor[0] is a min, anchor[2] is a max,
 *                anchor[1] is a soft nominal
 */
window.Sim = window.Sim || {};

Sim.Aim = (function () {
    'use strict';

    // ------------------------------------------------------------------
    // Defaults
    // ------------------------------------------------------------------
    const DEFAULT_ANCHORS = [
        { distM: 200, weather: 'fog',   targetA: 280e-9 },   // 280 nA
        { distM: 200, weather: 'clear', targetA: 5.93e-6 },  // 5.93 µA
        { distM: 5,   weather: 'clear', targetA: 2.5e-3 }    // 2.5 mA
    ];

    // ------------------------------------------------------------------
    // Part cost table (EUR, cheap-ish distributor prices)
    // ------------------------------------------------------------------
    const COSTS = {
        diode: 18,
        facLens: 35,
        lensTx: { '10': 15, '18': 45, '25': 65, '40': 110 },
        anamorphicPair: 120,
        lensRx: { '2': 3, '5': 5, '10': 10, '20': 25, '30': 45, '50': 90 },
        filter: { '370': 0, '50': 25, '10': 70, '800': 0 },
        tia: 5,
        agcCircuit: 15
    };

    function totalCost(p) {
        let c = COSTS.diode + COSTS.tia;
        if (p.opticsMode === 'fac') {
            c += COSTS.facLens + (COSTS.lensTx[String(p.dMainMm)] || 45);
        } else if (p.opticsMode === 'single') {
            c += (COSTS.lensTx[String(p.dMainMm)] || 45);
        } else if (p.opticsMode === 'anamorphic') {
            c += COSTS.anamorphicPair + (COSTS.lensTx[String(p.dMainMm)] || 45);
        }
        c += COSTS.lensRx[String(p.dRxMm)] || 5;
        c += COSTS.filter[String(p.filterBw)] || 0;
        if (p.agcOn) c += COSTS.agcCircuit;
        return c;
    }

    // ------------------------------------------------------------------
    // Spot constraint at 200 m
    // ------------------------------------------------------------------
    function checkSpot(p, tx) {
        const spot = Sim.Optics.spotAtDistance(p, tx, 200);
        const w = spot.spotW_m;
        const h = spot.spotH_m;
        const minS = 0.20;
        const maxS = 0.40;
        const maxDiff = 0.10;
        const ok = w >= minS && w <= maxS && h >= minS && h <= maxS &&
                   Math.abs(w - h) / Math.max(w, h) <= maxDiff;
        return { ok, w, h, aspect: w / h, area_m2: spot.area_m2 };
    }

    // ------------------------------------------------------------------
    // Single candidate evaluation
    // ------------------------------------------------------------------
    function evalCandidate(p, anchors, mode) {
        const tx = Sim.Optics.computeTxBeam(p);
        if (!tx || !Number.isFinite(tx.pTxEffW)) return null;

        const spot = checkSpot(p, tx);
        if (!spot.ok) return null;

        // Class-1 must hold under normal AND single-fault conditions
        // (IEC 60825-1 §5.1) — same rule as the main panel / autoSolve.
        let safety = Sim.Safety.classify(p, tx);
        if (p.faultMode && p.faultMode !== 'normal') {
            const D = Sim.Constants.DIODE;
            const iFault = p.faultMode === 'plus10'
                ? Math.min(D.MAX_DRIVE_CURRENT_A, p.iForward * D.FAULT_CURRENT_MULT)
                : D.MAX_DRIVE_CURRENT_A;
            const pF = { ...p, iForward: iFault };
            const sF = Sim.Safety.classify(pF, Sim.Optics.computeTxBeam(pF));
            if (sF.worstRatio > safety.worstRatio) safety = sF;
        }
        if (safety.worstRatio > 1) return null;

        const rxs = [];
        const currents = [];
        for (const a of anchors) {
            const pA = {
                ...p,
                distM: a.distM,
                visibilityKm: Sim.Atmosphere.WEATHER_PRESETS[a.weather].visibilityKm
            };
            const txA = Sim.Optics.computeTxBeam(pA);
            const rx = Sim.Receiver.linkBudget(pA, txA, a.distM);
            const chain = Sim.Receiver.evalChain(pA, rx);
            if (!chain.clean) return null;
            if (rx.snrDb < p.minSnrDb) return null;
            rxs.push(rx);
            currents.push(rx.iSignal);
        }

        const cost = totalCost(p);
        let score = 0;

        if (mode === 'exact') {
            let sqErr = 0;
            for (let i = 0; i < anchors.length; i++) {
                const logActual = Math.log10(Math.max(currents[i], 1e-18));
                const logTarget = Math.log10(Math.max(anchors[i].targetA, 1e-18));
                const d = logActual - logTarget;
                sqErr += d * d;
            }
            const rmse = Math.sqrt(sqErr / anchors.length);
            score = -rmse * 1000 - cost * 0.01;
        } else {
            // envelope: [0] = min bound, [2] = max bound, [1] = soft nominal
            if (anchors.length < 3) return null; // envelope needs all three anchors
            const iMin = currents[0];
            const iNom = currents[1];
            const iMax = currents[2];
            // hard bounds: any violation rejects the candidate outright
            if (iMin < anchors[0].targetA) return null;
            if (iMax > anchors[2].targetA) return null;
            const nomError = Math.abs(
                Math.log10(Math.max(iNom, 1e-18)) -
                Math.log10(Math.max(anchors[1].targetA, 1e-18))
            );
            score = -nomError * 100 - cost * 0.01;
        }

        return { p, tx, spot, safety, rxs, currents, cost, score };
    }

    // ------------------------------------------------------------------
    // Grid search
    // ------------------------------------------------------------------
    function solve(pBase, anchors, mode, onProgress, onResult) {
        const opticsModes = ['fac', 'single', 'anamorphic'];
        const fMainVals  = [50, 75, 100, 125, 150, 200];
        const fFacVals   = [0.5, 0.8, 1.0, 1.5, 2.0];
        const fSlowVals  = [50, 75, 100, 125, 150, 200];
        const fFastVals  = [10, 15, 20, 30, 50];
        const dMainVals  = [10, 18, 25, 40];
        const dRxVals    = [2, 5, 10, 20, 30];
        // Fine steps just above threshold (0.3 A): Class-1-limited solutions
        // live in this region, and the envelope window can fall between
        // coarse grid points.
        const iFwdVals   = [0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        const acModes    = ['before_tia', 'after_tia'];
        const gainModes  = [
            { gain: 10,   agcOn: false, agcTargetV: 0 },
            { gain: 100,  agcOn: false, agcTargetV: 0 },
            { gain: 1000, agcOn: false, agcTargetV: 0 },
            { gain: 10000,agcOn: false, agcTargetV: 0 },
            { gain: 100,  agcOn: true,  agcTargetV: 1.0 }
        ];

        // --- Phase 1: pre-filter optics configs by spot at 200 m --------
        const passingConfigs = [];
        for (const om of opticsModes) {
            let focalCombos = [];
            if (om === 'single') {
                fMainVals.forEach(fm => focalCombos.push({ fMainMm: fm }));
            } else if (om === 'fac') {
                fMainVals.forEach(fm =>
                    fFacVals.forEach(ff => focalCombos.push({ fMainMm: fm, fFacMm: ff })));
            } else if (om === 'anamorphic') {
                fSlowVals.forEach(fs =>
                    fFastVals.forEach(ff => focalCombos.push({ fSlowMm: fs, fFastMm: ff })));
            }
            for (const fc of focalCombos) {
                for (const dM of dMainVals) {
                    const pTest = { ...pBase, opticsMode: om, dMainMm: dM, ...fc };
                    const txTest = Sim.Optics.computeTxBeam(pTest);
                    if (txTest && Number.isFinite(txTest.pTxEffW) && checkSpot(pTest, txTest).ok) {
                        passingConfigs.push({ om, dM, ...fc });
                    }
                }
            }
        }

        // --- Phase 2: enumerate full candidates -------------------------
        const combos = [];
        for (const cfg of passingConfigs) {
            for (const dR of dRxVals) {
                for (const iF of iFwdVals) {
                    for (const ac of acModes) {
                        for (const gm of gainModes) {
                            combos.push({
                                opticsMode: cfg.om,
                                dMainMm: cfg.dM,
                                dRxMm: dR,
                                iForward: iF,
                                acCoupling: ac,
                                ...cfg,
                                ...gm
                            });
                        }
                    }
                }
            }
        }

        // Shuffle for better early exploration
        for (let i = combos.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [combos[i], combos[j]] = [combos[j], combos[i]];
        }

        let best = null;
        let idx = 0;
        const BATCH = 32;

        function step() {
            const end = Math.min(idx + BATCH, combos.length);
            for (; idx < end; idx++) {
                const c = combos[idx];
                // strip helper keys that aren't part of the param object
                const { om, dM, ...overrides } = c;
                const p = { ...pBase, ...overrides };
                const r = evalCandidate(p, anchors, mode);
                if (r && (!best || r.score > best.score)) best = r;
            }
            onProgress(Math.round((idx / combos.length) * 100));
            if (idx < combos.length) {
                setTimeout(step, 0);
            } else {
                onResult(best);
            }
        }

        if (combos.length === 0) {
            onProgress(100);
            onResult(null);
            return;
        }
        setTimeout(step, 0);
    }

    return {
        DEFAULT_ANCHORS,
        COSTS,
        totalCost,
        checkSpot,
        evalCandidate,
        solve
    };
})();
