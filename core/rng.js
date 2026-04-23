// ============================================================
// CORE RNG UTILITIES — deterministic and stateful randomness
// ============================================================
window.Game = window.Game || {};
window.Game.Core = window.Game.Core || {};

window.Game.Core.RNG = {
    normalizeSeed(seedValue = 1) {
        const n = Math.floor(Number(seedValue));
        return ((Number.isFinite(n) ? n : 1) >>> 0) || 1;
    },

    nextState(stateValue = 1) {
        let t = this.normalizeSeed(stateValue);
        t = (t + 0x6D2B79F5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return (r ^ (r >>> 14)) >>> 0;
    },

    toFloat(stateValue) {
        return (this.normalizeSeed(stateValue) >>> 0) / 4294967296;
    },

    create(seedValue = 1) {
        let state = this.normalizeSeed(seedValue);
        return () => {
            state = this.nextState(state);
            return this.toFloat(state);
        };
    },

    createStateful(seedValue = 1) {
        const boxed = {
            seed: this.normalizeSeed(seedValue),
            state: this.normalizeSeed(seedValue)
        };

        const roll = () => {
            boxed.state = this.nextState(boxed.state);
            return this.toFloat(boxed.state);
        };

        return {
            roll,
            getState: () => boxed.state,
            setState: (stateValue) => {
                boxed.state = this.normalizeSeed(stateValue);
            },
            getSeed: () => boxed.seed
        };
    }
};
