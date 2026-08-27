/**
 * Laser diode + transmitter optics physics.
 *
 * Equations audited from the original PoC:
 *  - Diode peak power: P = (I_F − I_th) · slope, temperature derated
 *  - Beam radius at lens: 2 f tan(θ/2)
 *  - Aperture capture (FIXED): Gaussian truncated-aperture integral
 *        η_axis = 1 − exp(−2 a² / w²)
 *    applied per axis (replaces the old ad-hoc area-ratio clamp and the
 *    dead `slowCapture` code path in FAC mode).
 *  - Collimated divergence (full angle): RSS of geometric term w_emit/f
 *    and Gaussian diffraction term 4λ/(π D).
 *  - Apparent source angular subtense per axis: α_axis = w_emit / f
 *    (= geometric divergence; feeds IEC 60825-1 C6 analysis).
 */
window.Sim = window.Sim || {};

Sim.Optics = (function () {
    'use strict';

    const D = Sim.Constants.DIODE;

    /**
     * Junction-temperature-adjusted wavelength [nm].
     * @param tempC operating temperature [°C]
     * @param baseNm measured/nominal wavelength at 25 °C (default: datasheet 905 nm)
     */
    function wavelengthNm(tempC, baseNm) {
        return (baseNm || D.WAVELENGTH_NOM_NM) + D.TC_LAMBDA_NM_PER_K * (tempC - 25);
    }

    /** Raw diode peak optical power [W] (before any optics). */
    function diodePeakPowerW(iForwardA, tempC) {
        const raw = Math.max(0, (iForwardA - D.I_THRESHOLD_A) * D.SLOPE_EFF_W_PER_A);
        const tempFactor = Math.max(0, 1 + D.TC_POWER_PER_K * (tempC - 25));
        return raw * tempFactor;
    }

    /** Fraction of a 1D Gaussian beam (1/e² radius w) passing a half-aperture a. */
    function gaussianCapture1D(a, w) {
        if (w <= 0) return 1;
        return 1 - Math.exp(-2 * a * a / (w * w));
    }

    /**
     * Compute the full TX beam state.
     * @param p input parameter object (see simulator.js buildParams)
     * @returns tx result object
     */
    function computeTxBeam(p) {
        const lambdaNm = wavelengthNm(p.tempC, p.lambdaNm);
        const lambdaM = lambdaNm * 1e-9;
        const peakW = diodePeakPowerW(p.iForward, p.tempC);

        const rawDivSlow = p.rawDivSlowDeg * Math.PI / 180;
        const rawDivFast = p.rawDivFastDeg * Math.PI / 180;

        let capture = 1.0;
        let divGeomSlow = 0, divGeomFast = 0;
        let divDiffSlow = 0, divDiffFast = 0;
        let beamLensSlowMm = p.dMainMm, beamLensFastMm = p.dMainMm;
        let fEffSlow = p.fMainMm, fEffFast = p.fMainMm;

        // Gaussian 1/e² radius of the raw cone at distance f: w = f·tan(θ/2)
        // (datasheet divergences are FWHM-ish; using the cone directly keeps
        // the capture estimate conservative).
        const wRawSlowAt = f => f * Math.tan(rawDivSlow / 2);
        const wRawFastAt = f => f * Math.tan(rawDivFast / 2);

        const rLens = p.dMainMm / 2;

        if (p.opticsMode === 'single') {
            const wS = wRawSlowAt(p.fMainMm);
            const wF = wRawFastAt(p.fMainMm);
            beamLensSlowMm = 2 * wS;
            beamLensFastMm = 2 * wF;
            capture = gaussianCapture1D(rLens, wS) * gaussianCapture1D(rLens, wF);

            fEffSlow = fEffFast = p.fMainMm;
            divGeomSlow = (p.emitterWum * 1e-3) / p.fMainMm;
            divGeomFast = (p.emitterHum * 1e-3) / p.fMainMm;
            const apertSlow = Math.min(p.dMainMm, beamLensSlowMm) * 1e-3;
            const apertFast = Math.min(p.dMainMm, beamLensFastMm) * 1e-3;
            divDiffSlow = (4 * lambdaM) / (Math.PI * apertSlow);
            divDiffFast = (4 * lambdaM) / (Math.PI * apertFast);

        } else if (p.opticsMode === 'fac') {
            // FAC (fast axis, f = fFac) + main spherical lens (slow axis, f = fMain)
            const wF = wRawFastAt(p.fFacMm);
            const wS = wRawSlowAt(p.fMainMm);
            beamLensFastMm = 2 * wF;   // fast axis re-imaged small by FAC
            beamLensSlowMm = 2 * wS;
            // FAC captures nearly all of the fast axis (micro-lens, no clip);
            // main lens clips the slow axis only.
            capture = 0.98 * gaussianCapture1D(rLens, wS);

            fEffSlow = p.fMainMm;
            fEffFast = p.fFacMm;
            divGeomSlow = (p.emitterWum * 1e-3) / p.fMainMm;
            divGeomFast = (p.emitterHum * 1e-3) / p.fFacMm;
            const apertSlow = Math.min(p.dMainMm, beamLensSlowMm) * 1e-3;
            const apertFast = Math.max(0.2e-3, beamLensFastMm * 1e-3);
            divDiffSlow = (4 * lambdaM) / (Math.PI * apertSlow);
            divDiffFast = (4 * lambdaM) / (Math.PI * apertFast);

        } else if (p.opticsMode === 'anamorphic') {
            const wS = wRawSlowAt(p.fSlowMm);
            const wF = wRawFastAt(p.fFastMm);
            beamLensSlowMm = 2 * wS;
            beamLensFastMm = 2 * wF;
            capture = 0.98 * gaussianCapture1D(rLens, wS) * gaussianCapture1D(rLens, wF);

            fEffSlow = p.fSlowMm;
            fEffFast = p.fFastMm;
            divGeomSlow = (p.emitterWum * 1e-3) / p.fSlowMm;
            divGeomFast = (p.emitterHum * 1e-3) / p.fFastMm;
            const apertSlow = Math.min(p.dMainMm, beamLensSlowMm) * 1e-3;
            const apertFast = Math.min(p.dMainMm, beamLensFastMm) * 1e-3;
            divDiffSlow = (4 * lambdaM) / (Math.PI * apertSlow);
            divDiffFast = (4 * lambdaM) / (Math.PI * apertFast);

        } else { // manual divergence override (user-specified, mrad)
            capture = 0.95;
            divGeomSlow = (p.manualDivSlowMrad || 2.5) * 1e-3;
            divGeomFast = (p.manualDivFastMrad || 10) * 1e-3;
            fEffSlow = fEffFast = 0; // α not meaningful in manual mode
        }

        const divSlow = Math.sqrt(divGeomSlow * divGeomSlow + divDiffSlow * divDiffSlow);
        const divFast = Math.sqrt(divGeomFast * divGeomFast + divDiffFast * divDiffFast);

        // Apparent source angular subtense per axis [mrad] — purely geometric
        // (diffraction does not enlarge the apparent source image).
        const alphaSlowMrad = fEffSlow > 0 ? (p.emitterWum * 1e-3) / fEffSlow * 1000 : (p.manualDivSlowMrad || 2.5);
        const alphaFastMrad = fEffFast > 0 ? (p.emitterHum * 1e-3) / fEffFast * 1000 : (p.manualDivFastMrad || 10);

        const pTxEffW = peakW * capture * (p.tArPct / 100);

        // Protocol duty cycle from the actual (adjustable) pulse-train settings
        const P = Sim.Constants.PROTOCOL;
        const pulsesPerS = (p.bitsPerFrame || P.BITS_PER_FRAME) * (p.framesPerS || P.MAX_FRAMES_PER_S);
        const dutyCycle = (p.pulseWidthNs * 1e-9) * pulsesPerS;

        return {
            lambdaNm,
            diodePeakPowerW: peakW,
            dutyCycle,
            lensCaptureEff: capture,
            divOutSlowMrad: divSlow * 1000,
            divOutFastMrad: divFast * 1000,
            divGeomSlowMrad: divGeomSlow * 1000,
            divGeomFastMrad: divGeomFast * 1000,
            divDiffSlowMrad: divDiffSlow * 1000,
            divDiffFastMrad: divDiffFast * 1000,
            beamDiaLensSlowMm: beamLensSlowMm,
            beamDiaLensFastMm: beamLensFastMm,
            alphaSlowMrad,
            alphaFastMrad,
            alphaMeanMrad: (alphaSlowMrad + alphaFastMrad) / 2,
            pTxEffW
        };
    }

    /**
     * Elliptical spot geometry at a given distance from the TX aperture.
     * Uses per-axis output divergence; near field starts at the beam
     * diameter at the lens plane.
     */
    function spotAtDistance(p, tx, distM) {
        const w = Math.max(p.dMainMm, tx.beamDiaLensSlowMm) * 1e-3 +
            2 * distM * Math.tan((tx.divOutSlowMrad / 1000) / 2);
        const h = Math.max(p.dMainMm, tx.beamDiaLensFastMm) * 1e-3 +
            2 * distM * Math.tan((tx.divOutFastMrad / 1000) / 2);
        return { spotW_m: w, spotH_m: h, area_m2: Math.PI * (w / 2) * (h / 2) };
    }

    return { wavelengthNm, diodePeakPowerW, gaussianCapture1D, computeTxBeam, spotAtDistance };
})();
