/**
 * Global namespace and constants for the Lasertag Optics & Safety Simulator.
 *
 * Sources:
 *  - OSRAM SPL PL90AT03 datasheet (poc/files/SPL PL90AT03_EN.pdf)
 *  - OSRAM BPW 34 FAS datasheet (poc/files/BPW 34 FAS_EN.pdf)
 *  - EN 60825-1:2014+A11:2021 (CENELEC adoption of IEC 60825-1:2014 incl.
 *    corrigenda and Interpretation Sheets ISH1/ISH2)
 *  - IEC 60825-1:2014 Interpretation Sheets ISH1/ISH2 preview
 *    (poc/files/info_iec60825-1{ed3.0}b.pdf, extracted text: iec_sheet.txt)
 *  - German research report on IEC 60825-1 AEL tables
 *    (poc/files/research-in-german-for-iec-spec.txt)
 *
 * NOTE: The numeric AEL base tables (EN 60825-1:2014+A11:2021 Tables 3/4/9/10)
 * are paywalled. Values below taken from the research report, ISH1/ISH2 text
 * and other public sources are marked with `// VERIFY:` and must be checked
 * against the official standard before any product release.
 */
window.Sim = window.Sim || {};

Sim.Constants = (function () {
    'use strict';

    const C = {};

    // ------------------------------------------------------------------
    // Physical constants
    // ------------------------------------------------------------------
    C.Q_E = 1.602e-19;  // Elementary charge [C]
    C.K_B = 1.381e-23;  // Boltzmann constant [J/K]

    // ------------------------------------------------------------------
    // Receiver amplifier (TIA) defaults — user-adjustable in the UI
    // ------------------------------------------------------------------
    C.AMPLIFIER = {
        AMP_TEMP_C_DEFAULT: 40,        // amplifier temperature [°C]
        TIA_RF_OHM_DEFAULT: 10e3       // TIA feedback resistor R_f [Ω] (= manual gain V/A)
    };

    // ------------------------------------------------------------------
    // OSRAM SPL PL90AT03 laser diode (905 nm)
    // ------------------------------------------------------------------
    C.DIODE = {
        WAVELENGTH_NOM_NM: 905,          // centre wavelength at 25 °C (default; user-adjustable in UI)
        MAX_DRIVE_CURRENT_A: 25,         // slider / fault-condition upper bound
        FAULT_CURRENT_MULT: 1.1,         // +10 % single-fault tolerance model
        I_THRESHOLD_A: 0.3,              // threshold current
        SLOPE_EFF_W_PER_A: 3.25,         // ~25 W @ 8 A … 75 W @ 25 A
        TC_LAMBDA_NM_PER_K: 0.28,        // wavelength temp. coefficient
        TC_POWER_PER_K: -0.004,          // optical power temp. coefficient (−0.4 %/K)
        MAX_DUTY_CYCLE: 0.001,           // 0.1 % max rating
        MAX_PULSE_WIDTH_NS: 100          // datasheet max pulse width
    };

    // ------------------------------------------------------------------
    // OSRAM BPW 34 FAS photodiode
    // ------------------------------------------------------------------
    C.DETECTOR = {
        RESPONSIVITY_A_PER_W: 0.65,      // at 905 nm
        SYSTEM_VOLTAGE_LIMIT_V: 5.0      // op-amp saturation
    };

    // ------------------------------------------------------------------
    // Data transmission protocol (lasertag) — DEFAULTS
    // Actual values are user-adjustable in the UI (frame length ~60 ms,
    // 65 pulses/frame, 100 ns pulses, ~300 µs bit period) and passed via
    // the parameter object; these constants serve as fallbacks.
    // ------------------------------------------------------------------
    C.PROTOCOL = {
        BITS_PER_FRAME: 65,              // pulses per shot frame
        MAX_FRAMES_PER_S: 17,            // max shots per second (frame period ≈ 60 ms)
        // max average pulse rate [Hz]
        get MAX_PULSES_PER_S() { return this.BITS_PER_FRAME * this.MAX_FRAMES_PER_S; }
    };

    // ------------------------------------------------------------------
    // EN 60825-1:2014+A11:2021 (= IEC 60825-1:2014 + ISH1:2017 / ISH2:2017)
    // ------------------------------------------------------------------
    C.IEC = {
        // --- Angular subtense -------------------------------------------
        ALPHA_MIN_MRAD: 1.5,             // smallest limiting angular subtense
        ALPHA_MAX_LIMIT_MRAD: 100,       // largest limiting angular subtense (t ≥ 0.25 s)

        /**
         * αmax(t) — largest angular subtense used for C6 / angle-of-acceptance.
         * Source: research report §7; ISH1 uses same t-dependence.
         * @param {number} t_s emission duration [s]
         * @returns {number} αmax [mrad]
         */
        alphaMax_mrad(t_s) {
            if (t_s < 625e-6) return 5;                    // t < 625 µs
            if (t_s <= 0.25) return 200 * Math.sqrt(t_s);  // 625 µs … 0.25 s
            return 100;                                    // t > 0.25 s
        },

        // --- Thermal integration time -----------------------------------
        // Pulses closer than Ti are summed into one effective pulse.
        TI_S: 5e-6,                      // 5 µs for 400–1050 nm (13 µs for 1050–1400 nm)

        // --- C4 (wavelength) --------------------------------------------
        // VERIFY: EN 60825-1:2014+A11:2021 Table 9
        C4(lambda_nm) {
            if (lambda_nm < 400 || lambda_nm > 1400) return 1;
            if (lambda_nm <= 700) return 1;
            if (lambda_nm <= 1050) return Math.pow(10, 0.002 * (lambda_nm - 700));
            return 5; // 1050–1400 nm
        },

        // --- C6 (extended source) ---------------------------------------
        /**
         * @param {number} alpha_mrad angular subtense (arithmetic mean of axes)
         * @param {number} t_s emission duration [s]
         */
        C6(alpha_mrad, t_s) {
            const aMax = this.alphaMax_mrad(t_s);
            if (alpha_mrad <= this.ALPHA_MIN_MRAD) return 1;
            if (alpha_mrad >= aMax) return aMax / this.ALPHA_MIN_MRAD;
            return alpha_mrad / this.ALPHA_MIN_MRAD;
        },

        // --- C7 (infrared 1050–1400 nm) -----------------------------
        // VERIFY: EN 60825-1:2014+A11:2021 Table 9 — piecewise form from
        // public sources; equals 1 at 905 nm (the design wavelength).
        C7(lambda_nm) {
            if (lambda_nm <= 1150) return 1;
            if (lambda_nm <= 1200) return Math.pow(10, 0.018 * (lambda_nm - 1150));
            if (lambda_nm <= 1400) return 8;
            return 1;
        },

        // --- C5 (pulse train / thermal additivity) ----------------------
        /**
         * C5 per EN 60825-1:2014+A11:2021 Table 9 and ISH1.
         * User-confirmed branch: α ≤ 5 mrad, t ≤ Ti → C5 = 5·N^(−0.25), floor 0.4.
         * @param {number} N number of (effective) pulses within min(time base, T2)
         * @param {number} alpha_mrad angular subtense [mrad]
         * @param {number} t_pulse_s pulse (or group) duration [s]
         */
        C5(N, alpha_mrad, t_pulse_s) {
            if (N <= 1) return 1;
            const aMax = this.alphaMax_mrad(t_pulse_s);
            let c5;
            if (alpha_mrad <= 5 && t_pulse_s <= this.TI_S) {
                // VERIFY: EN 60825-1:2014+A11:2021 Table 9, branch α ≤ 5 mrad, t ≤ Ti
                c5 = 5 * Math.pow(N, -0.25);
                return Math.min(1, Math.max(0.4, c5));
            }
            if (alpha_mrad <= 5) {
                // VERIFY: Table 9, α ≤ 5 mrad, t > Ti
                c5 = Math.pow(N, -0.25);
                return Math.min(1, Math.max(0.4, c5));
            }
            if (alpha_mrad <= aMax) {
                // VERIFY: Table 9, 5 mrad < α ≤ αmax
                c5 = Math.pow(N, -0.25);
                return Math.min(1, Math.max(0.2, c5));
            }
            // α > αmax: ISH1 criteria where C5 = 1 applies
            return 1;
        },

        // --- T2 (thermal equilibrium breakpoint) -------------------------
        /**
         * T2(α): time at which the retinal thermal limit transitions from
         * energy (J) to power (W).
         * VERIFY: EN 60825-1:2014+A11:2021 Table 9 / MPE tables.
         * @param {number} alpha_mrad angular subtense [mrad]
         * @returns {number} T2 [s]
         */
        T2(alpha_mrad) {
            const a = Math.min(alpha_mrad, this.ALPHA_MAX_LIMIT_MRAD);
            if (a <= this.ALPHA_MIN_MRAD) return 10;
            if (a >= this.ALPHA_MAX_LIMIT_MRAD) return 100;
            // log-linear interpolation 10 s … 100 s
            return Math.pow(10, 1 + (a - this.ALPHA_MIN_MRAD) /
                (this.ALPHA_MAX_LIMIT_MRAD - this.ALPHA_MIN_MRAD));
        },

        // --- AEL Class 1, 700–1050 nm -----------------------------------
        /**
         * Accessible Emission Limit for a single pulse or CW segment.
         * VERIFY: EN 60825-1:2014+A11:2021 Tables 3/4; numeric constants from
         * research report §4.2/4.3 and user feedback.
         *
         * @param {number} t_s emission duration [s]
         * @param {number} lambda_nm wavelength [nm]
         * @param {number} alpha_mrad angular subtense [mrad]
         * @returns {number} AEL [J] for t ≤ T2, or [W] for t > T2
         */
        AEL_class1(t_s, lambda_nm, alpha_mrad) {
            const c4 = this.C4(lambda_nm);
            const c6 = this.C6(alpha_mrad, t_s);
            const c7 = this.C7(lambda_nm);
            const t2 = this.T2(alpha_mrad);

            if (t_s <= 18e-6) {
                // VERIFY: 7.7×10⁻⁸ J base value (user correction)
                return 7.7e-8 * c4 * c6 * c7;
            }
            if (t_s <= t2) {
                return 7e-4 * Math.pow(t_s, 0.75) * c4 * c6 * c7;
            }
            // CW / long exposure → power limit [W]
            return 7e-4 * c4 * c6 * c7 * Math.pow(t2, -0.25);
        },

        // --- Tcrit (pulse-group critical period, ISH1 §5) ----------------
        /**
         * @param {number} alpha_mrad angular subtense [mrad]
         * @param {number} t_pulse_s individual pulse duration [s]
         * @returns {number} Tcrit [s]
         */
        Tcrit(alpha_mrad, t_pulse_s) {
            const tp = Math.max(t_pulse_s, this.TI_S);
            const aMax = this.alphaMax_mrad(tp);
            if (alpha_mrad <= aMax) return 2 * tp;
            // α > αmax: α not limited to αmax for this formula
            return 0.01 * alpha_mrad * Math.sqrt(tp);
        },

        // --- Measurement conditions (2014 edition, incl. A11:2021) -------
        // Old Condition 2 (eye loupe) was formally removed in IEC 60825-1:2014,
        // but test labs still measure at 7 mm @ 70 mm in practice (see the
        // MKL-R01 Intertek test report, poc/files/laser_testing_MKLR01.pdf),
        // so it is evaluated here as an additional condition.
        MEAS_CONDITIONS: {
            COND1_OPTICAL_AIDS:     { apertureMm: 50, distanceM: 2.0 },  // binoculars/telescope
            COND2_NAKED_EYE_CLOSE:  { apertureMm: 7,  distanceM: 0.07 }, // legacy 2007-ed. Cond. 2 (lab practice)
            COND3_NAKED_EYE:        { apertureMm: 7,  distanceM: 0.1 }   // near point of accommodation
        },

        // --- Classification time bases ------------------------------------
        // 0.25 s only for visible Class 2 (aversion response).
        // 100 s for IR where intentional staring is unlikely.
        // 30 000 s for Class 1 with unconscious prolonged exposure.
        TIME_BASE_DEFAULT_S: 100,
        TIME_BASE_CONSERVATIVE_S: 30000
    };

    return C;
})();
