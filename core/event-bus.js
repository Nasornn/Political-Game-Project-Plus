// ============================================================
// CORE EVENT BUS — lightweight pub/sub for game state events
// ============================================================
window.Game = window.Game || {};
window.Game.Core = window.Game.Core || {};

window.Game.Core.EventBus = {
    create() {
        const listeners = {};
        const history = [];

        const on = (eventName, callback) => {
            if (!eventName || typeof callback !== 'function') return () => {};
            if (!listeners[eventName]) listeners[eventName] = [];
            listeners[eventName].push(callback);
            return () => {
                listeners[eventName] = (listeners[eventName] || []).filter(cb => cb !== callback);
            };
        };

        const emit = (eventName, payload = {}) => {
            if (!eventName) return;
            history.push({ eventName, payload, at: Date.now() });
            if (history.length > 300) history.shift();

            for (const callback of (listeners[eventName] || [])) {
                try {
                    callback(payload);
                } catch (err) {
                    console.error('EventBus listener failed:', eventName, err);
                }
            }
        };

        const getHistory = (lastN = 50) => {
            const size = Math.max(0, Math.floor(Number(lastN) || 0));
            if (size === 0) return [];
            return history.slice(-size);
        };

        return { on, emit, getHistory };
    }
};
