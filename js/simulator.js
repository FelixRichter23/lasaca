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

    const inputs = {
        driveCurrent: $('driveCurrent'),
        pulseWidth: $('pulseWidth'),
        pulseFreq: $('pulseFreq'),
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
        timeBase: $('timeBase'),
        simplifiedEval: $('simplifiedEval'),
        faultMode: $('faultMode'),
        minSnr: $('minSnr'),
        measCond1: $('measCond1'),
        measCond2: $('measCond2'),
        measCond3: $('measCond3')
    };

    let rayCanvas, rayCtx, spotCanvas, spotCtx;
    let rawChart, filteredChart, snrChart;
    let isShooting = false;
    let simState = {};

    // Deterministic 65-bit protocol frame: 8-bit sync 0x7E + 57-bit payload (LCG)
    const DATA_FRAME = (function () {
        const bits = [0, 1, 1, 1, 1, 1, 1, 0];
        let seed = 0xBEEF;
        while (bits.length < PROT.BITS_PER_FRAME) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            bits.push((seed >> 16) & 1);
        }
        return bits;
    })();

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
            pulseFreqKHz: parseFloat(inputs.pulseFreq.value),
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
            tArPct: parseFloat(inputs.lensTransmission.value),
            distM: parseFloat(inputs.distance.value),
            visibilityKm,
            dRxMm: parseFloat(inputs.lensDiameterRx.value),
            tempC: parseFloat(inputs.operatingTemp.value),
            solarIrradiance: parseFloat(inputs.solarIrradiance.value),
            filterBw: parseFloat(inputs.sensorFilter.value),
            acCoupling: inputs.acCoupling.value,
            gain: parseFloat(inputs.tiaGain.value),
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

    /** Effective drive current under the selected single-fault condition (§5.1). */
    function effCurrent(p) {
        if (p.faultMode === 'plus10') return Math.min(C.DIODE.MAX_DRIVE_CURRENT_A, p.iForward * C.DIODE.FAULT_CURRENT_MULT);
        if (p.faultMode === 'short') return C.DIODE.MAX_DRIVE_CURRENT_A;
        return p.iForward;
    }

    // ------------------------------------------------------------------
    // Charts
    // ------------------------------------------------------------------
    function initCharts() {
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.font.family = "'JetBrains Mono', monospace";

        const commonScales = {
            x: { title: { display: true, text: 'Time (µs)' }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: {
                title: { display: true, text: 'Voltage (V)' },
                grid: { color: 'rgba(255,255,255,0.05)' },
                suggestedMin: -0.1, suggestedMax: 2.0
            }
        };
        const commonOptions = {
            responsive: true, maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: { legend: { display: false } }
        };

        rawChart = new Chart($('rawChart').getContext('2d'), {
            type: 'line', data: { labels: [], datasets: [] },
            options: { ...commonOptions, scales: JSON.parse(JSON.stringify(commonScales)) }
        });
        filteredChart = new Chart($('filteredChart').getContext('2d'), {
            type: 'line', data: { labels: [], datasets: [] },
            options: { ...commonOptions, scales: JSON.parse(JSON.stringify(commonScales)) }
        });
        snrChart = new Chart($('snrChart').getContext('2d'), {
            type: 'line', data: { labels: [], datasets: [] },
            options: {
                responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
                plugins: { legend: { display: true, labels: { boxWidth: 12 } } },
                scales: {
                    x: { title: { display: true, text: 'Distance (m)' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { title: { display: true, text: 'SNR (dB)' }, grid: { color: 'rgba(255,255,255,0.05)' } }
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // Canvases
    // ------------------------------------------------------------------
    function initCanvases() {
        rayCanvas = $('rayCanvas'); rayCtx = rayCanvas.getContext('2d');
        spotCanvas = $('spotCanvas'); spotCtx = spotCanvas.getContext('2d');

        function resize() {
            const dpr = window.devicePixelRatio || 1;
            [[rayCanvas, rayCtx, drawRayTracer], [spotCanvas, spotCtx, drawSpotProfile]]
                .forEach(([cv, ctx, draw]) => {
                    if (!cv || !cv.parentElement) return;
                    const rect = cv.parentElement.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        cv.width = rect.width * dpr;
                        cv.height = rect.height * dpr;
                        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                        draw();
                    }
                });
        }
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(() => window.requestAnimationFrame(resize));
            [rayCanvas, spotCanvas].forEach(cv => cv && cv.parentElement && ro.observe(cv.parentElement));
            const mc = document.querySelector('.main-content');
            if (mc) ro.observe(mc);
        }
        window.addEventListener('resize', () => window.requestAnimationFrame(resize));
        setTimeout(resize, 50);
    }

    // ------------------------------------------------------------------
    // Optics-mode control visibility
    // ------------------------------------------------------------------
    function updateOpticsModeUI() {
        const mode = inputs.opticsMode.value;
        const show = { ctrlMainFocal: false, ctrlMainDiameter: true, ctrlFacFocal: false, ctrlFocalSlow: false, ctrlFocalFast: false };
        let badge = 'Manual Override';
        if (mode === 'single') { show.ctrlMainFocal = true; badge = 'Single Collimator Lens'; }
        else if (mode === 'fac') { show.ctrlMainFocal = true; show.ctrlFacFocal = true; badge = 'FAC + Main Collimator'; }
        else if (mode === 'anamorphic') { show.ctrlFocalSlow = true; show.ctrlFocalFast = true; badge = 'Anamorphic Cylindrical Pair'; }
        Object.entries(show).forEach(([id, vis]) => { $(id).style.display = vis ? 'block' : 'none'; });
        $('opticsBadge').innerText = badge;
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
        const pFault = { ...p, iForward: effCurrent(p) };
        const txFault = p.faultMode === 'normal' ? tx : Sim.Optics.computeTxBeam(pFault);
        const safetyNormal = Sim.Safety.classify(p, tx);
        const safetyFault = p.faultMode === 'normal' ? safetyNormal : Sim.Safety.classify(pFault, txFault);
        const worstIsFault = safetyFault.worstRatio > safetyNormal.worstRatio;
        const safetyWorst = worstIsFault ? safetyFault : safetyNormal;
        const safetyView = p.faultMode === 'normal' ? safetyNormal : safetyFault;
        const txWorst = worstIsFault ? txFault : tx;
        const pWorst = worstIsFault ? pFault : p;
        const combinedRatio = safetyWorst.worstRatio;

        const solver = Sim.Safety.solveMaxClass1(p, tx, safetyWorst);
        const nohd = Sim.Safety.nohdM(pWorst, txWorst, safetyWorst);

        // ---- Diode / duty cycle -----------------------------------------
        $('calcPeakPowerTxt').innerText = tx.diodePeakPowerW.toFixed(1);
        const dutyPct = tx.dutyCycle * 100;
        $('calcDutyCycle').innerText = `${dutyPct.toFixed(4)}%`;
        if (tx.dutyCycle > C.DIODE.MAX_DUTY_CYCLE) {
            $('dutyCycleStatus').innerText = '⚠️ EXCEEDS 0.1% MAX RATING!';
            $('dutyCycleBadge').className = 'duty-cycle-badge warning';
        } else {
            $('dutyCycleStatus').innerText = '✅ OK (≤ 0.1% max)';
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
        renderSafetyPanel(p, tx, { safetyNormal, safetyFault, safetyWorst, safetyView, worstIsFault }, solver, nohd);

        // ---- Canvas state -------------------------------------------------
        simState = {
            opticsMode: p.opticsMode, fMainMm: p.fMainMm, dMainMm: p.dMainMm, fFacMm: p.fFacMm,
            rawDivFastDeg: p.rawDivFastDeg, lensCaptureEff: tx.lensCaptureEff,
            spotW_m: rx.spot.spotW_m, spotH_m: rx.spot.spotH_m, dRxMm: p.dRxMm
        };
        drawRayTracer();
        drawSpotProfile();

        // ---- Charts -------------------------------------------------------
        updateTimeSeriesCharts(p, rx);
        updateSnrChart(p, tx, rx, combinedRatio);
    }

    // ------------------------------------------------------------------
    // Safety panel rendering
    // ------------------------------------------------------------------
    function fmtRatio(r) {
        const cls = r <= 1 ? 'pass' : 'fail';
        const margin = 10 * Math.log10(1 / r);
        return `<span class="ratio ${cls}">${r.toFixed(2)}×</span><small>${margin >= 0 ? '+' : ''}${margin.toFixed(1)} dB</small>`;
    }

    function renderSafetyPanel(p, tx, modes, solver, nohd) {
        const { safetyNormal, safetyFault, safetyWorst, safetyView, worstIsFault } = modes;
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
            <div><small>Tcrit / grouping</small><strong>${(ep.tcrit * 1e6).toFixed(1)} µs / ${ep.grouped ? '⚠️ frame grouped' : 'not required'}</strong></div>
            <div><small>T2 / eval duration</small><strong>${safety.t2.toFixed(1)} s / ${safety.evalDur.toFixed(1)} s</strong></div>
            <div><small>λ (temp drift)</small><strong>${tx.lambdaNm.toFixed(1)} nm</strong></div>
            <div><small>Protocol rate</small><strong>${PROT.MAX_PULSES_PER_S} pulses/s</strong></div>
            <div><small>α candidate used</small><strong>${safety.alphaMrad.toFixed(2)} of ${safety.alphaRealMrad.toFixed(2)} mrad</strong></div>`;

        // Conditions table
        $('safetyTableBody').innerHTML = safety.conditions.map(c => `
            <tr>
                <td>${c.cond.label}<br><small>${c.measured ? '🧪 measured override' : `capture ${(c.capture * 100).toFixed(1)}%`}</small></td>
                <td>${c.aePeakW >= 1 ? c.aePeakW.toFixed(2) + ' W' : (c.aePeakW * 1000).toFixed(2) + ' mW'}</td>
                <td>${fmtRatio(c.crit1.ratio)}</td>
                <td>${fmtRatio(c.crit2.ratio)}</td>
                <td>${fmtRatio(c.crit3.ratio)}</td>
            </tr>`).join('');
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
    // Time-series charts (one 65-bit frame)
    // ------------------------------------------------------------------
    function updateTimeSeriesCharts(p, rx) {
        const bitPeriodS = 1 / (p.pulseFreqKHz * 1e3);
        const frameS = bitPeriodS * (DATA_FRAME.length + 2);
        const pulseS = p.pulseWidthNs * 1e-9;
        const riseS = p.riseTimeNs * 1e-9;

        const nSamples = 700;
        const dt = frameS / nSamples;
        const labels = [], rawData = [], filtData = [], satData = [];

        for (let i = 0; i <= nSamples; i++) {
            const t = i * dt;
            labels.push(+(t * 1e6).toFixed(2)); // µs
            satData.push(C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V);

            const noise = (Math.random() - 0.5) * rx.vNoiseRMS * 3;
            const bitIdx = Math.floor(t / bitPeriodS) - 1;
            let amp = 0;
            if (isShooting && bitIdx >= 0 && bitIdx < DATA_FRAME.length && DATA_FRAME[bitIdx] === 1) {
                const tb = t % bitPeriodS;
                if (tb < riseS) amp = rx.vSignal * (tb / riseS);
                else if (tb < pulseS) amp = rx.vSignal;
                else if (tb < pulseS + riseS) amp = rx.vSignal * (1 - (tb - pulseS) / riseS);
            }

            let vRaw = rx.vSolarTIA + amp + noise;
            vRaw = Math.min(C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V, Math.max(0, vRaw));
            rawData.push(vRaw);

            let vFilt;
            if (p.acCoupling === 'after_tia') {
                vFilt = amp + noise;
                if (rx.vSolarTIA >= C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V) vFilt = noise;
                else if (rx.vSolarTIA + amp > C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V) {
                    vFilt = Math.max(0, amp - (rx.vSolarTIA + amp - C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V)) + noise;
                }
            } else {
                vFilt = vRaw;
            }
            filtData.push(vFilt);
        }

        rawChart.options.scales.y.max = Math.max(C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V + 0.5, (rx.vSolarTIA + rx.vSignal) * 1.3, 1);
        filteredChart.options.scales.y.max = Math.max(1, (rx.vSignal + rx.vNoiseRMS * 3) * 1.4);

        rawChart.data.labels = labels;
        rawChart.data.datasets = [
            { label: 'Raw Sensor Voltage', data: rawData, borderColor: '#ff3366', backgroundColor: 'rgba(255,51,102,0.1)', borderWidth: 1.5, fill: true, tension: 0.1, pointRadius: 0 },
            { label: 'Op-Amp Saturation (5V)', data: satData, borderColor: 'rgba(255,255,255,0.4)', borderWidth: 1, borderDash: [5, 5], fill: false, pointRadius: 0 }
        ];
        rawChart.update();

        filteredChart.data.labels = labels;
        filteredChart.data.datasets = [
            { label: 'Filtered Signal (Data Frame)', data: filtData, borderColor: '#00e5ff', backgroundColor: 'rgba(0,229,255,0.1)', borderWidth: 1.5, fill: true, tension: 0.1, pointRadius: 0 }
        ];
        filteredChart.update();
    }

    // ------------------------------------------------------------------
    // SNR vs distance chart (current + Class-1 limited)
    // ------------------------------------------------------------------
    function updateSnrChart(p, tx, rx, worstRatio) {
        const dists = [], cur = [], lim = [], thr = [];
        const scale = Math.min(1, 1 / worstRatio);
        const txLim = { ...tx, pTxEffW: tx.pTxEffW * scale };

        for (let d = 10; d <= 500; d += 10) {
            dists.push(d);
            cur.push(+Sim.Receiver.linkBudget(p, tx, d).snrDb.toFixed(2));
            lim.push(+Sim.Receiver.linkBudget(p, txLim, d).snrDb.toFixed(2));
            thr.push(p.minSnrDb);
        }

        const pointData = dists.map(d => d === p.distM ? rx.snrDb : null);

        snrChart.data.labels = dists;
        snrChart.data.datasets = [
            { label: 'SNR (current power)', data: cur, borderColor: '#00ff88', backgroundColor: 'rgba(0,255,136,0.08)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0 },
            { label: 'SNR (Class-1 limited)', data: lim, borderColor: '#ffb703', borderWidth: 2, borderDash: [6, 4], fill: false, tension: 0.2, pointRadius: 0 },
            { label: 'Min. usable SNR', data: thr, borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1, borderDash: [3, 4], fill: false, pointRadius: 0 },
            { label: 'Current setup', data: pointData, borderColor: '#ff3366', backgroundColor: '#ff3366', pointRadius: 6, pointHoverRadius: 8, type: 'scatter' }
        ];
        snrChart.update();
    }

    // ------------------------------------------------------------------
    // Ray tracer canvas
    // ------------------------------------------------------------------
    function drawRayTracer() {
        if (!rayCtx || !rayCanvas) return;
        if (!Number.isFinite(simState.dMainMm) || !Number.isFinite(simState.lensCaptureEff)) return;
        const w = rayCanvas.parentElement.clientWidth;
        const h = rayCanvas.parentElement.clientHeight;
        rayCtx.clearRect(0, 0, w, h);

        rayCtx.strokeStyle = 'rgba(255,255,255,0.04)';
        rayCtx.lineWidth = 1;
        for (let x = 0; x < w; x += 30) { rayCtx.beginPath(); rayCtx.moveTo(x, 0); rayCtx.lineTo(x, h); rayCtx.stroke(); }
        for (let y = 0; y < h; y += 30) { rayCtx.beginPath(); rayCtx.moveTo(0, y); rayCtx.lineTo(w, y); rayCtx.stroke(); }

        const cy = h / 2;
        rayCtx.strokeStyle = 'rgba(255,255,255,0.2)';
        rayCtx.setLineDash([4, 4]);
        rayCtx.beginPath(); rayCtx.moveTo(20, cy); rayCtx.lineTo(w - 20, cy); rayCtx.stroke();
        rayCtx.setLineDash([]);

        const diodeX = 50, mainLensX = w * 0.65, facX = diodeX + 45;

        rayCtx.fillStyle = '#ff3366';
        rayCtx.fillRect(diodeX - 12, cy - 18, 12, 36);
        rayCtx.fillStyle = '#ffffff';
        rayCtx.fillRect(diodeX - 2, cy - 6, 4, 12);
        rayCtx.fillStyle = '#94a3b8';
        rayCtx.font = '10px "JetBrains Mono"';
        rayCtx.fillText('Diode (905nm)', diodeX - 25, cy + 32);

        const hasFAC = simState.opticsMode === 'fac';
        const mainLensHeight = Math.min(h - 40, (simState.dMainMm / 25) * 80);

        if (hasFAC) {
            rayCtx.fillStyle = 'rgba(0,229,255,0.25)';
            rayCtx.strokeStyle = '#00e5ff';
            rayCtx.lineWidth = 2;
            rayCtx.beginPath();
            rayCtx.ellipse(facX, cy, 6, 22, 0, 0, Math.PI * 2);
            rayCtx.fill(); rayCtx.stroke();
            rayCtx.fillStyle = '#00e5ff';
            rayCtx.fillText(`FAC (f=${simState.fFacMm}mm)`, facX - 25, cy - 28);
        }

        rayCtx.fillStyle = 'rgba(0,255,136,0.2)';
        rayCtx.strokeStyle = '#00ff88';
        rayCtx.lineWidth = 2;
        rayCtx.beginPath();
        rayCtx.ellipse(mainLensX, cy, 10, mainLensHeight / 2, 0, 0, Math.PI * 2);
        rayCtx.fill(); rayCtx.stroke();
        rayCtx.fillStyle = '#00ff88';
        rayCtx.fillText(`Lens Ø${simState.dMainMm}mm (f=${simState.fMainMm}mm)`, mainLensX - 45, cy - (mainLensHeight / 2) - 8);

        const numRays = 7;
        const rawFastAngle = (simState.rawDivFastDeg * Math.PI) / 180;
        for (let i = 0; i < numRays; i++) {
            const factor = (i - (numRays - 1) / 2) / ((numRays - 1) / 2);
            const angle = factor * (rawFastAngle / 2);

            if (hasFAC) {
                const yAtFac = cy + Math.tan(angle) * (facX - diodeX) * 2.5;
                rayCtx.strokeStyle = 'rgba(255,51,102,0.7)';
                rayCtx.lineWidth = 1.5;
                rayCtx.beginPath(); rayCtx.moveTo(diodeX, cy); rayCtx.lineTo(facX, yAtFac); rayCtx.stroke();

                const yAtMain = yAtFac;
                const captured = Math.abs(yAtMain - cy) <= (mainLensHeight / 2);
                rayCtx.strokeStyle = captured ? 'rgba(0,229,255,0.7)' : 'rgba(255,51,102,0.4)';
                rayCtx.beginPath(); rayCtx.moveTo(facX, yAtFac); rayCtx.lineTo(mainLensX, yAtMain); rayCtx.stroke();
                rayCtx.strokeStyle = captured ? '#00e5ff' : 'rgba(255,51,102,0.3)';
                rayCtx.beginPath(); rayCtx.moveTo(mainLensX, yAtMain); rayCtx.lineTo(w - 20, yAtMain + factor * 3); rayCtx.stroke();
            } else {
                const yAtMain = cy + Math.tan(angle) * (mainLensX - diodeX) * 0.8;
                const captured = Math.abs(yAtMain - cy) <= (mainLensHeight / 2);
                if (captured) {
                    rayCtx.strokeStyle = '#00e5ff';
                    rayCtx.lineWidth = 1.5;
                    rayCtx.beginPath(); rayCtx.moveTo(diodeX, cy); rayCtx.lineTo(mainLensX, yAtMain); rayCtx.lineTo(w - 20, yAtMain * 0.95 + cy * 0.05); rayCtx.stroke();
                } else {
                    rayCtx.strokeStyle = '#ff3366';
                    rayCtx.lineWidth = 1.2;
                    rayCtx.setLineDash([4, 4]);
                    rayCtx.beginPath(); rayCtx.moveTo(diodeX, cy); rayCtx.lineTo(mainLensX + 20, yAtMain * 1.05); rayCtx.stroke();
                    rayCtx.setLineDash([]);
                }
            }
        }

        rayCtx.fillStyle = '#fff';
        rayCtx.font = '11px "JetBrains Mono"';
        rayCtx.fillText(`Optical Transmission: ${(simState.lensCaptureEff * 100).toFixed(1)}%`, w - 200, 25);
    }

    // ------------------------------------------------------------------
    // Spot profile canvas
    // ------------------------------------------------------------------
    function drawSpotProfile() {
        if (!spotCtx || !spotCanvas) return;
        if (!Number.isFinite(simState.spotW_m) || !Number.isFinite(simState.spotH_m) ||
            simState.spotW_m <= 0 || simState.spotH_m <= 0) return;
        const w = spotCanvas.parentElement.clientWidth;
        const h = spotCanvas.parentElement.clientHeight;
        spotCtx.clearRect(0, 0, w, h);

        const cx = w / 2, cy = h / 2;
        spotCtx.strokeStyle = 'rgba(255,255,255,0.08)';
        spotCtx.lineWidth = 1;
        spotCtx.beginPath();
        spotCtx.moveTo(cx, 10); spotCtx.lineTo(cx, h - 10);
        spotCtx.moveTo(10, cy); spotCtx.lineTo(w - 10, cy);
        spotCtx.stroke();

        const scale = Math.min(w, h) / Math.max(1.0, Math.max(simState.spotW_m, simState.spotH_m) * 1.4);
        [0.1, 0.25, 0.5, 1.0].forEach(radiusM => {
            const rPx = radiusM * scale;
            if (rPx < Math.min(w, h) / 2) {
                spotCtx.strokeStyle = 'rgba(255,255,255,0.04)';
                spotCtx.beginPath(); spotCtx.arc(cx, cy, rPx, 0, Math.PI * 2); spotCtx.stroke();
                spotCtx.fillStyle = 'rgba(255,255,255,0.2)';
                spotCtx.font = '9px "JetBrains Mono"';
                spotCtx.fillText(`${radiusM * 100}cm`, cx + 4, cy - rPx + 10);
            }
        });

        const rxPx = (simState.spotW_m / 2) * scale;
        const ryPx = (simState.spotH_m / 2) * scale;
        const grad = spotCtx.createRadialGradient(cx, cy, 2, cx, cy, Math.max(rxPx, ryPx));
        grad.addColorStop(0, 'rgba(255,51,102,0.85)');
        grad.addColorStop(0.5, 'rgba(0,229,255,0.45)');
        grad.addColorStop(0.85, 'rgba(0,229,255,0.15)');
        grad.addColorStop(1, 'transparent');
        spotCtx.fillStyle = grad;
        spotCtx.beginPath(); spotCtx.ellipse(cx, cy, rxPx, ryPx, 0, 0, Math.PI * 2); spotCtx.fill();
        spotCtx.strokeStyle = '#00e5ff';
        spotCtx.lineWidth = 1.5;
        spotCtx.beginPath(); spotCtx.ellipse(cx, cy, rxPx, ryPx, 0, 0, Math.PI * 2); spotCtx.stroke();

        const rxLensPx = ((simState.dRxMm * 1e-3) / 2) * scale;
        spotCtx.fillStyle = 'rgba(255,183,3,0.7)';
        spotCtx.strokeStyle = '#ffb703';
        spotCtx.lineWidth = 2;
        spotCtx.beginPath(); spotCtx.arc(cx, cy, Math.max(3, rxLensPx), 0, Math.PI * 2); spotCtx.fill(); spotCtx.stroke();

        spotCtx.fillStyle = '#fff';
        spotCtx.font = '11px "JetBrains Mono"';
        spotCtx.fillText(`W: ${(simState.spotW_m * 100).toFixed(1)} cm`, cx + rxPx + 8, cy + 4);
        spotCtx.fillText(`H: ${(simState.spotH_m * 100).toFixed(1)} cm`, cx - 35, cy - ryPx - 8);
        spotCtx.fillStyle = '#ffb703';
        spotCtx.font = '10px "JetBrains Mono"';
        spotCtx.fillText(`● RX Lens (${simState.dRxMm}mm)`, 15, h - 15);
    }

    // ------------------------------------------------------------------
    // Presets
    // ------------------------------------------------------------------
    function setPreset(name) {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));

        const base = {
            driveCurrent: '16.0', pulseWidth: '100', pulseFreq: '500', riseTime: '2',
            emitterWidth: '200', emitterHeight: '2.0', rawDivSlow: '12.0', rawDivFast: '25.0',
            lensDiameterTx: '18', lensTransmission: '95', lensDiameterRx: '5',
            tiaGain: '100', acCoupling: 'after_tia', sensorFilter: '370',
            weatherPreset: 'clear', solarIrradiance: '0.8'
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
            updateOpticsModeUI();
            applyClass1Solver();
            return;
        }

        updateOpticsModeUI();
        updateSimulation();
    }

    function applyValues(map) {
        Object.entries(map).forEach(([k, v]) => { if (inputs[k]) inputs[k].value = v; });
        $('ctrlVisibility').style.display = inputs.weatherPreset.value === 'custom' ? 'block' : 'none';
    }

    /** Run the Class-1 solver (worst of normal + fault) and clamp the slider. */
    function applyClass1Solver() {
        const p = buildParams();
        const tx = Sim.Optics.computeTxBeam(p);
        const pFault = { ...p, iForward: effCurrent(p) };
        const txFault = p.faultMode === 'normal' ? tx : Sim.Optics.computeTxBeam(pFault);
        const sN = Sim.Safety.classify(p, tx);
        const sF = p.faultMode === 'normal' ? sN : Sim.Safety.classify(pFault, txFault);
        const worst = sF.worstRatio > sN.worstRatio ? sF : sN;
        const solver = Sim.Safety.solveMaxClass1(p, tx, worst);
        inputs.driveCurrent.value = Math.max(1, solver.maxCurrentA).toFixed(1);
        updateSimulation();
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
    // Events
    // ------------------------------------------------------------------
    $('preset100mm').addEventListener('click', () => setPreset('100mm'));
    $('presetFAC100mm').addEventListener('click', () => setPreset('fac100mm'));
    $('presetAnamorphic').addEventListener('click', () => setPreset('anamorphic'));
    $('presetDatasheet').addEventListener('click', () => setPreset('datasheet'));
    $('presetClass1').addEventListener('click', () => setPreset('class1'));
    $('presetNight').addEventListener('click', () => setPreset('night'));
    $('btnClass1Max').addEventListener('click', applyClass1Solver);

    inputs.opticsMode.addEventListener('change', () => { updateOpticsModeUI(); updateSimulation(); });
    inputs.weatherPreset.addEventListener('change', () => {
        $('ctrlVisibility').style.display = inputs.weatherPreset.value === 'custom' ? 'block' : 'none';
        updateSimulation();
    });

    Object.values(inputs).forEach(input => {
        if (input !== inputs.weatherPreset && input !== inputs.opticsMode) {
            input.addEventListener('input', updateSimulation);
        }
    });

    $('btnShoot').addEventListener('click', () => {
        isShooting = true;
        updateSimulation();
        setTimeout(() => { isShooting = false; updateSimulation(); }, 1500);
    });

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    initCollapsibles();
    initCharts();
    initCanvases();
    updateOpticsModeUI();
    updateSimulation();
})();
