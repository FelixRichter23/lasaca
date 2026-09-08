/**
 * Atmospheric attenuation model — Mie scattering, large-particle limit.
 *
 * At 905 nm both fog droplets (~1–20 µm) and raindrops (~0.1–6 mm) are large
 * compared to the wavelength, so the Mie extinction efficiency approaches the
 * geometric-optics limit Q_ext ≈ 2 and extinction becomes (nearly)
 * wavelength-independent. The `lambdaNm` parameter is kept in the API for
 * call-site compatibility but is unused in this limit.
 *
 * Fog — droplet spectrum parameterised by liquid water content (LWC) and
 * effective radius r_eff (fixed 10 µm, typical for fog):
 *   γ_fog = 3·LWC / (2·ρ_w·r_eff)
 *
 * Rain — Marshall–Palmer drop-size distribution
 *   N(D) = N0·exp(−ΛD),  N0 = 8000 m⁻³mm⁻¹,  Λ = 4.1·R^(−0.21) mm⁻¹
 *   γ_rain = (π/4)·Q_ext·∫ N(D) D² dD = π·N0/Λ³
 *
 * Total extinction: γ = γ_fog + γ_rain;  transmission τ = exp(−γ·d).
 */
window.Sim = window.Sim || {};

Sim.Atmosphere = (function () {
    'use strict';

    const RHO_WATER_KG_M3 = 1000;   // density of liquid water
    const R_EFF_FOG_UM = 10;        // effective fog-droplet radius [µm]
    const MP_N0 = 8000;             // Marshall–Palmer intercept [m⁻³ mm⁻¹]

    /**
     * Weather presets (particle-based; estimates).
     * lwcGm3  — fog liquid water content [g/m³]
     * rainMmH — rainfall rate [mm/h]
     */
    const WEATHER_PRESETS = {
        clear:     { label: 'Clear',                      lwcGm3: 0,    rainMmH: 0 },
        fog:       { label: 'Fog (LWC 0.04 g/m³)',        lwcGm3: 0.04, rainMmH: 0 },
        thickfog:  { label: 'Thick Fog (LWC 0.5 g/m³)',   lwcGm3: 0.5,  rainMmH: 0 },
        rain:      { label: 'Rain (10 mm/h)',             lwcGm3: 0,    rainMmH: 10 },
        heavyrain: { label: 'Heavy Rain (25 mm/h)',       lwcGm3: 0,    rainMmH: 25 }
    };

    /** Fog extinction coefficient γ [1/km] from liquid water content. */
    function fogExtinction(lwcGm3) {
        if (!(lwcGm3 > 0)) return 0;
        const lwc = lwcGm3 * 1e-3;              // g/m³ → kg/m³
        const rEff = R_EFF_FOG_UM * 1e-6;       // µm → m
        return 1000 * (3 * lwc) / (2 * RHO_WATER_KG_M3 * rEff); // 1/m → 1/km
    }

    /** Rain extinction coefficient γ [1/km] from rainfall rate R [mm/h]. */
    function rainExtinction(rainMmH) {
        if (!(rainMmH > 0)) return 0;
        const lambda = 4.1 * Math.pow(rainMmH, -0.21);  // Λ [mm⁻¹]
        // π·N0/Λ³ has units mm²/m³ → ×1e-3 → 1/km
        return Math.PI * MP_N0 / Math.pow(lambda, 3) * 1e-3;
    }

    /**
     * Total extinction coefficient γ [1/km].
     * @param atmo {lwcGm3, rainMmH} fog LWC [g/m³] and rain rate [mm/h]
     * @param lambdaNm unused in the large-particle Mie limit (see header)
     */
    function extinctionCoefficient(atmo, lambdaNm) { // eslint-disable-line no-unused-vars
        return fogExtinction(atmo && atmo.lwcGm3) + rainExtinction(atmo && atmo.rainMmH);
    }

    /** Atmospheric power transmission τ over distance d [m]. */
    function transmission(atmo, lambdaNm, distanceM) {
        const gamma = extinctionCoefficient(atmo, lambdaNm);
        return Math.exp(-gamma * (distanceM / 1000));
    }

    return { WEATHER_PRESETS, R_EFF_FOG_UM, fogExtinction, rainExtinction, extinctionCoefficient, transmission };
})();
