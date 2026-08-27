/**
 * IEC 60825-1:2014 (+ ISH1:2017) laser safety classification.
 *
 * Model summary (905 nm, pulsed):
 *  - α (angular subtense of apparent source) = arithmetic mean of the two
 *    beam axes (ISH1 §4) — from TX optics geometry, capped at 100 mrad for
 *    T2 / C5 criteria.
 *  - αmax(t): 5 mrad (t<625 µs) · 200√t mrad (≤0.25 s) · 100 mrad (>0.25 s).
 *  - C4 = 10^(0.002(λ−700)); C6 = clamp(α/1.5, 1, αmax/1.5); C7 = 1.
 *  - C5 = 5·N^(−0.25) floored at 0.4 (α ≤ 5 mrad, t ≤ Ti branch) per Table 9;
 *    pulses within Ti = 5 µs merged into one effective pulse.
 *  - AEL Class 1 (700–1050 nm):
 *      t ≤ 18 µs : 7.7e-8 · C4·C6·C7  [J]   (VERIFY vs Table 3/4)
 *      t ≤ T2    : 7e-4 · t^0.75 · C4·C6·C7 [J]
 *      t > T2    : 7e-4 · C4·C6·C7 · T2^(−0.25) [W]
 *  - Three pulsed criteria (4.3 f)): single pulse, average power over time
 *    base, single pulse × C5. All must pass.
 *  - Measurement conditions (2014 ed.; old Cond. 2 removed):
 *      Cond. 1 (optical aids): 50 mm aperture @ 2 m
 *      Cond. 3 (naked eye):     7 mm aperture @ 100 mm
 *    Near-field (at TX aperture) is also evaluated; worst case wins.
 *  - ISH1 §6b: when α > 5 mrad the classification may be based on an assumed
 *    smaller α (smaller C6 but larger C5 floor) — we evaluate the candidate
 *    set {α, 5, 1.5} mrad and take the best (least restrictive) result.
 *  - Default simplified evaluation toggle: α = 1.5 mrad, C6 = 1, C5 = 1
 *    (conservative, ISH1 §6d).
 */
window.Sim = window.Sim || {};

Sim.Safety = (function () {
    'use strict';

    const IEC = Sim.Constants.IEC;
    const PROT = Sim.Constants.PROTOCOL;

    /**
     * Effective-pulse analysis (Ti merging + ISH1 §5 pulse grouping).
     *
     * 1. Pulses closer than Ti are merged into one effective pulse (energy summed).
     * 2. ISH1 §5 grouping: when α > 5 mrad AND the frame (group) duration is
     *    between Ti and 0.25 s AND the intra-frame bit period < Tcrit, the whole
     *    65-bit frame is treated as ONE effective pulse; C5 then uses N = number
     *    of frames (groups) within min(time base, T2), and AEL is evaluated for
     *    the group duration. Conservative assumption: every bit is a "1" pulse.
     *
     * Grouping depends on α, so this is evaluated per candidate α in classify().
     */
    /** Protocol values (adjustable in UI; constants are fallbacks). */
    function protocol(p) {
        const bitsPerFrame = p.bitsPerFrame || PROT.BITS_PER_FRAME;
        const framesPerS = p.framesPerS || PROT.MAX_FRAMES_PER_S;
        return { bitsPerFrame, framesPerS, pulsesPerS: bitsPerFrame * framesPerS };
    }

    function effectivePulse(p, alphaMrad) {
        const proto = protocol(p);
        const tPulse = p.pulseWidthNs * 1e-9;
        const bitPeriod = 1 / (p.pulseFreqKHz * 1e3);
        const frameDur = bitPeriod * proto.bitsPerFrame;

        // Step 1: Ti merging
        let tEff, eFactor, merged;
        if (bitPeriod <= IEC.TI_S) {
            const nMerge = Math.max(1, Math.ceil(IEC.TI_S / bitPeriod));
            tEff = IEC.TI_S; eFactor = nMerge; merged = true;
        } else {
            tEff = tPulse; eFactor = 1; merged = false;
        }

        // Step 2: ISH1 §5 grouping check (α capped at 100 mrad per ISH1 §4)
        const alphaCapped = Math.min(alphaMrad, IEC.ALPHA_MAX_LIMIT_MRAD);
        const tcrit = IEC.Tcrit(alphaCapped, tPulse);
        let grouped = false;
        if (alphaCapped > 5 && frameDur > IEC.TI_S && frameDur <= 0.25 && bitPeriod < tcrit) {
            grouped = true;
            tEff = frameDur;
            eFactor = proto.bitsPerFrame; // conservative: all bits are pulses
        }

        // Groups per second (frame rate) vs effective pulses per second
        const rateHz = grouped
            ? proto.framesPerS
            : proto.pulsesPerS / eFactor;

        return { tEff, eFactor, merged, grouped, tcrit, frameDur, bitPeriod, rateHz };
    }

    /** Beam 1/e² radii [m] at distance r from the TX aperture (per axis). */
    function beamRadiiM(p, tx, r) {
        const wS0 = Math.max(p.dMainMm, tx.beamDiaLensSlowMm) / 2 * 1e-3;
        const wF0 = Math.max(p.dMainMm, tx.beamDiaLensFastMm) / 2 * 1e-3;
        const growS = r * Math.tan((tx.divOutSlowMrad / 1000) / 2);
        const growF = r * Math.tan((tx.divOutFastMrad / 1000) / 2);
        return {
            wS: Math.sqrt(wS0 * wS0 + growS * growS),
            wF: Math.sqrt(wF0 * wF0 + growF * growF)
        };
    }

    /** Fraction of beam peak power passing a circular aperture at distance r. */
    function apertureCapture(p, tx, r, apertureMm) {
        const a = (apertureMm / 2) * 1e-3;
        const { wS, wF } = beamRadiiM(p, tx, r);
        if (a >= Math.max(wS, wF)) return 1;
        // elliptical beam vs circular aperture: geometric-mean radius approx
        const wEff = Math.sqrt(wS * wF);
        return 1 - Math.exp(-2 * a * a / (wEff * wEff));
    }

    /** Worst-case capture for a measurement condition (near field + spec distance). */
    function conditionCapture(p, tx, cond) {
        const near = apertureCapture(p, tx, 0, cond.apertureMm);
        const atDist = apertureCapture(p, tx, cond.distanceM, cond.apertureMm);
        return Math.max(near, atDist);
    }

    /**
     * Evaluate all three pulsed criteria for one condition and candidate α.
     * @param measuredAvgW optional lab-measured average power through the
     *        condition aperture [W]. When given, it replaces the calculated
     *        accessible emission (capture is bypassed); the peak power is
     *        derived from the protocol duty cycle.
     */
    function evalCondition(p, tx, cond, alphaMrad, ep, c5Ctx, measuredAvgW) {
        const lambda = tx.lambdaNm;
        const proto = protocol(p);
        const tPulse = p.pulseWidthNs * 1e-9;
        const duty = tPulse * proto.pulsesPerS;

        const measured = measuredAvgW != null && measuredAvgW > 0;
        const capture = measured ? null : conditionCapture(p, tx, cond);
        const aePeakW = measured ? measuredAvgW / Math.max(duty, 1e-15) : tx.pTxEffW * capture;

        const ePulseEffJ = aePeakW * tPulse * ep.eFactor;      // effective pulse energy
        const pAvgAccW = measured ? measuredAvgW : aePeakW * tPulse * proto.pulsesPerS;

        // Criterion 1: single (effective) pulse vs AEL(t_eff)
        const aelSingleJ = c5Ctx.simplified
            ? IEC.AEL_class1(ep.tEff, lambda, 1.5)
            : IEC.AEL_class1(ep.tEff, lambda, alphaMrad);
        const crit1 = {
            ae: ePulseEffJ, ael: aelSingleJ,
            ratio: ePulseEffJ / aelSingleJ
        };

        // Criterion 3: thermal additivity, AEL_single × C5
        const aelTrainJ = aelSingleJ * c5Ctx.c5;
        const crit3 = {
            ae: ePulseEffJ, ael: aelTrainJ,
            ratio: ePulseEffJ / aelTrainJ
        };

        // Criterion 2: average power over min(time base, T2)
        // C6 for the averaging duration uses αmax(t_avg) (ISH1 §4)
        const aelAvgRaw = c5Ctx.simplified
            ? IEC.AEL_class1(c5Ctx.evalDur, lambda, 1.5)
            : IEC.AEL_class1(c5Ctx.evalDur, lambda, alphaMrad);
        const aelAvgW = c5Ctx.evalDur <= c5Ctx.t2 ? aelAvgRaw / c5Ctx.evalDur : aelAvgRaw;
        const crit2 = {
            ae: pAvgAccW, ael: aelAvgW,
            ratio: pAvgAccW / aelAvgW
        };

        const worst = Math.max(crit1.ratio, crit2.ratio, crit3.ratio);
        return { cond, capture, measured, aePeakW, crit1, crit2, crit3, worstRatio: worst };
    }

    /**
     * Full classification.
     * @param p input parameters (incl. timeBaseS, simplifiedEval)
     * @param tx TX beam result from Sim.Optics.computeTxBeam
     */
    function classify(p, tx) {
        const alphaReal = Math.min(tx.alphaMeanMrad, IEC.ALPHA_MAX_LIMIT_MRAD);
        const timeBase = p.timeBaseS || IEC.TIME_BASE_DEFAULT_S;

        // Candidate α values (ISH1 §6b allows assuming a smaller source)
        const alphas = [alphaReal];
        if (!p.simplifiedEval) {
            if (alphaReal > 5) alphas.push(5);
            if (alphaReal > IEC.ALPHA_MIN_MRAD) alphas.push(IEC.ALPHA_MIN_MRAD);
        }

        let best = null;

        for (const alphaMrad of alphas) {
            // Grouping depends on α → evaluate per candidate (ISH1 §5/§6b)
            const ep = effectivePulse(p, alphaMrad);
            const t2 = IEC.T2(alphaMrad);
            const evalDur = Math.min(timeBase, t2);
            const nEff = Math.max(1, Math.round(ep.rateHz * evalDur));
            const c5 = p.simplifiedEval ? 1 : IEC.C5(nEff, alphaMrad, ep.tEff);
            const c5Ctx = { c5, t2, evalDur, nEff, simplified: !!p.simplifiedEval };

            const meas = p.measuredMw || {};
            const measW = key => (meas[key] != null && meas[key] > 0) ? meas[key] * 1e-3 : null;
            const conds = [
                { key: 'cond1', label: 'Cond. 1 — Optical Aids (50 mm @ 2 m)', ...IEC.MEAS_CONDITIONS.COND1_OPTICAL_AIDS },
                { key: 'cond2', label: 'Cond. 2 — Naked Eye close (7 mm @ 70 mm)', ...IEC.MEAS_CONDITIONS.COND2_NAKED_EYE_CLOSE },
                { key: 'cond3', label: 'Cond. 3 — Naked Eye (7 mm @ 100 mm)', ...IEC.MEAS_CONDITIONS.COND3_NAKED_EYE }
            ].map(cond => evalCondition(p, tx, cond, alphaMrad, ep, c5Ctx, measW(cond.key)));

            const worstRatio = Math.max(...conds.map(c => c.worstRatio));

            if (!best || worstRatio < best.worstRatio) {
                best = { alphaMrad, c5, t2, evalDur, nEff, ep, conds, worstRatio };
            }
        }

        // --- Classification ----------------------------------------------
        const rOf = key => best.conds.find(c => c.cond.key === key).worstRatio;
        const r1 = rOf('cond1');
        const rEye = Math.max(rOf('cond2'), rOf('cond3')); // naked-eye conditions
        let classification;
        if (best.worstRatio <= 1) classification = '1';
        else if (rEye <= 1 && r1 > 1) classification = '1M';
        else if (best.worstRatio <= 5) classification = '3R'; // IR: 3R = 5× Class 1 AEL
        else {
            // 3B limits: ≤ 0.5 W CW / ≤ 30 mJ per pulse (VERIFY Table 8)
            const maxAeW = Math.max(...best.conds.map(c => c.aePeakW));
            const maxAeJ = Math.max(...best.conds.map(c => c.crit1.ae));
            classification = (maxAeW <= 0.5 && maxAeJ <= 0.03) ? '3B' : '4';
        }

        // Limiting condition & criterion
        let limiting = { ratio: -1 };
        for (const c of best.conds) {
            for (const k of ['crit1', 'crit2', 'crit3']) {
                if (c[k].ratio > limiting.ratio) {
                    limiting = { ratio: c[k].ratio, condition: c.cond.label, criterion: k };
                }
            }
        }

        const marginDb = 10 * Math.log10(1 / best.worstRatio);

        return {
            classification,
            worstRatio: best.worstRatio,
            marginDb,
            alphaMrad: best.alphaMrad,
            alphaRealMrad: alphaReal,
            c5: best.c5,
            nEff: best.nEff,
            t2: best.t2,
            evalDur: best.evalDur,
            effectivePulse: best.ep,
            conditions: best.conds,
            limiting,
            simplified: !!p.simplifiedEval
        };
    }

    /**
     * NOHD-like distance: greatest distance at which a 7 mm aperture still
     * intercepts more than the (worst-criterion) Class 1 limit. 0 if already
     * Class 1 at the aperture. Ratios scale linearly with captured power, so
     * we scale the Condition-3 reference ratios by cap(r)/capCond3.
     */
    function nohdM(p, tx, classification) {
        const res = classification || classify(p, tx);
        const cond3 = res.conditions.find(c => c.cond.key === 'cond3');
        const refRatio = Math.max(cond3.crit1.ratio, cond3.crit2.ratio, cond3.crit3.ratio);
        const capRef = cond3.capture;
        if (refRatio <= 1) return 0;
        const apt = IEC.MEAS_CONDITIONS.COND3_NAKED_EYE.apertureMm;
        let last = 0;
        for (let r = 0.1; r <= 2000; r += r < 10 ? 0.1 : (r < 100 ? 1 : 10)) {
            const cap = apertureCapture(p, tx, r, apt);
            const ratio = refRatio * (cap / capRef);
            if (ratio <= 1) break;
            last = r;
        }
        return last;
    }

    /**
     * Class-1 solver. Accessible emission is linear in (I_F − I_th), so the
     * max compliant drive current follows directly from the current ratio.
     * @returns {maxCurrentA, maxTxPeakPowerW}
     */
    function solveMaxClass1(p, tx, classification) {
        const I = Sim.Constants.DIODE.I_THRESHOLD_A;
        const ratio = Math.max(classification.worstRatio, 1e-12);
        const maxCurrent = I + (p.iForward - I) / ratio;
        return {
            maxCurrentA: Math.min(25, Math.max(I, maxCurrent)),
            maxTxPeakPowerW: tx.pTxEffW / ratio
        };
    }

    return { classify, nohdM, solveMaxClass1, apertureCapture, effectivePulse };
})();
