// ============================================================
// APP.JS — Central State Machine & Game Controller
// ============================================================
window.Game = window.Game || {};

window.Game.App = {
    state: null,

    SAVE_SLOT_COUNT: 3,
    CUSTOM_SCENARIO_STORAGE_KEY: 'thai-election-sim.custom-scenario.v1',
    SCENARIO_PACK_INDEX_PATH: 'scenarios/index.json',
    _scenarioPackCache: null,

    STATES: {
        STATE_SETUP: 'STATE_SETUP',
        STATE_CAMPAIGN: 'STATE_CAMPAIGN',
        STATE_ELECTION_CALC: 'STATE_ELECTION_CALC',
        STATE_COALITION: 'STATE_COALITION',
        STATE_PARLIAMENT_TERM: 'STATE_PARLIAMENT_TERM',
    },

    currentState: null,

    // ─── INITIALIZE ──────────────────────────────────────────
    async init() {
        console.log('🏛️ Thailand Election Simulator — Initializing...');

        // Build initial game state (lightweight — NO MP generation yet)
        this.state = {
            scenarioMode: 'realistic',
            difficultyMode: 'medium',
            customScenarioConfig: null,
            parties: this._initParties('realistic'),
            districts: [],       // Deferred
            partyMPs: {},
            playerPartyId: null,
            campaignTurn: 1,
            actionPoints: 10,
            electionResults: null,
            coalitionPartyIds: [],
            coalitionOrder: [],
            coalitionTurnIndex: 0,
            coalitionAttempt: 1,
            governmentPartyId: null,
            pendingCoalitionOffer: null,
            playerRole: 'government',
            oppositionPopularityYearTracker: { year: 1, gain: 0 },
            oppositionActionSession: 1,
            oppositionActionsRemaining: 2,
            oppositionWalkoutPlan: null,
            oppositionSplitPlan: null,
            governmentBillLog: [],
            governmentBillQueue: [],
            governmentBillFailedCooldown: {},
            governmentBillOutcomeHistory: [],
            governmentFailedBillStreak: 0,
            governmentStress: { scandalPoints: 0, failedBillPoints: 0, streakBonus: 0, total: 0 },
            governmentCrisisChain: null,
            governmentBillsVotedThisSession: 0,
            pmOpsUsedThisSession: 0,
            pmOperationFatigue: {},
            pmEmergencyShield: 0,
            seatedMPs: [],
            parliamentYear: 1,
            sessionNumber: 1,
            lobbyTurns: 3,
            electionCount: 1,
            passedBillNames: [],  // Track bills that have been passed so they can't be re-proposed
            sessionPhase: 'question_time',
            sessionHeadlines: [],
            pendingInterpellations: [],
            coalitionSatisfaction: {},
            pendingCoalitionEvents: [],
            _mpsGenerated: false,
            _spawnedPartyThisCampaign: false,
            _emergentPartyCount: 0,
            _pendingAdvanceStep: 1,
            pendingCampaignEvent: null,
            campaignMomentum: {},
            campaignActionMemory: {},
            _lastCampaignEventId: null,
            runHistory: [],
            aiPersonality: {},
            aiAllianceMemory: {},
            previousElectionSeatTotals: {},
            coalitionDemands: {},
            coalitionMinistryOffers: {},
        };

        this._ensureStateDefaults(this.state);
        this._restorePersistedCustomScenario();

        // Initialize map (start loading TopoJSON in parallel)
        window.Game.UI.Map.init('map-container');

        // Wire global utility controls
        window.Game.UI.Screens.bindMetaToolbar();

        // Show setup immediately — don't wait for map
        this.transition('STATE_SETUP');

        console.log('✅ Game initialized (fast mode).',
            `${this.state.parties.length} parties. MPs deferred until campaign starts.`
        );

        this.logRunEvent('system', 'New run initialized.');
        this._installCheatConsole();
    },

    _getMinistryPool() {
        return [
            'Interior', 'Finance', 'Defense', 'Foreign Affairs', 'Education',
            'Public Health', 'Transport', 'Commerce', 'Agriculture',
            'Justice', 'Labour', 'Digital Economy', 'Tourism & Sports',
            'Energy', 'Natural Resources', 'Social Development', 'Culture',
            'Higher Education', 'Industry', "PM's Office"
        ];
    },

    _ensureStateDefaults(state) {
        if (!state) return;
        if (!Array.isArray(state.runHistory)) state.runHistory = [];
        if (!state.aiPersonality) state.aiPersonality = {};
        if (!state.aiAllianceMemory) state.aiAllianceMemory = {};
        if (!state.previousElectionSeatTotals) state.previousElectionSeatTotals = {};
        if (!state.coalitionDemands) state.coalitionDemands = {};
        if (!state.coalitionMinistryOffers) state.coalitionMinistryOffers = {};
        if (state.oppositionWalkoutPlan === undefined) state.oppositionWalkoutPlan = null;
        if (state.oppositionSplitPlan === undefined) state.oppositionSplitPlan = null;
        if (!Array.isArray(state.governmentBillOutcomeHistory)) state.governmentBillOutcomeHistory = [];
        if (!Number.isFinite(state.governmentFailedBillStreak)) state.governmentFailedBillStreak = 0;
        if (!state.governmentStress) state.governmentStress = { scandalPoints: 0, failedBillPoints: 0, streakBonus: 0, total: 0 };
        if (state.governmentCrisisChain === undefined) state.governmentCrisisChain = null;
        if (!Number.isFinite(state.pmOpsUsedThisSession)) state.pmOpsUsedThisSession = 0;
        if (!state.pmOperationFatigue) state.pmOperationFatigue = {};
        if (!Number.isFinite(state.pmEmergencyShield)) state.pmEmergencyShield = 0;
        if (!state.difficultyMode) state.difficultyMode = 'medium';
        if (state.scenarioMode !== 'balanced' && state.scenarioMode !== 'custom') state.scenarioMode = 'realistic';
        if (state.customScenarioConfig === undefined) state.customScenarioConfig = null;
        if (!Number.isFinite(state.electionCount)) state.electionCount = 1;
    },

    _getSaveSlotKey(slotIndex) {
        return `thai-election-sim.save.slot.${slotIndex}`;
    },

    _clampNumber(value, min, max, fallback = 0, round = true) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        const bounded = Math.max(min, Math.min(max, n));
        return round ? Math.round(bounded) : bounded;
    },

    _safeHexColor(value, fallback = '#888888') {
        const s = String(value || '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
    },

    _pickUniquePartyColor(preferredColors = [], seedValue = Date.now()) {
        const usedColors = new Set(
            (this.state?.parties || [])
                .map(p => this._safeHexColor(p.hexColor || '', ''))
                .filter(Boolean)
                .map(c => c.toUpperCase())
        );

        for (const raw of preferredColors) {
            const candidate = this._safeHexColor(raw || '', '').toUpperCase();
            if (candidate && !usedColors.has(candidate)) return candidate;
        }

        let colorValue = Math.abs(Math.floor(Number(seedValue) || Date.now())) % 0x1000000;
        for (let i = 0; i < 0x1000000; i++) {
            const candidate = `#${colorValue.toString(16).padStart(6, '0').toUpperCase()}`;
            if (!usedColors.has(candidate)) return candidate;
            colorValue = (colorValue + 977) % 0x1000000;
        }

        return '#000001';
    },

    _scenarioRegions() {
        return Object.keys(window.Game.Data.REGIONS || {});
    },

    _normalizeRegionalMap(rawMap, min, max, round = true, fillMissing = true) {
        const regions = this._scenarioRegions();
        const next = {};
        if (fillMissing) {
            for (const region of regions) {
                next[region] = 0;
            }
        }
        if (!rawMap || typeof rawMap !== 'object') return next;
        for (const [region, value] of Object.entries(rawMap)) {
            if (!regions.includes(region)) continue;
            next[region] = this._clampNumber(value, min, max, 0, round);
        }
        return next;
    },

    _normalizeProvincialMap(rawMap, min, max, round = true) {
        const next = {};
        if (!rawMap || typeof rawMap !== 'object') return next;
        const validProvinces = new Set(Object.keys(window.Game.Data.PROVINCES || {}));
        for (const [province, value] of Object.entries(rawMap)) {
            if (!validProvinces.has(province)) continue;
            next[province] = this._clampNumber(value, min, max, 0, round);
        }
        return next;
    },

    _normalizeCustomParty(rawParty, index = 0, existingIds = new Set()) {
        if (!rawParty || typeof rawParty !== 'object') return null;

        const seedId = String(rawParty.id || `mod_party_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (!seedId) return null;
        let id = seedId;
        let suffix = 1;
        while (existingIds.has(id)) {
            id = `${seedId}_${suffix++}`;
        }
        existingIds.add(id);

        const name = String(rawParty.name || `Mod Party ${index + 1}`).trim().slice(0, 48) || `Mod Party ${index + 1}`;
        const thaiName = String(rawParty.thaiName || name).trim().slice(0, 48) || name;
        const shortName = String(rawParty.shortName || name.slice(0, 4)).trim().toUpperCase().slice(0, 4) || 'MOD';
        const candidateNames = Array.isArray(rawParty.customCandidates)
            ? rawParty.customCandidates.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20)
            : [];

        return {
            id,
            name,
            thaiName,
            shortName,
            hexColor: this._safeHexColor(rawParty.hexColor, '#8a6d3b'),
            basePopularity: this._clampNumber(rawParty.basePopularity, 0, 60, 8),
            banYaiPower: this._clampNumber(rawParty.banYaiPower, 0, 100, 20),
            regionalBanYai: this._normalizeRegionalMap(rawParty.regionalBanYai, 0, 100),
            provincialBanYai: this._normalizeProvincialMap(rawParty.provincialBanYai, 0, 100),
            regionalPopMod: this._normalizeRegionalMap(rawParty.regionalPopMod, -30, 30),
            politicalCapital: this._clampNumber(rawParty.politicalCapital, 50, 700, 180),
            greyMoney: this._clampNumber(rawParty.greyMoney, 0, 600, 20),
            scandalMeter: this._clampNumber(rawParty.scandalMeter, 0, 100, 0),
            ideology: this._clampNumber(rawParty.ideology, 0, 100, 50),
            description: String(rawParty.description || 'A modded party.').trim().slice(0, 220) || 'A modded party.',
            isPlayerSelectable: true,
            isCustom: true,
            isScenarioInjected: true,
            customCandidates: candidateNames
        };
    },

    _normalizeBasePartyOverride(rawOverride) {
        if (!rawOverride || typeof rawOverride !== 'object') return null;
        const id = String(rawOverride.id || '').trim();
        if (!id) return null;

        const patch = { id };
        const scalarFields = [
            ['basePopularity', 0, 60],
            ['banYaiPower', 0, 100],
            ['politicalCapital', 0, 900],
            ['greyMoney', 0, 900],
            ['scandalMeter', 0, 100],
            ['ideology', 0, 100]
        ];
        for (const [field, min, max] of scalarFields) {
            if (rawOverride[field] !== undefined) {
                patch[field] = this._clampNumber(rawOverride[field], min, max, 0);
            }
        }

        if (rawOverride.hexColor !== undefined) patch.hexColor = this._safeHexColor(rawOverride.hexColor);
        if (rawOverride.name !== undefined) patch.name = String(rawOverride.name || '').trim().slice(0, 48);
        if (rawOverride.thaiName !== undefined) patch.thaiName = String(rawOverride.thaiName || '').trim().slice(0, 48);
        if (rawOverride.shortName !== undefined) patch.shortName = String(rawOverride.shortName || '').trim().toUpperCase().slice(0, 4);
        if (rawOverride.description !== undefined) patch.description = String(rawOverride.description || '').trim().slice(0, 220);

        if (rawOverride.regionalPopMod !== undefined) {
            patch.regionalPopMod = this._normalizeRegionalMap(rawOverride.regionalPopMod, -30, 30, true, false);
        }
        if (rawOverride.regionalBanYai !== undefined) {
            patch.regionalBanYai = this._normalizeRegionalMap(rawOverride.regionalBanYai, 0, 100, true, false);
        }
        if (rawOverride.provincialBanYai !== undefined) {
            patch.provincialBanYai = this._normalizeProvincialMap(rawOverride.provincialBanYai, 0, 100);
        }

        return patch;
    },

    _normalizeCustomScenarioConfig(rawConfig) {
        if (!rawConfig || typeof rawConfig !== 'object') {
            throw new Error('Scenario JSON must be an object.');
        }

        const baseMode = rawConfig.baseMode === 'balanced' ? 'balanced' : 'realistic';
        const normalized = {
            name: String(rawConfig.name || 'Custom Scenario').trim().slice(0, 64) || 'Custom Scenario',
            description: String(rawConfig.description || '').trim().slice(0, 240),
            baseMode,
            campaign: {},
            partyOverrides: [],
            customParties: []
        };

        if (rawConfig.campaign && typeof rawConfig.campaign === 'object') {
            const c = rawConfig.campaign;
            if (c.maxTurns !== undefined) {
                normalized.campaign.maxTurns = this._clampNumber(c.maxTurns, 4, 16, 8);
            }
            if (c.apPerTurn !== undefined) {
                normalized.campaign.apPerTurn = this._clampNumber(c.apPerTurn, 4, 20, 10);
            }
            if (c.emergentPartyChance !== undefined) {
                normalized.campaign.emergentPartyChance = this._clampNumber(c.emergentPartyChance, 0, 0.8, 0.14, false);
            }
        }

        const basePartyIds = new Set(window.Game.Data.PARTIES.map(p => p.id));
        if (Array.isArray(rawConfig.partyOverrides)) {
            for (const rawOverride of rawConfig.partyOverrides) {
                const normalizedOverride = this._normalizeBasePartyOverride(rawOverride);
                if (!normalizedOverride || !basePartyIds.has(normalizedOverride.id)) continue;
                normalized.partyOverrides.push(normalizedOverride);
            }
        }

        const existingIds = new Set(basePartyIds);
        if (Array.isArray(rawConfig.customParties)) {
            rawConfig.customParties.forEach((rawParty, i) => {
                const customParty = this._normalizeCustomParty(rawParty, i, existingIds);
                if (customParty) normalized.customParties.push(customParty);
            });
        }

        return normalized;
    },

    _persistCustomScenario(configOrNull) {
        if (!configOrNull) {
            localStorage.removeItem(this.CUSTOM_SCENARIO_STORAGE_KEY);
            return;
        }
        localStorage.setItem(this.CUSTOM_SCENARIO_STORAGE_KEY, JSON.stringify(configOrNull));
    },

    _restorePersistedCustomScenario() {
        if (!this.state || this.state.customScenarioConfig) return;
        const raw = localStorage.getItem(this.CUSTOM_SCENARIO_STORAGE_KEY);
        if (!raw) return;

        try {
            const parsed = JSON.parse(raw);
            const normalized = this._normalizeCustomScenarioConfig(parsed);
            this.state.customScenarioConfig = normalized;
            this.state.scenarioMode = 'custom';
            this.state.parties = this._buildPartiesFromScenarioConfig(normalized);
        } catch (err) {
            console.warn('Failed to load persisted custom scenario. Clearing saved scenario.', err);
            localStorage.removeItem(this.CUSTOM_SCENARIO_STORAGE_KEY);
        }
    },

    async listScenarioPacks(forceRefresh = false) {
        if (!forceRefresh && Array.isArray(this._scenarioPackCache)) {
            return { success: true, packs: this._scenarioPackCache };
        }

        try {
            const res = await fetch(this.SCENARIO_PACK_INDEX_PATH, { cache: 'no-store' });
            if (!res.ok) {
                return { success: false, packs: [], msg: `Could not load ${this.SCENARIO_PACK_INDEX_PATH} (HTTP ${res.status}).` };
            }

            const data = await res.json();
            const rawPacks = Array.isArray(data?.packs) ? data.packs : (Array.isArray(data) ? data : []);
            const packs = rawPacks
                .map((p, idx) => {
                    if (!p || typeof p !== 'object') return null;
                    const id = String(p.id || '').trim();
                    const file = String(p.file || '').trim();
                    if (!id || !file || !/\.json$/i.test(file)) return null;
                    return {
                        id,
                        name: String(p.name || `Scenario ${idx + 1}`).trim().slice(0, 72) || `Scenario ${idx + 1}`,
                        description: String(p.description || '').trim().slice(0, 240),
                        file,
                        author: String(p.author || '').trim().slice(0, 64)
                    };
                })
                .filter(Boolean);

            this._scenarioPackCache = packs;
            return { success: true, packs };
        } catch (err) {
            return {
                success: false,
                packs: [],
                msg: 'Failed to load scenario packs. If you opened index.html directly, run from a local server so JSON fetch works.'
            };
        }
    },

    async getScenarioPackJSON(packId) {
        const manifest = await this.listScenarioPacks(false);
        if (!manifest.success) {
            return { success: false, msg: manifest.msg || 'Could not read scenario pack index.' };
        }

        const pack = (manifest.packs || []).find(p => p.id === packId);
        if (!pack) return { success: false, msg: 'Scenario pack not found.' };

        try {
            const res = await fetch(pack.file, { cache: 'no-store' });
            if (!res.ok) {
                return { success: false, msg: `Could not load ${pack.file} (HTTP ${res.status}).` };
            }

            const rawText = await res.text();
            let parsed;
            try {
                parsed = JSON.parse(rawText);
            } catch (err) {
                return { success: false, msg: `Pack JSON parse error (${pack.file}): ${err.message}` };
            }

            let normalized;
            try {
                normalized = this._normalizeCustomScenarioConfig(parsed);
            } catch (err) {
                return { success: false, msg: `Pack schema invalid (${pack.file}): ${err.message}` };
            }

            return {
                success: true,
                pack,
                scenario: normalized,
                jsonText: JSON.stringify(normalized, null, 2)
            };
        } catch (err) {
            return { success: false, msg: `Failed to fetch scenario pack file: ${pack.file}` };
        }
    },

    async applyScenarioPack(packId) {
        const result = await this.getScenarioPackJSON(packId);
        if (!result.success) return result;

        const applyResult = this.applyCustomScenario(result.scenario);
        if (!applyResult.success) return applyResult;

        this.logRunEvent('scenario', `Applied scenario pack: ${result.pack.name}.`, {
            turningPointScore: 1.6
        });

        return {
            ...applyResult,
            pack: result.pack,
            scenario: result.scenario,
            jsonText: result.jsonText
        };
    },

    getCustomScenarioConfig() {
        if (!this.state || !this.state.customScenarioConfig) return null;
        return JSON.parse(JSON.stringify(this.state.customScenarioConfig));
    },

    getCustomScenarioTemplate() {
        return {
            name: 'My Custom Scenario',
            description: 'Example: stronger regional machines and longer campaign season.',
            baseMode: 'realistic',
            campaign: {
                maxTurns: 9,
                apPerTurn: 11,
                emergentPartyChance: 0.16
            },
            partyOverrides: [
                {
                    id: 'progressive',
                    basePopularity: 34,
                    regionalPopMod: {
                        Bangkok: 18,
                        North: -2
                    }
                },
                {
                    id: 'pheuthai',
                    basePopularity: 18,
                    greyMoney: 130
                }
            ],
            customParties: [
                {
                    id: 'green_wave',
                    name: 'Green Wave Alliance',
                    thaiName: 'Green Wave',
                    shortName: 'GWA',
                    hexColor: '#2F9E44',
                    basePopularity: 7,
                    banYaiPower: 10,
                    ideology: 24,
                    politicalCapital: 170,
                    greyMoney: 15,
                    regionalPopMod: {
                        Bangkok: 2,
                        North: 3
                    },
                    provincialBanYai: {
                        Phuket: 55
                    },
                    description: 'A green-urban reform bloc with a Phuket machine.'
                }
            ]
        };
    },

    getCustomScenarioEditorJSON() {
        const payload = this.getCustomScenarioConfig() || this.getCustomScenarioTemplate();
        return JSON.stringify(payload, null, 2);
    },

    _serializeScenarioParty(party) {
        if (!party) return null;
        return {
            id: party.id,
            name: party.name,
            thaiName: party.thaiName,
            shortName: party.shortName,
            hexColor: party.hexColor,
            basePopularity: party.basePopularity,
            banYaiPower: party.banYaiPower,
            ideology: party.ideology,
            politicalCapital: party.politicalCapital,
            greyMoney: party.greyMoney,
            scandalMeter: party.scandalMeter,
            regionalPopMod: { ...(party.regionalPopMod || {}) },
            regionalBanYai: { ...(party.regionalBanYai || {}) },
            provincialBanYai: { ...(party.provincialBanYai || {}) },
            description: party.description || '',
            customCandidates: [...(party.customCandidates || [])]
        };
    },

    exportCurrentScenarioJSON() {
        if (!this.state) return JSON.stringify(this.getCustomScenarioTemplate(), null, 2);

        const customConfig = this.state.customScenarioConfig;
        const baseMode = customConfig?.baseMode || (this.state.scenarioMode === 'balanced' ? 'balanced' : 'realistic');
        const baseIds = new Set(window.Game.Data.PARTIES.map(p => p.id));
        const parties = this.state.parties || [];
        const campaign = customConfig?.campaign || {};

        const payload = {
            name: customConfig?.name || `Exported Scenario ${new Date().toISOString().slice(0, 10)}`,
            description: customConfig?.description || 'Exported from current game state.',
            baseMode,
            campaign: {
                maxTurns: Number.isFinite(campaign.maxTurns)
                    ? campaign.maxTurns
                    : window.Game.Engine.Campaign.getMaxCampaignTurns(this.state),
                apPerTurn: Number.isFinite(campaign.apPerTurn)
                    ? campaign.apPerTurn
                    : window.Game.Engine.Campaign.getAPPerTurn(this.state),
                emergentPartyChance: Number.isFinite(campaign.emergentPartyChance)
                    ? campaign.emergentPartyChance
                    : window.Game.Engine.Campaign.getEmergentPartyChance(this.state)
            },
            partyOverrides: parties
                .filter(p => baseIds.has(p.id))
                .map(p => this._serializeScenarioParty(p)),
            customParties: parties
                .filter(p => p.isCustom)
                .map(p => this._serializeScenarioParty(p))
        };

        return JSON.stringify(payload, null, 2);
    },

    _buildPartiesFromScenarioConfig(config) {
        const normalized = this._normalizeCustomScenarioConfig(config || {});
        const baseParties = this._getBasePartiesForMode(normalized.baseMode || 'realistic');
        const byId = new Map(baseParties.map(p => [p.id, p]));

        for (const patch of normalized.partyOverrides || []) {
            const target = byId.get(patch.id);
            if (!target) continue;

            const merged = {
                ...target,
                ...patch,
                regionalPopMod: {
                    ...(target.regionalPopMod || {}),
                    ...(patch.regionalPopMod || {})
                },
                regionalBanYai: {
                    ...(target.regionalBanYai || {}),
                    ...(patch.regionalBanYai || {})
                },
                provincialBanYai: {
                    ...(target.provincialBanYai || {}),
                    ...(patch.provincialBanYai || {})
                }
            };
            byId.set(patch.id, merged);
        }

        const baseList = [...byId.values()];
        const customParties = (normalized.customParties || []).map(p => ({
            ...p,
            regionalPopMod: { ...(p.regionalPopMod || {}) },
            regionalBanYai: { ...(p.regionalBanYai || {}) },
            provincialBanYai: { ...(p.provincialBanYai || {}) },
            customCandidates: [...(p.customCandidates || [])]
        }));

        return [...baseList, ...customParties];
    },

    applyCustomScenario(configInput) {
        if (!this.state) return { success: false, msg: 'Game state not initialized.' };
        if (this.currentState && this.currentState !== this.STATES.STATE_SETUP) {
            return { success: false, msg: 'Custom scenarios can only be applied from setup.' };
        }

        let raw;
        try {
            raw = (typeof configInput === 'string') ? JSON.parse(configInput) : configInput;
        } catch (err) {
            return { success: false, msg: `Scenario JSON parse error: ${err.message}` };
        }

        let normalized;
        try {
            normalized = this._normalizeCustomScenarioConfig(raw);
        } catch (err) {
            return { success: false, msg: `Scenario invalid: ${err.message}` };
        }

        this.state.scenarioMode = 'custom';
        this.state.customScenarioConfig = normalized;
        this.state.parties = this._buildPartiesFromScenarioConfig(normalized);
        this._persistCustomScenario(normalized);
        this._resetSetupDependentState();

        this.logRunEvent('scenario', `Applied custom scenario: ${normalized.name}.`, {
            turningPointScore: 1.4
        });

        return {
            success: true,
            msg: `Custom scenario applied: ${normalized.name}.`,
            details: {
                parties: this.state.parties.length,
                customParties: (normalized.customParties || []).length,
                baseMode: normalized.baseMode
            }
        };
    },

    clearCustomScenario() {
        if (!this.state) return { success: false, msg: 'Game state not initialized.' };
        if (this.currentState && this.currentState !== this.STATES.STATE_SETUP) {
            return { success: false, msg: 'Custom scenarios can only be disabled from setup.' };
        }

        this.state.customScenarioConfig = null;
        this.state.scenarioMode = 'realistic';
        this.state.parties = this._initParties('realistic');
        this._persistCustomScenario(null);
        this._resetSetupDependentState();
        this.logRunEvent('scenario', 'Custom scenario disabled.');
        return { success: true, msg: 'Custom scenario disabled. Back to Realistic mode.' };
    },

    _snapshotState() {
        return JSON.parse(JSON.stringify(this.state));
    },

    _hydrateLoadedState(rawState) {
        const state = JSON.parse(JSON.stringify(rawState || {}));
        this._ensureStateDefaults(state);

        if (Array.isArray(state.districts)) {
            state.districts = state.districts.map(d => {
                const district = new window.Game.Models.District({
                    id: d.id,
                    provinceName: d.provinceName,
                    seatIndex: d.seatIndex,
                    region: d.region,
                    localLeanings: { ...(d.localLeanings || {}) },
                    incumbentPartyId: d.incumbentPartyId || null
                });
                district.currentMPId = d.currentMPId || null;
                district.winningPartyId = d.winningPartyId || null;
                district.ioDebuff = { ...(d.ioDebuff || {}) };
                district.campaignBuff = { ...(d.campaignBuff || {}) };
                return district;
            });
        } else {
            state.districts = [];
        }

        const hydratedPartyMPs = {};
        const mpById = {};
        for (const [partyId, mpList] of Object.entries(state.partyMPs || {})) {
            hydratedPartyMPs[partyId] = (mpList || []).map(m => {
                const mp = new window.Game.Models.MP(m || {});
                mp.id = m.id;
                mp.name = m.name;
                mp.partyId = m.partyId;
                mp.ideology = m.ideology;
                mp.loyaltyToParty = m.loyaltyToParty;
                mp.corruptionLevel = m.corruptionLevel;
                mp.isBribedByPlayer = !!m.isBribedByPlayer;
                mp.isCobra = !!m.isCobra;
                mp.districtId = m.districtId || null;
                mp.isPartyList = !!m.isPartyList;
                mp.localPopularity = m.localPopularity || 0;
                mp.isSeated = !!m.isSeated;
                mpById[mp.id] = mp;
                return mp;
            });
        }
        state.partyMPs = hydratedPartyMPs;

        if (Array.isArray(state.seatedMPs)) {
            state.seatedMPs = state.seatedMPs
                .map(m => mpById[m.id])
                .filter(Boolean);
        } else {
            state.seatedMPs = [];
        }

        return state;
    },

    saveToSlot(slotIndex) {
        const slot = Number(slotIndex);
        if (!Number.isInteger(slot) || slot < 1 || slot > this.SAVE_SLOT_COUNT) {
            return { success: false, msg: 'Invalid save slot.' };
        }
        if (!this.state) return { success: false, msg: 'Game state not initialized.' };

        const playerParty = (this.state.parties || []).find(p => p.id === this.state.playerPartyId);
        const payload = {
            version: 2,
            savedAt: Date.now(),
            currentState: this.currentState || this.STATES.STATE_SETUP,
            meta: {
                electionCount: this.state.electionCount || 1,
                partyName: playerParty ? playerParty.thaiName : 'No party selected',
                parliamentYear: this.state.parliamentYear || 1,
                campaignTurn: this.state.campaignTurn || 1
            },
            state: this._snapshotState()
        };

        localStorage.setItem(this._getSaveSlotKey(slot), JSON.stringify(payload));
        this.logRunEvent('save', `Saved game to slot ${slot}.`, { slot });
        return { success: true, msg: `Saved to slot ${slot}.` };
    },

    loadFromSlot(slotIndex) {
        const slot = Number(slotIndex);
        if (!Number.isInteger(slot) || slot < 1 || slot > this.SAVE_SLOT_COUNT) {
            return { success: false, msg: 'Invalid save slot.' };
        }

        const raw = localStorage.getItem(this._getSaveSlotKey(slot));
        if (!raw) return { success: false, msg: 'No save data in this slot.' };

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            return { success: false, msg: 'Save data is corrupted.' };
        }

        this.state = this._hydrateLoadedState(parsed.state || {});
        this.currentState = parsed.currentState || this.STATES.STATE_SETUP;
        this._heavyInitDone = Array.isArray(this.state.districts) && this.state.districts.length > 0;

        this.logRunEvent('load', `Loaded game from slot ${slot}.`, { slot });
        this._renderCurrentState();

        return { success: true, msg: `Loaded slot ${slot}.` };
    },

    deleteSaveSlot(slotIndex) {
        const slot = Number(slotIndex);
        if (!Number.isInteger(slot) || slot < 1 || slot > this.SAVE_SLOT_COUNT) {
            return { success: false, msg: 'Invalid save slot.' };
        }
        localStorage.removeItem(this._getSaveSlotKey(slot));
        return { success: true, msg: `Deleted slot ${slot}.` };
    },

    getSaveSlots() {
        const slots = [];
        for (let i = 1; i <= this.SAVE_SLOT_COUNT; i++) {
            const raw = localStorage.getItem(this._getSaveSlotKey(i));
            if (!raw) {
                slots.push({ slot: i, empty: true });
                continue;
            }

            try {
                const parsed = JSON.parse(raw);
                slots.push({
                    slot: i,
                    empty: false,
                    savedAt: parsed.savedAt,
                    currentState: parsed.currentState,
                    meta: parsed.meta || {}
                });
            } catch (err) {
                slots.push({ slot: i, empty: true, corrupted: true });
            }
        }
        return slots;
    },

    _renderCurrentState() {
        switch (this.currentState) {
            case this.STATES.STATE_SETUP:
                window.Game.UI.Screens.renderSetup(this.state);
                break;
            case this.STATES.STATE_CAMPAIGN:
                window.Game.UI.Screens.renderCampaign(this.state);
                break;
            case this.STATES.STATE_ELECTION_CALC:
                if (this.state.electionResults) window.Game.UI.Screens.renderElectionResults(this.state);
                else window.Game.UI.Screens.renderCampaign(this.state);
                break;
            case this.STATES.STATE_COALITION:
                if (this.state.electionResults) window.Game.UI.Screens.renderCoalition(this.state);
                else window.Game.UI.Screens.renderCampaign(this.state);
                break;
            case this.STATES.STATE_PARLIAMENT_TERM:
                if (this.state.electionResults) {
                    window.Game.Engine.Parliament.getSeatedMPs(this.state);
                    window.Game.UI.Screens.renderParliament(this.state);
                } else {
                    window.Game.UI.Screens.renderCampaign(this.state);
                }
                break;
            default:
                window.Game.UI.Screens.renderSetup(this.state);
        }
    },

    logRunEvent(type, message, details = {}) {
        if (!this.state) return;
        if (!Array.isArray(this.state.runHistory)) this.state.runHistory = [];

        const playerParty = (this.state.parties || []).find(p => p.id === this.state.playerPartyId);
        const playerSeats = (this.state.electionResults && this.state.electionResults.totalSeats)
            ? (this.state.electionResults.totalSeats[this.state.playerPartyId] || 0)
            : null;

        this.state.runHistory.push({
            at: Date.now(),
            type,
            message,
            details,
            popularity: playerParty ? playerParty.basePopularity : null,
            playerSeats,
            campaignTurn: this.state.campaignTurn,
            parliamentYear: this.state.parliamentYear,
            sessionNumber: this.state.sessionNumber,
            screen: this.currentState
        });

        if (this.state.runHistory.length > 500) {
            this.state.runHistory = this.state.runHistory.slice(-500);
        }
    },

    getRunHistory(limit = 200) {
        if (!this.state || !Array.isArray(this.state.runHistory)) return [];
        return this.state.runHistory.slice(-limit).reverse();
    },

    getRunHistoryAnalytics(filterType = 'all') {
        const allHistory = this.getRunHistory(1000).reverse();
        const normalized = filterType || 'all';
        const filtered = normalized === 'all'
            ? allHistory
            : allHistory.filter(x => x.type === normalized || (normalized === 'parliament' && x.type === 'parliament'));

        let popularityDelta = 0;
        let seatDelta = 0;
        let trustDelta = 0;
        const turningPoints = [];

        for (let i = 0; i < filtered.length; i++) {
            const cur = filtered[i];
            const prev = i > 0 ? filtered[i - 1] : null;

            let popStep = 0;
            let seatStep = 0;
            let trustStep = 0;

            if (typeof cur.details?.popularityDelta === 'number') popStep += cur.details.popularityDelta;
            if (typeof cur.details?.seatDelta === 'number') seatStep += cur.details.seatDelta;
            if (typeof cur.details?.trustDelta === 'number') trustStep += cur.details.trustDelta;

            if (prev && Number.isFinite(cur.popularity) && Number.isFinite(prev.popularity)) {
                popStep += (cur.popularity - prev.popularity);
            }
            if (prev && Number.isFinite(cur.playerSeats) && Number.isFinite(prev.playerSeats)) {
                seatStep += (cur.playerSeats - prev.playerSeats);
            }

            popularityDelta += popStep;
            seatDelta += seatStep;
            trustDelta += trustStep;

            const impact = Math.abs(popStep) + Math.abs(seatStep * 0.7) + Math.abs(trustStep * 0.6) + (cur.details?.turningPointScore || 0);
            if (impact >= 2.2) {
                turningPoints.push({
                    at: cur.at,
                    type: cur.type,
                    message: cur.message,
                    impact: Math.round(impact * 100) / 100,
                    popStep: Math.round(popStep * 100) / 100,
                    seatStep: Math.round(seatStep * 100) / 100,
                    trustStep: Math.round(trustStep * 100) / 100
                });
            }
        }

        turningPoints.sort((a, b) => b.impact - a.impact);

        return {
            count: filtered.length,
            popularityDelta: Math.round(popularityDelta * 100) / 100,
            seatDelta: Math.round(seatDelta * 100) / 100,
            trustDelta: Math.round(trustDelta * 100) / 100,
            topTurningPoints: turningPoints.slice(0, 8),
            filteredEntries: filtered.reverse()
        };
    },

    _buildSandboxDistricts(parties) {
        const districts = [];
        let id = 0;
        for (const [province, seats] of Object.entries(window.Game.Data.PROVINCES || {})) {
            const region = window.Game.Data.PROVINCE_REGION[province] || 'Central';
            for (let i = 1; i <= seats; i++) {
                const d = new window.Game.Models.District({
                    id: ++id,
                    provinceName: province,
                    seatIndex: i,
                    region
                });
                for (const party of parties) {
                    d.localLeanings[party.id] = Math.floor(Math.random() * 10 - 5);
                }
                districts.push(d);
            }
        }
        return districts;
    },

    _buildSandboxPartyMPs(parties, districts) {
        const partyMPs = {};
        for (const party of parties) {
            const mps = [];
            const customNames = party.customCandidates || [];
            const neededNames = 500 - customNames.length;
            const generatedNames = window.Game.Data.generateRoster(Math.max(0, neededNames));
            const allNames = [...customNames, ...generatedNames];

            for (let i = 0; i < 400; i++) {
                const district = districts[i];
                if (!district) break;
                mps.push(new window.Game.Models.MP({
                    name: allNames[i] || window.Game.Data.generateName(),
                    partyId: party.id,
                    ideology: party.ideology + Math.floor(Math.random() * 20 - 10),
                    districtId: district.id,
                    isPartyList: false,
                    localPopularity: Math.floor(Math.random() * 30)
                }));
            }

            for (let i = 400; i < 500; i++) {
                mps.push(new window.Game.Models.MP({
                    name: allNames[i] || window.Game.Data.generateName(),
                    partyId: party.id,
                    ideology: party.ideology + Math.floor(Math.random() * 15 - 7),
                    isPartyList: true,
                    localPopularity: 0
                }));
            }

            partyMPs[party.id] = mps;
        }

        return partyMPs;
    },

    runBalanceSandbox(iterations = 50) {
        const runs = Math.max(5, Math.min(500, parseInt(iterations, 10) || 50));
        const mode = this.state?.scenarioMode || 'realistic';
        const seedParties = (this.state?.parties && this.state.parties.length > 0)
            ? this.state.parties
            : this._initParties(mode);
        const parties = seedParties.map(p => ({
            ...p,
            regionalPopMod: { ...(p.regionalPopMod || {}) },
            regionalBanYai: { ...(p.regionalBanYai || {}) },
            provincialBanYai: { ...(p.provincialBanYai || {}) },
            customCandidates: [...(p.customCandidates || [])]
        }));

        const winCounts = {};
        const seatSeries = {};
        for (const p of parties) {
            winCounts[p.id] = 0;
            seatSeries[p.id] = [];
        }

        for (let i = 0; i < runs; i++) {
            const districts = this._buildSandboxDistricts(parties);
            const partyMPs = this._buildSandboxPartyMPs(parties, districts);
            const simState = {
                parties: parties.map(p => ({
                    ...p,
                    regionalPopMod: { ...(p.regionalPopMod || {}) },
                    regionalBanYai: { ...(p.regionalBanYai || {}) },
                    provincialBanYai: { ...(p.provincialBanYai || {}) }
                })),
                districts,
                partyMPs
            };

            const result = window.Game.Engine.Election.runElection(simState);
            const ranked = [...parties].sort((a, b) => (result.totalSeats[b.id] || 0) - (result.totalSeats[a.id] || 0));
            const winner = ranked[0];
            if (winner) winCounts[winner.id]++;

            for (const p of parties) {
                seatSeries[p.id].push(result.totalSeats[p.id] || 0);
            }
        }

        const stats = parties.map(p => {
            const seats = seatSeries[p.id].slice().sort((a, b) => a - b);
            const avg = seats.reduce((s, v) => s + v, 0) / seats.length;
            const p10 = seats[Math.floor((seats.length - 1) * 0.1)] || 0;
            const p50 = seats[Math.floor((seats.length - 1) * 0.5)] || 0;
            const p90 = seats[Math.floor((seats.length - 1) * 0.9)] || 0;

            const buckets = {
                '0-99': seats.filter(x => x <= 99).length,
                '100-199': seats.filter(x => x >= 100 && x <= 199).length,
                '200-250': seats.filter(x => x >= 200 && x <= 250).length,
                '251+': seats.filter(x => x >= 251).length
            };

            return {
                partyId: p.id,
                shortName: p.shortName,
                thaiName: p.thaiName,
                winRate: Math.round((winCounts[p.id] / runs) * 1000) / 10,
                avgSeats: Math.round(avg * 10) / 10,
                p10,
                p50,
                p90,
                buckets
            };
        }).sort((a, b) => b.winRate - a.winRate || b.avgSeats - a.avgSeats);

        this.logRunEvent('sandbox', `Sandbox ran ${runs} AI-only elections.`, {
            turningPointScore: 2,
            seatDelta: 0
        });

        return {
            runs,
            scenarioMode: mode,
            generatedAt: Date.now(),
            stats
        };
    },

    // ─── Deferred heavy init — only when actually starting game ───
    _ensureHeavyInit() {
        if (this._heavyInitDone) return;
        this._heavyInitDone = true;

        console.time('⚡ Heavy init');

        // Create districts
        this.state.districts = this._initDistricts();

        // Generate MPs for all parties
        this._generateAllMPs();

        console.timeEnd('⚡ Heavy init');
        console.log(`  ${this.state.districts.length} districts, ${Object.values(this.state.partyMPs).reduce((s, a) => s + a.length, 0)} total MPs`);
    },

    // ─── STATE TRANSITIONS ───────────────────────────────────
    transition(newState) {
        console.log(`⚙️ State: ${this.currentState} → ${newState}`);
        this.currentState = newState;
        this.logRunEvent('state', `Transitioned to ${newState}.`);

        switch (newState) {
            case this.STATES.STATE_SETUP:
                window.Game.UI.Screens.renderSetup(this.state);
                break;

            case this.STATES.STATE_CAMPAIGN:
                // Ensure heavy data is ready
                this._ensureHeavyInit();

                this.state.campaignTurn = 1;
                this.state._spawnedPartyThisCampaign = false; // Max 1 emergent party per campaign season
                this.state.actionPoints = window.Game.Engine.Campaign.getAPPerTurn(this.state);
                this.state.campaignPromises = []; // Reset promises for new campaign
                this.state.governmentPartyId = null;
                this.state.playerRole = 'government';
                this.state.coalitionOrder = [];
                this.state.coalitionTurnIndex = 0;
                this.state.coalitionAttempt = 1;
                this.state.pendingCoalitionOffer = null;
                this.state.governmentBillFailedCooldown = {};
                this.state.governmentBillsVotedThisSession = 0;
                this.state.pendingCampaignEvent = null;
                this.state.campaignMomentum = {};
                this.state.campaignActionMemory = {};
                this.state._lastCampaignEventId = null;
                // Reset campaign effects
                for (const d of this.state.districts) {
                    d.campaignBuff = {};
                    d.ioDebuff = {};
                }
                window.Game.Engine.Campaign.initializeAIPersonality(this.state);
                window.Game.Engine.Campaign.initializeCampaignState(this.state);
                window.Game.UI.Map.resetColors();
                window.Game.UI.Screens.renderCampaign(this.state);
                break;

            case this.STATES.STATE_ELECTION_CALC:
                this._runElection();
                break;

            case this.STATES.STATE_COALITION:
                this._initCoalitionFormation();
                this._runAICoalitionRoundsUntilPlayerOrOutcome();
                window.Game.UI.Screens.renderCoalition(this.state);
                break;

            case this.STATES.STATE_PARLIAMENT_TERM:
                this.state.parliamentYear = 1;
                this.state.sessionNumber = 1;
                this.state.seatedMPs = [];
                this.state.passedBillNames = []; // Reset passed bills for new term
                this.state.oppositionPopularityYearTracker = { year: 1, gain: 0 };
                this.state.oppositionActionSession = 1;
                this.state.oppositionActionsRemaining = 2;
                this.state.oppositionWalkoutPlan = null;
                this.state.oppositionSplitPlan = null;
                this.state.governmentBillLog = [];
                this.state.governmentBillQueue = [];
                this.state.governmentBillFailedCooldown = {};
                this.state.governmentBillOutcomeHistory = [];
                this.state.governmentFailedBillStreak = 0;
                this.state.governmentStress = { scandalPoints: 0, failedBillPoints: 0, streakBonus: 0, total: 0 };
                this.state.governmentCrisisChain = null;
                this.state.governmentBillsVotedThisSession = 0;
                this.state.pmOpsUsedThisSession = 0;
                this.state.pmOperationFatigue = {};
                this.state.pmEmergencyShield = 0;
                // Session phase system
                this.state.sessionPhase = (this.state.playerRole === 'government') ? 'question_time' : 'legislative';
                this.state.sessionHeadlines = [];
                this.state.pendingInterpellations = [];
                this.state.pendingCoalitionEvents = [];
                // Initialize coalition satisfaction from formation data
                this.state.coalitionSatisfaction = {};
                if (this.state.playerRole === 'government') {
                    window.Game.Engine.Parliament.initCoalitionSatisfaction(this.state);
                }
                if (this.state.playerRole === 'opposition') {
                    window.Game.Engine.Parliament.queueGovernmentBillsForOpposition(this.state, 0.5);
                }
                try {
                    // Populate seated MPs
                    window.Game.Engine.Parliament.getSeatedMPs(this.state);
                    window.Game.UI.Screens.renderParliament(this.state);
                } catch (err) {
                    console.error('Failed entering parliament term:', err);
                    window.Game.UI.Screens.showNotification('Failed to enter parliament. Recovered to coalition.', 'error');
                    this.currentState = this.STATES.STATE_COALITION;
                    window.Game.UI.Screens.renderCoalition(this.state);
                }
                break;
        }
    },

    // ─── ADD CUSTOM PARTY ────────────────────────────────────
    addCustomParty(partyData) {
        const requestedColor = this._safeHexColor(partyData.hexColor || '', '');
        const uniqueColor = this._pickUniquePartyColor([requestedColor, '#888888']);
        const newParty = {
            id: partyData.id || 'custom_' + Date.now(),
            name: partyData.name,
            thaiName: partyData.thaiName,
            shortName: partyData.shortName || partyData.name.substring(0, 3).toUpperCase(),
            hexColor: uniqueColor,
            basePopularity: parseInt(partyData.basePopularity) || 5,
            banYaiPower: parseInt(partyData.banYaiPower) || 0,
            regionalBanYai: partyData.regionalBanYai || {},
            provincialBanYai: partyData.provincialBanYai || {},
            regionalPopMod: partyData.regionalPopMod || {
                "Bangkok": 0, "Central": 0, "North": 0,
                "Northeast": 0, "East": 0, "West": 0, "South": 0
            },
            politicalCapital: parseInt(partyData.politicalCapital) || 150,
            greyMoney: parseInt(partyData.greyMoney) || 0,
            scandalMeter: 0,
            ideology: parseInt(partyData.ideology) || 50,
            description: partyData.description || 'Custom party',
            isPlayerSelectable: true,
            isCustom: true,
            isScenarioInjected: false,
            customCandidates: partyData.customCandidates || [] // Player-named candidates
        };

        this.state.parties.push(newParty);

        // Need to regenerate heavy init if it was already done
        this._heavyInitDone = false;

        return newParty;
    },

    setScenarioMode(mode) {
        if (!this.state) return;
        const normalized = (mode === 'balanced') ? 'balanced' : 'realistic';
        if (this.state.scenarioMode === normalized) return;

        const customParties = (this.state.parties || [])
            .filter(p => p.isCustom && !p.isScenarioInjected)
            .map(p => ({
                ...p,
                regionalPopMod: { ...(p.regionalPopMod || {}) },
                regionalBanYai: { ...(p.regionalBanYai || {}) },
                provincialBanYai: { ...(p.provincialBanYai || {}) },
                customCandidates: [...(p.customCandidates || [])]
            }));

        this.state.customScenarioConfig = null;
        this._persistCustomScenario(null);
        this.state.scenarioMode = normalized;
        this.state.parties = this._initParties(normalized);
        this.state.parties.push(...customParties);

        this._resetSetupDependentState();
    },

    setDifficultyMode(mode) {
        if (!this.state) return;
        const normalized = window.Game.Engine.Campaign.normalizeDifficultyMode(mode);
        if (this.state.difficultyMode === normalized) return;

        this.state.difficultyMode = normalized;
        this._resetSetupDependentState();
    },

    _resetSetupDependentState() {
        if (!this.state) return;

        // Reset setup-dependent runtime state
        this.state.playerPartyId = null;
        this.state.districts = [];
        this.state.partyMPs = {};
        this.state.electionResults = null;
        this.state.coalitionPartyIds = [];
        this.state.coalitionOrder = [];
        this.state.coalitionTurnIndex = 0;
        this.state.coalitionAttempt = 1;
        this.state.governmentPartyId = null;
        this.state.pendingCoalitionOffer = null;
        this.state.playerRole = 'government';
        this.state.oppositionPopularityYearTracker = { year: 1, gain: 0 };
        this.state.oppositionActionSession = 1;
        this.state.oppositionActionsRemaining = 2;
        this.state.oppositionWalkoutPlan = null;
        this.state.oppositionSplitPlan = null;
        this.state.governmentBillLog = [];
        this.state.governmentBillQueue = [];
        this.state.governmentBillFailedCooldown = {};
        this.state.governmentBillOutcomeHistory = [];
        this.state.governmentFailedBillStreak = 0;
        this.state.governmentStress = { scandalPoints: 0, failedBillPoints: 0, streakBonus: 0, total: 0 };
        this.state.governmentCrisisChain = null;
        this.state.governmentBillsVotedThisSession = 0;
        this.state.pmOpsUsedThisSession = 0;
        this.state.pmOperationFatigue = {};
        this.state.pmEmergencyShield = 0;
        this.state.seatedMPs = [];
        this.state.pendingCampaignEvent = null;
        this.state.campaignMomentum = {};
        this.state.campaignActionMemory = {};
        this.state._lastCampaignEventId = null;
        this.state.runHistory = [];
        this.state.aiPersonality = {};
        this.state.aiAllianceMemory = {};
        this.state.previousElectionSeatTotals = {};
        this.state.coalitionDemands = {};
        this.state.coalitionMinistryOffers = {};
        this.state._spawnedPartyThisCampaign = false;
        this.state._pendingAdvanceStep = 1;
        this._heavyInitDone = false;
    },

    // ─── CAMPAIGN TURN LOGIC ─────────────────────────────────
    endCampaignTurn() {
        // AI campaigns
        window.Game.Engine.Campaign.runAICampaign(this.state, this.state.campaignTurn);
        this._maybeSpawnCampaignPartyEvent();

        this.logRunEvent('campaign', `Week ${this.state.campaignTurn} ended.`);

        this.state.campaignTurn++;
        this.state.actionPoints = window.Game.Engine.Campaign.getAPPerTurn(this.state);

        if (this.state.campaignTurn > window.Game.Engine.Campaign.getMaxCampaignTurns(this.state)) {
            // Election!
            this.transition('STATE_ELECTION_CALC');
        } else {
            this.state.pendingCampaignEvent = window.Game.Engine.Campaign.generateWeeklyEvent(this.state);
            window.Game.UI.Screens.renderCampaign(this.state);
        }
    },

    resolveCampaignEvent(optionIndex) {
        const event = this.state.pendingCampaignEvent;
        if (!event) return;

        const result = window.Game.Engine.Campaign.resolveWeeklyEvent(this.state, event, optionIndex);
        this.state.pendingCampaignEvent = null;

        if (result && result.message) {
            window.Game.UI.Screens.showNotification(
                result.message,
                result.success ? 'success' : 'error'
            );
            this.logRunEvent('campaign-event', result.message, {
                eventId: event.id,
                optionIndex,
                success: result.success,
                popularityDelta: result.metrics?.popularityDelta || 0,
                turningPointScore: result.metrics?.turningPointScore || 0.8
            });
        }

        window.Game.UI.Screens.renderCampaign(this.state);
    },

    // ─── RUN ELECTION ────────────────────────────────────────
    _runElection() {
        console.log('🗳️ Running election...');
        const previousSeatTotals = { ...(this.state.previousElectionSeatTotals || {}) };
        this.state.electionResults = window.Game.Engine.Election.runElection(this.state);
        window.Game.Engine.Campaign.evolveAIPersonalities(this.state, this.state.electionResults);

        // Log results
        for (const p of this.state.parties) {
            console.log(`  ${p.shortName}: ${this.state.electionResults.totalSeats[p.id]} seats (${this.state.electionResults.constituencyWins[p.id]} + ${this.state.electionResults.partyListSeats[p.id]})`);
        }

        const seatSummary = this.state.parties
            .map(p => ({ id: p.id, seats: this.state.electionResults.totalSeats[p.id] || 0 }))
            .sort((a, b) => b.seats - a.seats)
            .slice(0, 5)
            .map(x => `${x.id}:${x.seats}`)
            .join(', ');
        const seatDelta = this.state.playerPartyId
            ? ((this.state.electionResults.totalSeats[this.state.playerPartyId] || 0) - (previousSeatTotals[this.state.playerPartyId] || 0))
            : 0;
        this.logRunEvent('election', `Election concluded. Top seats -> ${seatSummary}`, {
            seatDelta,
            turningPointScore: 2.5
        });

        // Reset seated MPs for fresh population
        this.state.seatedMPs = [];
        this.state.coalitionPartyIds = [];
        this.state.coalitionOrder = [];
        this.state.coalitionTurnIndex = 0;
        this.state.coalitionAttempt = 1;
        this.state.governmentPartyId = null;
        this.state.pendingCoalitionOffer = null;
        this.state.governmentBillLog = [];
        this.state.governmentBillQueue = [];
        this.state.governmentBillFailedCooldown = {};
        this.state.governmentBillOutcomeHistory = [];
        this.state.governmentFailedBillStreak = 0;
        this.state.governmentStress = { scandalPoints: 0, failedBillPoints: 0, streakBonus: 0, total: 0 };
        this.state.governmentCrisisChain = null;
        this.state.governmentBillsVotedThisSession = 0;
        this.state.pmOpsUsedThisSession = 0;
        this.state.pmOperationFatigue = {};
        this.state.pmEmergencyShield = 0;
        this.state.oppositionActionSession = 1;
        this.state.oppositionActionsRemaining = 2;
        this.state.oppositionWalkoutPlan = null;
        this.state.oppositionSplitPlan = null;

        this.state.electionCount++;
        window.Game.UI.Screens.renderElectionResults(this.state);
    },

    _ensureAllianceMemoryState() {
        if (!this.state.aiAllianceMemory) this.state.aiAllianceMemory = {};
        for (const p of this.state.parties || []) {
            if (!this.state.aiAllianceMemory[p.id]) this.state.aiAllianceMemory[p.id] = {};
        }
    },

    _getAllianceMemoryScore(observerPartyId, subjectPartyId) {
        this._ensureAllianceMemoryState();
        return this.state.aiAllianceMemory?.[observerPartyId]?.[subjectPartyId] || 0;
    },

    _adjustAllianceMemory(observerPartyId, subjectPartyId, delta, reason = '') {
        this._ensureAllianceMemoryState();
        const current = this._getAllianceMemoryScore(observerPartyId, subjectPartyId);
        const next = Math.max(-80, Math.min(80, current + delta));
        this.state.aiAllianceMemory[observerPartyId][subjectPartyId] = next;
        this.logRunEvent('coalition', `Alliance memory: ${observerPartyId} -> ${subjectPartyId} ${delta > 0 ? '+' : ''}${delta}. ${reason}`.trim(), {
            trustDelta: delta,
            turningPointScore: Math.abs(delta) >= 8 ? 1.5 : 0.6
        });
        return next;
    },

    _getInviteBreakdown(formateurId, inviteeId, coalitionPartyIds) {
        const formateur = this.state.parties.find(p => p.id === formateurId);
        const invitee = this.state.parties.find(p => p.id === inviteeId);
        if (!formateur || !invitee) {
            return {
                chance: 0,
                minChance: 0.02,
                maxChance: 0.9,
                trust: 0,
                offered: 0,
                required: 0,
                shortfall: 0,
                redLinePartyIds: []
            };
        }

        const totalSeats = this.state.electionResults.totalSeats || {};
        const inviteeSeats = totalSeats[inviteeId] || 0;
        const currentSeats = this._getCoalitionSeats(coalitionPartyIds);
        const seatsNeeded = Math.max(0, 251 - currentSeats);
        const ideologyDistance = Math.abs((formateur.ideology || 50) - (invitee.ideology || 50));

        let chance = 0.58;
        const pieces = {
            base: 0.58,
            ideology: -(ideologyDistance / 185),
            smallPartyBonus: inviteeSeats <= 30 ? 0.12 : 0,
            kingmakerBonus: inviteeSeats >= seatsNeeded && seatsNeeded > 0 ? 0.08 : 0,
            roundTwoBonus: this.state.coalitionAttempt === 2 ? 0.08 : 0,
            trustBonus: 0,
            offerBonus: 0,
            allianceMemoryBonus: 0,
            redLinePenalty: 0
        };

        chance += pieces.ideology;
        chance += pieces.smallPartyBonus;
        chance += pieces.kingmakerBonus;
        chance += pieces.roundTwoBonus;

        const demand = this.state.coalitionDemands[inviteeId];
        let trust = 0;
        let offered = 0;
        let required = 0;
        let shortfall = 0;
        let redLinePartyIds = [];

        if (demand) {
            trust = demand.trust;
            offered = this.state.coalitionMinistryOffers[inviteeId] || 0;
            required = demand.ministryDemand || 0;
            shortfall = Math.max(0, required - offered);
            redLinePartyIds = [...(demand.redLinePartyIds || [])];

            pieces.trustBonus = (trust - 50) / 100;
            pieces.offerBonus = (offered - required) * 0.07;
            chance += pieces.trustBonus;
            chance += pieces.offerBonus;

            if (redLinePartyIds.some(pid => coalitionPartyIds.includes(pid))) {
                pieces.redLinePenalty = -0.5;
                chance = Math.min(chance, 0.08);
            }
        }

        const memory = this._getAllianceMemoryScore(inviteeId, formateurId);
        pieces.allianceMemoryBonus = memory / 220;
        chance += pieces.allianceMemoryBonus;

        chance = Math.max(0.08, Math.min(0.9, chance));

        return {
            chance,
            minChance: 0.02,
            maxChance: 0.9,
            ideologyDistance,
            seatsNeeded,
            inviteeSeats,
            trust,
            offered,
            required,
            shortfall,
            redLinePartyIds,
            allianceMemory: memory,
            pieces
        };
    },

    // ─── ADVANCE YEAR ────────────────────────────────────────
    _initCoalitionFormation() {
        const results = this.state.electionResults;
        const sorted = [...this.state.parties]
            .filter(p => (results.totalSeats[p.id] || 0) > 0)
            .sort((a, b) => (results.totalSeats[b.id] || 0) - (results.totalSeats[a.id] || 0));

        this.state.coalitionOrder = sorted.map(p => p.id);
        this.state.coalitionTurnIndex = 0;
        this.state.coalitionAttempt = 1;
        this.state.governmentPartyId = null;
        this.state.pendingCoalitionOffer = null;

        const first = this.getCurrentFormateurId();
        this.state.coalitionPartyIds = first ? [first] : [];
        this._initCoalitionNegotiationData();
    },

    _initCoalitionNegotiationData() {
        const formateurId = this.getCurrentFormateurId();
        const formateur = this.state.parties.find(p => p.id === formateurId);
        const results = this.state.electionResults || { totalSeats: {} };
        const all = this.state.parties.filter(p => (results.totalSeats[p.id] || 0) > 0);

        this._ensureAllianceMemoryState();

        this.state.coalitionDemands = {};
        this.state.coalitionMinistryOffers = {};

        for (const p of all) {
            if (p.id === formateurId) continue;
            const ideologyDistance = Math.abs((formateur?.ideology || 50) - (p.ideology || 50));
            const memoryWithFormateur = this._getAllianceMemoryScore(p.id, formateurId);
            const trustBase = 70 - (ideologyDistance * 0.48) + (memoryWithFormateur * 0.28) + Math.floor(Math.random() * 14 - 7);
            const trust = Math.max(22, Math.min(88, Math.round(trustBase)));

            const redLineCandidate = [...all]
                .filter(x => x.id !== p.id && x.id !== formateurId)
                .sort((a, b) => Math.abs((p.ideology || 50) - (b.ideology || 50)) - Math.abs((p.ideology || 50) - (a.ideology || 50)))[0];
            const redLineIds = [];
            if (redLineCandidate) {
                const dist = Math.abs((p.ideology || 50) - (redLineCandidate.ideology || 50));
                const memoryWithCandidate = this._getAllianceMemoryScore(p.id, redLineCandidate.id);
                if (dist >= 45 || memoryWithCandidate <= -35) redLineIds.push(redLineCandidate.id);
            }

            const seats = results.totalSeats[p.id] || 0;
            const demandCount = Math.max(1, Math.min(5, Math.round((seats / 500) * 14 + (trust < 42 ? 1 : 0))));
            const desiredMinistries = window.Game.Engine.Parliament.getMinistryDemands(p.id, seats, 500);

            this.state.coalitionDemands[p.id] = {
                trust,
                ministryDemand: demandCount,
                desiredMinistries,
                redLinePartyIds: redLineIds
            };
            this.state.coalitionMinistryOffers[p.id] = 0;
        }
    },

    getCoalitionOfferedMinistryTotal() {
        return Object.values(this.state.coalitionMinistryOffers || {}).reduce((sum, v) => sum + (v || 0), 0);
    },

    adjustCoalitionOffer(partyId, delta) {
        const formateurId = this.getCurrentFormateurId();
        if (formateurId !== this.state.playerPartyId) {
            return { success: false, msg: 'Only the player formateur can allocate ministries.' };
        }
        const demandMeta = this.state.coalitionDemands[partyId];
        if (!demandMeta) {
            return { success: false, msg: 'No negotiation demand found for this party.' };
        }

        const current = this.state.coalitionMinistryOffers[partyId] || 0;
        const offeredTotal = this.getCoalitionOfferedMinistryTotal();
        const maxPool = this._getMinistryPool().length;

        if (delta > 0 && offeredTotal >= maxPool) {
            return { success: false, msg: 'No ministries left to offer.' };
        }

        const next = Math.max(0, Math.min(8, current + delta));
        if (next > current && (offeredTotal + (next - current)) > maxPool) {
            return { success: false, msg: 'Ministry pool exceeded.' };
        }

        this.state.coalitionMinistryOffers[partyId] = next;
        return {
            success: true,
            msg: `Offer for ${partyId}: ${next}/${demandMeta.ministryDemand} ministries (trust ${demandMeta.trust}).`,
            details: {
                partyId,
                offered: next,
                required: demandMeta.ministryDemand,
                trust: demandMeta.trust
            }
        };
    },

    _getCoalitionDealIssues(formateurId, coalitionIds, ministryOffersOverride = null) {
        const offers = ministryOffersOverride || this.state.coalitionMinistryOffers || {};
        const unmet = [];
        const redLineViolations = [];

        for (const pid of coalitionIds) {
            if (pid === formateurId) continue;
            const demand = this.state.coalitionDemands[pid];
            if (!demand) continue;

            const offered = offers[pid] || 0;
            if (offered < demand.ministryDemand) {
                unmet.push({ partyId: pid, missing: demand.ministryDemand - offered });
            }

            if ((demand.redLinePartyIds || []).some(blocked => coalitionIds.includes(blocked))) {
                redLineViolations.push({ partyId: pid, blockedBy: demand.redLinePartyIds.filter(x => coalitionIds.includes(x)) });
            }
        }

        return { unmet, redLineViolations };
    },

    getCurrentFormateurId() {
        return (this.state.coalitionOrder || [])[this.state.coalitionTurnIndex] || null;
    },

    isPlayerCoalitionTurn() {
        return this.getCurrentFormateurId() === this.state.playerPartyId;
    },

    _getCoalitionSeats(partyIds) {
        const results = this.state.electionResults;
        return (partyIds || []).reduce((sum, pid) => sum + (results.totalSeats[pid] || 0), 0);
    },

    _inviteAcceptanceChance(formateurId, inviteeId, coalitionPartyIds) {
        return this._getInviteBreakdown(formateurId, inviteeId, coalitionPartyIds).chance;
    },

    tryInviteCoalitionParty(inviteeId) {
        const formateurId = this.getCurrentFormateurId();
        if (!formateurId || formateurId !== this.state.playerPartyId) {
            return { success: false, msg: 'Not your coalition turn.' };
        }
        if (inviteeId === formateurId) {
            return { success: false, msg: 'Cannot invite your own party.' };
        }

        const idx = this.state.coalitionPartyIds.indexOf(inviteeId);
        if (idx !== -1) {
            this.state.coalitionPartyIds.splice(idx, 1);
            return { success: true, msg: 'Party removed from proposed coalition.' };
        }

        const breakdown = this._getInviteBreakdown(formateurId, inviteeId, this.state.coalitionPartyIds);
        const chance = breakdown.chance;
        const accepted = Math.random() < chance;
        const party = this.state.parties.find(p => p.id === inviteeId);
        const name = party ? party.thaiName : inviteeId;

        const demand = this.state.coalitionDemands[inviteeId];
        if (demand) {
            const offered = this.state.coalitionMinistryOffers[inviteeId] || 0;
            if (offered < demand.ministryDemand) {
                return {
                    success: false,
                    msg: `${name} demands ${demand.ministryDemand} ministries. Offer more before inviting.`,
                    details: {
                        reason: 'ministry_shortfall',
                        trust: demand.trust,
                        offered,
                        required: demand.ministryDemand,
                        shortfall: Math.max(0, demand.ministryDemand - offered),
                        chancePercent: Math.round(chance * 100)
                    }
                };
            }
            const blocked = (demand.redLinePartyIds || []).find(pid => this.state.coalitionPartyIds.includes(pid));
            if (blocked) {
                const blockedParty = this.state.parties.find(p => p.id === blocked);
                return {
                    success: false,
                    msg: `${name} refuses to sit with ${blockedParty ? blockedParty.thaiName : blocked}.`,
                    details: {
                        reason: 'red_line',
                        trust: demand.trust,
                        offered,
                        required: demand.ministryDemand,
                        blockedPartyId: blocked,
                        chancePercent: Math.round(chance * 100)
                    }
                };
            }
        }

        if (!accepted) {
            const msg = `${name} rejected your invitation (chance ${Math.round(chance * 100)}%, trust ${breakdown.trust || '-'}, offer ${breakdown.offered || 0}/${breakdown.required || 0}).`;
            this.logRunEvent('coalition', `${name} rejected coalition invite.`, {
                trustDelta: -1,
                turningPointScore: 1.2
            });
            this._adjustAllianceMemory(inviteeId, formateurId, -2, 'Rejected coalition invite.');
            return {
                success: false,
                msg,
                details: {
                    reason: 'probability_reject',
                    chancePercent: Math.round(chance * 100),
                    trust: breakdown.trust,
                    offered: breakdown.offered,
                    required: breakdown.required,
                    allianceMemory: breakdown.allianceMemory
                }
            };
        }

        this.state.coalitionPartyIds.push(inviteeId);
        this.logRunEvent('coalition', `${name} joined coalition talks.`);
        this._adjustAllianceMemory(inviteeId, formateurId, 3, 'Accepted coalition invite.');
        return { success: true, msg: `${name} accepted and joined your coalition talks.` };
    },

    submitCoalitionAttempt() {
        const formateurId = this.getCurrentFormateurId();
        if (!formateurId || formateurId !== this.state.playerPartyId) return;

        const seats = this._getCoalitionSeats(this.state.coalitionPartyIds);
        if (seats >= 251) {
            const issues = this._getCoalitionDealIssues(formateurId, this.state.coalitionPartyIds);
            if (issues.redLineViolations.length > 0) {
                const bad = issues.redLineViolations[0];
                const party = this.state.parties.find(p => p.id === bad.partyId);
                const blockedParty = this.state.parties.find(p => p.id === bad.blockedBy[0]);
                window.Game.UI.Screens.showNotification(
                    `${party ? party.thaiName : bad.partyId} vetoed coalition due to red-line conflict with ${blockedParty ? blockedParty.thaiName : bad.blockedBy[0]}.`,
                    'error'
                );
                this.logRunEvent('coalition', 'Coalition submission failed: red-line conflict.', {
                    trustDelta: -3,
                    turningPointScore: 2,
                    details: { partyId: bad.partyId, blockedBy: bad.blockedBy }
                });
                this._adjustAllianceMemory(bad.partyId, formateurId, -6, 'Red-line conflict during coalition submission.');
                return;
            }
            if (issues.unmet.length > 0) {
                const miss = issues.unmet[0];
                const party = this.state.parties.find(p => p.id === miss.partyId);
                window.Game.UI.Screens.showNotification(
                    `${party ? party.thaiName : miss.partyId} still wants ${miss.missing} more ministry allocation(s).`,
                    'error'
                );
                this.logRunEvent('coalition', 'Coalition submission failed: ministry shortfall.', {
                    trustDelta: -2,
                    turningPointScore: 1.5,
                    details: { partyId: miss.partyId, missing: miss.missing }
                });
                this._adjustAllianceMemory(miss.partyId, formateurId, -4, 'Ministry demand unmet during coalition submission.');
                return;
            }
            this._finalizeGovernment(formateurId, this.state.coalitionPartyIds);
            this.transition('STATE_PARLIAMENT_TERM');
            return;
        }

        const remaining = 251 - seats;
        if (this.state.coalitionAttempt < 2) {
            this.state.coalitionAttempt++;
            this.state.coalitionPartyIds = [formateurId];
            window.Game.UI.Screens.showNotification(
                `Round 1 failed (${remaining} seats short). You get one final coalition round.`,
                'error'
            );
            window.Game.UI.Screens.renderCoalition(this.state);
            return;
        }

        window.Game.UI.Screens.showNotification(
            'Your coalition rounds are over. Mandate passed to the next party.',
            'error'
        );
        this._advanceCoalitionMandate();
        this._runAICoalitionRoundsUntilPlayerOrOutcome();

        if (this.state.governmentPartyId) {
            this.transition('STATE_PARLIAMENT_TERM');
            return;
        }
        window.Game.UI.Screens.renderCoalition(this.state);
    },

    _advanceCoalitionMandate() {
        this.state.coalitionTurnIndex++;
        this.state.coalitionAttempt = 1;

        const nextFormateur = this.getCurrentFormateurId();
        this.state.coalitionPartyIds = nextFormateur ? [nextFormateur] : [];
        this._initCoalitionNegotiationData();
    },

    _finalizeGovernment(formateurId, coalitionPartyIds) {
        const coalition = [...new Set(coalitionPartyIds)];
        this.state.governmentPartyId = formateurId;
        this.state.coalitionPartyIds = coalition;
        this.state.playerRole = coalition.includes(this.state.playerPartyId) ? 'government' : 'opposition';
        this.logRunEvent('coalition', `Government formed by ${formateurId} with ${this._getCoalitionSeats(coalition)} seats.`);

        for (const pid of coalition) {
            if (pid === formateurId) continue;
            this._adjustAllianceMemory(pid, formateurId, 6, 'Entered governing coalition together.');
            this._adjustAllianceMemory(formateurId, pid, 4, 'Built coalition partnership.');
        }
    },

    _runAICoalitionRoundsUntilPlayerOrOutcome() {
        while (!this.state.governmentPartyId) {
            if (this.state.pendingCoalitionOffer) return;
            const formateurId = this.getCurrentFormateurId();
            if (!formateurId) break;
            if (formateurId === this.state.playerPartyId) return;

            const result = this._runSingleAICoalitionAttempt(formateurId);
            if (result.formed) return;
            if (result.offerPending) return;

            if (this.state.coalitionAttempt < 2) {
                this.state.coalitionAttempt++;
                this.state.coalitionPartyIds = [formateurId];
            } else {
                this._advanceCoalitionMandate();
            }
        }

        if (!this.state.governmentPartyId) {
            const caretakerId = (this.state.coalitionOrder || [])[0];
            if (caretakerId) {
                this._finalizeGovernment(caretakerId, [caretakerId]);
            }
        }
    },

    _runSingleAICoalitionAttempt(formateurId) {
        const totalSeats = this.state.electionResults.totalSeats || {};
        const seatRanked = [...this.state.parties]
            .filter(p => p.id !== formateurId && (totalSeats[p.id] || 0) > 0)
            .sort((a, b) => (totalSeats[b.id] || 0) - (totalSeats[a.id] || 0));

        const proposed = [formateurId];
        const offerPlan = {};
        let ministriesRemaining = this._getMinistryPool().length;
        for (let i = 0; i < seatRanked.length; i++) {
            const p = seatRanked[i];
            if (this._getCoalitionSeats(proposed) >= 251) break;

            const demand = this.state.coalitionDemands[p.id];
            const minimumOffer = demand ? demand.ministryDemand : 1;
            const aiOffer = Math.max(1, Math.min(6, minimumOffer + (Math.random() < 0.35 ? 1 : 0)));
            if (ministriesRemaining < minimumOffer) continue;
            offerPlan[p.id] = aiOffer;
            ministriesRemaining -= aiOffer;
            this.state.coalitionMinistryOffers[p.id] = aiOffer;

            const chance = this._inviteAcceptanceChance(formateurId, p.id, proposed);
            const wantsInvite = Math.random() < chance;
            if (!wantsInvite) {
                if (chance >= 0.5) {
                    this._adjustAllianceMemory(p.id, formateurId, -1, 'AI coalition outreach failed.');
                }
                continue;
            }

            if (p.id === this.state.playerPartyId) {
                this.state.pendingCoalitionOffer = {
                    formateurId,
                    attempt: this.state.coalitionAttempt,
                    baseProposedPartyIds: [...proposed],
                    remainingCandidateIds: seatRanked.slice(i + 1).map(x => x.id),
                    ministryOffers: { ...offerPlan }
                };
                this.state.coalitionPartyIds = [...proposed];
                return { formed: false, offerPending: true };
            }

            proposed.push(p.id);
            this._adjustAllianceMemory(p.id, formateurId, 2, 'Joined AI coalition talks.');
        }

        if (this._getCoalitionSeats(proposed) >= 251) {
            this._finalizeGovernment(formateurId, proposed);
            return { formed: true };
        }

        return { formed: false };
    },

    respondToCoalitionOffer(accept) {
        const offer = this.state.pendingCoalitionOffer;
        if (!offer) return;

        this.logRunEvent('coalition', `Player ${accept ? 'accepted' : 'rejected'} coalition offer from ${offer.formateurId}.`);

        const formateurId = offer.formateurId;
        const proposed = [...offer.baseProposedPartyIds];
        const remaining = [...offer.remainingCandidateIds];
        const ministryOffers = { ...(offer.ministryOffers || {}) };
        if (accept) {
            proposed.push(this.state.playerPartyId);
            this._adjustAllianceMemory(this.state.playerPartyId, formateurId, 5, 'Accepted coalition invitation.');
        }
        if (!accept) {
            this._adjustAllianceMemory(this.state.playerPartyId, formateurId, -5, 'Rejected coalition invitation.');
        }

        for (const pid of remaining) {
            if (this._getCoalitionSeats(proposed) >= 251) break;
            if (pid === this.state.playerPartyId) continue;
            const demand = this.state.coalitionDemands[pid];
            if (demand) {
                ministryOffers[pid] = Math.max(ministryOffers[pid] || 0, demand.ministryDemand);
            }
            this.state.coalitionMinistryOffers[pid] = ministryOffers[pid] || this.state.coalitionMinistryOffers[pid] || 0;
            const chance = this._inviteAcceptanceChance(formateurId, pid, proposed);
            const accepted = Math.random() < chance;
            if (accepted) proposed.push(pid);
        }

        this.state.pendingCoalitionOffer = null;
        this.state.coalitionPartyIds = [...new Set(proposed)];
        this.state.coalitionMinistryOffers = { ...this.state.coalitionMinistryOffers, ...ministryOffers };

        if (this._getCoalitionSeats(this.state.coalitionPartyIds) >= 251) {
            const issues = this._getCoalitionDealIssues(formateurId, this.state.coalitionPartyIds);
            if (issues.redLineViolations.length === 0 && issues.unmet.length === 0) {
                this._finalizeGovernment(formateurId, this.state.coalitionPartyIds);
                window.Game.UI.Screens.showNotification(
                    accept ? 'You accepted the coalition offer. Government formed.' : 'You rejected, but they formed government anyway.',
                    'info'
                );
                this.transition('STATE_PARLIAMENT_TERM');
                return;
            }

            const failMsg = issues.redLineViolations.length > 0
                ? 'Coalition collapsed due to red-line conflict among partners.'
                : 'Coalition collapsed due to unmet ministry demands.';
            window.Game.UI.Screens.showNotification(failMsg, 'error');
            this.logRunEvent('coalition', failMsg, {
                trustDelta: -4,
                turningPointScore: 2.3,
                details: {
                    redLineViolations: issues.redLineViolations,
                    unmet: issues.unmet
                }
            });
        }

        if (this.state.coalitionAttempt < 2) {
            this.state.coalitionAttempt++;
            this.state.coalitionPartyIds = [formateurId];
        } else {
            this._advanceCoalitionMandate();
        }
        this._runAICoalitionRoundsUntilPlayerOrOutcome();
        if (this.state.governmentPartyId) {
            this.transition('STATE_PARLIAMENT_TERM');
            return;
        }
        window.Game.UI.Screens.renderCoalition(this.state);
    },

    _advanceYearLegacy() {
        // Generate a crisis event first (70% chance)
        const crisis = window.Game.Engine.Crisis.generateCrisis(this.state);
        if (crisis) {
            // Store crisis and show it — year won't advance until player resolves it
            this.state._pendingCrisis = crisis;
            window.Game.UI.Screens.renderCrisis(this.state, crisis);
            return;
        }

        // No crisis — advance immediately
        this._advanceYearAfterCrisisLegacy();
    },

    // Called after crisis is resolved (or if no crisis occurred)
    _advanceYearAfterCrisisLegacy() {
        // EC investigation check
        const ecResult = window.Game.Engine.Shadow.checkECInvestigation(this.state);
        if (ecResult) {
            if (ecResult.gameOver) {
                window.Game.UI.Screens.renderGameOver(ecResult.msg);
                return;
            }
            window.Game.UI.Screens.showNotification(ecResult.msg, 'error');
        }

        this.state.parliamentYear++;
        this.state.sessionNumber++;
        this.state.governmentBillsVotedThisSession = 0;

        // Check unfulfilled campaign promises
        const promiseWarnings = window.Game.Engine.Parliament.checkUnfulfilledPromises(this.state);
        for (const warning of promiseWarnings) {
            setTimeout(() => {
                window.Game.UI.Screens.showNotification(warning, 'error');
            }, promiseWarnings.indexOf(warning) * 1500);
        }

        // Reset temporary bribes (not cobras)
        for (const mp of this.state.seatedMPs) {
            if (!mp.isCobra) {
                mp.isBribedByPlayer = false;
            }
            // Small loyalty drift
            mp.loyaltyToParty = Math.max(10, Math.min(95,
                mp.loyaltyToParty + Math.floor(Math.random() * 10 - 5)
            ));
        }

        // Grant yearly resources
        const pp = this.state.parties.find(p => p.id === this.state.playerPartyId);
        pp.politicalCapital += 80;
        // Scandal decay
        pp.scandalMeter = Math.max(0, pp.scandalMeter - 5);

        if (this.state.parliamentYear > 4) {
            // Term ends — new election
            window.Game.UI.Screens.showNotification("📅 4-year term complete! New election triggered.", 'info');
            setTimeout(() => this.transition('STATE_CAMPAIGN'), 1500);
            return;
        }

        window.Game.UI.Screens.renderParliament(this.state);
    },

    // Called when player resolves a crisis
    resolveCrisis(optionIndex) {
        if (this.state.playerRole === 'opposition') return;
        const crisis = this.state._pendingCrisis;
        if (!crisis) return;

        const result = window.Game.Engine.Crisis.resolveCrisis(this.state, crisis, optionIndex);
        this.state._pendingCrisis = null;
        this.state.governmentStress = window.Game.Engine.Crisis.calculateGovernmentStress(this.state);
        this.logRunEvent('crisis', `${crisis.engName}: ${result.success ? 'handled' : 'failed'} via option ${optionIndex + 1}.`);

        // Show the result, then advance year
        window.Game.UI.Screens.renderCrisisResult(this.state, crisis, result);
    },

    // Time-advance overrides (placed after legacy methods to take precedence)
    advanceYear() {
        this._advanceTime(1);
    },

    advanceHalfYear() {
        this._advanceTime(0.5);
    },

    recordGovernmentBillOutcome(passed) {
        if (!this.state || this.state.playerRole !== 'government') return;
        if (!Array.isArray(this.state.governmentBillOutcomeHistory)) {
            this.state.governmentBillOutcomeHistory = [];
        }

        const didPass = !!passed;
        this.state.governmentBillOutcomeHistory.push(didPass);
        this.state.governmentBillOutcomeHistory = this.state.governmentBillOutcomeHistory.slice(-8);

        if (didPass) {
            this.state.governmentFailedBillStreak = 0;
        } else {
            this.state.governmentFailedBillStreak = (this.state.governmentFailedBillStreak || 0) + 1;
        }

        this.state.governmentStress = window.Game.Engine.Crisis.calculateGovernmentStress(this.state);
    },

    _advanceTime(stepYears) {
        // Opposition cannot directly choose government crisis responses.
        if (this.state.playerRole === 'opposition') {
            this.state._pendingCrisis = null;
            this.state._pendingAdvanceStep = 1;
            this._advanceYearAfterCrisis(stepYears);
            return;
        }

        const stress = window.Game.Engine.Crisis.calculateGovernmentStress(this.state);
        this.state.governmentStress = stress;

        const chainedCrisis = window.Game.Engine.Crisis.maybeStartGovernmentCrisisChain(this.state, stress);
        if (chainedCrisis) {
            this.state._pendingCrisis = chainedCrisis;
            this.state._pendingAdvanceStep = stepYears;
            window.Game.UI.Screens.renderCrisis(this.state, chainedCrisis);
            return;
        }

        const shield = Math.max(0, this.state.pmEmergencyShield || 0);
        const baseChance = stepYears >= 1 ? 0.70 : 0.40;
        const crisisChance = Math.max(0.08, baseChance - (shield * 0.1));
        const crisis = window.Game.Engine.Crisis.generateCrisis(this.state, crisisChance);
        if (crisis) {
            this.state._pendingCrisis = crisis;
            this.state._pendingAdvanceStep = stepYears;
            window.Game.UI.Screens.renderCrisis(this.state, crisis);
            return;
        }
        this._advanceYearAfterCrisis(stepYears);
    },

    _advanceYearAfterCrisis(stepYears = 1) {
        const ecResult = window.Game.Engine.Shadow.checkECInvestigation(this.state);
        if (ecResult) {
            if (ecResult.gameOver) {
                window.Game.UI.Screens.renderGameOver(ecResult.msg);
                return;
            }
            window.Game.UI.Screens.showNotification(ecResult.msg, 'error');
        }

        this.state.parliamentYear = Math.round((this.state.parliamentYear + stepYears) * 10) / 10;
        this.state.sessionNumber++;
        this.state.governmentBillsVotedThisSession = 0;
        this.state.pmOpsUsedThisSession = 0;
        this.state.sessionPhase = (this.state.playerRole === 'government') ? 'question_time' : 'legislative';
        this.state.sessionHeadlines = [];
        this.state.pendingInterpellations = [];
        this.state.pendingCoalitionEvents = [];
        this.state.pmEmergencyShield = Math.max(0, (this.state.pmEmergencyShield || 0) - 1);
        this.state.oppositionActionSession = this.state.sessionNumber;
        this.state.oppositionActionsRemaining = 2;

        if (this.state.playerRole === 'opposition') {
            const autoResolved = window.Game.Engine.Parliament.resolvePendingGovernmentBillsAsAbstain(this.state);
            const govResult = window.Game.Engine.Parliament.queueGovernmentBillsForOpposition(this.state, stepYears);
            window.Game.Engine.Parliament.applyOppositionIncumbencyWear(this.state, stepYears);
            if (autoResolved > 0) {
                window.Game.UI.Screens.showNotification(
                    `You skipped ${autoResolved} government bill vote(s). They were auto-resolved.`,
                    'info'
                );
            }
            if (govResult && govResult.queuedCount > 0) {
                window.Game.UI.Screens.showNotification(
                    `Government proposed ${govResult.queuedCount} bill(s) for parliamentary vote.`,
                    'info'
                );
            }
        }

        const promiseWarnings = window.Game.Engine.Parliament.checkUnfulfilledPromises(this.state);
        for (const warning of promiseWarnings) {
            setTimeout(() => {
                window.Game.UI.Screens.showNotification(warning, 'error');
            }, promiseWarnings.indexOf(warning) * 1500);
        }

        for (const mp of this.state.seatedMPs) {
            if (!mp.isCobra) {
                mp.isBribedByPlayer = false;
            }
            mp.loyaltyToParty = Math.max(10, Math.min(95,
                mp.loyaltyToParty + Math.floor(Math.random() * 10 - 5)
            ));
        }

        const pp = this.state.parties.find(p => p.id === this.state.playerPartyId);
        pp.politicalCapital += Math.round(80 * stepYears);
        pp.scandalMeter = Math.max(0, pp.scandalMeter - Math.round(5 * stepYears));

        if (this.state.parliamentYear > 4) {
            window.Game.UI.Screens.showNotification("📅 4-year term complete! New election triggered.", 'info');
            setTimeout(() => this.transition('STATE_CAMPAIGN'), 1500);
            return;
        }

        window.Game.UI.Screens.renderParliament(this.state);
    },

    continueAfterCrisis() {
        if (this.state.playerRole === 'government') {
            const nextChainCrisis = window.Game.Engine.Crisis.getActiveGovernmentChainCrisis(this.state);
            if (nextChainCrisis) {
                this.state._pendingCrisis = nextChainCrisis;
                window.Game.UI.Screens.renderCrisis(this.state, nextChainCrisis);
                return;
            }
        }

        const step = this.state._pendingAdvanceStep || 1;
        this.state._pendingAdvanceStep = 1;
        this._advanceYearAfterCrisis(step);
    },

    // ─── SESSION PHASE MANAGEMENT ──────────────────────────────
    advanceSessionPhase() {
        const phases = window.Game.Engine.Parliament.SESSION_PHASES;
        const currentIndex = phases.indexOf(this.state.sessionPhase || 'question_time');
        if (currentIndex < phases.length - 1) {
            this.state.sessionPhase = phases[currentIndex + 1];

            // When entering legislative phase for government, tick coalition dynamics
            if (this.state.sessionPhase === 'legislative' && this.state.playerRole === 'government') {
                const dynamics = window.Game.Engine.Parliament.tickCoalitionDynamics(this.state);
                // Store any events for UI to pick up
                this.state.pendingCoalitionEvents = dynamics.events || [];
                // Notify about expired demands
                for (const exp of (dynamics.expiredDemands || [])) {
                    const partyName = (this.state.parties || []).find(p => p.id === exp.partyId)?.thaiName || exp.partyId;
                    window.Game.UI.Screens.showNotification(
                        `⚠️ ${partyName} demand expired: ${exp.demand.label}. Satisfaction penalized!`, 'error'
                    );
                }
                // Notify about new demands
                for (const nd of (dynamics.newDemands || [])) {
                    const partyName = (this.state.parties || []).find(p => p.id === nd.partyId)?.thaiName || nd.partyId;
                    window.Game.UI.Screens.showNotification(
                        `📮 ${partyName} has a new demand: ${nd.demand.label}`, 'info'
                    );
                }
            }

            // When entering adjournment, check for coalition collapse
            if (this.state.sessionPhase === 'adjournment' && this.state.playerRole === 'government') {
                const collapse = window.Game.Engine.Parliament.checkCoalitionCollapse(this.state);
                if (collapse) {
                    this.state._coalitionCollapseResult = collapse;
                }
            }

            window.Game.UI.Screens.renderParliament(this.state);
            this.logRunEvent('parliament', `Session phase advanced to ${this.state.sessionPhase}.`);
        } else {
            // Adjournment complete → advance time
            this._advanceTime(1);
        }
    },

    resolveCoalitionEventChoice(partyId, event, optionIndex) {
        const option = event.options[optionIndex];
        if (!option) return;
        const effect = option.effect;
        const playerParty = (this.state.parties || []).find(p => p.id === this.state.playerPartyId);
        const sat = (this.state.coalitionSatisfaction || {})[partyId];

        if (effect.partnerSatisfaction && sat) {
            sat.score = Math.max(5, Math.min(95, sat.score + effect.partnerSatisfaction));
        }
        if (effect.capital && playerParty) {
            playerParty.politicalCapital = Math.max(0, playerParty.politicalCapital + effect.capital);
        }
        if (effect.scandal && playerParty) {
            playerParty.scandalMeter = Math.max(0, Math.min(100, playerParty.scandalMeter + effect.scandal));
        }
        if (effect.popularity && playerParty) {
            playerParty.basePopularity = Math.max(1, Math.min(60, playerParty.basePopularity + effect.popularity));
        }
        // Risk walkout on bluff-calling
        if (effect.riskWalkout && sat && sat.score < 20 && Math.random() < 0.4) {
            const coalitionIds = [...(this.state.coalitionPartyIds || [])];
            this.state.coalitionPartyIds = coalitionIds.filter(id => id !== partyId);
            delete this.state.coalitionSatisfaction[partyId];
            const partyName = (this.state.parties || []).find(p => p.id === partyId)?.thaiName || partyId;
            window.Game.UI.Screens.showNotification(`💥 ${partyName} has left the coalition!`, 'error');
        }

        // Remove processed event
        this.state.pendingCoalitionEvents = (this.state.pendingCoalitionEvents || []).filter(e => e.event.id !== event.id || e.partyId !== partyId);

        this.logRunEvent('coalition', `Coalition event resolved: ${event.label}, option ${optionIndex + 1}.`);
        window.Game.UI.Screens.renderParliament(this.state);
    },

    _maybeSpawnCampaignPartyEvent() {
        if (!this.state || this.state._spawnedPartyThisCampaign) return;
        if ((this.state._emergentPartyCount || 0) >= 4) return;
        if (this.state.campaignTurn < 3) return;
        if (Math.random() > window.Game.Engine.Campaign.getEmergentPartyChance(this.state)) return;

        const provinceEntries = Object.entries(window.Game.Data.PROVINCES || {});
        if (provinceEntries.length === 0) return;
        const localStrongholdProvinces = provinceEntries
            .filter(([, seats]) => seats >= 2 && seats <= 4)
            .map(([name]) => name);
        const fallbackProvinces = provinceEntries
            .filter(([name, seats]) => name !== 'Bangkok' && seats >= 2 && seats <= 6)
            .map(([name]) => name);
        const provincePool = localStrongholdProvinces.length > 0
            ? localStrongholdProvinces
            : (fallbackProvinces.length > 0 ? fallbackProvinces : provinceEntries.map(([name]) => name));
        const provinceName = provincePool[Math.floor(Math.random() * provincePool.length)];
        const provinceSeatCount = window.Game.Data.PROVINCES[provinceName] || 1;
        const targetSeatCount = Math.max(1, Math.min(3, provinceSeatCount));
        const region = window.Game.Data.PROVINCE_REGION[provinceName] || 'Central';

        const namePool = [
            { thaiName: 'พลังคนใหม่', name: 'New People Power', shortName: 'NPP' },
            { thaiName: 'อนาคตท้องถิ่น', name: 'Local Future', shortName: 'LF' },
            { thaiName: 'รวมพัฒนาชนบท', name: 'Rural Development United', shortName: 'RDU' },
            { thaiName: 'เสรีประชาชน', name: 'People Liberty', shortName: 'PLB' },
            { thaiName: 'ก้าวใหม่ไทย', name: 'Thai New Step', shortName: 'TNS' },
            { thaiName: 'พรรคทางเลือก', name: 'Alternative Path', shortName: 'ALP' },
            { thaiName: 'พลังชุมชนไทย', name: 'Thai Community Power', shortName: 'TCP' },
            { thaiName: 'รวมใจท้องถิ่น', name: 'Local Unity Front', shortName: 'LUF' },
            { thaiName: 'พรรคบ้านเกิด', name: 'Hometown Alliance', shortName: 'HTA' },
            { thaiName: 'ก้าวหน้าภูมิภาค', name: 'Regional Progress Bloc', shortName: 'RPB' },
            { thaiName: 'พลังชาติพัฒนา', name: 'National Development Power', shortName: 'NDP' },
            { thaiName: 'เครือข่ายคนรุ่นใหม่', name: 'New Generation Network', shortName: 'NGN' },
            { thaiName: 'เสียงประชาชนใหม่', name: 'People Voice Movement', shortName: 'PVM' },
            { thaiName: 'เพื่อถิ่นพัฒนา', name: 'For Local Development', shortName: 'FLD' },
            { thaiName: 'พลังเกษตรไทย', name: 'Thai Farmers Force', shortName: 'TFF' }
        ];
        const palette = [
            '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16', '#22C55E', '#10B981', '#14B8A6',
            '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1', '#8B5CF6', '#A855F7', '#D946EF', '#EC4899',
            '#F43F5E', '#DC2626', '#7C3AED', '#1D4ED8', '#0284C7', '#0F766E', '#16A34A', '#65A30D'
        ];
        const chosen = namePool[Math.floor(Math.random() * namePool.length)];
        const uniqueColor = this._pickUniquePartyColor(palette, Date.now());

        const usedIds = new Set(this.state.parties.map(p => p.id));
        let id = `emergent_${Date.now()}`;
        while (usedIds.has(id)) id = `emergent_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const regionalPopMod = {};
        for (const r of Object.keys(window.Game.Data.REGIONS || {})) regionalPopMod[r] = -6;
        regionalPopMod[region] = -1;

        const provincialBanYaiValue = 65 + Math.floor(Math.random() * 16); // 65-80 local machine
        const newParty = {
            id,
            name: chosen.name,
            thaiName: chosen.thaiName,
            shortName: chosen.shortName,
            hexColor: uniqueColor,
            basePopularity: 3 + Math.floor(Math.random() * 3), // 3-5 national baseline
            banYaiPower: 0, // No broad influence; strength is only in one province
            regionalBanYai: {},
            provincialBanYai: { [provinceName]: provincialBanYaiValue },
            regionalPopMod,
            partyListVoteWeight: 0.38,
            politicalCapital: 80,
            greyMoney: 20,
            scandalMeter: 0,
            ideology: 35 + Math.floor(Math.random() * 31),
            description: `A newly formed local movement centered in ${provinceName}.`,
            isPlayerSelectable: true,
            isCustom: true,
            customCandidates: []
        };

        this.state.parties.push(newParty);

        if (this.state.districts && this.state.districts.length > 0) {
            for (const d of this.state.districts) {
                if (d.provinceName === provinceName) {
                    // Concentrate strength in only a few seats to mimic a local machine.
                    if (d.seatIndex <= targetSeatCount) {
                        d.localLeanings[newParty.id] = 13 + Math.floor(Math.random() * 5); // 13-17
                    } else {
                        d.localLeanings[newParty.id] = 3 + Math.floor(Math.random() * 4); // 3-6
                    }
                } else {
                    d.localLeanings[newParty.id] = -7 + Math.floor(Math.random() * 4); // -7 to -4
                }
            }
            this.state.partyMPs[newParty.id] = this._generatePartyMPs(newParty);
            // Boost only target-seat candidates; keep other districts weak.
            for (const mp of this.state.partyMPs[newParty.id]) {
                if (!mp.isPartyList) {
                    const d = this.state.districts.find(dd => dd.id === mp.districtId);
                    if (d && d.provinceName === provinceName) {
                        if (d.seatIndex <= targetSeatCount) {
                            mp.localPopularity = Math.min(32, mp.localPopularity + 11);
                        } else {
                            mp.localPopularity = Math.min(16, mp.localPopularity + 3);
                        }
                    } else {
                        mp.localPopularity = Math.min(mp.localPopularity, 10);
                    }
                }
            }
        }

        this.state._spawnedPartyThisCampaign = true;
        this.state._emergentPartyCount = (this.state._emergentPartyCount || 0) + 1;

        window.Game.UI.Screens.showNotification(
            `🆕 New party emerged: ${newParty.thaiName} established BanYai ${provincialBanYaiValue} in ${provinceName}!`,
            'info'
        );
    },

    // ─── INIT HELPERS ────────────────────────────────────────
    _getBasePartiesForMode(mode = 'realistic') {
        // Deep clone party data
        const baseParties = window.Game.Data.PARTIES.map(p => ({
            ...p,
            regionalPopMod: { ...(p.regionalPopMod || {}) },
            regionalBanYai: { ...(p.regionalBanYai || {}) },
            provincialBanYai: { ...(p.provincialBanYai || {}) }
        }));
        if (mode !== 'balanced') return baseParties;

        return baseParties.map(p => {
            const balancedRegions = {};
            for (const region of Object.keys(window.Game.Data.REGIONS || {})) {
                balancedRegions[region] = 0;
            }
            return {
                ...p,
                basePopularity: 10,
                banYaiPower: 30,
                regionalBanYai: {},
                provincialBanYai: {},
                regionalPopMod: balancedRegions,
                politicalCapital: 220,
                greyMoney: 80,
                scandalMeter: 0
            };
        });
    },

    _initParties(mode = 'realistic') {
        if (mode === 'custom' && this.state && this.state.customScenarioConfig) {
            return this._buildPartiesFromScenarioConfig(this.state.customScenarioConfig);
        }
        return this._getBasePartiesForMode(mode);
    },

    _initDistricts() {
        const districts = [];
        let id = 0;
        for (const [province, seats] of Object.entries(window.Game.Data.PROVINCES)) {
            const region = window.Game.Data.PROVINCE_REGION[province] || 'Central';
            for (let i = 1; i <= seats; i++) {
                const d = new window.Game.Models.District({
                    id: ++id,
                    provinceName: province,
                    seatIndex: i,
                    region: region
                });

                // Randomize local leanings for each party
                for (const party of this.state.parties) {
                    d.localLeanings[party.id] = Math.floor(Math.random() * 10 - 5);
                }

                districts.push(d);
            }
        }
        return districts;
    },

    _generateAllMPs() {
        this.state.partyMPs = {};
        for (const party of this.state.parties) {
            this.state.partyMPs[party.id] = this._generatePartyMPs(party);
        }
    },

    _generatePartyMPs(party) {
        const mps = [];
        const customNames = party.customCandidates || [];
        const neededNames = 500 - customNames.length;
        const generatedNames = window.Game.Data.generateRoster(Math.max(0, neededNames));
        const allNames = [...customNames, ...generatedNames];

        // 400 constituency candidates
        for (let i = 0; i < 400; i++) {
            const district = this.state.districts[i];
            if (!district) break;
            mps.push(new window.Game.Models.MP({
                name: allNames[i] || window.Game.Data.generateName(),
                partyId: party.id,
                ideology: party.ideology + Math.floor(Math.random() * 20 - 10),
                districtId: district.id,
                isPartyList: false,
                localPopularity: Math.floor(Math.random() * 30)
            }));
        }

        // 100 party-list candidates
        for (let i = 400; i < 500; i++) {
            mps.push(new window.Game.Models.MP({
                name: allNames[i] || window.Game.Data.generateName(),
                partyId: party.id,
                ideology: party.ideology + Math.floor(Math.random() * 15 - 7),
                isPartyList: true,
                localPopularity: 0
            }));
        }

        return mps;
    },

    _installCheatConsole() {
        const app = this;
        window.Game.Cheat = {
            run(commandText) {
                return app.runCheatCommand(commandText);
            },
            help() {
                return app.getCheatHelp();
            },
            state() {
                return app.state;
            }
        };
        console.info('Cheat console ready. Use window.Game.Cheat.help() and window.Game.Cheat.run("command").');
    },

    getCheatHelp() {
        return [
            'Cheat commands (run from browser console):',
            'help',
            'state <setup|campaign|coalition|parliament>',
            'capital <delta>',
            'grey <delta>',
            'scandal <delta>',
            'pop <delta>',
            'ap <value>',
            'oppap <value>',
            'role <government|opposition>',
            'queuebills [count]',
            'walkout [seats]',
            'split <partyId> [seats]',
            'vote <support|oppose|abstain>',
            'advance <0.5|1>'
        ].join('\n');
    },

    _cheatParseNumber(raw, fallback = 0) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : fallback;
    },

    _cheatGetPlayerParty() {
        if (!this.state || !this.state.playerPartyId) return null;
        return (this.state.parties || []).find(p => p.id === this.state.playerPartyId) || null;
    },

    _cheatNotify(msg, type = 'info') {
        if (window.Game.UI && window.Game.UI.Screens && typeof window.Game.UI.Screens.showNotification === 'function') {
            window.Game.UI.Screens.showNotification(msg, type);
        }
    },

    _cheatRefreshActiveScreen() {
        if (!window.Game.UI || !window.Game.UI.Screens) return;
        if (!this.state || !this.currentState) return;
        const screens = window.Game.UI.Screens;
        try {
            switch (this.currentState) {
                case this.STATES.STATE_SETUP:
                    screens.renderSetup(this.state);
                    break;
                case this.STATES.STATE_CAMPAIGN:
                    screens.renderCampaign(this.state);
                    break;
                case this.STATES.STATE_COALITION:
                    screens.renderCoalition(this.state);
                    break;
                case this.STATES.STATE_PARLIAMENT_TERM:
                    screens.renderParliament(this.state);
                    break;
                case this.STATES.STATE_ELECTION_CALC:
                    if (this.state.electionResults) screens.renderElectionResults(this.state);
                    break;
                default:
                    break;
            }
        } catch (err) {
            console.warn('Cheat refresh skipped due to render error:', err);
        }
    },

    runCheatCommand(commandText = '') {
        const input = String(commandText || '').trim();
        if (!input) {
            const msg = 'Empty cheat command. Use window.Game.Cheat.help().';
            console.warn(msg);
            return { success: false, msg };
        }

        const parts = input.split(/\s+/);
        const command = (parts.shift() || '').toLowerCase();
        const stateMap = {
            setup: this.STATES.STATE_SETUP,
            campaign: this.STATES.STATE_CAMPAIGN,
            coalition: this.STATES.STATE_COALITION,
            parliament: this.STATES.STATE_PARLIAMENT_TERM
        };

        if (command === 'help') {
            const help = this.getCheatHelp();
            console.info(help);
            return { success: true, msg: help };
        }

        if (!this.state) {
            const msg = 'Game state is not initialized yet.';
            console.warn(msg);
            return { success: false, msg };
        }

        const playerParty = this._cheatGetPlayerParty();
        let msg = '';
        let ok = true;

        switch (command) {
            case 'state': {
                const target = (parts[0] || '').toLowerCase();
                const nextState = stateMap[target];
                if (!nextState) {
                    ok = false;
                    msg = 'Unknown state. Use: state <setup|campaign|coalition|parliament>';
                    break;
                }
                this.transition(nextState);
                msg = `Cheat: transitioned to ${nextState}.`;
                break;
            }
            case 'capital': {
                if (!playerParty) {
                    ok = false;
                    msg = 'Select a party first.';
                    break;
                }
                const delta = Math.round(this._cheatParseNumber(parts[0], 0));
                playerParty.politicalCapital = Math.max(0, playerParty.politicalCapital + delta);
                msg = `Cheat: capital ${delta >= 0 ? '+' : ''}${delta} -> ${playerParty.politicalCapital}.`;
                break;
            }
            case 'grey': {
                if (!playerParty) {
                    ok = false;
                    msg = 'Select a party first.';
                    break;
                }
                const delta = Math.round(this._cheatParseNumber(parts[0], 0));
                playerParty.greyMoney = Math.max(0, playerParty.greyMoney + delta);
                msg = `Cheat: grey money ${delta >= 0 ? '+' : ''}${delta} -> ${playerParty.greyMoney}.`;
                break;
            }
            case 'scandal': {
                if (!playerParty) {
                    ok = false;
                    msg = 'Select a party first.';
                    break;
                }
                const delta = Math.round(this._cheatParseNumber(parts[0], 0));
                playerParty.scandalMeter = Math.max(0, Math.min(100, playerParty.scandalMeter + delta));
                msg = `Cheat: scandal ${delta >= 0 ? '+' : ''}${delta} -> ${playerParty.scandalMeter}.`;
                break;
            }
            case 'pop': {
                if (!playerParty) {
                    ok = false;
                    msg = 'Select a party first.';
                    break;
                }
                const delta = this._cheatParseNumber(parts[0], 0);
                playerParty.basePopularity = Math.max(1, Math.min(60, Math.round((playerParty.basePopularity + delta) * 10) / 10));
                msg = `Cheat: base popularity ${delta >= 0 ? '+' : ''}${delta} -> ${playerParty.basePopularity}.`;
                break;
            }
            case 'ap': {
                const value = Math.max(0, Math.round(this._cheatParseNumber(parts[0], this.state.actionPoints || 0)));
                this.state.actionPoints = value;
                msg = `Cheat: campaign AP set to ${value}.`;
                break;
            }
            case 'oppap': {
                const value = Math.max(0, Math.round(this._cheatParseNumber(parts[0], this.state.oppositionActionsRemaining || 0)));
                this.state.oppositionActionsRemaining = value;
                this.state.oppositionActionSession = this.state.sessionNumber || this.state.oppositionActionSession || 1;
                msg = `Cheat: opposition actions remaining set to ${value}.`;
                break;
            }
            case 'role': {
                const role = (parts[0] || '').toLowerCase();
                if (role !== 'government' && role !== 'opposition') {
                    ok = false;
                    msg = 'Use: role <government|opposition>';
                    break;
                }
                this.state.playerRole = role;
                msg = `Cheat: player role set to ${role}.`;
                break;
            }
            case 'queuebills': {
                if (this.state.playerRole !== 'opposition') {
                    ok = false;
                    msg = 'queuebills requires opposition role.';
                    break;
                }
                const loops = Math.max(1, Math.min(6, Math.round(this._cheatParseNumber(parts[0], 1))));
                let queued = 0;
                for (let i = 0; i < loops; i++) {
                    const result = window.Game.Engine.Parliament.queueGovernmentBillsForOpposition(this.state, 1);
                    queued += result.queuedCount || 0;
                }
                msg = `Cheat: queued ${queued} government bill(s).`;
                break;
            }
            case 'walkout': {
                if (this.state.playerRole !== 'opposition') {
                    ok = false;
                    msg = 'walkout requires opposition role.';
                    break;
                }
                const totalSeats = (this.state.electionResults && this.state.electionResults.totalSeats) || {};
                const coalitionSeats = (this.state.coalitionPartyIds || []).reduce((sum, pid) => sum + (totalSeats[pid] || 0), 0);
                const configuredSeats = Math.round(this._cheatParseNumber(parts[0], Math.max(8, Math.round(coalitionSeats * 0.08))));
                this.state.oppositionWalkoutPlan = {
                    sessionNumber: this.state.sessionNumber || 1,
                    swingSeats: Math.max(1, configuredSeats),
                    used: false
                };
                msg = `Cheat: walkout primed with ${this.state.oppositionWalkoutPlan.swingSeats} swing seats.`;
                break;
            }
            case 'split': {
                if (this.state.playerRole !== 'opposition') {
                    ok = false;
                    msg = 'split requires opposition role.';
                    break;
                }
                const targetPartyId = parts[0];
                if (!targetPartyId) {
                    ok = false;
                    msg = 'Use: split <partyId> [seats]';
                    break;
                }
                const coalitionPartners = (this.state.coalitionPartyIds || []).filter(pid => pid !== this.state.governmentPartyId);
                if (!coalitionPartners.includes(targetPartyId)) {
                    ok = false;
                    msg = 'Target must be a non-lead coalition partner currently in government coalition.';
                    break;
                }
                const totalSeats = (this.state.electionResults && this.state.electionResults.totalSeats) || {};
                const fallbackSeats = Math.max(3, Math.round((totalSeats[targetPartyId] || 0) * 0.35));
                const abstainSeats = Math.max(1, Math.round(this._cheatParseNumber(parts[1], fallbackSeats)));
                this.state.oppositionSplitPlan = {
                    sessionNumber: this.state.sessionNumber || 1,
                    targetPartyId,
                    abstainSeats,
                    used: false
                };
                msg = `Cheat: split primed for ${targetPartyId} with ${abstainSeats} abstain seats.`;
                break;
            }
            case 'vote': {
                if (this.state.playerRole !== 'opposition') {
                    ok = false;
                    msg = 'vote cheat requires opposition role.';
                    break;
                }
                const stance = (parts[0] || 'oppose').toLowerCase();
                if (!['support', 'oppose', 'abstain'].includes(stance)) {
                    ok = false;
                    msg = 'Use: vote <support|oppose|abstain>';
                    break;
                }
                const nextBill = (this.state.governmentBillQueue || [])[0];
                if (!nextBill) {
                    ok = false;
                    msg = 'No pending government bill to vote on.';
                    break;
                }
                const result = window.Game.Engine.Parliament.resolveGovernmentBillVote(this.state, nextBill.id, stance);
                if (!result) {
                    ok = false;
                    msg = 'Could not resolve vote for the selected bill.';
                    break;
                }
                msg = `Cheat vote: ${result.billName} ${result.passed ? 'PASSED' : 'FAILED'} (${result.aye}-${result.nay}-${result.abstain}).`;
                break;
            }
            case 'advance': {
                const step = this._cheatParseNumber(parts[0], 1);
                if (step === 0.5) {
                    this.advanceHalfYear();
                    msg = 'Cheat: advanced 6 months.';
                } else {
                    this.advanceYear();
                    msg = 'Cheat: advanced 1 year.';
                }
                break;
            }
            default:
                ok = false;
                msg = `Unknown cheat command: ${command}. Use window.Game.Cheat.help().`;
                break;
        }

        if (ok) {
            this.logRunEvent('system', `Cheat executed: ${input}`);
            if (command !== 'state' && command !== 'advance') {
                this._cheatRefreshActiveScreen();
            }
            this._cheatNotify(msg, 'success');
            console.info(msg);
        } else {
            this._cheatNotify(msg, 'error');
            console.warn(msg);
        }

        return { success: ok, msg };
    }
};

// ─── BOOT ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Small delay for CSS to settle
    setTimeout(() => window.Game.App.init(), 100);
});
