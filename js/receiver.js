/**
 * Receiver link budget, solar background and noise.
 *
 * Changes vs the original PoC:
 *  - Noise bandwidth is no longer hardcoded to 20 MHz; it is derived from
 *    the pulse rise time (BW ≈ 0.35 / t_rise).
 *  - Atmospheric transmission τ (Kruse/Kim) is applied to the received power.
 */
window.Sim = window.Sim || {};

Sim.Receiver = (function () {
    'use strict';

    const DET = Sim.Constants.DETECTOR;

    /** Signal bandwidth from rise time [Hz]. */
    function noiseBandwidthHz(riseTimeNs) {
        const tr = Math.max(0.1, riseTimeNs) * 1e-9;
        return 0.35 / tr;
    }

    /**
     * Full receiver budget at distance distM.
     * @returns object with powers, voltages, noise and SNR
     */
    function linkBudget(p, tx, distM) {
        const spot = Sim.Optics.spotAtDistance(p, tx, distM);

        const rxRadiusM = (p.dRxMm / 2) * 1e-3;
        const rxAreaM2 = Math.PI * rxRadiusM * rxRadiusM;
        const captureRatio = Math.min(1, rxAreaM2 / spot.area_m2);

        // Atmosphere
        const tau = Sim.Atmosphere.transmission(p.visibilityKm, tx.lambdaNm, distM);

        // Optical bandpass: hard pass/block based on temp-drifted wavelength
        let filterLoss = 1.0;
        if (p.filterBw !== 800) {
            const fMin = 905 - p.filterBw / 2;
            const fMax = 905 + p.filterBw / 2;
            if (tx.lambdaNm < fMin || tx.lambdaNm > fMax) filterLoss = 0;
        }

        const rxPowerW = tx.pTxEffW * captureRatio * tau * filterLoss;

        // Solar background (daylight filter etc. via filterBw)
        const solarPowerW = p.solarIrradiance * p.filterBw * rxAreaM2;

        const R = DET.RESPONSIVITY_A_PER_W;
        const iSignal = rxPowerW * R;
        const iSolar = solarPowerW * R;

        // TIA gain: manual slider or AGC (keeps V_signal at the target level)
        let gain = p.gain;
        let agcActive = false;
        if (p.agcOn && iSignal > 1e-15) {
            gain = Math.min(1e6, Math.max(10, (p.agcTargetV || 1) / iSignal));
            agcActive = true;
        }

        const vSignal = iSignal * gain;
        const vSolarRaw = iSolar * gain;
        const vSolarTIA = p.acCoupling === 'before_tia' ? 0 : vSolarRaw;

        const bw = noiseBandwidthHz(p.riseTimeNs);
        const iNoiseRMS = Math.sqrt(2 * Sim.Constants.Q_E * iSolar * bw);
        const vNoiseRMS = iNoiseRMS * gain;

        const snrLinear = vSignal / (vNoiseRMS || 1e-5);
        const snrDb = 20 * Math.log10(Math.max(snrLinear, 1e-9));

        return {
            spot,
            rxAreaM2,
            captureRatio,
            tau,
            filterLoss,
            rxPowerW,
            solarPowerW,
            iSignal,
            iSolar,
            gainUsed: gain,
            agcActive,
            vSignal,
            vSolarRaw,
            vSolarTIA,
            noiseBwHz: bw,
            vNoiseRMS,
            snrDb: snrDb > 0 ? snrDb : 0
        };
    }

    /**
     * Evaluate the receiver electronics chain:
     * photodiode → AGC/TIA → comparator → monostable pulse stretcher → MCU.
     * Answers: "how much photocurrent arrives, and can it be measured cleanly?"
     */
    function evalChain(p, rx) {
        const vLimit = DET.SYSTEM_VOLTAGE_LIMIT_V;

        // Comparator: pulse must clear both the threshold and 3× RMS noise
        const threshV = Math.max((p.compThreshMv || 50) / 1000, 3 * rx.vNoiseRMS);
        const detectOk = rx.vSignal >= threshV;
        const marginDb = 20 * Math.log10(Math.max(rx.vSignal, 1e-12) / threshV);

        // Saturation / clipping at the TIA output (solar DC + pulse)
        const clipping = (rx.vSolarTIA + rx.vSignal) > vLimit;

        // Monostable pulse stretcher: stretches the ns pulse for the MCU
        const monoOutUs = Math.max(p.pulseWidthNs / 1000, p.monoStretchUs || 10);

        const clean = detectOk && !clipping;
        const reasons = [];
        if (!detectOk) reasons.push('signal below comparator threshold / 3×noise');
        if (clipping) reasons.push('TIA clipping (solar DC + pulse > 5 V) — use AC coupling before TIA or lower gain');
        if (rx.agcActive) reasons.push('AGC active: gain auto-adjusted');

        return {
            threshV,
            detectOk,
            marginDb,
            clipping,
            monoOutUs,
            clean,
            reasons
        };
    }

    return { noiseBandwidthHz, linkBudget, evalChain };
})();
