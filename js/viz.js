/**
 * Charts and canvas visualisations (ray tracer, spot profile, time series,
 * SNR vs distance). UI layer; physics comes from the Sim.* modules.
 */
window.Sim = window.Sim || {};

Sim.Viz = (function () {
    'use strict';

    const C = Sim.Constants;
    const $ = id => document.getElementById(id);

    let rayCanvas, rayCtx, spotCanvas, spotCtx;
    let rawChart, filteredChart, snrChart;
    let isShooting = false;
    let simState = {};

    // Deterministic protocol frame: 8-bit sync 0x7E + pseudo-random payload (LCG).
    // Regenerated (cached) when the pulses-per-frame setting changes.
    const frameCache = {};
    function genFrame(n) {
        if (frameCache[n]) return frameCache[n];
        const bits = [0, 1, 1, 1, 1, 1, 1, 0];
        let seed = 0xBEEF;
        while (bits.length < n) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            bits.push((seed >> 16) & 1);
        }
        return (frameCache[n] = bits.slice(0, n));
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
    // Time-series charts (one 65-bit frame)
    // ------------------------------------------------------------------
    function updateTimeSeriesCharts(p, rx) {
        const frame = genFrame(p.bitsPerFrame);
        const bitPeriodS = 1 / (p.pulseFreqKHz * 1e3);
        const frameS = bitPeriodS * (frame.length + 2);
        // Pulse width exaggerated for display when pulses would be sub-pixel
        const dispPulseS = Math.max(p.pulseWidthNs * 1e-9, bitPeriodS * 0.03);
        const riseS = Math.min(p.riseTimeNs * 1e-9, dispPulseS / 2);

        const nSamples = 700;
        const dt = frameS / nSamples;
        const useMs = frameS > 2e-3;
        const labels = [], rawData = [], filtData = [], satData = [];

        for (let i = 0; i <= nSamples; i++) {
            const t = i * dt;
            labels.push(+(useMs ? t * 1e3 : t * 1e6).toFixed(2));
            satData.push(C.DETECTOR.SYSTEM_VOLTAGE_LIMIT_V);

            const noise = (Math.random() - 0.5) * rx.vNoiseRMS * 3;
            const bitIdx = Math.floor(t / bitPeriodS) - 1;
            let amp = 0;
            if (isShooting && bitIdx >= 0 && bitIdx < frame.length && frame[bitIdx] === 1) {
                const tb = t % bitPeriodS;
                if (tb < riseS) amp = rx.vSignal * (tb / riseS);
                else if (tb < dispPulseS) amp = rx.vSignal;
                else if (tb < dispPulseS + riseS) amp = rx.vSignal * (1 - (tb - dispPulseS) / riseS);
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

        rawChart.options.scales.x.title.text = useMs ? 'Time (ms)' : 'Time (µs)';
        filteredChart.options.scales.x.title.text = useMs ? 'Time (ms)' : 'Time (µs)';
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
    // Public API
    // ------------------------------------------------------------------
    function init() { initCharts(); initCanvases(); }
    function setSimState(s) { simState = s; }
    function setShooting(b) { isShooting = b; }
    function redraw() { drawRayTracer(); drawSpotProfile(); }
    function updateCharts(p, tx, rx, worstRatio) {
        updateTimeSeriesCharts(p, rx);
        updateSnrChart(p, tx, rx, worstRatio);
    }

    return { init, setSimState, setShooting, redraw, updateCharts };
})();
