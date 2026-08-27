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

        const vSignal = iSignal * p.gain;
        const vSolarRaw = iSolar * p.gain;
        const vSolarTIA = p.acCoupling === 'before_tia' ? 0 : vSolarRaw;

        const bw = noiseBandwidthHz(p.riseTimeNs);
        const iNoiseRMS = Math.sqrt(2 * Sim.Constants.Q_E * iSolar * bw);
        const vNoiseRMS = iNoiseRMS * p.gain;

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
            vSignal,
            vSolarRaw,
            vSolarTIA,
            noiseBwHz: bw,
            vNoiseRMS,
            snrDb: snrDb > 0 ? snrDb : 0
        };
    }

    return { noiseBandwidthHz, linkBudget };
})();
