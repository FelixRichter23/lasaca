/**
 * Atmospheric attenuation model (Kruse / Kim visibility model).
 *
 * γ(λ) = (3.912 / V) · (λ / 550 nm)^(−q)
 *   q = 1.6            V > 50 km
 *   q = 1.3            6 km < V ≤ 50 km
 *   q = 0.585 · V^(1/3) V ≤ 6 km
 *
 * Transmission: τ = exp(−γ · d)
 */
window.Sim = window.Sim || {};

Sim.Atmosphere = (function () {
    'use strict';

    const WEATHER_PRESETS = {
        clear:     { label: '☀️ Clear (23 km)',        visibilityKm: 23 },
        haze:      { label: '🌤 Haze (10 km)',         visibilityKm: 10 },
        rain:      { label: '🌧 Rain (4 km)',          visibilityKm: 4 },
        lightfog:  { label: '🌫 Light Fog (2 km)',     visibilityKm: 2 },
        fog:       { label: '🌫 Fog (500 m)',          visibilityKm: 0.5 },
        heavyfog:  { label: '🌁 Heavy Fog (200 m)',    visibilityKm: 0.2 }
    };

    function kimQ(visibilityKm) {
        if (visibilityKm > 50) return 1.6;
        if (visibilityKm > 6) return 1.3;
        return 0.585 * Math.pow(visibilityKm, 1 / 3);
    }

    /** Extinction coefficient γ [1/km]. */
    function extinctionCoefficient(visibilityKm, lambdaNm) {
        const V = Math.max(0.05, visibilityKm);
        const q = kimQ(V);
        return (3.912 / V) * Math.pow(lambdaNm / 550, -q);
    }

    /** Atmospheric power transmission τ over distance d [m]. */
    function transmission(visibilityKm, lambdaNm, distanceM) {
        const gamma = extinctionCoefficient(visibilityKm, lambdaNm);
        return Math.exp(-gamma * (distanceM / 1000));
    }

    return { WEATHER_PRESETS, extinctionCoefficient, transmission };
})();
