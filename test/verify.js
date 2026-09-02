/**
 * Verification harness for the physics/safety modules (runs in Node).
 * Loads the browser modules with a global shim and checks them against
 * hand-calculated reference cases from PLAN.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;
global.Sim = {};
['constants.js', 'atmosphere.js', 'optics.js', 'receiver.js', 'safety.js', 'aim.js'].forEach(f => {
    eval(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'));
});

const IEC = Sim.Constants.IEC;
let failures = 0;
function check(name, actual, expected, tol = 0.01) {
    const ok = Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected));
    console.log(`${ok ? '✅' : '❌'} ${name}: got ${actual}, expected ~${expected}`);
    if (!ok) failures++;
}

// --- 1. ISH1 §3 golden test (arithmetic mean + C6 + AEL + ratios) ------
// ISH1 worked example: Class 2 CW visible → AEL = 1 mW × C6; each diode AE = 1 mW.
// single element: α=(1.5+2.2)/2=1.85 mrad → C6=1.233 → AEL=1.23 mW → AE/AEL=0.8
const a1 = (1.5 + 2.2) / 2;
const ael1 = 1e-3 * IEC.C6(a1, 10);
check('ISH1 α single = 1.85 mrad', a1, 1.85, 0);
check('ISH1 AEL single = 1.23 mW', ael1 * 1000, 1.2333, 0.01);
check('ISH1 AE/AEL single = 0.8', 1e-3 / ael1, 0.8108, 0.01);
// vertical two-element group: α=(2.8+2.2)/2=2.5 → C6=1.667 → AEL=1.66 mW → AE/AEL=1.2
const a2 = (2.8 + 2.2) / 2;
const ael2 = 1e-3 * IEC.C6(a2, 10);
check('ISH1 α 2-elem = 2.5 mrad', a2, 2.5, 0);
check('ISH1 AEL 2-elem = 1.66 mW', ael2 * 1000, 1.6667, 0.01);
check('ISH1 AE/AEL 2-elem = 1.2 (most restrictive)', 2e-3 / ael2, 1.2, 0.01);

// --- 2. AEL single pulse, 905 nm, 100 ns, point source ----------------
// AEL_sp = 7.7e-8 × C4(905) J ; C4 = 10^(0.002×205) = 2.5704
check('C4(905 nm)', IEC.C4(905), 2.5704, 0.001);
check('AEL_sp point source (J)', IEC.AEL_class1(100e-9, 905, 1.0), 7.7e-8 * 2.5704, 1e-6);
// α = 4 mrad → C6 = 2.667 (αmax=5 mrad for ns pulses)
check('C6(α=4 mrad, 100 ns)', IEC.C6(4, 100e-9), 2.6667, 0.001);
check('AEL_sp α=4 mrad (J)', IEC.AEL_class1(100e-9, 905, 4), 7.7e-8 * 2.5704 * 8 / 3, 1e-6);

// --- 3. C5 with protocol pulse count ----------------------------------
// N = 65 × 17 × 100 s = 110 500 → 5·N^(−0.25) = 0.274 → floored to 0.4
const N = Sim.Constants.PROTOCOL.MAX_PULSES_PER_S * 100;
check('N (protocol, 100 s)', N, 110500, 0);
check('C5 floor 0.4 (α≤5mrad, t≤Ti)', IEC.C5(N, 2, 100e-9), 0.4, 0);
// Small N: N=16 → 5·16^(−0.25) = 2.5 → capped at 1
check('C5 cap at 1 (N=16)', IEC.C5(16, 2, 100e-9), 1, 0);

// --- 4. T2(α) ----------------------------------------------------------
check('T2(α=1.5 mrad)', IEC.T2(1.5), 10, 0);
check('T2(α=100 mrad)', IEC.T2(100), 100, 0);

// --- 5. Atmosphere -----------------------------------------------------
const tau = Sim.Atmosphere.transmission(23, 905, 200);
check('τ clear 23 km @ 200 m', tau, 0.983, 0.01);
const tauFog = Sim.Atmosphere.transmission(0.5, 905, 200);
console.log(`   (fog 500 m @ 200 m: τ = ${tauFog.toFixed(3)})`);
if (!(tauFog < 0.6)) { console.log('❌ fog attenuation too weak'); failures++; }

// --- 6. Gaussian capture ----------------------------------------------
check('Gaussian capture a=3.5/w=9', Sim.Optics.gaussianCapture1D(3.5, 9), 0.2608, 0.01);

// --- 7. Full classification, default FAC preset ------------------------
const p = {
    iForward: 16, pulseWidthNs: 100, pulseFreqKHz: 500, riseTimeNs: 2,
    emitterWum: 200, emitterHum: 2, rawDivSlowDeg: 12, rawDivFastDeg: 25,
    opticsMode: 'fac', fMainMm: 100, dMainMm: 18, fFacMm: 1, fSlowMm: 100, fFastMm: 20,
    tArPct: 95, distM: 200, visibilityKm: 23, dRxMm: 5, tempC: 25,
    solarIrradiance: 0.8, filterBw: 370, acCoupling: 'after_tia', gain: 100,
    timeBaseS: 100, simplifiedEval: false, minSnrDb: 20
};
const tx = Sim.Optics.computeTxBeam(p);
console.log(`\nTX: peak=${tx.diodePeakPowerW.toFixed(1)} W, capture=${(tx.lensCaptureEff * 100).toFixed(1)}%, ` +
    `P_tx=${tx.pTxEffW.toFixed(2)} W, div=${tx.divOutSlowMrad.toFixed(2)}×${tx.divOutFastMrad.toFixed(2)} mrad, ` +
    `α=${tx.alphaMeanMrad.toFixed(2)} mrad, duty=${(tx.dutyCycle * 100).toFixed(4)}%`);

const safety = Sim.Safety.classify(p, tx);
console.log(`Safety: class=${safety.classification}, worstRatio=${safety.worstRatio.toFixed(2)}, ` +
    `margin=${safety.marginDb.toFixed(1)} dB, C5=${safety.c5.toFixed(2)}, N=${safety.nEff}, ` +
    `limiting=${safety.limiting.criterion} @ ${safety.limiting.condition}`);
safety.conditions.forEach(c => console.log(
    `  ${c.cond.key}: capture=${(c.capture * 100).toFixed(1)}%, AE=${c.aePeakW.toFixed(2)} W, ` +
    `crit1=${c.crit1.ratio.toFixed(2)}, crit2=${c.crit2.ratio.toFixed(2)}, crit3=${c.crit3.ratio.toFixed(2)}`));

// --- 8. Solver boundary: classification must flip at solved current ----
const solver = Sim.Safety.solveMaxClass1(p, tx, safety);
console.log(`Solver: max I = ${solver.maxCurrentA.toFixed(2)} A, max P_tx = ${solver.maxTxPeakPowerW.toFixed(2)} W`);
const pSolved = { ...p, iForward: solver.maxCurrentA };
const txSolved = Sim.Optics.computeTxBeam(pSolved);
const safetySolved = Sim.Safety.classify(pSolved, txSolved);
check('Solver boundary ratio ≈ 1', safetySolved.worstRatio, 1, 0.02);
const pOver = { ...p, iForward: solver.maxCurrentA + 0.5 };
const safetyOver = Sim.Safety.classify(pOver, Sim.Optics.computeTxBeam(pOver));
if (!(safetyOver.worstRatio > 1)) { console.log('❌ classification does not flip above solved current'); failures++; }
else console.log('✅ classification flips above solved current');

// --- 9. NOHD ------------------------------------------------------------
const nohd = Sim.Safety.nohdM(p, tx, safety);
console.log(`NOHD ≈ ${nohd.toFixed(1)} m`);
// sanity: classification at beyond-NOHD distance capture must pass
if (safety.worstRatio > 1 && nohd <= 0) { console.log('❌ NOHD inconsistent'); failures++; }

// --- 10. Receiver sanity -------------------------------------------------
const rx = Sim.Receiver.linkBudget(p, tx, 200);
console.log(`RX @200 m: spot=${(rx.spot.spotW_m * 100).toFixed(1)}×${(rx.spot.spotH_m * 100).toFixed(1)} cm, ` +
    `P_rx=${(rx.rxPowerW * 1e6).toFixed(1)} µW, SNR=${rx.snrDb.toFixed(1)} dB, BW=${(rx.noiseBwHz / 1e6).toFixed(0)} MHz`);
check('Noise BW from 2 ns rise time (Hz)', rx.noiseBwHz, 175e6, 0.001);

// --- 11. Three measurement conditions incl. legacy Cond. 2 (7mm @ 70mm) --
if (safety.conditions.length !== 3) { console.log('❌ expected 3 measurement conditions'); failures++; }
else console.log('✅ 3 measurement conditions evaluated (Cond 1/2/3)');
const c2 = safety.conditions.find(c => c.cond.key === 'cond2');
console.log(`  cond2 (7 mm @ 70 mm): capture=${(c2.capture * 100).toFixed(1)}%, worst=${c2.worstRatio.toFixed(2)}`);

// --- 12. Measured-power lab override --------------------------------------
// Feed a tiny measured avg power into Cond. 3 → its ratios must collapse.
const pMeas = { ...p, measuredMw: { cond3: 0.0001 } }; // 0.1 µW avg
const safetyMeas = Sim.Safety.classify(pMeas, tx);
const c3Meas = safetyMeas.conditions.find(c => c.cond.key === 'cond3');
if (!(c3Meas.measured && c3Meas.worstRatio < 1)) { console.log('❌ measured override not applied'); failures++; }
else console.log(`✅ measured override applied (cond3 AE=${(c3Meas.aePeakW * 1000).toFixed(2)} mW peak-equiv, worst=${c3Meas.worstRatio.toExponential(2)})`);
// Average-power criterion must use the measured average directly:
check('measured avg power → crit2 AE (W)', c3Meas.crit2.ae, 1e-7, 1e-6);

// --- 13. Single fault condition (current-limit short → 25 A) --------------
const pShort = { ...p, iForward: 25 };
const safetyShort = Sim.Safety.classify(pShort, Sim.Optics.computeTxBeam(pShort));
if (!(safetyShort.worstRatio > safety.worstRatio)) { console.log('❌ fault short not worse than normal'); failures++; }
else console.log(`✅ fault short (25 A) is more restrictive: ${safetyShort.worstRatio.toFixed(1)}× vs ${safety.worstRatio.toFixed(1)}×`);

// --- 13b. ISH1 §5 pulse grouping (Tcrit) ---------------------------------
// Default config (α=2 mrad): grouping NOT required.
const epDefault = Sim.Safety.effectivePulse(p, 2);
if (epDefault.grouped) { console.log('❌ grouping wrongly applied at α=2 mrad'); failures++; }
else console.log(`✅ no grouping at α=2 mrad (Tcrit=${(epDefault.tcrit * 1e6).toFixed(1)} µs, bit period=${(epDefault.bitPeriod * 1e6).toFixed(1)} µs)`);
// Large-source config (α=10.1 mrad, single lens f=10mm): frame must group.
const pGrp = { ...p, opticsMode: 'single', fMainMm: 10 };
const txGrp = Sim.Optics.computeTxBeam(pGrp);
console.log(`  grouping config: α_mean=${txGrp.alphaMeanMrad.toFixed(1)} mrad`);
const epGrp = Sim.Safety.effectivePulse(pGrp, txGrp.alphaMeanMrad);
if (!epGrp.grouped) { console.log('❌ grouping NOT applied at α>5 mrad with bit period < Tcrit'); failures++; }
else {
    console.log(`✅ grouping applied: frame=${(epGrp.frameDur * 1e6).toFixed(0)} µs as ONE effective pulse (×${epGrp.eFactor}), rate=${epGrp.rateHz} frames/s, Tcrit=${(epGrp.tcrit * 1e6).toFixed(0)} µs`);
    check('grouped effective pulse duration = frame', epGrp.tEff, epGrp.frameDur, 1e-9);
    check('grouped eFactor = 65 bits', epGrp.eFactor, 65, 0);
}
// Classification must still run and stay finite with grouping
const safetyGrp = Sim.Safety.classify(pGrp, txGrp);
if (!Number.isFinite(safetyGrp.worstRatio)) { console.log('❌ grouped classification not finite'); failures++; }
else console.log(`  grouped config classification: class=${safetyGrp.classification}, worst=${safetyGrp.worstRatio.toFixed(1)}× (α candidate ${safetyGrp.alphaMrad.toFixed(1)} mrad)`);

// --- 14. User-editable wavelength ------------------------------------------
const p850 = { ...p, lambdaNm: 850 };
const tx850 = Sim.Optics.computeTxBeam(p850);
check('λ base 850 nm @ 25 °C', tx850.lambdaNm, 850, 0);
check('C4(850 nm) via TX chain', IEC.C4(tx850.lambdaNm), Math.pow(10, 0.3), 0.001);
const tx850hot = Sim.Optics.computeTxBeam({ ...p850, tempC: 85 });
check('λ drift 850 nm @ 85 °C', tx850hot.lambdaNm, 850 + 0.28 * 60, 0.001);

// --- 15. Adjustable pulse-train protocol ----------------------------------
const pProto = { ...p, bitsPerFrame: 32, framesPerS: 10, pulseFreqKHz: 3.3 };
const txProto = Sim.Optics.computeTxBeam(pProto);
// duty = 100 ns × 32 × 10 = 3.2e-7
check('custom protocol duty cycle', txProto.dutyCycle, 100e-9 * 32 * 10, 1e-9);
const safetyProto = Sim.Safety.classify(pProto, txProto);
// N = 320 pulses/s × min(100 s, T2=10.12 s) ≈ 3237 (no Ti merge at 3.3 kHz)
check('custom protocol N', safetyProto.nEff, Math.round(32 * 10 * safetyProto.evalDur), 0.01);
console.log(`  custom protocol: duty=${(txProto.dutyCycle * 100).toFixed(4)}%, N=${safetyProto.nEff}, C5=${safetyProto.c5.toFixed(2)}`);

// --- 16. AGC + electronics chain -------------------------------------------
const rxNow = Sim.Receiver.linkBudget(p, tx, 200);
const pAgc = { ...p, agcOn: true, agcTargetV: 1.0 };
const rxAgc = Sim.Receiver.linkBudget(pAgc, tx, 200);
check('AGC gain = target / I_signal', rxAgc.gainUsed, 1.0 / rxAgc.iSignal, 0.001);
check('AGC V_signal hits target', rxAgc.vSignal, 1.0, 0.01);
const chain = Sim.Receiver.evalChain({ ...pAgc, compThreshMv: 50, monoStretchUs: 10 }, rxAgc);
console.log(`  chain @200m AGC: detect=${chain.detectOk}, clip=${chain.clipping}, clean=${chain.clean}, margin=${chain.marginDb.toFixed(1)} dB`);
if (!chain.detectOk) { console.log('❌ AGC chain should detect 1 V signal at 50 mV threshold'); failures++; }
// comparator must reject a tiny signal
const chainWeak = Sim.Receiver.evalChain({ ...p, compThreshMv: 50, monoStretchUs: 10 },
    { ...rxNow, vSignal: 0.001, vNoiseRMS: rxNow.vNoiseRMS });
if (chainWeak.detectOk) { console.log('❌ comparator accepted sub-threshold signal'); failures++; }
else console.log('✅ comparator rejects sub-threshold signal');
// monostable stretch
check('monostable stretch 100 ns → 10 µs', chain.monoOutUs, 10, 0);

// --- 17. Aim module --------------------------------------------------------
console.log('\n--- Aim module ---');

// Spot check
const pSpotOk = { ...p, opticsMode: 'fac', fMainMm: 125, fFacMm: 2.0, dMainMm: 18 };
const txSpotOk = Sim.Optics.computeTxBeam(pSpotOk);
const spotOk = Sim.Aim.checkSpot(pSpotOk, txSpotOk);
console.log(`  spot check (FAC 125/2 mm, Ø18): ${spotOk.ok ? 'PASS' : 'FAIL'} — ${(spotOk.w*100).toFixed(1)}×${(spotOk.h*100).toFixed(1)} cm`);
if (!spotOk.ok) { console.log('❌ spot should pass 20-40 cm ±10%'); failures++; }
else console.log('✅ spot constraint satisfied');

// Cost
const cost = Sim.Aim.totalCost({ ...pSpotOk, opticsMode: 'fac', dRxMm: 5, filterBw: 370, agcOn: false });
check('Aim totalCost FAC+18+5+370', cost, 18 + 35 + 45 + 5 + 5, 0);

// Solve tests (async)
function runAimTests() {
    return new Promise(resolve => {
        const anchors = Sim.Aim.DEFAULT_ANCHORS;

        // Exact fit
        Sim.Aim.solve(p, anchors, 'exact',
            () => {},
            bestExact => {
                if (!bestExact) { console.log('❌ Aim exact mode found no candidate'); failures++; }
                else {
                    console.log(`✅ Aim exact mode: score=${bestExact.score.toFixed(1)}, cost=€${bestExact.cost}, spot=${(bestExact.spot.w*100).toFixed(1)}×${(bestExact.spot.h*100).toFixed(1)} cm`);
                    if (!bestExact.safety || bestExact.safety.worstRatio > 1) { console.log('❌ exact candidate not Class 1'); failures++; }
                }

                // Envelope mode
                Sim.Aim.solve(p, anchors, 'envelope',
                    () => {},
                    bestEnv => {
                        if (!bestEnv) { console.log('❌ Aim envelope mode found no candidate'); failures++; }
                        else {
                            console.log(`✅ Aim envelope mode: score=${bestEnv.score.toFixed(1)}, cost=€${bestEnv.cost}`);
                            const iFog = bestEnv.currents[0];
                            const i5m  = bestEnv.currents[2];
                            if (iFog < 280e-9) { console.log(`❌ envelope 200m fog ${(iFog*1e9).toFixed(1)} nA < 280 nA`); failures++; }
                            else console.log(`   200m fog ≥ 280 nA: ${(iFog*1e9).toFixed(1)} nA`);
                            if (i5m > 2.5e-3) { console.log(`❌ envelope 5m clear ${(i5m*1e3).toFixed(2)} mA > 2.5 mA`); failures++; }
                            else console.log(`   5m clear ≤ 2.5 mA: ${(i5m*1e3).toFixed(2)} mA`);
                        }
                        resolve();
                    }
                );
            }
        );
    });
}

// --- 18. Regression: clipped-beam near-field diameter --------------------
// Ø18 mm lens clips the ~21 mm incident slow-axis beam → spot at d=0 must
// start at 18 mm (min), not 21 mm (max).
const spot0 = Sim.Optics.spotAtDistance(p, tx, 0);
check('near-field spot starts at clipped beam Ø (m)', spot0.spotW_m, 0.018, 0.001);

// --- 19. Simplified-eval consistency (α = αmin everywhere) ----------------
const safetySimpl = Sim.Safety.classify({ ...p, simplifiedEval: true }, tx);
check('simplified: α candidate = αmin', safetySimpl.alphaMrad, 1.5, 0);
check('simplified: C5 = 1', safetySimpl.c5, 1, 0);
if (safetySimpl.effectivePulse.grouped) { console.log('❌ ISH1 §5 grouping triggered in simplified mode'); failures++; }
const safetyGrpSimpl = Sim.Safety.classify({ ...pGrp, simplifiedEval: true }, txGrp);
if (safetyGrpSimpl.effectivePulse.grouped) { console.log('❌ grouping in simplified mode (large source)'); failures++; }
else console.log('✅ no ISH1 §5 grouping in simplified mode, even for a large source');

// --- 20. NOHD stays finite with measured-power override --------------------
const pMeasBig = { ...p, measuredMw: { cond3: 0.5 } }; // 0.5 mW avg → fails Class 1
const safetyMeasBig = Sim.Safety.classify(pMeasBig, tx);
const nohdMeas = Sim.Safety.nohdM(pMeasBig, tx, safetyMeasBig);
if (!Number.isFinite(nohdMeas)) { console.log('❌ NOHD not finite with measured override'); failures++; }
else console.log(`✅ NOHD finite with measured override: ${nohdMeas.toFixed(1)} m`);

// --- 21. Aim: fault mode respected + envelope anchor guard -----------------
const candFault = Sim.Aim.evalCandidate({ ...pSpotOk, faultMode: 'short', iForward: 1.0 },
    Sim.Aim.DEFAULT_ANCHORS, 'exact');
if (candFault) { console.log('❌ aim accepted candidate failing Class 1 under short fault'); failures++; }
else console.log('✅ aim rejects candidate that fails Class 1 under short fault');
let guardOk = false;
try {
    guardOk = Sim.Aim.evalCandidate(pSpotOk, Sim.Aim.DEFAULT_ANCHORS.slice(0, 2), 'envelope') === null;
} catch (e) { guardOk = false; }
if (!guardOk) { console.log('❌ envelope mode did not cleanly reject <3 anchors'); failures++; }
else console.log('✅ envelope mode rejects <3 anchors');

runAimTests().then(() => {
    console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED' : `\n💥 ${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
});
