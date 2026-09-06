/**
 * Orchestrator & UI layer.
 * Reads inputs, calls the physics modules (Sim.Optics / Sim.Atmosphere /
 * Sim.Receiver / Sim.Safety) and renders stat boxes, the safety panel,
 * charts and canvases.
 */
(function () {
    'use strict';

    const C = Sim.Constants;
    const PROT = C.PROTOCOL;

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------
    const $ = id => document.getElementById(id);

    let aimLastBest = null;

    const inputs = {
        driveCurrent: $('driveCurrent'),
        pulseWidth: $('pulseWidth'),
        pulseFreq: $('pulseFreq'),
        pulseFreqNum: $('pulseFreqNum'),
        bitsPerFrame: $('bitsPerFrame'),
        framesPerS: $('framesPerS'),
        riseTime: $('riseTime'),
        wavelength: $('wavelength'),
        emitterWidth: $('emitterWidth'),
        emitterHeight: $('emitterHeight'),
        rawDivSlow: $('rawDivSlow'),
        rawDivFast: $('rawDivFast'),
        opticsMode: $('opticsMode'),
        focalMain: $('focalMain'),
        lensDiameterTx: $('lensDiameterTx'),
        focalFac: $('focalFac'),
        focalSlow: $('focalSlow'),
        focalFast: $('focalFast'),
        manualDivSlow: $('manualDivSlow'),
        manualDivFast: $('manualDivFast'),
        lensTransmission: $('lensTransmission'),
        distance: $('distance'),
        weatherPreset: $('weatherPreset'),
        visibility: $('visibility'),
        lensDiameterRx: $('lensDiameterRx'),
        operatingTemp: $('operatingTemp'),
        solarIrradiance: $('solarIrradiance'),
        sensorFilter: $('sensorFilter'),
        acCoupling: $('acCoupling'),
        tiaGain: $('tiaGain'),
        agcMode: $('agcMode'),
        agcTarget: $('agcTarget'),
        compThresh: $('compThresh'),
        monoStretch: $('monoStretch'),
        timeBase: $('timeBase'),
        simplifiedEval: $('simplifiedEval'),
        faultMode: $('faultMode'),
        minSnr: $('minSnr'),
        measCond1: $('measCond1'),
        measCond2: $('measCond2'),
        measCond3: $('measCond3'),
        aimMode: $('aimMode'),
        aimDist1: $('aimDist1'),
        aimWeather1: $('aimWeather1'),
        aimTarget1: $('aimTarget1'),
        aimUnit1: $('aimUnit1'),
        aimDist2: $('aimDist2'),
        aimWeather2: $('aimWeather2'),
        aimTarget2: $('aimTarget2'),
        aimUnit2: $('aimUnit2'),
        aimDist3: $('aimDist3'),
        aimWeather3: $('aimWeather3'),
        aimTarget3: $('aimTarget3'),
        aimUnit3: $('aimUnit3')
    };

    // ------------------------------------------------------------------
    // Parameter bundle
    // ------------------------------------------------------------------
    function buildParams() {
        const weather = inputs.weatherPreset.value;
        const visibilityKm = weather === 'custom'
            ? parseFloat(inputs.visibility.value)
            : Sim.Atmosphere.WEATHER_PRESETS[weather].visibilityKm;

        return {
            iForward: parseFloat(inputs.driveCurrent.value),
            pulseWidthNs: parseFloat(inputs.pulseWidth.value),
            pulseFreqKHz: parseFloat(inputs.pulseFreqNum.value || inputs.pulseFreq.value),
            bitsPerFrame: parseInt(inputs.bitsPerFrame.value, 10) || PROT.BITS_PER_FRAME,
            framesPerS: parseFloat(inputs.framesPerS.value) || PROT.MAX_FRAMES_PER_S,
            riseTimeNs: parseFloat(inputs.riseTime.value),
            lambdaNm: parseFloat(inputs.wavelength.value),
            emitterWum: parseFloat(inputs.emitterWidth.value),
            emitterHum: parseFloat(inputs.emitterHeight.value),
            rawDivSlowDeg: parseFloat(inputs.rawDivSlow.value),
            rawDivFastDeg: parseFloat(inputs.rawDivFast.value),
            opticsMode: inputs.opticsMode.value,
            fMainMm: parseFloat(inputs.focalMain.value),
            dMainMm: parseFloat(inputs.lensDiameterTx.value),
            fFacMm: parseFloat(inputs.focalFac.value),
            fSlowMm: parseFloat(inputs.focalSlow.value),
            fFastMm: parseFloat(inputs.focalFast.value),
            manualDivSlowMrad: parseFloat(inputs.manualDivSlow.value) || 2.5,
            manualDivFastMrad: parseFloat(inputs.manualDivFast.value) || 10,
            tArPct: parseFloat(inputs.lensTransmission.value),
            distM: parseFloat(inputs.distance.value),
            visibilityKm,
            dRxMm: parseFloat(inputs.lensDiameterRx.value),
            tempC: parseFloat(inputs.operatingTemp.value),
            solarIrradiance: parseFloat(inputs.solarIrradiance.value),
            filterBw: parseFloat(inputs.sensorFilter.value),
            acCoupling: inputs.acCoupling.value,
            gain: parseFloat(inputs.tiaGain.value),
            agcOn: inputs.agcMode.value === 'agc',
            agcTargetV: parseFloat(inputs.agcTarget.value),
            compThreshMv: parseFloat(inputs.compThresh.value) || 50,
            monoStretchUs: parseFloat(inputs.monoStretch.value) || 10,
            timeBaseS: parseFloat(inputs.timeBase.value),
            simplifiedEval: inputs.simplifiedEval.value === 'simplified',
            faultMode: inputs.faultMode.value,
            minSnrDb: parseFloat(inputs.minSnr.value),
            measuredMw: {
                cond1: measVal(inputs.measCond1),
                cond2: measVal(inputs.measCond2),
                cond3: measVal(inputs.measCond3)
            }
        };
    }

    function measVal(input) {
        const v = parseFloat(input.value);
        return Number.isFinite(v) && v > 0 ? v : null;
    }

    /**
     * Class-1 current limit expressed in normal-mode slider units.
     * Sim.Safety.solveMaxClass1 works in whichever domain the worst case
     * lives in; a fault-domain result must be mapped back through the fault
     * current model, otherwise the solved slider current does not land on
     * ratio = 1 (slightly non-conservative for +10 %, wrong for short).
     */
    function class1SliderLimit(pWorst, txWorst, safetyWorst, worstIsFault, faultMode) {
        const s = Sim.Safety.solveMaxClass1(pWorst, txWorst, safetyWorst);
        let maxA = s.maxCurrentA;
        if (worstIsFault && faultMode === 'plus10') {
            maxA = Math.min(C.DIODE.MAX_DRIVE_CURRENT_A, maxA / C.DIODE.FAULT_CURRENT_MULT);
        } else if (worstIsFault && faultMode === 'short') {
            // Fault current is fixed at 25 A regardless of the slider: if the
            // short still passes, any slider value is fine; if not, none helps.
            maxA = safetyWorst.worstRatio <= 1 ? C.DIODE.MAX_DRIVE_CURRENT_A : C.DIODE.I_THRESHOLD_A;
        }
        return { maxCurrentA: maxA, maxTxPeakPowerW: s.maxTxPeakPowerW };
    }

    // ------------------------------------------------------------------
    // Control visibility (optics mode, AGC, custom weather)
    // ------------------------------------------------------------------
    function updateOpticsModeUI() {
        const mode = inputs.opticsMode.value;
        const show = { ctrlMainFocal: false, ctrlMainDiameter: true, ctrlFacFocal: false, ctrlFocalSlow: false, ctrlFocalFast: false };
        let badge = 'Manual Override';
        if (mode === 'single') { show.ctrlMainFocal = true; badge = 'Single Collimator Lens'; }
        else if (mode === 'fac') { show.ctrlMainFocal = true; show.ctrlFacFocal = true; badge = 'FAC + Main Collimator'; }
        else if (mode === 'anamorphic') { show.ctrlFocalSlow = true; show.ctrlFocalFast = true; badge = 'Anamorphic Cylindrical Pair'; }
        Object.entries(show).forEach(([id, vis]) => { $(id).style.display = vis ? 'block' : 'none'; });
        $('ctrlDivManual').style.display = mode === 'manual' ? 'block' : 'none';
        $('opticsBadge').innerText = badge;
    }

    function refreshControlUI() {
        updateOpticsModeUI();
        const agc = inputs.agcMode.value === 'agc';
        $('ctrlTiaGain').style.display = agc ? 'none' : 'block';
        $('ctrlAgcTarget').style.display = agc ? 'block' : 'none';
        $('ctrlVisibility').style.display = inputs.weatherPreset.value === 'custom' ? 'block' : 'none';
    }

    function populateWeatherSelects() {
        const options = Object.entries(Sim.Atmosphere.WEATHER_PRESETS)
            .map(([val, pr]) => `<option value="${val}">${pr.label}</option>`).join('');
        inputs.weatherPreset.innerHTML = options + '<option value="custom">Custom (slider below)</option>';
        inputs.weatherPreset.value = 'clear';
        for (let i = 1; i <= 3; i++) {
            inputs[`aimWeather${i}`].innerHTML = options;
        }
        inputs.aimWeather1.value = 'fog';
        inputs.aimWeather2.value = 'clear';
        inputs.aimWeather3.value = 'clear';
    }

    // ------------------------------------------------------------------
    // Main update
    // ------------------------------------------------------------------
    function updateSimulation() {
        const p = buildParams();

        Object.keys(inputs).forEach(key => {
            const span = $(`${key}Val`);
            if (span) span.innerText = inputs[key].value;
        });

        // ---- Physics chain ---------------------------------------------
        // Normal operating point drives the link budget & charts.
        const tx = Sim.Optics.computeTxBeam(p);
        const rx = Sim.Receiver.linkBudget(p, tx, p.distM);

        // Safety: classification must hold under normal AND single-fault
        // conditions (IEC 60825-1 §5.1). Evaluate both, take the worst.
        const se = Sim.Safety.classifyWithFault(p, tx);
        const { worst: safetyWorst, view: safetyView, worstIsFault,
                txWorst, pWorst, txFault } = se;
        const combinedRatio = safetyWorst.worstRatio;

        const solver = class1SliderLimit(pWorst, txWorst, safetyWorst, worstIsFault, p.faultMode);
        const nohd = Sim.Safety.nohdM(pWorst, txWorst, safetyWorst);

        // ---- Diode / duty cycle -----------------------------------------
        $('calcPeakPowerTxt').innerText = tx.diodePeakPowerW.toFixed(1);

        // Protocol info line (frame length / period / average pulse rate)
        const bitPeriodUs = 1e3 / p.pulseFreqKHz;
        const frameMs = bitPeriodUs * p.bitsPerFrame / 1000;
        const periodMs = 1000 / p.framesPerS;
        const pulsesPerS = p.bitsPerFrame * p.framesPerS;
        $('calcBitPeriod').innerText = bitPeriodUs.toFixed(0);
        $('protocolInfo').innerText =
            `Frame: ${p.bitsPerFrame} bits = ${frameMs.toFixed(1)} ms &bull; period: ${periodMs.toFixed(1)} ms &bull; ${pulsesPerS.toLocaleString()} pulses/s`;

        // Divergence breakdown readout (geometric vs diffraction per axis)
        $('divInfo').innerText =
            `θ_out slow ${tx.divOutSlowMrad.toFixed(2)} mrad (geom ${tx.divGeomSlowMrad.toFixed(2)} + diffr ${tx.divDiffSlowMrad.toFixed(2)}) &bull; ` +
            `fast ${tx.divOutFastMrad.toFixed(2)} mrad (geom ${tx.divGeomFastMrad.toFixed(2)} + diffr ${tx.divDiffFastMrad.toFixed(2)})`;

        const dutyPct = tx.dutyCycle * 100;
        $('calcDutyCycle').innerText = `${dutyPct.toFixed(4)}%`;
        if (tx.dutyCycle > C.DIODE.MAX_DUTY_CYCLE) {
            $('dutyCycleStatus').innerText = 'EXCEEDS 0.1% MAX RATING!';
            $('dutyCycleBadge').className = 'duty-cycle-badge warning';
        } else {
            $('dutyCycleStatus').innerText = 'OK (≤ 0.1% max)';
            $('dutyCycleBadge').className = 'duty-cycle-badge';
        }

        // ---- Math steps ---------------------------------------------------
        $('calcDiodeRawPower').innerText = `${tx.diodePeakPowerW.toFixed(1)} W`;
        $('lblRawDiv').innerText = `${p.rawDivSlowDeg.toFixed(1)}°×${p.rawDivFastDeg.toFixed(1)}°`;
        $('lblTxLensDia').innerText = p.dMainMm;
        $('calcLensCapturePct').innerText = `${(tx.lensCaptureEff * 100).toFixed(1)}%`;
        $('calcTxPowerEff').innerText = `${tx.pTxEffW.toFixed(2)} W`;

        $('calcDivMrad').innerText = `${tx.divOutSlowMrad.toFixed(2)} × ${tx.divOutFastMrad.toFixed(2)} mrad`;
        $('lblDist').innerText = p.distM;
        $('lblDistSpot').innerText = p.distM;
        $('lblDistAtmo').innerText = p.distM;
        $('calcSpotSize').innerText = `${(rx.spot.spotW_m * 100).toFixed(1)} cm × ${(rx.spot.spotH_m * 100).toFixed(1)} cm`;
        $('calcSpotArea').innerText = `${rx.spot.area_m2.toFixed(3)} m²`;

        $('lblVisibility').innerText = p.visibilityKm;
        $('calcGamma').innerText = Sim.Atmosphere.extinctionCoefficient(p.visibilityKm, tx.lambdaNm).toFixed(3);
        $('calcTau').innerText = `${(rx.tau * 100).toFixed(1)}%`;

        $('lblRxLensDia').innerText = p.dRxMm;
        $('calcRxCaptureRatio').innerText = `${(rx.captureRatio * 100).toFixed(4)}%`;
        $('calcRxPower').innerText = rx.rxPowerW >= 1e-3
            ? `${(rx.rxPowerW * 1000).toFixed(2)} mW` : `${(rx.rxPowerW * 1e6).toFixed(2)} µW`;

        $('calcSolarPower').innerText = `${(rx.solarPowerW * 1000).toFixed(2)} mW`;
        $('calcNoiseRMS').innerText = `${(rx.vNoiseRMS * 1000).toFixed(3)} mV`;
        $('lblNoiseBw').innerText = (rx.noiseBwHz / 1e6).toFixed(0);

        const IEC = C.IEC;
        $('calcAlpha').innerText = `${safetyView.alphaMrad.toFixed(2)} mrad`;
        $('calcC6').innerText = IEC.C6(safetyView.alphaMrad, safetyView.effectivePulse.tEff).toFixed(2);
        $('calcC4').innerText = IEC.C4(tx.lambdaNm).toFixed(2);
        $('calcC5').innerText = safetyView.c5.toFixed(2);
        const aelSp = IEC.AEL_class1(safetyView.effectivePulse.tEff, tx.lambdaNm, safetyView.alphaMrad);
        $('calcAel').innerText = `${(aelSp * 1e9).toFixed(1)} nJ`;

        // ---- Stat boxes ---------------------------------------------------
        $('outTxLensEff').innerText = `${(tx.lensCaptureEff * (p.tArPct / 100) * 100).toFixed(1)}%`;
        $('outSolarV').innerText = `${rx.vSolarTIA.toFixed(2)} V`;
        $('outSignalV').innerText = `${rx.vSignal.toFixed(3)} V`;
        $('outSnr').innerText = rx.snrDb > 0 ? `${rx.snrDb.toFixed(1)} dB` : '0 dB';
        $('statBoxSolar').className = `stat-box ${rx.vSolarTIA > C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V ? 'warning' : 'success'}`;
        $('statBoxSignal').className = `stat-box ${rx.vSignal > 0.05 ? 'success' : 'warning'}`;
        if (p.faultMode !== 'normal') {
            $('calcPeakPowerTxt').innerText = `${tx.diodePeakPowerW.toFixed(1)} (fault: ${txFault.diodePeakPowerW.toFixed(1)})`;
        }

        const aspect = (rx.spot.spotW_m / rx.spot.spotH_m).toFixed(1);
        $('spotAspectBadge').innerText = `Aspect: ${aspect}:1`;

        // ---- Safety panel -------------------------------------------------
        renderSafetyPanel(p, tx, se, solver, nohd);

        // ---- RX electronics chain -----------------------------------------
        renderChain(p, rx);

        // ---- Canvas + charts ----------------------------------------------
        Sim.Viz.setSimState({
            opticsMode: p.opticsMode, fMainMm: p.fMainMm, dMainMm: p.dMainMm, fFacMm: p.fFacMm,
            rawDivFastDeg: p.rawDivFastDeg, lensCaptureEff: tx.lensCaptureEff,
            spotW_m: rx.spot.spotW_m, spotH_m: rx.spot.spotH_m, dRxMm: p.dRxMm
        });
        Sim.Viz.redraw();
        Sim.Viz.updateCharts(p, tx, rx, combinedRatio);
    }

    // ------------------------------------------------------------------
    // Safety panel rendering
    // ------------------------------------------------------------------
    function fmtRatio(r) {
        const cls = r <= 1 ? 'pass' : 'fail';
        const margin = 10 * Math.log10(1 / r);
        return `<span class="ratio ${cls}">${r.toFixed(2)}×</span><small>${margin >= 0 ? '+' : ''}${margin.toFixed(1)} dB</small>`;
    }

    function renderSafetyPanel(p, tx, se, solver, nohd) {
        const { normal: safetyNormal, fault: safetyFault, worst: safetyWorst,
                view: safetyView, worstIsFault } = se;
        const safety = safetyView; // per-condition table shows the selected mode

        const badge = $('classBadge');
        badge.innerText = `CLASS ${safetyWorst.classification}`;
        const clsMap = { '1': 'class-ok', '1M': 'class-warn', '3R': 'class-warn', '3B': 'class-bad', '4': 'class-bad' };
        badge.className = `class-badge ${clsMap[safetyWorst.classification]}`;

        const faultLabel = { normal: null, plus10: 'Fault +10 %', short: 'Fault short (25 A)' }[p.faultMode];
        $('classDetail').innerHTML = faultLabel
            ? `Normal operation: <strong>Class ${safetyNormal.classification}</strong> (${safetyNormal.marginDb.toFixed(1)} dB) &bull; ` +
              `${faultLabel}: <strong>Class ${safetyFault.classification}</strong> (${safetyFault.marginDb.toFixed(1)} dB) ` +
              `&rarr; product class = worst = <strong>Class ${safetyWorst.classification}</strong>. Table shows ${worstIsFault ? 'fault' : 'normal'} evaluation.`
            : 'Normal operation only (no fault condition selected). Enable a single-fault mode in section 5 for the §5.1 check.';

        $('outClass').innerText = safetyWorst.classification;
        $('statBoxClass').className = `stat-box ${safetyWorst.classification === '1' ? 'success' : 'warning'}`;
        $('outMargin').innerText = `${safetyWorst.marginDb >= 0 ? '+' : ''}${safetyWorst.marginDb.toFixed(1)} dB`;
        $('statBoxMargin').className = `stat-box ${safetyWorst.worstRatio <= 1 ? 'success' : 'warning'}`;

        const critName = { crit1: 'Single pulse', crit2: 'Average power', crit3: 'Pulse × C5' };
        $('outLimiting').innerText = safety.limiting.condition
            ? `${critName[safety.limiting.criterion]} — ${safety.limiting.condition.split('—')[0].trim()}`
            : '—';
        $('outNohd').innerText = nohd <= 0 ? '0 m (Class 1 at aperture)' : `≈ ${nohd.toFixed(nohd < 10 ? 1 : 0)} m`;
        $('outMaxCurrent').innerText = `${solver.maxCurrentA.toFixed(2)} A`;
        $('outMaxPower').innerText = solver.maxTxPeakPowerW >= 1
            ? `${solver.maxTxPeakPowerW.toFixed(2)} W` : `${(solver.maxTxPeakPowerW * 1000).toFixed(1)} mW`;

        const maxDist = maxSafeDistance(p, tx, safetyWorst.worstRatio);
        $('outMaxDistance').innerText = maxDist >= 10 ? `≈ ${maxDist.toFixed(0)} m` : '< 10 m';

        $('outFactors').innerText =
            `${safety.alphaMrad.toFixed(2)} mrad / ${C.IEC.C4(tx.lambdaNm).toFixed(2)} / ` +
            `${safety.c5.toFixed(2)} / ${C.IEC.C6(safety.alphaMrad, safety.effectivePulse.tEff).toFixed(2)} / ` +
            `N=${safety.nEff.toLocaleString()}`;

        // Facts row
        const pulsesPerS = p.bitsPerFrame * p.framesPerS;
        const ep = safety.effectivePulse;
        const epTxt = ep.grouped
            ? `frame ${(ep.frameDur * 1e6).toFixed(0)} µs (×${ep.eFactor}, ISH1 §5 group)`
            : ep.merged
                ? `${(ep.tEff * 1e6).toFixed(1)} µs (×${ep.eFactor} merged @ Ti)`
                : `${(ep.tEff * 1e9).toFixed(0)} ns (single)`;
        $('safetyFacts').innerHTML = `
            <div><small>Method</small><strong>${safety.simplified ? 'Default simplified (C6=1, C5=1)' : 'Extended source (ISH1)'}</strong></div>
            <div><small>Time base</small><strong>${p.timeBaseS} s</strong></div>
            <div><small>Effective pulse</small><strong>${epTxt}</strong></div>
            <div><small>Tcrit / grouping</small><strong>${(ep.tcrit * 1e6).toFixed(1)} µs / ${ep.grouped ? 'frame grouped' : 'not required'}</strong></div>
            <div><small>T2 / eval duration</small><strong>${safety.t2.toFixed(1)} s / ${safety.evalDur.toFixed(1)} s</strong></div>
            <div><small>λ (temp drift)</small><strong>${tx.lambdaNm.toFixed(1)} nm</strong></div>
            <div><small>Protocol rate</small><strong>${pulsesPerS.toLocaleString()} pulses/s</strong></div>
            <div><small>α candidate used</small><strong>${safety.alphaMrad.toFixed(2)} of ${safety.alphaRealMrad.toFixed(2)} mrad</strong></div>`;

        // Conditions table
        $('safetyTableBody').innerHTML = safety.conditions.map(c => `
            <tr>
                <td>${c.cond.label}<br><small>${c.measured ? 'measured override' : `capture ${(c.capture * 100).toFixed(1)}%`}</small></td>
                <td>${c.aePeakW >= 1 ? c.aePeakW.toFixed(2) + ' W' : (c.aePeakW * 1000).toFixed(2) + ' mW'}</td>
                <td>${fmtRatio(c.crit1.ratio)}</td>
                <td>${fmtRatio(c.crit2.ratio)}</td>
                <td>${fmtRatio(c.crit3.ratio)}</td>
            </tr>`).join('');
    }

    // ------------------------------------------------------------------
    // RX electronics chain rendering
    // ------------------------------------------------------------------
    function fmtCurrent(a) {
        if (a >= 1e-3) return `${(a * 1e3).toFixed(2)} mA`;
        if (a >= 1e-6) return `${(a * 1e6).toFixed(2)} µA`;
        return `${(a * 1e9).toFixed(1)} nA`;
    }

    function renderChain(p, rx) {
        const chain = Sim.Receiver.evalChain(p, rx);
        const gainTxt = rx.agcActive
            ? `AGC: ${rx.gainUsed.toFixed(0)} Ω`
            : `manual: ${rx.gainUsed.toFixed(0)} Ω`;

        const stages = [
            { name: 'Photodiode', lines: [`I_sig ${fmtCurrent(rx.iSignal)}`, `I_sun ${fmtCurrent(rx.iSolar)} DC`], ok: true },
            { name: 'AGC + TIA', lines: [gainTxt, `V_sig ${rx.vSignal.toFixed(3)} V`, `V_sun ${rx.vSolarTIA.toFixed(2)} V DC`], ok: !chain.clipping },
            { name: 'Comparator', lines: [`thr ${(chain.threshV * 1000).toFixed(1)} mV`, `margin ${chain.marginDb >= 0 ? '+' : ''}${chain.marginDb.toFixed(1)} dB`], ok: chain.detectOk },
            { name: 'Monostable', lines: [`in ${p.pulseWidthNs} ns`, `out ${chain.monoOutUs.toFixed(0)} µs`], ok: true },
            { name: 'MCU', lines: [`frame ${p.bitsPerFrame} bit`, `@ ${p.pulseFreqKHz} kHz`], ok: chain.clean }
        ];

        $('chainFlow').innerHTML = stages.map((s, i) => `
            <div class="chain-stage ${s.ok ? 'ok' : 'bad'}">
                <div class="chain-head">${s.name}</div>
                ${s.lines.map(l => `<div class="chain-line">${l}</div>`).join('')}
            </div>${i < stages.length - 1 ? '<div class="chain-arrow">→</div>' : ''}`).join('');

        const verdict = $('chainVerdict');
        verdict.innerText = chain.clean ? 'CLEAN' : 'NOT CLEAN';
        verdict.className = `class-badge ${chain.clean ? 'class-ok' : 'class-bad'}`;

        $('chainReasons').innerText = chain.reasons.length ? chain.reasons.join(' • ') : '';
    }

    /** Max distance where SNR ≥ minSnr with power clamped to the Class-1 limit. */
    function maxSafeDistance(p, tx, worstRatio) {
        const scale = Math.min(1, 1 / worstRatio);
        const txLim = { ...tx, pTxEffW: tx.pTxEffW * scale };
        let best = 0;
        for (let d = 10; d <= 3000; d += 10) {
            const r = Sim.Receiver.linkBudget(p, txLim, d);
            if (r.snrDb >= p.minSnrDb) best = d; else if (d > best + 50) break;
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Presets
    // ------------------------------------------------------------------
    function setPreset(name) {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));

        const base = {
            driveCurrent: '8.0', pulseWidth: '100', pulseFreq: '3.3', pulseFreqNum: '3.3', riseTime: '2',
            emitterWidth: '200', emitterHeight: '2.0', rawDivSlow: '12.0', rawDivFast: '25.0',
            lensDiameterTx: '18', lensTransmission: '95', lensDiameterRx: '5',
            tiaGain: '100', acCoupling: 'after_tia', sensorFilter: '370',
            weatherPreset: 'clear', solarIrradiance: '0.8',
            bitsPerFrame: '65', framesPerS: '17', agcMode: 'manual', compThresh: '50', monoStretch: '10'
        };

        if (name === '100mm') {
            $('preset100mm').classList.add('active');
            applyValues({ ...base, opticsMode: 'single', focalMain: '100' });
        } else if (name === 'fac100mm') {
            $('presetFAC100mm').classList.add('active');
            applyValues({ ...base, opticsMode: 'fac', focalMain: '100', focalFac: '1.0' });
        } else if (name === 'anamorphic') {
            $('presetAnamorphic').classList.add('active');
            applyValues({ ...base, opticsMode: 'anamorphic', focalSlow: '100', focalFast: '20', lensDiameterTx: '25' });
        } else if (name === 'datasheet') {
            $('presetDatasheet').classList.add('active');
            applyValues({ ...base, opticsMode: 'fac', focalMain: '100', focalFac: '1.0', emitterWidth: '110' });
        } else if (name === 'night') {
            $('presetNight').classList.add('active');
            applyValues({ ...base, opticsMode: 'fac', focalMain: '100', focalFac: '1.0', solarIrradiance: '0.0' });
        } else if (name === 'class1') {
            $('presetClass1').classList.add('active');
            applyValues({ ...base, opticsMode: 'fac', focalMain: '100', focalFac: '1.0' });
            refreshControlUI();
            applyClass1Solver();
            return;
        }

        refreshControlUI();
        updateSimulation();
    }

    function applyValues(map) {
        Object.entries(map).forEach(([k, v]) => { if (inputs[k]) inputs[k].value = v; });
    }

    /** Run the Class-1 solver (worst of normal + fault) and clamp the slider. */
    function applyClass1Solver() {
        const p = buildParams();
        const tx = Sim.Optics.computeTxBeam(p);
        const se = Sim.Safety.classifyWithFault(p, tx);
        const solver = class1SliderLimit(se.pWorst, se.txWorst, se.worst, se.worstIsFault, p.faultMode);
        inputs.driveCurrent.value = Math.min(10, Math.max(0.1, solver.maxCurrentA)).toFixed(1);
        updateSimulation();
    }

    // ------------------------------------------------------------------
    // Auto-solver: grid search over compatible optics presets x drive
    // current for the safest Class-1 setup that still closes the link
    // (SNR + clean RX chain) at the selected distance and weather.
    // ------------------------------------------------------------------
    const AUTO_OPTICS = [
        { name: 'FAC + 100mm lens', values: { opticsMode: 'fac', focalMain: '100', focalFac: '1.0', lensDiameterTx: '18' } },
        { name: '100mm/18mm single lens', values: { opticsMode: 'single', focalMain: '100', lensDiameterTx: '18' } },
        { name: 'Anamorphic pair', values: { opticsMode: 'anamorphic', focalSlow: '100', focalFast: '20', lensDiameterTx: '25' } },
        { name: 'Datasheet (110µm emitter, FAC)', values: { opticsMode: 'fac', focalMain: '100', focalFac: '1.0', lensDiameterTx: '18', emitterWidth: '110' } }
    ];

    function evalAutoCandidate(pBase, opticsValues, iA) {
        const p = { ...pBase, iForward: iA };
        if (opticsValues.opticsMode) p.opticsMode = opticsValues.opticsMode;
        if (opticsValues.focalMain) p.fMainMm = parseFloat(opticsValues.focalMain);
        if (opticsValues.lensDiameterTx) p.dMainMm = parseFloat(opticsValues.lensDiameterTx);
        if (opticsValues.focalFac) p.fFacMm = parseFloat(opticsValues.focalFac);
        if (opticsValues.focalSlow) p.fSlowMm = parseFloat(opticsValues.focalSlow);
        if (opticsValues.focalFast) p.fFastMm = parseFloat(opticsValues.focalFast);
        if (opticsValues.emitterWidth) p.emitterWum = parseFloat(opticsValues.emitterWidth);

        const tx = Sim.Optics.computeTxBeam(p);
        const worst = Sim.Safety.classifyWithFault(p, tx).worst;
        const rx = Sim.Receiver.linkBudget(p, tx, p.distM);
        const chain = Sim.Receiver.evalChain(p, rx);

        const feasible = worst.worstRatio <= 1 && rx.snrDb >= p.minSnrDb && chain.clean;
        return { p, worst, snrDb: rx.snrDb, chainClean: chain.clean, feasible,
                 score: Math.min(worst.marginDb, rx.snrDb - p.minSnrDb) };
    }

    let autoSolveRunning = false;
    function autoSolve() {
        if (autoSolveRunning) return;
        autoSolveRunning = true;
        const btn = $('btnAutoSolve');
        const status = $('autoSolveStatus');
        btn.disabled = true;
        const pBase = buildParams();

        const combos = [];
        AUTO_OPTICS.forEach(o => {
            for (let i = 1; i <= 100; i++) combos.push([o, i / 10]);
        });

        let best = null;
        let bestEffort = null;
        status.className = 'auto-solve-status';
        status.innerText = 'Searching… 0 %';

        Sim.Search.run(combos, ([optics, iA]) => {
            const r = evalAutoCandidate(pBase, optics.values, iA);
            if (r.feasible && (!best || r.score > best.score ||
                (r.score === best.score && iA < best.iA))) {
                best = { ...r, iA, optics };
            }
            if (!bestEffort || r.score > bestEffort.score) {
                bestEffort = { ...r, iA, optics };
            }
        }, {
            batchSize: 16,
            onProgress: pct => { status.innerText = `Searching… ${pct} %`; },
            onDone: finish
        });

        function finish() {
            autoSolveRunning = false;
            btn.disabled = false;
            if (best) {
                applyValues({ ...best.optics.values, driveCurrent: best.iA.toFixed(1) });
                updateOpticsModeUI();
                updateSimulation();
                status.className = 'auto-solve-status ok';
                status.innerText = `${best.optics.name} @ ${best.iA.toFixed(1)} A — ` +
                    `SNR ${best.snrDb.toFixed(1)} dB (+${(best.snrDb - pBase.minSnrDb).toFixed(1)} dB margin) ` +
                    `at ${pBase.distM} m, safety margin +${best.worst.marginDb.toFixed(1)} dB — Class 1.`;
            } else {
                status.className = 'auto-solve-status warn';
                const r = bestEffort;
                const reasons = [];
                if (r.worst.worstRatio > 1) reasons.push(`exceeds Class 1 AEL (${r.worst.worstRatio.toFixed(1)}×)`);
                if (r.snrDb < pBase.minSnrDb) reasons.push(`SNR ${r.snrDb.toFixed(1)} dB < ${pBase.minSnrDb} dB`);
                if (!r.chainClean) reasons.push('RX chain not clean');
                status.innerText = `No Class-1 setup closes the link at ${pBase.distM} m ` +
                    `(visibility ${pBase.visibilityKm} km). Closest: ${r.optics.name} @ ${r.iA.toFixed(1)} A — ` +
                    `${reasons.join(', ')}. Try a larger RX lens, shorter distance, better weather, or lower min SNR.`;
            }
        }
    }

    // ------------------------------------------------------------------
    // Saved settings (localStorage) + base64 share/import
    // ------------------------------------------------------------------
    const SAVE_KEY = 'sim-saved-configs-v1';
    const MAX_SAVED = 20;

    function getSavedConfigs() {
        try {
            const l = JSON.parse(localStorage.getItem(SAVE_KEY));
            return Array.isArray(l) ? l : [];
        } catch (e) { return []; }
    }

    function persistSavedConfigs(list) {
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
    }

    function snapshotValues() {
        const v = {};
        Object.keys(inputs).forEach(k => { v[k] = inputs[k].value; });
        return v;
    }

    function summaryFromValues(values) {
        return `I=${values.driveCurrent} A, d=${values.distance} m, ` +
            `${values.opticsMode}, ${values.pulseFreqNum || values.pulseFreq} kHz`;
    }

    function applyConfigValues(values) {
        applyValues(values);
        refreshControlUI();
        updateSimulation();
    }

    function addConfig(name, values, summary) {
        const arr = getSavedConfigs();
        arr.unshift({ name, ts: Date.now(), summary, values });
        if (arr.length > MAX_SAVED) arr.length = MAX_SAVED;
        persistSavedConfigs(arr);
        renderSavedList();
    }

    function saveConfig() {
        const nameInput = $('saveName');
        const name = nameInput.value.trim() || `Config ${getSavedConfigs().length + 1}`;
        const values = snapshotValues();
        addConfig(name, values, summaryFromValues(values));
        nameInput.value = '';
    }

    function renderSavedList() {
        const listEl = $('savedList');
        listEl.innerHTML = '';
        const cfgs = getSavedConfigs();
        if (!cfgs.length) {
            const empty = document.createElement('div');
            empty.className = 'saved-empty';
            empty.textContent = 'No saved configurations yet.';
            listEl.appendChild(empty);
            return;
        }
        cfgs.forEach((cfg, idx) => {
            const row = document.createElement('div');
            row.className = 'saved-item';

            const info = document.createElement('div');
            info.className = 'saved-info';
            const name = document.createElement('strong');
            name.textContent = cfg.name;
            const meta = document.createElement('small');
            meta.textContent = `${new Date(cfg.ts).toLocaleString()} — ${cfg.summary || ''}`;
            info.appendChild(name);
            info.appendChild(meta);

            const btns = document.createElement('div');
            btns.className = 'saved-btns';

            const load = document.createElement('button');
            load.textContent = 'Load';
            load.className = 'saved-btn load';
            load.addEventListener('click', () => applyConfigValues(cfg.values));

            const share = document.createElement('button');
            share.textContent = 'Share';
            share.className = 'saved-btn share';
            share.addEventListener('click', () => exportConfig(cfg.name, cfg.values));

            const del = document.createElement('button');
            del.textContent = 'Del';
            del.className = 'saved-btn del';
            del.addEventListener('click', () => {
                const arr = getSavedConfigs();
                arr.splice(idx, 1);
                persistSavedConfigs(arr);
                renderSavedList();
            });

            btns.appendChild(load);
            btns.appendChild(share);
            btns.appendChild(del);
            row.appendChild(info);
            row.appendChild(btns);
            listEl.appendChild(row);
        });
    }

    function setShareStatus(msg, isError) {
        const el = $('shareStatus');
        el.innerText = msg;
        el.className = `share-status ${isError ? 'error' : 'ok'}`;
    }

    function encodeConfig(name, values) {
        return btoa(unescape(encodeURIComponent(
            JSON.stringify({ app: 'lasertag-sim', v: 1, name, values }))));
    }

    function decodeConfig(code) {
        const obj = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
        if (!obj || obj.app !== 'lasertag-sim' || obj.v !== 1 ||
            typeof obj.values !== 'object' || obj.values === null) {
            throw new Error('bad payload');
        }
        // keep only known input keys with primitive values
        const values = {};
        Object.keys(inputs).forEach(k => {
            const val = obj.values[k];
            if (typeof val === 'string' || typeof val === 'number') values[k] = String(val);
        });
        const name = typeof obj.name === 'string' && obj.name.trim()
            ? obj.name.trim().slice(0, 40) : null;
        return { name, values };
    }

    function exportConfig(name, values) {
        const code = encodeConfig(name, values);
        const shareInput = $('shareCode');
        shareInput.value = code;
        shareInput.focus();
        shareInput.select();
        const fallback = () => setShareStatus('Share code ready — copy it from the field.', false);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(
                () => setShareStatus('Share code copied to clipboard.', false),
                fallback);
        } else {
            fallback();
        }
    }

    function importConfig() {
        const code = $('importCode').value;
        if (!code.trim()) { setShareStatus('Paste a share code first.', true); return; }
        try {
            const { name, values } = decodeConfig(code);
            const cfgName = name || `Imported ${getSavedConfigs().length + 1}`;
            addConfig(cfgName, values, summaryFromValues(values));
            applyConfigValues(values);
            $('importCode').value = '';
            setShareStatus(`Imported "${cfgName}" and applied.`, false);
        } catch (e) {
            setShareStatus('Invalid share code — import failed.', true);
        }
    }

    // ------------------------------------------------------------------
    // Collapsible sidebar sections & math panel (state persisted)
    // ------------------------------------------------------------------
    const COLLAPSE_KEY = 'sim-collapse-v1';
    // default: sections 3 (Target/Weather) and 4 (Noise) collapsed
    const COLLAPSE_DEFAULT = { g2: true, g3: true };

    function initCollapsibles() {
        let state = COLLAPSE_DEFAULT;
        try {
            state = { ...COLLAPSE_DEFAULT, ...JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') };
        } catch (e) { /* ignore */ }

        document.querySelectorAll('.control-group').forEach((g, idx) => {
            const h = g.querySelector('h3');
            if (!h) return;
            h.classList.add('collapsible-toggle');
            h.addEventListener('click', () => {
                g.classList.toggle('collapsed');
                saveCollapseState();
            });
            if (state['g' + idx]) g.classList.add('collapsed');
        });

        const mp = document.querySelector('.math-panel');
        const mh = mp && mp.querySelector('h3');
        if (mh) {
            mh.classList.add('collapsible-toggle');
            mh.addEventListener('click', () => mp.classList.toggle('collapsed'));
        }
    }

    function saveCollapseState() {
        const state = {};
        document.querySelectorAll('.control-group').forEach((g, idx) => {
            state['g' + idx] = g.classList.contains('collapsed');
        });
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Sidebar collapse (global)
    // ------------------------------------------------------------------
    const SIDEBAR_KEY = 'sim-sidebar-collapsed';
    function initSidebarCollapse() {
        let collapsed = false;
        try { collapsed = JSON.parse(localStorage.getItem(SIDEBAR_KEY) || 'false'); } catch (e) {}
        if (collapsed) document.querySelector('.app-container').classList.add('sidebar-collapsed');
    }
    function toggleSidebar(collapsed) {
        document.querySelector('.app-container').classList.toggle('sidebar-collapsed', collapsed);
        try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify(collapsed)); } catch (e) {}
    }

    // ------------------------------------------------------------------
    // Define Aim
    // ------------------------------------------------------------------
    function readAnchors() {
        const anchors = [];
        for (let i = 1; i <= 3; i++) {
            const dist = parseFloat(inputs[`aimDist${i}`].value) || 0;
            const weather = inputs[`aimWeather${i}`].value;
            const target = parseFloat(inputs[`aimTarget${i}`].value) || 0;
            const unit = parseFloat(inputs[`aimUnit${i}`].value) || 1e-9;
            if (dist > 0 && target > 0) {
                anchors.push({ distM: dist, weather, targetA: target * unit });
            }
        }
        return anchors;
    }

    let aimSolveRunning = false;
    function defineAim() {
        if (aimSolveRunning) return;
        aimSolveRunning = true;
        const btn = $('btnDefineAim');
        const status = $('aimStatus');
        const results = $('aimResults');
        btn.disabled = true;
        status.className = 'auto-solve-status';
        status.innerText = 'Searching… 0 %';
        results.style.display = 'none';

        const anchors = readAnchors();
        if (anchors.length === 0) {
            status.className = 'auto-solve-status warn';
            status.innerText = 'Please fill in at least one anchor row.';
            btn.disabled = false;
            aimSolveRunning = false;
            return;
        }

        const pBase = buildParams();
        const mode = inputs.aimMode.value;
        if (mode === 'envelope' && anchors.length < 3) {
            status.className = 'auto-solve-status warn';
            status.innerText = 'Envelope mode needs all three anchor rows (min / nominal / max).';
            btn.disabled = false;
            aimSolveRunning = false;
            return;
        }

        Sim.Aim.solve(pBase, anchors, mode,
            pct => { status.innerText = `Searching… ${pct} %`; },
            best => {
                aimSolveRunning = false;
                btn.disabled = false;
                if (!best) {
                    status.className = 'auto-solve-status warn';
                    status.innerText = 'No feasible setup found. Try relaxing constraints (wider spot, lower min SNR, or closer distance).';
                    return;
                }
                status.className = 'auto-solve-status ok';
                status.innerText = 'Setup found — see results below.';
                renderAimResults(best, anchors);
                results.style.display = 'block';
            }
        );
    }

    function renderAimResults(best, anchors) {
        aimLastBest = best;
        const p = best.p;
        const opticsName = p.opticsMode === 'fac' ? `FAC + ${p.fMainMm} mm` :
            p.opticsMode === 'anamorphic' ? `Anamorphic (${p.fSlowMm}/${p.fFastMm} mm)` :
            `Single ${p.fMainMm} mm`;
        $('aimResOptics').innerText = opticsName;
        $('aimResCurrent').innerText = `${p.iForward.toFixed(1)} A`;
        $('aimResRxLens').innerText = `${p.dRxMm} mm`;
        $('aimResGain').innerText = p.agcOn ? `AGC @ ${p.agcTargetV} V` : `Manual ${p.gain} Ω`;
        $('aimResSpot').innerText = `${(best.spot.w * 100).toFixed(1)} × ${(best.spot.h * 100).toFixed(1)} cm`;
        $('aimResCost').innerText = `≈ €${best.cost}`;
        $('aimResMargin').innerText = `${best.safety.marginDb >= 0 ? '+' : ''}${best.safety.marginDb.toFixed(1)} dB`;
        $('aimResChain').innerText = 'CLEAN';

        $('aimResultBody').innerHTML = anchors.map((a, i) => {
            const achieved = best.currents[i];
            const diffPct = a.targetA > 0 ? ((achieved - a.targetA) / a.targetA * 100) : 0;
            const diffCls = Math.abs(diffPct) <= 10 ? 'pass' : (Math.abs(diffPct) <= 30 ? 'warn' : 'fail');
            return `<tr>
                <td>${a.distM} m, ${Sim.Atmosphere.WEATHER_PRESETS[a.weather].label}</td>
                <td>${fmtCurrent(a.targetA)}</td>
                <td>${fmtCurrent(achieved)} <span class="ratio ${diffCls}">${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%</span></td>
            </tr>`;
        }).join('');
    }

    function applyAimWinner() {
        const best = aimLastBest;
        if (!best) return;
        const p = best.p;
        const values = {
            driveCurrent: p.iForward.toFixed(1),
            opticsMode: p.opticsMode,
            focalMain: String(p.fMainMm),
            lensDiameterTx: String(p.dMainMm),
            lensDiameterRx: String(p.dRxMm),
            tiaGain: String(p.gain),
            agcMode: p.agcOn ? 'agc' : 'manual',
            acCoupling: p.acCoupling
        };
        if (p.opticsMode === 'fac') values.focalFac = String(p.fFacMm);
        if (p.opticsMode === 'anamorphic') {
            values.focalSlow = String(p.fSlowMm);
            values.focalFast = String(p.fFastMm);
        }
        if (p.agcOn && p.agcTargetV > 0) values.agcTarget = String(p.agcTargetV);
        applyValues(values);
        refreshControlUI();
        updateSimulation();
        $('aimStatus').innerText = 'Setup applied to simulator.';
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    $('preset100mm').addEventListener('click', () => setPreset('100mm'));
    $('presetFAC100mm').addEventListener('click', () => setPreset('fac100mm'));
    $('presetAnamorphic').addEventListener('click', () => setPreset('anamorphic'));
    $('presetDatasheet').addEventListener('click', () => setPreset('datasheet'));
    $('presetClass1').addEventListener('click', () => setPreset('class1'));
    $('presetNight').addEventListener('click', () => setPreset('night'));
    $('btnAutoSolve').addEventListener('click', autoSolve);
    $('btnSaveConfig').addEventListener('click', saveConfig);
    $('saveName').addEventListener('keydown', e => { if (e.key === 'Enter') saveConfig(); });
    $('btnShareCurrent').addEventListener('click', () => {
        exportConfig($('saveName').value.trim() || 'Current setup', snapshotValues());
    });
    $('btnImportConfig').addEventListener('click', importConfig);
    $('importCode').addEventListener('keydown', e => { if (e.key === 'Enter') importConfig(); });

    inputs.opticsMode.addEventListener('change', () => { updateOpticsModeUI(); updateSimulation(); });
    inputs.weatherPreset.addEventListener('change', () => {
        $('ctrlVisibility').style.display = inputs.weatherPreset.value === 'custom' ? 'block' : 'none';
        updateSimulation();
    });

    // Bit-rate slider <-> numeric input sync
    inputs.pulseFreq.addEventListener('input', () => { inputs.pulseFreqNum.value = inputs.pulseFreq.value; });
    inputs.pulseFreqNum.addEventListener('input', () => {
        const v = Math.min(10, Math.max(0.5, parseFloat(inputs.pulseFreqNum.value) || 0.5));
        inputs.pulseFreq.value = v;
    });

    // AGC mode toggle: hide manual gain slider, show AGC target
    inputs.agcMode.addEventListener('change', refreshControlUI);

    Object.values(inputs).forEach(input => {
        if (input !== inputs.weatherPreset && input !== inputs.opticsMode) {
            input.addEventListener('input', updateSimulation);
        }
    });

    $('btnShoot').addEventListener('click', () => {
        Sim.Viz.setShooting(true);
        updateSimulation();
        setTimeout(() => { Sim.Viz.setShooting(false); updateSimulation(); }, 1500);
    });
    $('btnDefineAim').addEventListener('click', defineAim);
    $('btnApplyAim').addEventListener('click', applyAimWinner);
    $('sidebarToggle').addEventListener('click', () => toggleSidebar(true));
    $('sidebarExpand').addEventListener('click', () => toggleSidebar(false));

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    initSidebarCollapse();
    initCollapsibles();
    populateWeatherSelects();
    Sim.Viz.init();
    refreshControlUI();
    renderSavedList();
    updateSimulation();
})();
