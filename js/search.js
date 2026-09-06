/**
 * Shared batched async search helper.
 *
 * Keeps the UI responsive by breaking heavy loops into chunks
 * executed via setTimeout — used by the auto-solver and the aim solver.
 */
window.Sim = window.Sim || {};

Sim.Search = (function () {
    'use strict';

    /**
     * Iterate over items in batches, calling visit(item, index) for each.
     * The caller is responsible for tracking its own best results.
     * @param {Array} items
     * @param {Function} visit
     * @param {Object} opts
     * @param {number} [opts.batchSize=32]
     * @param {Function} [opts.onProgress] (pct 0-100)
     * @param {Function} [opts.onDone]
     */
    function run(items, visit, { batchSize = 32, onProgress = () => {}, onDone = () => {} } = {}) {
        if (!items.length) {
            onProgress(100);
            onDone();
            return;
        }
        let idx = 0;
        function step() {
            const end = Math.min(idx + batchSize, items.length);
            for (; idx < end; idx++) {
                visit(items[idx], idx);
            }
            onProgress(Math.round((idx / items.length) * 100));
            if (idx < items.length) {
                setTimeout(step, 0);
            } else {
                onDone();
            }
        }
        setTimeout(step, 0);
    }

    return { run };
})();
