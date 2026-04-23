// ============================================================
// CORE STATE MACHINE — transition guards for app states
// ============================================================
window.Game = window.Game || {};
window.Game.Core = window.Game.Core || {};

window.Game.Core.StateMachine = {
    canTransition(currentState, nextState, transitionsMap = {}) {
        if (!nextState) return false;
        if (!currentState) return true;
        if (currentState === nextState) return true;

        const allowed = transitionsMap[currentState] || [];
        return allowed.includes(nextState);
    }
};
