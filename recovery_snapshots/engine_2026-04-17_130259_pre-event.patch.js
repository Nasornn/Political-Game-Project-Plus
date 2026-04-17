// ============================================================
// GAME ENGINES — Election, Campaign, Parliament, Shadow
// ============================================================
window.Game = window.Game || {};
window.Game.Engine = {};

// ─── ELECTION ENGINE ─────────────────────────────────────────
window.Game.Engine.Election = {

    /**
     * THE CORE ELECTION ALGORITHM — runs the full 500-seat calculation.
     * @param {Object} gameState - The full game state
     * @returns {Object} Election results
     */
    runElection(gameState) {
        const parties = gameState.parties;
        const districts = gameState.districts;
        const partyMPs = gameState.partyMPs; // partyId → MP[]

        // Reset
        const results = {
            constituencyWins: {},   // partyId → count
            partyListSeats: {},     // partyId → count
            totalSeats: {},         // partyId → count
            nationalPopularVote: {}, // partyId → total score (sans banYai)
            districtResults: [],     // [{districtId, winnerId, scores}]
            partyListDetail: {},    // partyId → {exact, floor, remainder, bonus}
        };

        for (const p of parties) {
            results.constituencyWins[p.id] = 0;
            results.partyListSeats[p.id] = 0;
            results.totalSeats[p.id] = 0;
            results.nationalPopularVote[p.id] = 0;
        }

        // ── STEP 1: 400 Constituency Seats ──────────────────────
        for (const district of districts) {
            const scores = {};
            let bestParty = null;
            let bestScore = -Infinity;

            for (const party of parties) {
                const region = district.region;

                // Base popularity
                let score = party.basePopularity;

                // Regional popularity modifier
                if (party.regionalPopMod && party.regionalPopMod[region] !== undefined) {
                    score += party.regionalPopMod[region];
                }

                // Local candidate popularity (from MP assigned to this district)
                const mp = this._getDistrictCandidate(partyMPs, party.id, district.id);
                const localCandidatePop = mp ? (mp.localPopularity / 5) : 0; // 0-6 points
                score += localCandidatePop;

                // BanYai Bonus (province-level override > regional > base)
                // Provincial BanYai uses /3 (strong local dominance)
                // Regional BanYai uses /5 (moderate broad influence)
                let banYaiBonus = party.banYaiPower || 0;
                let banYaiDivisor = 5;
                if (party.provincialBanYai && party.provincialBanYai[district.provinceName] !== undefined) {
                    banYaiBonus = party.provincialBanYai[district.provinceName];
                    banYaiDivisor = 3; // Provincial = stronger
                } else if (party.regionalBanYai && party.regionalBanYai[region] !== undefined) {
                    banYaiBonus = party.regionalBanYai[region];
                    banYaiDivisor = 5; // Regional = old value
                }
                const banYaiScore = banYaiBonus / banYaiDivisor;
                score += banYaiScore;

                // Campaign buffs (from campaign phase actions)
                const campaignBuff = district.campaignBuff[party.id] || 0;
                score += campaignBuff;

                // IO penalties (from shadow politics)
                const ioPenalty = district.ioDebuff[party.id] || 0;
                score -= ioPenalty;

                // District local leanings (randomized at init, simulates incumbency etc.)
                const localLeaning = district.localLeanings[party.id] || 0;
                score += localLeaning;

                // Small random factor (±2) to prevent perfect determinism
                score += (Math.random() * 4 - 2);

                // Floor at 0
                score = Math.max(0, score);
                scores[party.id] = score;

                if (score > bestScore) {
                    bestScore = score;
                    bestParty = party.id;
                }
            }

            // Winner takes the constituency seat
            results.constituencyWins[bestParty]++;
            district.winningPartyId = bestParty;

            // Add to national popular vote — BUT subtract banYai bonus first
            for (const party of parties) {
                const region = district.region;
                let banYai = party.banYaiPower || 0;
                let banYaiDiv = 5;
                if (party.provincialBanYai && party.provincialBanYai[district.provinceName] !== undefined) {
                    banYai = party.provincialBanYai[district.provinceName];
                    banYaiDiv = 3;
                } else if (party.regionalBanYai && party.regionalBanYai[region] !== undefined) {
                    banYai = party.regionalBanYai[region];
                    banYaiDiv = 5;
                }
                const banYaiScore = banYai / banYaiDiv;
                const scoreWithoutBanYai = Math.max(0, scores[party.id] - banYaiScore);
                const partyListWeightRaw = Number.isFinite(party.partyListVoteWeight)
                    ? party.partyListVoteWeight
                    : 1;
                const partyListWeight = Math.max(0, Math.min(1, partyListWeightRaw));
                results.nationalPopularVote[party.id] += scoreWithoutBanYai * partyListWeight;
            }

            results.districtResults.push({
                districtId: district.id,
                provinceName: district.provinceName,
                seatIndex: district.seatIndex,
                winnerId: bestParty,
                scores: { ...scores }
            });
        }

        // ── STEP 2: 100 Party-List Seats ────────────────────────
        let totalValidVotes = 0;
        for (const p of parties) {
            totalValidVotes += results.nationalPopularVote[p.id];
        }

        const seatQuota = totalValidVotes / 100;
        let assignedListSeats = 0;

        const partyRemainders = [];
        for (const p of parties) {
            const exactSeats = results.nationalPopularVote[p.id] / seatQuota;
            const floorSeats = Math.floor(exactSeats);
            const remainder = exactSeats - floorSeats;

            results.partyListSeats[p.id] = floorSeats;
            assignedListSeats += floorSeats;

            results.partyListDetail[p.id] = {
                exactSeats: exactSeats,
                floorSeats: floorSeats,
                remainder: remainder,
                bonusSeats: 0
            };

            partyRemainders.push({ partyId: p.id, remainder: remainder });
        }

        // ── STEP 3: Largest Remainder Method ────────────────────
        let remainingSeats = 100 - assignedListSeats;
        partyRemainders.sort((a, b) => b.remainder - a.remainder);

        for (let i = 0; i < remainingSeats && i < partyRemainders.length; i++) {
            const pid = partyRemainders[i].partyId;
            results.partyListSeats[pid]++;
            results.partyListDetail[pid].bonusSeats = 1;
        }

        // ── Total seats ─────────────────────────────────────────
        for (const p of parties) {
            results.totalSeats[p.id] = results.constituencyWins[p.id] + results.partyListSeats[p.id];
        }

        return results;
    },

    _getDistrictCandidate(partyMPs, partyId, districtId) {
        const mps = partyMPs[partyId];
        if (!mps) return null;
        return mps.find(mp => mp.districtId === districtId) || null;
    }
};


// ─── CAMPAIGN ENGINE ─────────────────────────────────────────
window.Game.Engine.Campaign = {
    MAX_TURNS: 8,
    AP_PER_TURN: 10,
    CAMPAIGN_BUFF_CAP: 18,
    IO_DEBUFF_CAP: 18,

    DIFFICULTY_PRESETS: {
        easy: {
            id: 'easy',
            label: 'Backroom Rookie',
            tier: 'Easy',
            description: 'Extra AP, calmer AI, and friendlier headlines while you learn the machine.',
            playerAPPerTurn: 12,
            aiAPBase: 5,
            eventChance: 0.55,
            eventSuccessModifier: 0.08,
            playerPowerMultiplier: 1.12,
            aiPowerMultiplier: 0.92,
            playerScandalMultiplier: 0.8,
            aiScandalMultiplier: 1.0,
            aiAggression: -0.1,
            fundraiseMultiplier: 1.15,
            emergentPartyChance: 0.09
        },
        medium: {
            id: 'medium',
            label: 'War Room Strategist',
            tier: 'Medium',
            description: 'Balanced pressure. Smart rivals, meaningful events, and tight resource play.',
            playerAPPerTurn: 10,
            aiAPBase: 6,
            eventChance: 0.65,
            eventSuccessModifier: 0,
            playerPowerMultiplier: 1,
            aiPowerMultiplier: 1,
            playerScandalMultiplier: 1,
            aiScandalMultiplier: 1,
            aiAggression: 0,
            fundraiseMultiplier: 1,
            emergentPartyChance: 0.14
        },
        hard: {
            id: 'hard',
            label: 'Kingmaker Gauntlet',
            tier: 'Hard',
            description: 'Fewer actions, sharper AI, higher event volatility, and brutal scandal penalties.',
            playerAPPerTurn: 8,
            aiAPBase: 7,
            eventChance: 0.78,
            eventSuccessModifier: -0.08,
            playerPowerMultiplier: 0.92,
            aiPowerMultiplier: 1.08,
            playerScandalMultiplier: 1.2,
            aiScandalMultiplier: 0.9,
            aiAggression: 0.2,
            fundraiseMultiplier: 0.9,
            emergentPartyChance: 0.2
        }
    },

    normalizeDifficultyMode(mode) {
        if (mode === 'easy' || mode === 'hard') return mode;
        return 'medium';
    },

    getDifficultyConfig(gameStateOrMode) {
        const mode = typeof gameStateOrMode === 'string'
            ? this.normalizeDifficultyMode(gameStateOrMode)
            : this.normalizeDifficultyMode(gameStateOrMode && gameStateOrMode.difficultyMode);
        return this.DIFFICULTY_PRESETS[mode] || this.DIFFICULTY_PRESETS.medium;
    },

    getDifficultyModes() {
        return [
            this.DIFFICULTY_PRESETS.easy,
            this.DIFFICULTY_PRESETS.medium,
            this.DIFFICULTY_PRESETS.hard
        ];
    },

    getAPPerTurn(gameState) {
        const override = gameState?.customScenarioConfig?.campaign?.apPerTurn;
        if (Number.isFinite(override)) {
            return Math.max(4, Math.min(20, Math.round(override)));
        }
        return this.getDifficultyConfig(gameState).playerAPPerTurn;
    },

    getMaxCampaignTurns(gameState) {
        const override = gameState?.customScenarioConfig?.campaign?.maxTurns;
        if (Number.isFinite(override)) {
            return Math.max(4, Math.min(16, Math.round(override)));
        }
        return this.MAX_TURNS;
    },

    getEmergentPartyChance(gameState) {
        const override = gameState?.customScenarioConfig?.campaign?.emergentPartyChance;
        if (Number.isFinite(override)) {
            return Math.max(0, Math.min(0.8, override));
        }
        return this.getDifficultyConfig(gameState).emergentPartyChance;
    },

    AI_PROFILES: {
        progressive: { aggressive: true, shadowy: false, grassroots: true },
        pheuthai: { aggressive: false, shadowy: true, grassroots: true },
        bhumjaithai: { aggressive: true, shadowy: true, grassroots: true },
        unitedthai: { aggressive: true, shadowy: true, grassroots: false },
        palangpracharath: { aggressive: true, shadowy: true, grassroots: false },
        klatham: { aggressive: false, shadowy: true, grassroots: true },
        democrat: { aggressive: false, shadowy: false, grassroots: true },
        setthakit: { aggressive: false, shadowy: false, grassroots: false },
        prachachat: { aggressive: false, shadowy: true, grassroots: true },
        thaisangthai: { aggressive: false, shadowy: false, grassroots: true }
    },

    EVENT_TEMPLATES: [
        {
            id: 'tv_debate',
            title: 'TV Debate Night',
            description: 'A prime-time national debate slot opened unexpectedly. Your decision will shape the week narrative.',
            options: [
                {
                    label: 'Take the stage and attack rivals',
                    successChance: 0.62,
                    success: {
                        momentum: 2,
                        regionalSwing: { Bangkok: 2, Central: 1 },
                        actionPoints: 1
                    },
                    fail: {
                        momentum: -2,
                        regionalSwing: { Bangkok: -2 },
                        scandal: 2
                    }
                },
                {
                    label: 'Skip TV, run targeted ground campaign',
                    successChance: 0.78,
                    success: {
                        momentum: 1,
                        regionalSwing: { Northeast: 1, North: 1 },
                        capital: 20
                    },
                    fail: {
                        momentum: -1,
                        regionalSwing: { Bangkok: -1 }
                    }
                }
            ]
        },
        {
            id: 'scandal_rumor',
            title: 'Candidate Scandal Rumor',
            description: 'A rumor about one of your candidates is trending online. Media pressure is rising fast.',
            options: [
                {
                    label: 'Full transparency and documents release',
                    successChance: 0.7,
                    success: {
                        momentum: 2,
                        scandal: -3,
                        regionalSwing: { Bangkok: 1, Central: 1 }
                    },
                    fail: {
                        momentum: -1,
                        scandal: 4,
                        regionalSwing: { Bangkok: -1 }
                    }
                },
                {
                    label: 'Counter-narrative campaign through allies',
                    successChance: 0.5,
                    success: {
                        momentum: 1,
                        actionPoints: 1,
                        scandal: 2,
                        nationalSwing: 1
                    },
                    fail: {
                        momentum: -2,
                        scandal: 6,
                        nationalSwing: -1
                    }
                }
            ]
        },
        {
            id: 'flood_response',
            title: 'Flood Relief Emergency',
            description: 'Heavy flooding hit several provinces. Voters expect immediate campaign-level assistance.',
            options: [
                {
                    label: 'Deploy volunteers and relief budget',
                    successChance: 0.66,
                    success: {
                        momentum: 2,
                        capital: -35,
                        regionalSwing: { Central: 2, Northeast: 1 }
                    },
                    fail: {
                        momentum: -1,
                        capital: -35,
                        regionalSwing: { Central: -1 }
                    }
                },
                {
                    label: 'Focus on policy messaging only',
                    successChance: 0.58,
                    success: {
                        momentum: 1,
                        capital: 15,
                        regionalSwing: { Bangkok: 1 }
                    },
                    fail: {
                        momentum: -2,
                        regionalSwing: { Central: -2, Northeast: -1 }
                    }
                }
            ]
        },
        {
            id: 'business_forum',
            title: 'National Business Forum',
            description: 'Industry leaders ask for a clear economic platform this week.',
            options: [
                {
                    label: 'Pro-business reform speech',
                    successChance: 0.64,
                    success: {
                        momentum: 1,
                        capital: 30,
                        regionalSwing: { Bangkok: 1, East: 2 }
                    },
                    fail: {
                        momentum: -1,
                        regionalSwing: { Northeast: -1 }
                    }
                },
                {
                    label: 'People-first welfare platform',
                    successChance: 0.64,
                    success: {
                        momentum: 1,
                        regionalSwing: { Northeast: 2, North: 1 },
                        capital: 10
                    },
                    fail: {
                        momentum: -1,
                        regionalSwing: { Bangkok: -1, East: -1 }
                    }
                }
            ]
        }
    ],

    initializeCampaignState(gameState) {
        if (!gameState.campaignMomentum) gameState.campaignMomentum = {};
        if (!gameState.campaignActionMemory) gameState.campaignActionMemory = {};
        if (!gameState.difficultyMode) gameState.difficultyMode = 'medium';
        for (const p of gameState.parties) {
            if (!Number.isFinite(gameState.campaignMomentum[p.id])) {
                gameState.campaignMomentum[p.id] = 0;
            }
        }
    },

    initializeAIPersonality(gameState) {
        if (!gameState.aiPersonality) gameState.aiPersonality = {};

        for (const p of gameState.parties) {
            if (p.id === gameState.playerPartyId) continue;
            if (gameState.aiPersonality[p.id]) continue;

            const base = this.AI_PROFILES[p.id] || { aggressive: false, shadowy: false, grassroots: true };
            gameState.aiPersonality[p.id] = {
                aggression: base.aggressive ? 0.62 : 0.36,
                shadowFocus: base.shadowy ? 0.62 : 0.3,
                grassrootsFocus: base.grassroots ? 0.62 : 0.35,
                pragmatism: 0.5
            };
        }
    },

    _clampTrait(v) {
        return Math.max(0.1, Math.min(0.9, v));
    },

    getAIPersonality(gameState, partyId) {
        this.initializeAIPersonality(gameState);
        return gameState.aiPersonality[partyId] || {
            aggression: 0.45,
            shadowFocus: 0.45,
            grassrootsFocus: 0.45,
            pragmatism: 0.5
        };
    },

    evolveAIPersonalities(gameState, electionResults) {
        if (!gameState || !electionResults || !electionResults.totalSeats) return;
        this.initializeAIPersonality(gameState);

        const previous = gameState.previousElectionSeatTotals || {};
        const hasBaseline = Object.keys(previous).length > 0;

        for (const p of gameState.parties) {
            if (p.id === gameState.playerPartyId) continue;

            const persona = this.getAIPersonality(gameState, p.id);
            const seatsNow = electionResults.totalSeats[p.id] || 0;
            const seatsPrev = hasBaseline ? (previous[p.id] || 0) : seatsNow;
            const seatDelta = seatsNow - seatsPrev;
            const scandal = p.scandalMeter || 0;

            if (seatDelta <= -10) {
                persona.aggression = this._clampTrait(persona.aggression + 0.08);
                persona.grassrootsFocus = this._clampTrait(persona.grassrootsFocus + 0.06);
                persona.pragmatism = this._clampTrait(persona.pragmatism - 0.04);
                if (scandal > 30) {
                    persona.shadowFocus = this._clampTrait(persona.shadowFocus - 0.06);
                } else {
                    persona.shadowFocus = this._clampTrait(persona.shadowFocus + 0.04);
                }
            } else if (seatDelta >= 10) {
                persona.aggression = this._clampTrait(persona.aggression - 0.05);
                persona.pragmatism = this._clampTrait(persona.pragmatism + 0.07);
                persona.grassrootsFocus = this._clampTrait(persona.grassrootsFocus + 0.02);
            }

            if (scandal >= 50) {
                persona.shadowFocus = this._clampTrait(persona.shadowFocus - 0.05);
                persona.grassrootsFocus = this._clampTrait(persona.grassrootsFocus + 0.05);
            }

            gameState.aiPersonality[p.id] = {
                aggression: this._clampTrait(persona.aggression),
                shadowFocus: this._clampTrait(persona.shadowFocus),
                grassrootsFocus: this._clampTrait(persona.grassrootsFocus),
                pragmatism: this._clampTrait(persona.pragmatism)
            };
        }

        gameState.previousElectionSeatTotals = { ...(electionResults.totalSeats || {}) };
    },

    _getMomentum(gameState, partyId) {
        this.initializeCampaignState(gameState);
        return gameState.campaignMomentum[partyId] || 0;
    },

    _adjustMomentum(gameState, partyId, delta) {
        this.initializeCampaignState(gameState);
        const current = gameState.campaignMomentum[partyId] || 0;
        gameState.campaignMomentum[partyId] = Math.max(-10, Math.min(10, current + delta));
        return gameState.campaignMomentum[partyId];
    },

    _getPowerMultiplier(gameState, partyId) {
        const diff = this.getDifficultyConfig(gameState);
        return partyId === gameState.playerPartyId ? diff.playerPowerMultiplier : diff.aiPowerMultiplier;
    },

    _getScandalMultiplier(gameState, partyId) {
        const diff = this.getDifficultyConfig(gameState);
        return partyId === gameState.playerPartyId ? diff.playerScandalMultiplier : diff.aiScandalMultiplier;
    },

    _getActionBucket(gameState, partyId, provinceName) {
        this.initializeCampaignState(gameState);
        const turn = gameState.campaignTurn || 1;
        if (!gameState.campaignActionMemory[turn]) gameState.campaignActionMemory[turn] = {};
        if (!gameState.campaignActionMemory[turn][partyId]) gameState.campaignActionMemory[turn][partyId] = {};
        if (!gameState.campaignActionMemory[turn][partyId][provinceName]) {
            gameState.campaignActionMemory[turn][partyId][provinceName] = {
                counts: {},
                lastAction: null
            };
        }
        return gameState.campaignActionMemory[turn][partyId][provinceName];
    },

    _getDiminishingMultiplier(repeatCount) {
        if (repeatCount <= 0) return 1;
        if (repeatCount === 1) return 0.7;
        return 0.5;
    },

    _getComboBonus(lastAction, currentAction) {
        if (!lastAction || lastAction === currentAction) return 0;
        if ((lastAction === 'rally' && currentAction === 'canvass') || (lastAction === 'canvass' && currentAction === 'rally')) {
            return 1.5;
        }
        if ((lastAction === 'attackAd' && currentAction === 'ioOperation') || (lastAction === 'ioOperation' && currentAction === 'attackAd')) {
            return 1.2;
        }
        if (lastAction === 'buySupport' && currentAction === 'rally') {
            return 1;
        }
        return 0.4;
    },

    _commitActionUsage(bucket, actionKey) {
        bucket.counts[actionKey] = (bucket.counts[actionKey] || 0) + 1;
        bucket.lastAction = actionKey;
    },

    _calculateActionPower(gameState, partyId, actionKey, provinceName, basePower) {
        const bucket = this._getActionBucket(gameState, partyId, provinceName);
        const repeatCount = bucket.counts[actionKey] || 0;
        const diminishing = this._getDiminishingMultiplier(repeatCount);
        const combo = this._getComboBonus(bucket.lastAction, actionKey);
        const momentum = this._getMomentum(gameState, partyId);
        const momentumMultiplier = 1 + (momentum * 0.02);
        const difficultyPower = this._getPowerMultiplier(gameState, partyId);
        const power = Math.max(1, Math.round((basePower * diminishing * momentumMultiplier * difficultyPower) + combo));

        this._commitActionUsage(bucket, actionKey);

        return {
            power,
            diminishing,
            combo,
            momentum
        };
    },

    _applyRegionalSwing(gameState, partyId, regionSwing) {
        for (const [region, swing] of Object.entries(regionSwing || {})) {
            const provinces = window.Game.Data.REGIONS[region] || [];
            for (const prov of provinces) {
                for (const d of gameState.districts) {
                    if (d.provinceName === prov) {
                        this._addCampaignBuff(d, partyId, swing);
                    }
                }
            }
        }
    },

    _addCampaignBuff(district, partyId, delta) {
        // Bangkok naturally leans progressive; non-progressive campaign boosts convert less efficiently there.
        if (district.region === 'Bangkok' && Number.isFinite(delta) && delta > 0) {
            if (partyId === 'progressive') {
                delta = delta + 0.3;
            } else {
                delta = delta * 0.72;
            }
        }
        const current = district.campaignBuff[partyId] || 0;
        const next = Math.max(-this.CAMPAIGN_BUFF_CAP, Math.min(this.CAMPAIGN_BUFF_CAP, current + delta));
        district.campaignBuff[partyId] = next;
        return next;
    },

    _addIODebuff(district, partyId, delta) {
        const current = district.ioDebuff[partyId] || 0;
        const next = Math.max(0, Math.min(this.IO_DEBUFF_CAP, current + delta));
        district.ioDebuff[partyId] = next;
        return next;
    },

    _applyRally(gameState, partyId, provinceName, basePower = 3) {
        const calc = this._calculateActionPower(gameState, partyId, 'rally', provinceName, basePower);
        for (const d of gameState.districts) {
            if (d.provinceName === provinceName) {
                this._addCampaignBuff(d, partyId, calc.power);
            }
        }
        this._adjustMomentum(gameState, partyId, calc.power >= basePower ? 1 : 0);
        return calc;
    },

    _applyAttack(gameState, attackerPartyId, targetPartyId, provinceName, basePower = 3) {
        const calc = this._calculateActionPower(gameState, attackerPartyId, 'attackAd', provinceName, basePower);
        for (const d of gameState.districts) {
            if (d.provinceName === provinceName) {
                this._addIODebuff(d, targetPartyId, calc.power);
            }
        }
        this._adjustMomentum(gameState, attackerPartyId, 1);
        return calc;
    },

    _applyCanvass(gameState, partyId, districtId, basePower = 5) {
        const district = gameState.districts.find(d => d.id === districtId);
        if (!district) return null;
        const calc = this._calculateActionPower(gameState, partyId, 'canvass', district.provinceName, basePower);
        this._addCampaignBuff(district, partyId, calc.power);
        this._adjustMomentum(gameState, partyId, 1);
        return calc;
    },

    _applyIO(gameState, attackerPartyId, targetPartyId, provinceName, greyCost = 30, scandalCost = 5, basePower = 5) {
        const party = gameState.parties.find(p => p.id === attackerPartyId);
        if (!party || party.greyMoney < greyCost) return null;

        const calc = this._calculateActionPower(gameState, attackerPartyId, 'ioOperation', provinceName, basePower);
        party.greyMoney -= greyCost;
        const scandalDelta = Math.max(1, Math.round(scandalCost * this._getScandalMultiplier(gameState, attackerPartyId)));
        party.scandalMeter = Math.min(100, party.scandalMeter + scandalDelta);
        for (const d of gameState.districts) {
            if (d.provinceName === provinceName) {
                this._addIODebuff(d, targetPartyId, calc.power);
            }
        }
        this._adjustMomentum(gameState, attackerPartyId, 1);
        return calc;
    },

    _applyBuySupport(gameState, partyId, provinceName, greyCost = 40, scandalCost = 8, basePower = 4) {
        const party = gameState.parties.find(p => p.id === partyId);
        if (!party || party.greyMoney < greyCost) return null;

        const calc = this._calculateActionPower(gameState, partyId, 'buySupport', provinceName, basePower);
        party.greyMoney -= greyCost;
        const scandalDelta = Math.max(1, Math.round(scandalCost * this._getScandalMultiplier(gameState, partyId)));
        party.scandalMeter = Math.min(100, party.scandalMeter + scandalDelta);
        for (const d of gameState.districts) {
            if (d.provinceName === provinceName) {
                this._addCampaignBuff(d, partyId, calc.power);
            }
        }
        this._adjustMomentum(gameState, partyId, 1);
        return calc;
    },

    _pickAttackTargetParty(gameState, attackerPartyId, provinceName) {
        if (!provinceName) return gameState.playerPartyId;
        const provinceDistricts = gameState.districts.filter(d => d.provinceName === provinceName);
        if (provinceDistricts.length === 0) return gameState.playerPartyId;

        let best = null;
        let bestScore = -Infinity;

        for (const p of gameState.parties) {
            if (p.id === attackerPartyId) continue;
            let total = 0;
            for (const d of provinceDistricts) {
                total += this._estimateDistrictScore(gameState, d, p);
            }
            if (total > bestScore) {
                bestScore = total;
                best = p.id;
            }
        }

        return best || gameState.playerPartyId;
    },

    _estimateDistrictScore(gameState, district, party) {
        let score = party.basePopularity;
        if (party.regionalPopMod && party.regionalPopMod[district.region] !== undefined) {
            score += party.regionalPopMod[district.region];
        }
        if (district.region === 'Bangkok') {
            const ideology = Number.isFinite(party.ideology) ? party.ideology : 50;
            score += Math.max(-2, Math.min(2, (45 - ideology) / 20));
            if (party.id === 'progressive') score += 2;
            if (party.id === 'unitedthai') score -= 1.5;
            if (party.id === 'setthakit') score -= 2;
        }
        score += (district.localLeanings[party.id] || 0);
        score += (district.campaignBuff[party.id] || 0);
        score -= (district.ioDebuff[party.id] || 0);
        const momentum = this._getMomentum(gameState, party.id);
        score += Math.round(momentum * 0.4);
        return score;
    },

    _estimateDistrictMargin(gameState, district, partyId) {
        const party = gameState.parties.find(p => p.id === partyId);
        if (!party) return null;

        let bestOther = -Infinity;
        const ownScore = this._estimateDistrictScore(gameState, district, party);

        for (const p of gameState.parties) {
            if (p.id === partyId) continue;
            const score = this._estimateDistrictScore(gameState, district, p);
            if (score > bestOther) bestOther = score;
        }

        return ownScore - bestOther;
    },

    _getBattlegroundProvinces(gameState, partyId, topN = 4) {
        const provinceStats = {};
        for (const district of gameState.districts) {
            const margin = this._estimateDistrictMargin(gameState, district, partyId);
            if (margin === null) continue;

            const isBattleground = Math.abs(margin) <= 4;
            if (!isBattleground) continue;

            if (!provinceStats[district.provinceName]) {
                provinceStats[district.provinceName] = { swingSeats: 0, pressure: 0 };
            }
            provinceStats[district.provinceName].swingSeats += 1;
            provinceStats[district.provinceName].pressure += (4 - Math.abs(margin));
        }

        return Object.entries(provinceStats)
            .map(([provinceName, meta]) => ({ provinceName, ...meta }))
            .sort((a, b) => {
                if (b.swingSeats !== a.swingSeats) return b.swingSeats - a.swingSeats;
                return b.pressure - a.pressure;
            })
            .slice(0, topN);
    },

    _pickBestSwingDistrict(gameState, partyId) {
        let best = null;
        let bestNeed = Infinity;
        for (const district of gameState.districts) {
            const margin = this._estimateDistrictMargin(gameState, district, partyId);
            if (margin === null) continue;
            if (margin >= 3 || margin <= -8) continue;
            const need = Math.abs(margin);
            if (need < bestNeed) {
                bestNeed = need;
                best = district;
            }
        }
        return best;
    },

    _pickPlayerPressureProvince(gameState, aiPartyId) {
        const playerId = gameState.playerPartyId;
        const map = {};
        for (const d of gameState.districts) {
            const playerAdv = this._estimateDistrictMargin(gameState, d, playerId);
            if (playerAdv === null || playerAdv < 1) continue;
            map[d.provinceName] = (map[d.provinceName] || 0) + playerAdv;
        }
        const ranked = Object.entries(map).sort((a, b) => b[1] - a[1]);
        if (ranked.length === 0) return null;

        // Avoid over-focusing one location forever.
        const pickIndex = Math.min(ranked.length - 1, Math.floor(Math.random() * 2));
        return ranked[pickIndex][0];
    },

    generateWeeklyEvent(gameState) {
        if (!gameState || (gameState.campaignTurn || 1) > this.getMaxCampaignTurns(gameState)) return null;
        const diff = this.getDifficultyConfig(gameState);
        if (Math.random() > diff.eventChance) return null;

        let pool = this.EVENT_TEMPLATES;
        if (gameState._lastCampaignEventId) {
            const filtered = pool.filter(e => e.id !== gameState._lastCampaignEventId);
            if (filtered.length > 0) pool = filtered;
        }
        const chosen = pool[Math.floor(Math.random() * pool.length)];
        if (!chosen) return null;
        gameState._lastCampaignEventId = chosen.id;
        return {
            ...chosen,
            options: chosen.options.map(o => ({ ...o }))
        };
    },

    resolveWeeklyEvent(gameState, event, optionIndex) {
        if (!event || !event.options || !event.options[optionIndex]) return null;

        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        if (!playerParty) return null;

        const option = event.options[optionIndex];
        const diff = this.getDifficultyConfig(gameState);
        const adjustedSuccessChance = Math.max(0.2, Math.min(0.92, option.successChance + diff.eventSuccessModifier));
        const success = Math.random() < adjustedSuccessChance;
        const effects = success ? option.success : option.fail;

        if (Number.isFinite(effects.actionPoints)) {
            const apCap = this.getAPPerTurn(gameState) + 4;
            gameState.actionPoints = Math.max(0, Math.min(apCap, gameState.actionPoints + effects.actionPoints));
        }
        if (Number.isFinite(effects.capital)) {
            playerParty.politicalCapital = Math.max(0, playerParty.politicalCapital + effects.capital);
        }
        if (Number.isFinite(effects.scandal)) {
            playerParty.scandalMeter = Math.max(0, Math.min(100, playerParty.scandalMeter + effects.scandal));
        }
        if (Number.isFinite(effects.momentum)) {
            this._adjustMomentum(gameState, playerParty.id, effects.momentum);
        }
        if (Number.isFinite(effects.nationalSwing)) {
            for (const d of gameState.districts) {
                this._addCampaignBuff(d, playerParty.id, effects.nationalSwing);
            }
        }
        this._applyRegionalSwing(gameState, playerParty.id, effects.regionalSwing || {});

        const effectNotes = [];
        if (Number.isFinite(effects.actionPoints) && effects.actionPoints !== 0) effectNotes.push(`AP ${effects.actionPoints > 0 ? '+' : ''}${effects.actionPoints}`);
        if (Number.isFinite(effects.capital) && effects.capital !== 0) effectNotes.push(`Capital ${effects.capital > 0 ? '+' : ''}${effects.capital}`);
        if (Number.isFinite(effects.scandal) && effects.scandal !== 0) effectNotes.push(`Scandal ${effects.scandal > 0 ? '+' : ''}${effects.scandal}`);
        if (Number.isFinite(effects.momentum) && effects.momentum !== 0) effectNotes.push(`Momentum ${effects.momentum > 0 ? '+' : ''}${effects.momentum}`);

        const regionalSwingTotal = Object.values(effects.regionalSwing || {}).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
        const popularityDelta = (Number.isFinite(effects.nationalSwing) ? effects.nationalSwing : 0) + regionalSwingTotal;

        return {
            success,
            message: `${success ? 'Event success:' : 'Event setback:'} ${event.title}${effectNotes.length ? ` (${effectNotes.join(', ')})` : ''}`,
            metrics: {
                popularityDelta,
                turningPointScore: Math.abs(popularityDelta) >= 4 ? 1.8 : 0.9
            }
        };
    },

    ACTIONS: {
        rally: {
            name: "Rally",
            thaiName: "จัดปราศรัย",
            apCost: 3,
            description: "Hold a rally in a province to boost popularity in all its districts.",
            icon: "📢",
            execute(gameState, params) {
                const { provinceName } = params;
                const playerPartyId = gameState.playerPartyId;
                const calc = window.Game.Engine.Campaign._applyRally(gameState, playerPartyId, provinceName, 3);
                return `Rally held in ${provinceName}! Popularity +${calc.power} in all districts.`;
            }
        },
        attackAd: {
            name: "Attack Ad",
            thaiName: "โจมตีคู่แข่ง",
            apCost: 4,
            description: "Run attack ads against a rival party in a province.",
            icon: "⚔️",
            execute(gameState, params) {
                const { provinceName, targetPartyId } = params;
                const calc = window.Game.Engine.Campaign._applyAttack(gameState, gameState.playerPartyId, targetPartyId, provinceName, 3);
                return `Attack ads deployed in ${provinceName}! ${targetPartyId} debuffed by ${calc.power}.`;
            }
        },
        canvass: {
            name: "Canvass",
            thaiName: "ลงพื้นที่",
            apCost: 2,
            description: "Canvass a specific district to boost your local candidate.",
            icon: "🚪",
            execute(gameState, params) {
                const { districtId } = params;
                const calc = window.Game.Engine.Campaign._applyCanvass(gameState, gameState.playerPartyId, districtId, 5);
                if (!calc) return 'District not found.';
                return `Canvassing complete! Local candidate popularity +${calc.power}.`;
            }
        },
        fundraise: {
            name: "Fundraise",
            thaiName: "ระดมทุน",
            apCost: 2,
            description: "Raise political capital for your party.",
            icon: "💰",
            execute(gameState) {
                const p = gameState.parties.find(p => p.id === gameState.playerPartyId);
                const momentum = window.Game.Engine.Campaign._getMomentum(gameState, p.id);
                const diff = window.Game.Engine.Campaign.getDifficultyConfig(gameState);
                const gain = Math.round((40 + Math.max(-10, Math.min(20, momentum * 2))) * diff.fundraiseMultiplier);
                p.politicalCapital += gain;
                return `Raised ${gain} political capital! Total: ${p.politicalCapital}`;
            }
        },
        ioOperation: {
            name: "IO Operation",
            thaiName: "ปฏิบัติการ IO",
            apCost: 5,
            requiresGreyMoney: 30,
            description: "Use grey money to tank a rival's popularity in a province.",
            icon: "🕵️",
            execute(gameState, params) {
                const { provinceName, targetPartyId } = params;
                const calc = window.Game.Engine.Campaign._applyIO(
                    gameState,
                    gameState.playerPartyId,
                    targetPartyId,
                    provinceName,
                    30,
                    5,
                    5
                );
                if (!calc) return 'Not enough grey money for IO operation.';
                return `IO deployed in ${provinceName}. ${targetPartyId} debuffed by ${calc.power}. Scandal +5.`;
            }
        },
        buySupport: {
            name: "Buy Support",
            thaiName: "ซื้อเสียง",
            apCost: 4,
            requiresGreyMoney: 40,
            description: "Use grey money to boost your banYai power in a province.",
            icon: "🤝",
            execute(gameState, params) {
                const { provinceName } = params;
                const calc = window.Game.Engine.Campaign._applyBuySupport(
                    gameState,
                    gameState.playerPartyId,
                    provinceName,
                    40,
                    8,
                    4
                );
                if (!calc) return 'Not enough grey money to buy support.';
                return `Support bought in ${provinceName}. BanYai +${calc.power}. Scandal +8.`;
            }
        },
        promisePolicy: {
            name: "Promise Policy",
            thaiName: "สัญญานโยบาย",
            apCost: 2,
            description: "Promise a policy to boost popularity. If elected, you must pass it or lose trust!",
            icon: "📜",
            requiresPromisePick: true,
            execute(gameState, params) {
                const { promise } = params;
                if (!gameState.campaignPromises) gameState.campaignPromises = [];
                // Check for duplicates
                if (gameState.campaignPromises.find(p => p.promiseId === promise.promiseId)) {
                    return `Already promised ${promise.engName}!`;
                }
                gameState.campaignPromises.push({
                    promiseId: promise.promiseId,
                    name: promise.name,
                    engName: promise.engName,
                    fulfilled: false,
                    failed: false
                });
                // Apply immediate campaign boost
                const playerPartyId = gameState.playerPartyId;
                for (const [region, boost] of Object.entries(promise.popularityBoost)) {
                    const provinces = window.Game.Data.REGIONS[region] || [];
                    for (const prov of provinces) {
                        for (const d of gameState.districts) {
                            if (d.provinceName === prov) {
                                window.Game.Engine.Campaign._addCampaignBuff(d, playerPartyId, boost);
                            }
                        }
                    }
                }
                window.Game.Engine.Campaign._adjustMomentum(gameState, playerPartyId, 1);
                return `📜 Promised: ${promise.engName}! Popularity boosted in key regions.`;
            }
        }
    },

    // AI campaign logic — battleground targeting and profile-driven behavior
    runAICampaign(gameState, turn) {
        this.initializeCampaignState(gameState);
        this.initializeAIPersonality(gameState);
        const diff = this.getDifficultyConfig(gameState);
        for (const party of gameState.parties) {
            if (party.id === gameState.playerPartyId) continue;

            const profile = this.AI_PROFILES[party.id] || { aggressive: false, shadowy: false, grassroots: true };
            const persona = this.getAIPersonality(gameState, party.id);
            const momentum = this._getMomentum(gameState, party.id);
            let aiAP = diff.aiAPBase + (momentum >= 4 ? 1 : 0);
            const aggression = diff.aiAggression;

            const battlegrounds = this._getBattlegroundProvinces(gameState, party.id, 5);

            while (aiAP >= 2) {
                let acted = false;

                const shadowTrigger = (profile.shadowy ? 0.2 : 0.07) + (persona.shadowFocus * 0.28) + (aggression * 0.2);
                if (aiAP >= 5 && party.greyMoney >= 30 && Math.random() < shadowTrigger) {
                    const pressureProvince = this._pickPlayerPressureProvince(gameState, party.id)
                        || (battlegrounds[0] ? battlegrounds[0].provinceName : null);
                    if (pressureProvince) {
                        const targetPartyId = Math.random() < 0.75
                            ? gameState.playerPartyId
                            : this._pickAttackTargetParty(gameState, party.id, pressureProvince);
                        const io = this._applyIO(gameState, party.id, targetPartyId, pressureProvince, 30, 4, 4);
                        if (io) {
                            aiAP -= 5;
                            acted = true;
                        }
                    }
                }
                if (acted) continue;

                const attackTrigger = (profile.aggressive ? 0.22 : 0.08) + (persona.aggression * 0.28) + (aggression * 0.25);
                if (aiAP >= 4 && battlegrounds.length > 0 && Math.random() < attackTrigger) {
                    const targetProvince = battlegrounds[0].provinceName;
                    const targetPartyId = Math.random() < 0.75
                        ? gameState.playerPartyId
                        : this._pickAttackTargetParty(gameState, party.id, targetProvince);
                    this._applyAttack(gameState, party.id, targetPartyId, targetProvince, 2.5);
                    aiAP -= 4;
                    acted = true;
                }
                if (acted) continue;

                if (aiAP >= 3) {
                    const shouldPushStronghold = Math.random() < (0.35 + persona.grassrootsFocus * 0.3);
                    const battleground = shouldPushStronghold ? battlegrounds.shift() : null;
                    let rallyProvince = battleground ? battleground.provinceName : null;
                    if (!rallyProvince) {
                        const strongRegion = this._getPartyStronghold(party);
                        const strongholdProvs = window.Game.Data.REGIONS[strongRegion] || [];
                        if (strongholdProvs.length > 0) {
                            rallyProvince = strongholdProvs[Math.floor(Math.random() * strongholdProvs.length)];
                        }
                    }
                    if (rallyProvince) {
                        this._applyRally(gameState, party.id, rallyProvince, 2.5);
                        aiAP -= 3;
                        acted = true;
                    }
                }
                if (acted) continue;

                if (aiAP >= 2) {
                    const swingDistrict = this._pickBestSwingDistrict(gameState, party.id) || gameState.districts[Math.floor(Math.random() * gameState.districts.length)];
                    if (swingDistrict) {
                        this._applyCanvass(gameState, party.id, swingDistrict.id, 3);
                        aiAP -= 2;
                        acted = true;
                    }
                }

                if (!acted) break;
            }
        }
    },

    _getPartyStronghold(party) {
        if (!party.regionalPopMod) return "Central";
        let best = "Central";
        let bestVal = -999;
        for (const [region, val] of Object.entries(party.regionalPopMod)) {
            if (val > bestVal) {
                bestVal = val;
                best = region;
            }
        }
        return best;
    }
};


// ─── PARLIAMENT ENGINE ───────────────────────────────────────
window.Game.Engine.Parliament = {
    REGIONAL_POP_MOD_CAP: 24,
    QUESTION_TIME_POP_GAIN_SCALE: 0.5,
    QUESTION_TIME_POP_SESSION_GAIN_CAP: 1.0,
    OPPOSITION_GOV_BILL_POSITIVE_SCALE: 0.72,
    OPPOSITION_GOV_BILL_NEGATIVE_SCALE: 1.0,
    OPPOSITION_GOV_COALITION_SPILLOVER_SCALE: 0.45,
    OPPOSITION_GOV_COALITION_SPILLOVER_CHANCE: 0.75,
    OPPOSITION_GOV_INCUMBENCY_GAIN_LEAD: 0.34,
    OPPOSITION_GOV_INCUMBENCY_GAIN_PARTNER: 0.18,
    OPPOSITION_VOTE_POP_DELTA: 0.7,
    OPPOSITION_VOTE_POP_YEARLY_CAP: 1.6,
    OPPOSITION_WALKOUT_SHARE_MIN: 0.05,
    OPPOSITION_WALKOUT_SHARE_MAX: 0.1,
    OPPOSITION_SPLIT_SHARE_MIN: 0.25,
    OPPOSITION_SPLIT_SHARE_MAX: 0.45,

    _applyRegionalPopDelta(party, region, delta, cap = 24) {
        if (!party || !region || !Number.isFinite(delta) || delta === 0) return 0;
        if (!party.regionalPopMod) party.regionalPopMod = {};
        const current = party.regionalPopMod[region] || 0;
        const next = Math.max(-cap, Math.min(cap, current + delta));
        party.regionalPopMod[region] = next;
        return next - current;
    },

    applyOppositionIncumbencyWear(gameState, stepYears = 1) {
        if (!gameState || gameState.playerRole !== 'opposition') return;
        const coalitionIds = Array.isArray(gameState.coalitionPartyIds) ? gameState.coalitionPartyIds : [];
        if (coalitionIds.length === 0) return;

        const totalSeats = (gameState.electionResults && gameState.electionResults.totalSeats) || {};
        const coalitionSeats = coalitionIds.reduce((sum, pid) => sum + (totalSeats[pid] || 0), 0);
        const coalitionStability = coalitionSeats >= 300
            ? 0.12
            : coalitionSeats >= 270
                ? 0.07
                : coalitionSeats >= 251
                    ? 0.03
                    : -0.1;

        for (const pid of coalitionIds) {
            const party = gameState.parties.find(p => p.id === pid);
            if (!party) continue;

            const isLead = pid === gameState.governmentPartyId;
            const scandal = party.scandalMeter || 0;
            const scandalPenalty = scandal >= 60 ? 0.5 : (scandal >= 35 ? 0.2 : 0);
            const annualDrift =
                (isLead ? this.OPPOSITION_GOV_INCUMBENCY_GAIN_LEAD : this.OPPOSITION_GOV_INCUMBENCY_GAIN_PARTNER)
                + (isLead ? coalitionStability : coalitionStability * 0.6)
                - scandalPenalty;
            const popularityDelta = Math.round((annualDrift * stepYears) * 10) / 10;
            party.basePopularity = Math.max(1, Math.min(60, Math.round((party.basePopularity + popularityDelta) * 10) / 10));

            if (!party.regionalPopMod) continue;
            const baseDecayPerYear = isLead ? 0.65 : 0.4;
            const instabilityDecay = coalitionStability < 0 ? 0.18 : 0;
            const effectiveDecay = Math.max(0, (baseDecayPerYear + instabilityDecay) * stepYears);
            for (const [region, value] of Object.entries(party.regionalPopMod)) {
                if (value <= 0) continue;
                party.regionalPopMod[region] = Math.max(0, Math.round((value - effectiveDecay) * 10) / 10);
            }
        }
    },

    _getActiveOppositionDisruption(gameState, coalitionSeats) {
        const disruption = {
            ayePenalty: 0,
            abstainBoost: 0,
            walkoutSeats: 0,
            splitSeats: 0,
            summary: []
        };
        if (!gameState || gameState.playerRole !== 'opposition' || coalitionSeats <= 0) return disruption;

        const walkout = gameState.oppositionWalkoutPlan;
        if (walkout && walkout.sessionNumber === gameState.sessionNumber && !walkout.used) {
            const seats = Math.max(0, Math.min(coalitionSeats, Math.floor(walkout.swingSeats || 0)));
            if (seats > 0) {
                disruption.ayePenalty += seats;
                disruption.abstainBoost += seats;
                disruption.walkoutSeats = seats;
                disruption.summary.push(`Walkout pressure shifted ${seats} coalition votes to abstain`);
            }
        }

        const split = gameState.oppositionSplitPlan;
        if (split && split.sessionNumber === gameState.sessionNumber && !split.used) {
            const remaining = Math.max(0, coalitionSeats - disruption.ayePenalty);
            const seats = Math.max(0, Math.min(remaining, Math.floor(split.abstainSeats || 0)));
            if (seats > 0) {
                disruption.ayePenalty += seats;
                disruption.abstainBoost += seats;
                disruption.splitSeats = seats;
                const targetParty = (gameState.parties || []).find(p => p.id === split.targetPartyId);
                const targetName = targetParty ? (targetParty.shortName || targetParty.thaiName || targetParty.id) : split.targetPartyId;
                disruption.summary.push(`Coalition split in ${targetName} shifted ${seats} votes to abstain`);
            }
        }

        return disruption;
    },

    launchParliamentaryWalkout(gameState) {
        if (!gameState || gameState.playerRole !== 'opposition') {
            return { success: false, msg: 'Parliamentary walkout is available only in opposition mode.' };
        }

        const activePlan = gameState.oppositionWalkoutPlan;
        if (activePlan && activePlan.sessionNumber === gameState.sessionNumber && !activePlan.used) {
            return { success: false, msg: 'A walkout is already prepared for the next government vote this session.' };
        }

        const totalSeats = (gameState.electionResults && gameState.electionResults.totalSeats) || {};
        const coalitionSeats = (gameState.coalitionPartyIds || [])
            .reduce((sum, pid) => sum + (totalSeats[pid] || 0), 0);
        if (coalitionSeats <= 0) {
            return { success: false, msg: 'No government coalition seats found to disrupt.' };
        }

        const share = this.OPPOSITION_WALKOUT_SHARE_MIN +
            (Math.random() * (this.OPPOSITION_WALKOUT_SHARE_MAX - this.OPPOSITION_WALKOUT_SHARE_MIN));
        const swingSeats = Math.max(8, Math.round(coalitionSeats * share));

        gameState.oppositionWalkoutPlan = {
            sessionNumber: gameState.sessionNumber,
            swingSeats,
            used: false
        };

        return {
            success: true,
            swingSeats,
            msg: `Parliamentary walkout staged: up to ${swingSeats} coalition votes may abstain on the next bill vote.`
        };
    },

    attemptCoalitionSplit(gameState, targetPartyId) {
        if (!gameState || gameState.playerRole !== 'opposition') {
            return { success: false, msg: 'Coalition split attempt is available only in opposition mode.' };
        }

        const coalitionPartners = (gameState.coalitionPartyIds || [])
            .filter(pid => pid !== gameState.governmentPartyId);
        if (!coalitionPartners.includes(targetPartyId)) {
            return { success: false, msg: 'Target must be a non-lead coalition partner.' };
        }

        const totalSeats = (gameState.electionResults && gameState.electionResults.totalSeats) || {};
        const targetSeats = totalSeats[targetPartyId] || 0;
        if (targetSeats <= 0) {
            return { success: false, msg: 'Target coalition partner has no seats to split.' };
        }

        const baseChance = Math.max(0.2, 0.62 - Math.min(0.28, targetSeats / 220));
        const chancePercent = Math.round(baseChance * 100);
        if (Math.random() > baseChance) {
            return {
                success: false,
                chancePercent,
                msg: `Split attempt failed (${chancePercent}% chance). Coalition closed ranks.`
            };
        }

        const share = this.OPPOSITION_SPLIT_SHARE_MIN +
            (Math.random() * (this.OPPOSITION_SPLIT_SHARE_MAX - this.OPPOSITION_SPLIT_SHARE_MIN));
        const abstainSeats = Math.max(3, Math.round(targetSeats * share));
        gameState.oppositionSplitPlan = {
            sessionNumber: gameState.sessionNumber,
            targetPartyId,
            abstainSeats,
            used: false
        };

        const targetParty = (gameState.parties || []).find(p => p.id === targetPartyId);
        const targetName = targetParty ? targetParty.thaiName : targetPartyId;
        return {
            success: true,
            chancePercent,
            abstainSeats,
            msg: `Split attempt succeeded: ${targetName} may abstain with about ${abstainSeats} MPs on the next bill vote.`
        };
    },

    /**
     * Check if a coalition has 251+ seats.
     */
    checkCoalitionViability(coalitionPartyIds, electionResults) {
        let total = 0;
        for (const pid of coalitionPartyIds) {
            total += (electionResults.totalSeats[pid] || 0);
        }
        return { viable: total >= 251, totalSeats: total };
    },

    /**
     * Government bill cap per session.
     * Coalition seats < 276: cap 1
     * Coalition seats >= 276: cap 2
     */
    getGovernmentBillSessionCap(gameState) {
        const totalSeats = (gameState.electionResults && gameState.electionResults.totalSeats) || {};
        const coalitionSeats = (gameState.coalitionPartyIds || [])
            .reduce((sum, pid) => sum + (totalSeats[pid] || 0), 0);
        if (coalitionSeats >= 340) return 3;
        if (coalitionSeats >= 251) return 2;
        return 1;
    },

    /**
     * Current usage/remaining for government bill votes in this session.
     */
    getGovernmentBillSessionStatus(gameState) {
        const cap = this.getGovernmentBillSessionCap(gameState);
        const rawUsed = Number.isFinite(gameState.governmentBillsVotedThisSession)
            ? gameState.governmentBillsVotedThisSession
            : 0;
        const used = Math.max(0, Math.floor(rawUsed));
        const remaining = Math.max(0, cap - used);
        return { cap, used, remaining, allowed: remaining > 0 };
    },

    /**
     * Consume one session slot when government calls a bill vote.
     */
    consumeGovernmentBillSessionSlot(gameState) {
        const status = this.getGovernmentBillSessionStatus(gameState);
        if (!status.allowed) return status;
        gameState.governmentBillsVotedThisSession = status.used + 1;
        return this.getGovernmentBillSessionStatus(gameState);
    },

    getPMOperationSessionCap(gameState) {
        const totalSeats = (gameState.electionResults && gameState.electionResults.totalSeats) || {};
        const coalitionSeats = (gameState.coalitionPartyIds || [])
            .reduce((sum, pid) => sum + (totalSeats[pid] || 0), 0);
        // PM operations are powerful by design; only super-majority coalitions may use 2 per session.
        return coalitionSeats >= 360 ? 2 : 1;
    },

    getPMOperationSessionStatus(gameState) {
        const cap = this.getPMOperationSessionCap(gameState);
        const used = Math.max(0, Math.floor(gameState.pmOpsUsedThisSession || 0));
        return {
            cap,
            used,
            remaining: Math.max(0, cap - used),
            allowed: used < cap
        };
    },

    _getPMFatigueMultiplier(gameState, operationId) {
        const fatigue = (gameState.pmOperationFatigue && gameState.pmOperationFatigue[operationId]) || 0;
        return Math.max(0.3, 1 - (fatigue * 0.25));
    },

    _bumpPMFatigue(gameState, operationId) {
        if (!gameState.pmOperationFatigue) gameState.pmOperationFatigue = {};
        gameState.pmOperationFatigue[operationId] = (gameState.pmOperationFatigue[operationId] || 0) + 1;
    },

    performPMOperation(gameState, operationId, opts = {}) {
        if (!gameState || gameState.playerRole === 'opposition') {
            return { success: false, msg: 'PM operations are available only when you lead the government.' };
        }

        const status = this.getPMOperationSessionStatus(gameState);
        if (!status.allowed) {
            return { success: false, msg: `PM operation cap reached (${status.used}/${status.cap}) this session.` };
        }

        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        if (!playerParty) return { success: false, msg: 'Player party not found.' };

        const mult = this._getPMFatigueMultiplier(gameState, operationId);
        const effects = { operationId, multiplier: Math.round(mult * 100) / 100 };

        if (operationId === 'cabinet_meeting') {
            const cost = 38;
            if (playerParty.politicalCapital < cost) return { success: false, msg: `Need ${cost} political capital.` };
            playerParty.politicalCapital -= cost;

            const trustBoost = mult >= 0.8 ? 1 : 0;
            const loyaltyBoost = Math.max(1, Math.round(3 * mult));
            const scandalRise = 1;

            for (const pid of (gameState.coalitionPartyIds || [])) {
                if (pid === gameState.playerPartyId) continue;
                if (!gameState.coalitionDemands[pid]) continue;
                const cur = gameState.coalitionDemands[pid].trust || 50;
                gameState.coalitionDemands[pid].trust = Math.max(15, Math.min(95, cur + trustBoost));
            }

            for (const mp of (gameState.seatedMPs || [])) {
                if (!gameState.coalitionPartyIds.includes(mp.partyId)) continue;
                mp.loyaltyToParty = Math.max(10, Math.min(95, mp.loyaltyToParty + loyaltyBoost));
            }

            playerParty.scandalMeter = Math.min(100, playerParty.scandalMeter + scandalRise);

            effects.capitalCost = cost;
            effects.trustBoost = trustBoost;
            effects.loyaltyBoost = loyaltyBoost;
            effects.scandalRise = scandalRise;
            effects.msg = `Cabinet discipline adjusted: coalition trust +${trustBoost}, coalition MP loyalty +${loyaltyBoost}, scandal +${scandalRise}.`;
        } else if (operationId === 'field_inspection') {
            const cost = 30;
            const provinceName = opts.provinceName;
            const region = window.Game.Data.PROVINCE_REGION[provinceName] || null;
            if (!provinceName || !region) return { success: false, msg: 'Choose a valid province for field inspection.' };
            if (playerParty.politicalCapital < cost) return { success: false, msg: `Need ${cost} political capital.` };
            playerParty.politicalCapital -= cost;

            if (!playerParty.regionalPopMod) playerParty.regionalPopMod = {};
            const popBoost = Math.random() < (0.75 * mult) ? 1 : 0;
            if (popBoost > 0) {
                playerParty.regionalPopMod[region] = (playerParty.regionalPopMod[region] || 0) + popBoost;
            }

            const scandalRelief = Math.random() < (0.45 * mult) ? 1 : 0;
            playerParty.scandalMeter = Math.max(0, playerParty.scandalMeter - scandalRelief);

            effects.capitalCost = cost;
            effects.region = region;
            effects.provinceName = provinceName;
            effects.popBoost = popBoost;
            effects.scandalRelief = scandalRelief;
            effects.msg = `Inspection in ${provinceName}: ${region} popularity +${popBoost}, scandal -${scandalRelief}.`;
        } else if (operationId === 'emergency_order') {
            const cost = 55;
            if (playerParty.politicalCapital < cost) return { success: false, msg: `Need ${cost} political capital.` };
            playerParty.politicalCapital -= cost;

            const scandalRise = Math.max(4, Math.round(7 - (mult * 1.2)));
            playerParty.scandalMeter = Math.min(100, playerParty.scandalMeter + scandalRise);
            const shieldGranted = Math.random() < (0.75 * mult);
            gameState.pmEmergencyShield = shieldGranted ? Math.max(gameState.pmEmergencyShield || 0, 1) : (gameState.pmEmergencyShield || 0);

            const trustBoost = mult >= 0.95 ? 1 : 0;
            for (const pid of (gameState.coalitionPartyIds || [])) {
                if (pid === gameState.playerPartyId) continue;
                if (!gameState.coalitionDemands[pid]) continue;
                const cur = gameState.coalitionDemands[pid].trust || 50;
                gameState.coalitionDemands[pid].trust = Math.max(15, Math.min(95, cur + trustBoost));
            }

            effects.capitalCost = cost;
            effects.scandalRise = scandalRise;
            effects.emergencyShield = shieldGranted ? gameState.pmEmergencyShield : 0;
            effects.trustBoost = trustBoost;
            effects.msg = `Emergency order issued: shield ${shieldGranted ? 'active' : 'failed'}, coalition trust +${trustBoost}, scandal +${scandalRise}.`;
        } else {
            return { success: false, msg: 'Unknown PM operation.' };
        }

        gameState.pmOpsUsedThisSession = (gameState.pmOpsUsedThisSession || 0) + 1;
        this._bumpPMFatigue(gameState, operationId);

        return { success: true, msg: effects.msg, effects };
    },

    /**
     * Queue government bills for opposition vote.
     */
    queueGovernmentBillsForOpposition(gameState, stepYears = 1) {
        if (gameState.playerRole !== 'opposition') return { queuedCount: 0, bills: [] };
        if (!gameState.governmentBillQueue) gameState.governmentBillQueue = [];
        if (!gameState.passedBillNames) gameState.passedBillNames = [];
        if (!gameState.governmentBillFailedCooldown) gameState.governmentBillFailedCooldown = {};

        // Tick down failed-bill cooldown (prevents immediate repeated retries).
        for (const [billName, remaining] of Object.entries(gameState.governmentBillFailedCooldown)) {
            const next = remaining - 1;
            if (next <= 0) delete gameState.governmentBillFailedCooldown[billName];
            else gameState.governmentBillFailedCooldown[billName] = next;
        }

        const templates = window.Game.Data.BILL_TEMPLATES || [];
        const alreadyQueued = new Set((gameState.governmentBillQueue || []).map(b => b.name));
        const unpassed = templates.filter(t =>
            !gameState.passedBillNames.includes(t.name) &&
            !alreadyQueued.has(t.name) &&
            !(gameState.governmentBillFailedCooldown[t.name] > 0)
        );
        if (unpassed.length === 0) return { queuedCount: 0, bills: [] };

        let queueCount = 1;
        if (stepYears >= 1 && this.getGovernmentBillSessionCap(gameState) > 1 && Math.random() < 0.45) {
            queueCount = 2;
        }
        const queued = [];
        for (let i = 0; i < queueCount && unpassed.length > 0; i++) {
            const idx = Math.floor(Math.random() * unpassed.length);
            const tmpl = unpassed.splice(idx, 1)[0];
            const entry = {
                id: `gov_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
                name: tmpl.name,
                description: tmpl.description || '',
                effects: { ...(tmpl.effects || {}) },
                queuedSession: gameState.sessionNumber
            };
            gameState.governmentBillQueue.push(entry);
            queued.push(entry);
        }

        return { queuedCount: queued.length, bills: queued };
    },

    resolvePendingGovernmentBillsAsAbstain(gameState) {
        if (!gameState.governmentBillQueue || gameState.governmentBillQueue.length === 0) return 0;
        let resolved = 0;
        while (gameState.governmentBillQueue.length > 0) {
            const bill = gameState.governmentBillQueue[0];
            this.resolveGovernmentBillVote(gameState, bill.id, 'abstain');
            resolved++;
        }
        return resolved;
    },

    projectGovernmentBillVote(gameState, bill, stance = 'oppose') {
        const totalSeats = gameState.electionResults.totalSeats || {};
        const coalitionSeats = (gameState.coalitionPartyIds || []).reduce((sum, pid) => sum + (totalSeats[pid] || 0), 0);
        const playerSeats = totalSeats[gameState.playerPartyId] || 0;
        const otherOppositionSeats = Math.max(0, 500 - coalitionSeats - playerSeats);
        const disruption = this._getActiveOppositionDisruption(gameState, coalitionSeats);

        const popNet = Object.values((bill.effects && bill.effects.popularityChanges) || {}).reduce((sum, v) => sum + v, 0);
        const otherSupportRatio = Math.max(0.12, Math.min(0.58, 0.30 + (popNet / 40)));
        const otherAbstainRatio = 0.10;

        const otherSupport = Math.round(otherOppositionSeats * otherSupportRatio);
        const otherAbstain = Math.round(otherOppositionSeats * otherAbstainRatio);
        const otherNay = Math.max(0, otherOppositionSeats - otherSupport - otherAbstain);

        const playerAye = stance === 'support' ? playerSeats : 0;
        const playerNay = stance === 'oppose' ? playerSeats : 0;
        const playerAbstain = stance === 'abstain' ? playerSeats : 0;

        const effectiveCoalitionAye = Math.max(0, coalitionSeats - disruption.ayePenalty);

        const aye = effectiveCoalitionAye + otherSupport + playerAye;
        const nay = otherNay + playerNay;
        const abstain = otherAbstain + playerAbstain + disruption.abstainBoost;
        const passed = aye >= 251;

        let playerBaseDelta = 0;
        if (popNet > 0 && stance === 'support') playerBaseDelta = this.OPPOSITION_VOTE_POP_DELTA;
        if (popNet > 0 && stance === 'oppose') playerBaseDelta = -this.OPPOSITION_VOTE_POP_DELTA;
        if (popNet < 0 && stance === 'oppose') playerBaseDelta = this.OPPOSITION_VOTE_POP_DELTA;
        if (popNet < 0 && stance === 'support') playerBaseDelta = -this.OPPOSITION_VOTE_POP_DELTA;

        const regionalExpected = {};
        const billRegionalEffects = (bill.effects && bill.effects.popularityChanges) || {};
        for (const [region, change] of Object.entries(billRegionalEffects)) {
            let expected = 0;
            if (stance === 'oppose') {
                if (change < 0) expected = 0.5; // +1 with 50% chance
            } else if (stance === 'support') {
                if (change > 0) expected = 0.35; // +1 with 35% chance
                if (change < 0) expected = -1;
            }
            regionalExpected[region] = expected;
        }

        return {
            aye,
            nay,
            abstain,
            passed,
            popNet,
            playerBaseDelta,
            regionalExpected,
            walkoutSeats: disruption.walkoutSeats,
            splitSeats: disruption.splitSeats,
            disruptionSummary: disruption.summary
        };
    },

    resolveGovernmentBillVote(gameState, billId, stance = 'oppose') {
        if (gameState.playerRole !== 'opposition') return null;
        if (!gameState.governmentBillQueue) gameState.governmentBillQueue = [];
        if (!gameState.governmentBillLog) gameState.governmentBillLog = [];
        if (!gameState.passedBillNames) gameState.passedBillNames = [];

        const idx = gameState.governmentBillQueue.findIndex(b => b.id === billId);
        if (idx === -1) return null;
        const bill = gameState.governmentBillQueue[idx];
        const projected = this.projectGovernmentBillVote(gameState, bill, stance);
        const aye = projected.aye;
        const nay = projected.nay;
        const abstain = projected.abstain;
        const passed = projected.passed;
        const popNet = projected.popNet;

        const governmentParty = gameState.parties.find(p => p.id === gameState.governmentPartyId);
        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const billRegionalEffects = (bill.effects && bill.effects.popularityChanges) || {};
        const coalitionPopularityBoost = {};

        if (passed) {
            gameState.passedBillNames.push(bill.name);
            if (gameState.governmentBillFailedCooldown) {
                delete gameState.governmentBillFailedCooldown[bill.name];
            }
            if (governmentParty) {
                const popChanges = (bill.effects && bill.effects.popularityChanges) || {};
                if (!governmentParty.regionalPopMod) governmentParty.regionalPopMod = {};
                for (const [region, change] of Object.entries(popChanges)) {
                    let adjustedChange = change;
                    if (change > 0) {
                        adjustedChange = Math.round(change * this.OPPOSITION_GOV_BILL_POSITIVE_SCALE);
                        if (adjustedChange <= 0 && Math.random() < 0.35) adjustedChange = 1;
                    } else if (change < 0) {
                        adjustedChange = Math.round(change * this.OPPOSITION_GOV_BILL_NEGATIVE_SCALE);
                    }
                    this._applyRegionalPopDelta(governmentParty, region, adjustedChange, this.REGIONAL_POP_MOD_CAP);
                }
                if (bill.effects && bill.effects.capitalReward) {
                    governmentParty.politicalCapital = Math.max(0, governmentParty.politicalCapital + bill.effects.capitalReward);
                }
                if (bill.effects && bill.effects.scandalChange) {
                    governmentParty.scandalMeter = Math.max(0, Math.min(100, governmentParty.scandalMeter + bill.effects.scandalChange));
                }
            }

            // AI coalition partners (excluding the lead government party)
            // gain smaller positive spillover from a successful bill.
            const coalitionPartnerIds = (gameState.coalitionPartyIds || [])
                .filter(pid => pid !== gameState.governmentPartyId);
            for (const partnerId of coalitionPartnerIds) {
                const partner = gameState.parties.find(p => p.id === partnerId);
                if (!partner) continue;
                if (!partner.regionalPopMod) partner.regionalPopMod = {};
                coalitionPopularityBoost[partnerId] = {};

                for (const [region, change] of Object.entries(billRegionalEffects)) {
                    if (change <= 0) continue;
                    const coalitionBoost = Math.round(change * this.OPPOSITION_GOV_COALITION_SPILLOVER_SCALE);
                    if (coalitionBoost <= 0 || Math.random() > this.OPPOSITION_GOV_COALITION_SPILLOVER_CHANCE) continue;
                    const applied = this._applyRegionalPopDelta(partner, region, coalitionBoost, this.REGIONAL_POP_MOD_CAP);
                    if (applied !== 0) coalitionPopularityBoost[partnerId][region] = applied;
                }
            }
        } else {
            if (!gameState.governmentBillFailedCooldown) gameState.governmentBillFailedCooldown = {};
            gameState.governmentBillFailedCooldown[bill.name] = 2;
        }

        // Small credibility/popularity consequence from how opposition voted.
        if (playerParty) {
            let effectiveBaseDelta = projected.playerBaseDelta || 0;
            if (effectiveBaseDelta > 0) {
                if (!gameState.oppositionVotePopularityYearTracker) {
                    gameState.oppositionVotePopularityYearTracker = { year: 1, gain: 0 };
                }
                const currentYear = Math.max(1, Math.ceil(gameState.parliamentYear || 1));
                if (gameState.oppositionVotePopularityYearTracker.year !== currentYear) {
                    gameState.oppositionVotePopularityYearTracker = { year: currentYear, gain: 0 };
                }
                const tracker = gameState.oppositionVotePopularityYearTracker;
                const remainingGain = Math.max(0, this.OPPOSITION_VOTE_POP_YEARLY_CAP - tracker.gain);
                effectiveBaseDelta = Math.min(effectiveBaseDelta, remainingGain);
                tracker.gain = Math.round((tracker.gain + effectiveBaseDelta) * 10) / 10;
            }
            playerParty.basePopularity = Math.max(1, Math.min(60, Math.round((playerParty.basePopularity + effectiveBaseDelta) * 10) / 10));

            // Regional response to opposition stance:
            // - Oppose: no bonus in regions helped by the bill; small chance gain in regions harmed by the bill.
            // - Support: small chance gain in regions helped by the bill; risk in regions harmed by the bill.
            if (!playerParty.regionalPopMod) playerParty.regionalPopMod = {};
            for (const [region, change] of Object.entries(billRegionalEffects)) {
                let regionalDelta = 0;
                if (stance === 'oppose') {
                    if (change < 0) regionalDelta = Math.random() < 0.5 ? 1 : 0;
                    else regionalDelta = 0;
                } else if (stance === 'support') {
                    if (change > 0) regionalDelta = Math.random() < 0.35 ? 1 : 0;
                    if (change < 0) regionalDelta = -1;
                }
                if (regionalDelta !== 0) {
                    playerParty.regionalPopMod[region] = (playerParty.regionalPopMod[region] || 0) + regionalDelta;
                }
            }
        }

        gameState.governmentBillLog.unshift({
            name: bill.name,
            description: bill.description,
            popNet,
            sessionNumber: gameState.sessionNumber,
            stance,
            passed,
            disruptionApplied: projected.disruptionSummary || []
        });
        gameState.governmentBillLog = gameState.governmentBillLog.slice(0, 10);

        if (projected.walkoutSeats > 0 && gameState.oppositionWalkoutPlan && gameState.oppositionWalkoutPlan.sessionNumber === gameState.sessionNumber) {
            gameState.oppositionWalkoutPlan.used = true;
        }
        if (projected.splitSeats > 0 && gameState.oppositionSplitPlan && gameState.oppositionSplitPlan.sessionNumber === gameState.sessionNumber) {
            gameState.oppositionSplitPlan.used = true;
        }
        if (gameState.oppositionWalkoutPlan && gameState.oppositionWalkoutPlan.used) {
            delete gameState.oppositionWalkoutPlan;
        }
        if (gameState.oppositionSplitPlan && gameState.oppositionSplitPlan.used) {
            delete gameState.oppositionSplitPlan;
        }

        gameState.governmentBillQueue.splice(idx, 1);
        return {
            billName: bill.name,
            stance,
            aye,
            nay,
            abstain,
            passed,
            popNet,
            coalitionPopularityBoost,
            disruptionApplied: projected.disruptionSummary || []
        };
    },

    /**
     * AI calculates ministry demands based on seat proportion.
     */
    getMinistryDemands(partyId, seatCount, totalCoalitionSeats) {
        const MINISTRIES = [
            "Interior", "Finance", "Defense", "Foreign Affairs", "Education",
            "Public Health", "Transport", "Commerce", "Agriculture",
            "Justice", "Labour", "Digital Economy", "Tourism & Sports",
            "Energy", "Natural Resources", "Social Development", "Culture",
            "Higher Education", "Industry", "PM's Office"
        ];

        const proportion = seatCount / totalCoalitionSeats;
        const demandCount = Math.max(1, Math.round(proportion * MINISTRIES.length));

        // Prioritize certain ministries based on party ideology
        const shuffled = [...MINISTRIES].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, demandCount);
    },

    /**
     * Project how 500 MPs will vote on a bill.
     */
    projectVotes(gameState, bill) {
        const seatedMPs = this.getSeatedMPs(gameState);
        let aye = 0, nay = 0, abstain = 0;

        for (const mp of seatedMPs) {
            const party = gameState.parties.find(p => p.id === mp.partyId);
            const isCoalition = gameState.coalitionPartyIds.includes(mp.partyId);
            const partyPosition = isCoalition ? 'aye' : 'nay';
            const playerPosition = 'aye'; // Player proposes = aye

            const vote = mp.voteLogic(bill, partyPosition, playerPosition);
            if (vote === 'aye') aye++;
            else if (vote === 'nay') nay++;
            else abstain++;
        }

        bill.projectedAye = aye;
        bill.projectedNay = nay;
        return { aye, nay, abstain };
    },

    /**
     * Execute the final vote (The Gavel).
     */
    executeVote(gameState, bill) {
        const seatedMPs = this.getSeatedMPs(gameState);
        let aye = 0, nay = 0, abstain = 0;
        const voteRecord = [];

        for (const mp of seatedMPs) {
            const isCoalition = gameState.coalitionPartyIds.includes(mp.partyId);
            const partyPosition = isCoalition ? 'aye' : 'nay';
            const playerPosition = 'aye';

            const vote = mp.voteLogic(bill, partyPosition, playerPosition);
            if (vote === 'aye') aye++;
            else if (vote === 'nay') nay++;
            else abstain++;

            voteRecord.push({ mpId: mp.id, mpName: mp.name, partyId: mp.partyId, vote });
        }

        bill.actualAye = aye;
        bill.actualNay = nay;
        bill.actualAbstain = abstain;
        bill.passed = aye > nay;

        // Apply bill effects if passed
        const effectsReport = this.applyBillEffects(gameState, bill);

        return { aye, nay, abstain, passed: bill.passed, voteRecord, effectsReport };
    },

    /**
     * Apply real consequences when a bill passes or fails.
     */
    applyBillEffects(gameState, bill) {
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const report = { popularityChanges: {}, capitalReward: 0, scandalChange: 0, promiseFulfilled: null, coalitionPopularityBoost: {} };
        const tmpl = window.Game.Data.BILL_TEMPLATES.find(t => t.name === bill.name);
        if (!tmpl || !tmpl.effects) return report;

        const isOppositionPlayer = gameState.playerRole === 'opposition';
        if (!gameState.oppositionPopularityYearTracker) {
            gameState.oppositionPopularityYearTracker = { year: 1, gain: 0 };
        }
        const currentYear = Math.max(1, Math.ceil(gameState.parliamentYear || 1));
        if (gameState.oppositionPopularityYearTracker.year !== currentYear) {
            gameState.oppositionPopularityYearTracker = { year: currentYear, gain: 0 };
        }

        const balancePlayerPopularityGain = (change) => {
            if (!isOppositionPlayer || change <= 0) return change;
            const tracker = gameState.oppositionPopularityYearTracker;
            const scaled = Math.max(0, Math.round(change * 0.5));
            const remainingGain = Math.max(0, 3 - tracker.gain);
            const allowed = Math.min(scaled, remainingGain);
            tracker.gain += allowed;
            return allowed;
        };

        if (bill.passed) {
            // Track bill as passed (prevents re-proposing)
            if (!gameState.passedBillNames) gameState.passedBillNames = [];
            if (!gameState.passedBillNames.includes(bill.name)) {
                gameState.passedBillNames.push(bill.name);
            }

            // Apply popularity changes per region
            const popChanges = tmpl.effects.popularityChanges || {};
            for (const [region, change] of Object.entries(popChanges)) {
                const adjustedChange = balancePlayerPopularityGain(change);
                report.popularityChanges[region] = adjustedChange;
                // Modify the player's regional popularity
                if (pp.regionalPopMod[region] !== undefined) {
                    pp.regionalPopMod[region] += adjustedChange;
                } else {
                    pp.regionalPopMod[region] = adjustedChange;
                }
            }

            // Coalition partners (excluding player) also gain smaller popularity
            // from shared government success when a bill passes.
            if (!isOppositionPlayer) {
                const coalitionPartnerIds = (gameState.coalitionPartyIds || [])
                    .filter(pid => pid !== gameState.playerPartyId);
                for (const partnerId of coalitionPartnerIds) {
                    const partner = gameState.parties.find(p => p.id === partnerId);
                    if (!partner) continue;
                    if (!partner.regionalPopMod) partner.regionalPopMod = {};
                    report.coalitionPopularityBoost[partnerId] = {};

                    for (const [region, change] of Object.entries(popChanges)) {
                        // Only apply positive spillover (smaller than player's gain).
                        if (change <= 0) continue;
                        const coalitionBoost = Math.max(1, Math.round(change * 0.8));
                        partner.regionalPopMod[region] = (partner.regionalPopMod[region] || 0) + coalitionBoost;
                        report.coalitionPopularityBoost[partnerId][region] = coalitionBoost;
                    }
                }
            }

            // Capital reward
            if (tmpl.effects.capitalReward) {
                pp.politicalCapital += tmpl.effects.capitalReward;
                report.capitalReward = tmpl.effects.capitalReward;
            }

            // Scandal change
            if (tmpl.effects.scandalChange) {
                pp.scandalMeter = Math.max(0, Math.min(100, pp.scandalMeter + tmpl.effects.scandalChange));
                report.scandalChange = tmpl.effects.scandalChange;
            }

            // Check if this fulfills a campaign promise
            if (tmpl.promiseId && gameState.campaignPromises) {
                const promise = gameState.campaignPromises.find(p => p.promiseId === tmpl.promiseId && !p.fulfilled);
                if (promise) {
                    promise.fulfilled = true;
                    report.promiseFulfilled = promise.engName;
                    // Bonus popularity for keeping promise
                    for (const [region, change] of Object.entries(popChanges)) {
                        const bonus = Math.ceil(Math.abs(change) * 0.5);
                        if (pp.regionalPopMod[region] !== undefined) {
                            pp.regionalPopMod[region] += bonus;
                        }
                    }
                }
            }
        } else {
            // Bill failed — check if this was a promised policy
            if (tmpl.promiseId && gameState.campaignPromises) {
                const promise = gameState.campaignPromises.find(p => p.promiseId === tmpl.promiseId && !p.fulfilled && !p.failed);
                if (promise) {
                    promise.failed = true;
                    report.promiseFulfilled = null;
                    // Penalty for breaking promise
                    const popChanges = tmpl.effects.popularityChanges || {};
                    for (const [region, change] of Object.entries(popChanges)) {
                        const penalty = -Math.ceil(Math.abs(change) * 0.7);
                        report.popularityChanges[region] = penalty;
                        if (pp.regionalPopMod[region] !== undefined) {
                            pp.regionalPopMod[region] += penalty;
                        } else {
                            pp.regionalPopMod[region] = penalty;
                        }
                    }
                }
            }
        }

        return report;
    },

    /**
     * Check unfulfilled promises at year end and apply penalties.
     */
    checkUnfulfilledPromises(gameState) {
        if (!gameState.campaignPromises) return [];
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const warnings = [];

        // Only penalize at year 3+ for unfulfilled promises
        if (gameState.parliamentYear >= 3) {
            for (const promise of gameState.campaignPromises) {
                if (!promise.fulfilled && !promise.failed) {
                    // Opposition still gets punished, but only half as strongly.
                    const penalty = gameState.playerRole === 'opposition' ? 0.5 : 1;
                    pp.basePopularity = Math.max(1, Math.round((pp.basePopularity - penalty) * 10) / 10);
                    warnings.push(`⚠️ Voters unhappy: "${promise.engName}" still unfulfilled! Popularity -${penalty}`);
                }
            }
        }

        return warnings;
    },

    /**
     * Run a no-confidence motion against the player.
     */
    runNoConfidence(gameState) {
        const bill = new window.Game.Models.Bill({
            name: "ญัตติไม่ไว้วางใจ",
            description: "No-confidence motion against the Prime Minister",
            type: 'no_confidence',
            ideologicalPosition: 50, // Neutral ideology — pure politics
            capitalCost: 0
        });

        // For no-confidence: opposition votes 'aye' (to remove PM), coalition votes 'nay'
        const isOppositionPlayer = gameState.playerRole === 'opposition';
        const seatedMPs = this.getSeatedMPs(gameState);
        let aye = 0, nay = 0, abstain = 0;

        for (const mp of seatedMPs) {
            const isCoalition = gameState.coalitionPartyIds.includes(mp.partyId);
            const partyPosition = isCoalition ? 'nay' : 'aye'; // Coalition defends
            const playerPosition = isOppositionPlayer ? 'aye' : 'nay';

            const vote = mp.voteLogic(bill, partyPosition, playerPosition);
            if (vote === 'aye') aye++;
            else if (vote === 'nay') nay++;
            else abstain++;
        }

        const motionPassed = aye > nay;
        const survived = !motionPassed;
        return { aye, nay, abstain, motionPassed, survived, bill };
    },

    /**
     * Lobby actions during the 3-turn lobby phase.
     */
    lobbyActions: {
        quidProQuo: {
            name: "Quid Pro Quo",
            thaiName: "แลกเปลี่ยนผลประโยชน์",
            description: "Trade favors with an AI party leader to align their votes.",
            capitalCost: 40,
            icon: "🤝",
            execute(gameState, targetPartyId) {
                const mps = gameState.seatedMPs.filter(mp => mp.partyId === targetPartyId);
                // Temporarily boost their loyalty toward the aye position
                for (const mp of mps) {
                    mp.loyaltyToParty = Math.min(100, mp.loyaltyToParty + 15);
                }
                const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
                pp.politicalCapital -= 40;
                return `Deal struck with ${targetPartyId}! Their MPs' loyalty increased.`;
            }
        },
        whip: {
            name: "Whip",
            thaiName: "วิปรัฐบาล",
            description: "Spend capital to force rebellious coalition MPs in line.",
            capitalCost: 25,
            icon: "📋",
            execute(gameState) {
                const playerPartyId = gameState.playerPartyId;
                const coalitionMPs = gameState.seatedMPs.filter(
                    mp => gameState.coalitionPartyIds.includes(mp.partyId)
                );
                let whipped = 0;
                for (const mp of coalitionMPs) {
                    if (mp.loyaltyToParty < 60) {
                        mp.loyaltyToParty = Math.min(100, mp.loyaltyToParty + 20);
                        whipped++;
                    }
                }
                const pp = gameState.parties.find(p => p.id === playerPartyId);
                pp.politicalCapital -= 25;
                return `Whipped ${whipped} rebellious coalition MPs into line!`;
            }
        },
        bribe: {
            name: "Bribe",
            thaiName: "ติดสินบน",
            description: "Use grey money to bribe high-corruption opposition MPs.",
            greyMoneyCost: 50,
            icon: "💵",
            execute(gameState, targetMPId) {
                const mp = gameState.seatedMPs.find(m => m.id === targetMPId);
                if (!mp) return "MP not found.";

                const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);

                if (mp.corruptionLevel < 30) {
                    return `${mp.name} refuses the bribe! Too clean.`;
                }

                pp.greyMoney -= 50;
                pp.scandalMeter = Math.min(100, pp.scandalMeter + 3);
                mp.isBribedByPlayer = true;
                return `${mp.name} has been bribed! They will vote with you on the next bill.`;
            }
        }
    },

    // ─── COALITION DYNAMICS ─────────────────────────────────────
    COALITION_DEMAND_TEMPLATES: [
        { id: 'policy_concession', label: '📜 Pass a bill matching our ideology', thaiLabel: 'ผ่านกฎหมายตามแนวทางเรา', type: 'bill_pass', deadlineSessions: 3, satisfactionPenalty: 12, satisfactionReward: 8 },
        { id: 'ministry_upgrade', label: '🏛️ Give us an additional ministry', thaiLabel: 'เพิ่มตำแหน่งกระทรวง', type: 'ministry', deadlineSessions: 2, satisfactionPenalty: 15, satisfactionReward: 10 },
        { id: 'budget_share', label: '💰 Increase our budget allocation', thaiLabel: 'เพิ่มงบประมาณให้เรา', type: 'capital', capitalCost: 40, deadlineSessions: 2, satisfactionPenalty: 10, satisfactionReward: 6 },
        { id: 'scandal_distance', label: '🚫 Distance from scandal publicly', thaiLabel: 'แสดงจุดยืนห่างเรื่องอื้อฉาว', type: 'scandal', scandalThreshold: 40, deadlineSessions: 2, satisfactionPenalty: 8, satisfactionReward: 5 },
        { id: 'regional_focus', label: '🗺️ Prioritize our region in policy', thaiLabel: 'ให้ความสำคัญกับภูมิภาคเรา', type: 'regional', deadlineSessions: 3, satisfactionPenalty: 10, satisfactionReward: 7 },
        { id: 'public_endorsement', label: '📺 Publicly endorse our party leader', thaiLabel: 'แสดงการสนับสนุนผู้นำพรรคเรา', type: 'endorsement', capitalCost: 25, deadlineSessions: 1, satisfactionPenalty: 8, satisfactionReward: 6 },
    ],

    COALITION_EVENT_TEMPLATES: [
        { id: 'partner_scandal', icon: '📰', label: 'Partner MP Scandal', thaiLabel: 'สส. พรรคร่วมมีเรื่องอื้อฉาว', description: 'A coalition partner MP is caught in a corruption scandal.',
          options: [
            { label: '🛡️ Defend them publicly', effect: { partnerSatisfaction: +8, scandal: +5, popularity: -1 } },
            { label: '⚖️ Call for investigation', effect: { partnerSatisfaction: -10, scandal: -3, popularity: +1 } }
          ]
        },
        { id: 'partner_defection', icon: '🚪', label: 'MP Defection Threat', thaiLabel: 'สส. ขู่ย้ายพรรค', description: 'Several partner MPs are considering defecting to the opposition.',
          options: [
            { label: '💰 Offer incentives to stay', effect: { partnerSatisfaction: +6, capital: -35, scandal: +2 } },
            { label: '📋 Enforce party discipline', effect: { partnerSatisfaction: -5, popularity: +1 } }
          ]
        },
        { id: 'partner_policy_clash', icon: '⚡', label: 'Policy Disagreement', thaiLabel: 'ขัดแย้งนโยบาย', description: 'A coalition partner publicly opposes your latest policy direction.',
          options: [
            { label: '🤝 Compromise on the issue', effect: { partnerSatisfaction: +10, popularity: -1 } },
            { label: '💪 Hold firm on your position', effect: { partnerSatisfaction: -8, popularity: +2 } }
          ]
        },
        { id: 'partner_media_attack', icon: '📺', label: 'Media Attack on Partner', thaiLabel: 'สื่อโจมตีพรรคร่วม', description: 'Opposition media is attacking your coalition partner heavily.',
          options: [
            { label: '📢 Publicly defend partner', effect: { partnerSatisfaction: +12, scandal: +2, popularity: -1 } },
            { label: '🤐 Stay silent', effect: { partnerSatisfaction: -6, popularity: 0 } }
          ]
        },
        { id: 'partner_walkout_threat', icon: '🚶', label: 'Walkout Threat', thaiLabel: 'ขู่ถอนตัวจากรัฐบาล', description: 'A partner party threatens to withdraw from the coalition entirely.',
          options: [
            { label: '🎁 Emergency concession package', effect: { partnerSatisfaction: +15, capital: -50, scandal: +3 } },
            { label: '🎲 Call their bluff', effect: { partnerSatisfaction: -12, popularity: +2, riskWalkout: true } }
          ]
        },
    ],

    INTERPELLATION_TEMPLATES: [
        { id: 'qt_economy', icon: '📊', topic: 'Economy', thaiTopic: 'เศรษฐกิจ', question: 'The opposition demands an explanation for rising cost of living.',
          options: [
            { label: '📈 Cite economic growth data', effect: { popularity: +1, coalitionTrust: +2, capital: 0 } },
            { label: '🛑 Blame global factors', effect: { popularity: -1, coalitionTrust: 0, capital: +10 } },
            { label: '💸 Announce relief measures', effect: { popularity: +2, coalitionTrust: +1, capital: -30 } }
          ]
        },
        { id: 'qt_corruption', icon: '⚖️', topic: 'Corruption', thaiTopic: 'ทุจริต', question: 'MPs question the PM about corruption allegations within the coalition.',
          options: [
            { label: '🔍 Promise transparent investigation', effect: { popularity: +2, coalitionTrust: -3, scandal: -3 } },
            { label: '🛡️ Defend coalition integrity', effect: { popularity: -1, coalitionTrust: +5, scandal: +2 } },
            { label: '📋 Redirect to policy achievements', effect: { popularity: 0, coalitionTrust: +1, capital: 0 } }
          ]
        },
        { id: 'qt_security', icon: '🛡️', topic: 'National Security', thaiTopic: 'ความมั่นคง', question: 'The opposition grills the PM on border security concerns.',
          options: [
            { label: '⚔️ Announce security buildup', effect: { popularity: +1, coalitionTrust: +2, capital: -20 } },
            { label: '🕊️ Emphasize diplomatic approach', effect: { popularity: +1, coalitionTrust: 0, capital: 0 } },
            { label: '📊 Dismiss threat as exaggerated', effect: { popularity: -1, coalitionTrust: -1, capital: +10 } }
          ]
        },
        { id: 'qt_education', icon: '📚', topic: 'Education', thaiTopic: 'การศึกษา', question: 'MPs demand answers about declining educational standards and budget cuts.',
          options: [
            { label: '💰 Pledge increased education budget', effect: { popularity: +2, coalitionTrust: +1, capital: -25 } },
            { label: '📜 Highlight ongoing reform programs', effect: { popularity: +1, coalitionTrust: +2, capital: 0 } },
            { label: '🏫 Blame previous government', effect: { popularity: -1, coalitionTrust: -1, capital: +5 } }
          ]
        },
        { id: 'qt_healthcare', icon: '🏥', topic: 'Healthcare', thaiTopic: 'สาธารณสุข', question: 'Hospital overcrowding sparks heated parliamentary debate.',
          options: [
            { label: '🏗️ Announce hospital expansion', effect: { popularity: +2, coalitionTrust: +1, capital: -30 } },
            { label: '📋 Present efficiency improvements', effect: { popularity: +1, coalitionTrust: +2, capital: -10 } },
            { label: '🤷 Acknowledge challenge, buy time', effect: { popularity: -1, coalitionTrust: 0, capital: +5 } }
          ]
        },
        { id: 'qt_environment', icon: '🌿', topic: 'Environment', thaiTopic: 'สิ่งแวดล้อม', question: 'Air pollution crisis triggers opposition demands for emergency action.',
          options: [
            { label: '🚒 Declare environmental emergency', effect: { popularity: +2, coalitionTrust: -1, capital: -25 } },
            { label: '📜 Propose new green legislation', effect: { popularity: +1, coalitionTrust: +3, capital: -15 } },
            { label: '🏭 Protect industry interests', effect: { popularity: -2, coalitionTrust: +1, capital: +10 } }
          ]
        },
        { id: 'qt_inequality', icon: '📉', topic: 'Inequality', thaiTopic: 'ความเหลื่อมล้ำ', question: 'Rising wealth gap data sparks fiery debate in the house.',
          options: [
            { label: '💸 Announce wealth redistribution plan', effect: { popularity: +2, coalitionTrust: -2, capital: -20 } },
            { label: '📈 Focus on overall growth metrics', effect: { popularity: -1, coalitionTrust: +2, capital: +5 } },
            { label: '🤝 Propose cross-party working group', effect: { popularity: +1, coalitionTrust: +3, capital: -10 } }
          ]
        },
    ],

    initCoalitionSatisfaction(gameState) {
        if (!gameState.coalitionSatisfaction) gameState.coalitionSatisfaction = {};
        const coalitionIds = gameState.coalitionPartyIds || [];
        for (const pid of coalitionIds) {
            if (pid === gameState.playerPartyId) continue;
            if (gameState.coalitionSatisfaction[pid]) continue;
            const demand = (gameState.coalitionDemands || {})[pid];
            const trust = demand ? (demand.trust || 50) : 50;
            const offered = (gameState.coalitionMinistryOffers || {})[pid] || 0;
            const required = demand ? (demand.ministryDemand || 1) : 1;
            const ministryBonus = Math.min(15, (offered - required) * 5);
            gameState.coalitionSatisfaction[pid] = {
                score: Math.max(20, Math.min(90, trust + ministryBonus)),
                demands: [],
                lastEventSession: 0,
                totalDemandsMet: 0,
                totalDemandsFailed: 0
            };
        }
    },

    getCoalitionHealth(gameState) {
        if (!gameState.coalitionSatisfaction) return { average: 50, lowest: 50, critical: false, parties: {} };
        const entries = Object.entries(gameState.coalitionSatisfaction);
        if (entries.length === 0) return { average: 50, lowest: 50, critical: false, parties: {} };
        let total = 0;
        let lowest = 100;
        const parties = {};
        for (const [pid, data] of entries) {
            const score = data.score || 50;
            total += score;
            if (score < lowest) lowest = score;
            const party = (gameState.parties || []).find(p => p.id === pid);
            parties[pid] = {
                name: party ? party.thaiName : pid,
                score,
                status: score >= 70 ? 'loyal' : score >= 45 ? 'uneasy' : score >= 25 ? 'unhappy' : 'critical',
                demands: data.demands || []
            };
        }
        const average = Math.round(total / entries.length);
        return { average, lowest, critical: lowest < 25, parties };
    },

    tickCoalitionDynamics(gameState) {
        if (gameState.playerRole === 'opposition') return { events: [], newDemands: [], expiredDemands: [] };
        this.initCoalitionSatisfaction(gameState);
        const results = { events: [], newDemands: [], expiredDemands: [] };
        const coalitionIds = (gameState.coalitionPartyIds || []).filter(pid => pid !== gameState.playerPartyId);

        for (const pid of coalitionIds) {
            const sat = gameState.coalitionSatisfaction[pid];
            if (!sat) continue;

            // Natural satisfaction drift
            const scandal = ((gameState.parties || []).find(p => p.id === gameState.playerPartyId) || {}).scandalMeter || 0;
            const scandalDrain = scandal >= 60 ? -2 : scandal >= 35 ? -1 : 0;
            sat.score = Math.max(5, Math.min(95, sat.score + scandalDrain));

            // Check expired demands
            const activeDemands = [];
            for (const demand of (sat.demands || [])) {
                demand.remainingSessions = Math.max(0, (demand.remainingSessions || 0) - 1);
                if (demand.remainingSessions <= 0 && !demand.fulfilled) {
                    const penalty = Math.max(4, Math.round((demand.satisfactionPenalty || 10) * 0.75));
                    sat.score = Math.max(5, sat.score - penalty);
                    sat.totalDemandsFailed = (sat.totalDemandsFailed || 0) + 1;
                    results.expiredDemands.push({ partyId: pid, demand });
                } else {
                    activeDemands.push(demand);
                }
            }
            sat.demands = activeDemands;

            // Maybe generate new demand (22% chance if < 2 active demands)
            if (sat.demands.length < 2 && Math.random() < 0.22) {
                const newDemand = this._generateCoalitionDemand(gameState, pid);
                if (newDemand) {
                    sat.demands.push(newDemand);
                    results.newDemands.push({ partyId: pid, demand: newDemand });
                }
            }

            // Maybe trigger coalition event (14% chance, not same session)
            if (sat.lastEventSession !== gameState.sessionNumber && Math.random() < 0.14) {
                const event = this._generateCoalitionEvent(gameState, pid);
                if (event) {
                    sat.lastEventSession = gameState.sessionNumber;
                    results.events.push({ partyId: pid, event });
                }
            }
        }

        return results;
    },

    _generateCoalitionDemand(gameState, partyId) {
        const existing = ((gameState.coalitionSatisfaction[partyId] || {}).demands || []).map(d => d.id);
        const pool = this.COALITION_DEMAND_TEMPLATES.filter(t => !existing.includes(t.id));
        if (pool.length === 0) return null;
        const template = pool[Math.floor(Math.random() * pool.length)];
        return {
            ...template,
            instanceId: `${template.id}_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            remainingSessions: template.deadlineSessions,
            fulfilled: false,
            createdSession: gameState.sessionNumber
        };
    },

    _generateCoalitionEvent(gameState, partyId) {
        const sat = gameState.coalitionSatisfaction[partyId];
        if (!sat) return null;
        let pool = [...this.COALITION_EVENT_TEMPLATES];
        // Weight walkout threats toward low satisfaction
        if (sat.score > 50) pool = pool.filter(e => e.id !== 'partner_walkout_threat');
        if (pool.length === 0) return null;
        const template = pool[Math.floor(Math.random() * pool.length)];
        return { ...template, targetPartyId: partyId, options: template.options.map(o => ({ ...o, effect: { ...o.effect } })) };
    },

    resolveCoalitionEvent(gameState, partyId, optionIndex) {
        const sat = gameState.coalitionSatisfaction[partyId];
        if (!sat) return null;
        // Event is passed from UI, option effects are applied here
        const playerParty = (gameState.parties || []).find(p => p.id === gameState.playerPartyId);
        return { applied: true };
    },

    fulfillCoalitionDemand(gameState, partyId, demandInstanceId) {
        const sat = gameState.coalitionSatisfaction[partyId];
        if (!sat) return { success: false, msg: 'No satisfaction data.' };
        const demand = (sat.demands || []).find(d => d.instanceId === demandInstanceId);
        if (!demand) return { success: false, msg: 'Demand not found.' };
        if (demand.fulfilled) return { success: false, msg: 'Already fulfilled.' };

        const playerParty = (gameState.parties || []).find(p => p.id === gameState.playerPartyId);
        if (!playerParty) return { success: false, msg: 'Player party not found.' };

        if (demand.capitalCost && playerParty.politicalCapital < demand.capitalCost) {
            return { success: false, msg: `Need ${demand.capitalCost} political capital.` };
        }

        if (demand.capitalCost) playerParty.politicalCapital -= demand.capitalCost;
        demand.fulfilled = true;
        sat.score = Math.min(95, sat.score + (demand.satisfactionReward || 5));
        sat.totalDemandsMet = (sat.totalDemandsMet || 0) + 1;
        sat.demands = sat.demands.filter(d => d.instanceId !== demandInstanceId);

        return { success: true, msg: `Demand fulfilled! ${(gameState.parties || []).find(p => p.id === partyId)?.thaiName || partyId} satisfaction +${demand.satisfactionReward}.` };
    },

    reshuffleCabinet(gameState, targetPartyId, delta) {
        if (gameState.playerRole === 'opposition') return { success: false, msg: 'Not in government.' };
        const sat = gameState.coalitionSatisfaction[targetPartyId];
        if (!sat) return { success: false, msg: 'Party not in coalition.' };
        const playerParty = (gameState.parties || []).find(p => p.id === gameState.playerPartyId);
        if (!playerParty || playerParty.politicalCapital < 30) return { success: false, msg: 'Need 30 political capital for reshuffle.' };

        const currentOffer = (gameState.coalitionMinistryOffers || {})[targetPartyId] || 0;
        const newOffer = Math.max(0, Math.min(8, currentOffer + delta));
        if (newOffer === currentOffer) return { success: false, msg: 'No change possible.' };

        playerParty.politicalCapital -= 30;
        gameState.coalitionMinistryOffers[targetPartyId] = newOffer;
        const satisfactionDelta = delta > 0 ? 8 : -10;
        sat.score = Math.max(5, Math.min(95, sat.score + satisfactionDelta));

        return { success: true, msg: `Cabinet reshuffled: ${(gameState.parties || []).find(p => p.id === targetPartyId)?.thaiName || targetPartyId} now has ${newOffer} ministries. Satisfaction ${satisfactionDelta > 0 ? '+' : ''}${satisfactionDelta}.` };
    },

    checkCoalitionCollapse(gameState) {
        if (gameState.playerRole === 'opposition') return null;
        const health = this.getCoalitionHealth(gameState);
        if (!health.critical) return null;

        // Find the most unhappy partner
        for (const [pid, data] of Object.entries(health.parties)) {
            if (data.score < 10 && Math.random() < 0.3) {
                // Partner walks out!
                const coalitionIds = [...(gameState.coalitionPartyIds || [])];
                gameState.coalitionPartyIds = coalitionIds.filter(id => id !== pid);
                delete gameState.coalitionSatisfaction[pid];
                return {
                    collapsed: true,
                    partyId: pid,
                    partyName: data.name,
                    remainingSeats: (gameState.coalitionPartyIds || []).reduce((sum, id) => sum + ((gameState.electionResults?.totalSeats || {})[id] || 0), 0)
                };
            }
        }
        return null;
    },

    // ─── SESSION PHASE SYSTEM ─────────────────────────────────
    SESSION_PHASES: ['question_time', 'legislative', 'adjournment'],

    getSessionPhaseInfo(gameState) {
        const phase = gameState.sessionPhase || 'question_time';
        const phaseIndex = this.SESSION_PHASES.indexOf(phase);
        const labels = {
            question_time: { name: 'Question Time', thaiName: 'ตั้งกระทู้ถาม', icon: '❓', description: 'MPs grill the PM on key issues.' },
            legislative: { name: 'Legislative Floor', thaiName: 'สภานิติบัญญัติ', icon: '📜', description: 'Propose and vote on bills.' },
            adjournment: { name: 'Adjournment', thaiName: 'ปิดสมัยประชุม', icon: '🔔', description: 'Review coalition health and advance time.' }
        };
        return {
            phase,
            phaseIndex,
            total: this.SESSION_PHASES.length,
            ...(labels[phase] || labels.question_time),
            isFirst: phaseIndex === 0,
            isLast: phaseIndex === this.SESSION_PHASES.length - 1
        };
    },

    generateInterpellations(gameState, count = 2) {
        const pool = [...this.INTERPELLATION_TEMPLATES];
        const lastIds = gameState._lastInterpellationIds || [];
        const filtered = pool.filter(t => !lastIds.includes(t.id));
        const source = filtered.length >= count ? filtered : pool;
        const shuffled = source.sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, count);
        gameState._lastInterpellationIds = selected.map(s => s.id);
        return selected.map(t => ({ ...t, options: t.options.map(o => ({ ...o, effect: { ...o.effect } })) }));
    },

    resolveInterpellation(gameState, interpellation, optionIndex) {
        const option = interpellation.options[optionIndex];
        if (!option) return null;
        const effect = option.effect;
        const playerParty = (gameState.parties || []).find(p => p.id === gameState.playerPartyId);
        if (!playerParty) return null;

        const result = { label: option.label, effects: {} };

        if (effect.popularity) {
            if (!gameState.questionTimePopularityTracker) {
                gameState.questionTimePopularityTracker = { sessionNumber: gameState.sessionNumber, gain: 0 };
            }
            if (gameState.questionTimePopularityTracker.sessionNumber !== gameState.sessionNumber) {
                gameState.questionTimePopularityTracker = { sessionNumber: gameState.sessionNumber, gain: 0 };
            }

            let appliedPopularity = effect.popularity;
            if (effect.popularity > 0) {
                const tracker = gameState.questionTimePopularityTracker;
                const scaledGain = Math.round((effect.popularity * this.QUESTION_TIME_POP_GAIN_SCALE) * 10) / 10;
                const remainingGain = Math.max(0, this.QUESTION_TIME_POP_SESSION_GAIN_CAP - tracker.gain);
                appliedPopularity = Math.min(scaledGain, remainingGain);
                tracker.gain = Math.round((tracker.gain + appliedPopularity) * 10) / 10;
            }

            playerParty.basePopularity = Math.max(1, Math.min(60, playerParty.basePopularity + appliedPopularity));
            result.effects.popularity = appliedPopularity;
        }
        if (effect.capital) {
            playerParty.politicalCapital = Math.max(0, playerParty.politicalCapital + effect.capital);
            result.effects.capital = effect.capital;
        }
        if (effect.scandal) {
            playerParty.scandalMeter = Math.max(0, Math.min(100, playerParty.scandalMeter + effect.scandal));
            result.effects.scandal = effect.scandal;
        }
        if (effect.coalitionTrust) {
            // Apply to all coalition partners
            const coalitionIds = (gameState.coalitionPartyIds || []).filter(pid => pid !== gameState.playerPartyId);
            for (const pid of coalitionIds) {
                const sat = (gameState.coalitionSatisfaction || {})[pid];
                if (sat) {
                    sat.score = Math.max(5, Math.min(95, sat.score + effect.coalitionTrust));
                }
            }
            result.effects.coalitionTrust = effect.coalitionTrust;
        }

        // Add to session headlines
        if (!gameState.sessionHeadlines) gameState.sessionHeadlines = [];
        const headlineVerb = (effect.popularity || 0) > 0 ? 'impressed' : (effect.popularity || 0) < 0 ? 'stumbled during' : 'addressed';
        gameState.sessionHeadlines.push(`PM ${headlineVerb} ${interpellation.topic} question time.`);

        return result;
    },

    generateAdjournmentSummary(gameState) {
        const health = this.getCoalitionHealth(gameState);
        const headlines = gameState.sessionHeadlines || [];
        const billsThisSession = gameState.governmentBillsVotedThisSession || 0;
        const pp = (gameState.parties || []).find(p => p.id === gameState.playerPartyId);

        return {
            coalitionHealth: health,
            headlines,
            billsVoted: billsThisSession,
            scandalLevel: pp ? pp.scandalMeter : 0,
            capitalRemaining: pp ? pp.politicalCapital : 0,
            year: gameState.parliamentYear,
            session: gameState.sessionNumber
        };
    },

    /**
     * Get all seated MPs (those who won seats).
     */
    getSeatedMPs(gameState) {
        if (gameState.seatedMPs && gameState.seatedMPs.length > 0) return gameState.seatedMPs;

        const seated = [];
        // Constituency winners
        for (const result of gameState.electionResults.districtResults) {
            const mps = gameState.partyMPs[result.winnerId];
            if (mps) {
                const mp = mps.find(m => m.districtId === result.districtId);
                if (mp) {
                    mp.isSeated = true;
                    seated.push(mp);
                }
            }
        }
        // Party list seats
        for (const party of gameState.parties) {
            const listCount = gameState.electionResults.partyListSeats[party.id] || 0;
            const listMPs = (gameState.partyMPs[party.id] || []).filter(m => m.isPartyList && !m.isSeated);
            for (let i = 0; i < listCount && i < listMPs.length; i++) {
                listMPs[i].isSeated = true;
                seated.push(listMPs[i]);
            }
        }

        gameState.seatedMPs = seated;
        return seated;
    }
};


// ─── SHADOW ENGINE ───────────────────────────────────────────
window.Game.Engine.Shadow = {

    /**
     * Dark Wallet: Siphon political capital into grey money.
     */
    siphonFunds(gameState, amount) {
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
        if (pp.politicalCapital < amount) return { success: false, msg: "Not enough political capital!" };

        pp.politicalCapital -= amount;
        pp.greyMoney += Math.floor(amount * 0.7); // 70% conversion rate
        pp.scandalMeter = Math.min(100, pp.scandalMeter + Math.floor(amount / 10));

        return {
            success: true,
            msg: `Siphoned ${amount} capital → ${Math.floor(amount * 0.7)} grey money. Scandal: ${pp.scandalMeter}/100`
        };
    },

    /**
     * IO Operation: Tank a rival's popularity in a province.
     */
    deployIO(gameState, targetPartyId, provinceName) {
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const cost = 30;
        if (pp.greyMoney < cost) return { success: false, msg: "Not enough grey money!" };

        pp.greyMoney -= cost;
        pp.scandalMeter = Math.min(100, pp.scandalMeter + 5);

        for (const d of gameState.districts) {
            if (d.provinceName === provinceName) {
                d.ioDebuff[targetPartyId] = (d.ioDebuff[targetPartyId] || 0) + 5;
            }
        }

        return {
            success: true,
            msg: `IO deployed against ${targetPartyId} in ${provinceName}. -5 local popularity.`
        };
    },

    /**
     * Distribute Bananas (Kluai): Long-term bribe — turn rival MPs into Cobras.
     */
    distributeBanana(gameState, targetMPId) {
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const cost = 100;
        if (pp.greyMoney < cost) return { success: false, msg: "Not enough grey money! Need 100." };

        const mp = gameState.seatedMPs.find(m => m.id === targetMPId);
        if (!mp) return { success: false, msg: "MP not found." };
        if (mp.partyId === gameState.playerPartyId) return { success: false, msg: "Can't banana your own MP!" };

        if (mp.corruptionLevel < 40) {
            pp.greyMoney -= 30; // Wasted some money trying
            return { success: false, msg: `${mp.name} is too clean to become a Cobra!` };
        }

        pp.greyMoney -= cost;
        pp.scandalMeter = Math.min(100, pp.scandalMeter + 10);
        mp.isCobra = true;
        mp.isBribedByPlayer = true;

        return {
            success: true,
            msg: `🐍 ${mp.name} is now a Cobra! They will permanently vote with you.`
        };
    },

    /**
     * EC Investigation check — runs when scandalMeter hits thresholds.
     */
    checkECInvestigation(gameState) {
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);

        if (pp.scandalMeter >= 100) {
            // Guaranteed investigation
            return this._triggerInvestigation(gameState, 'severe');
        }
        if (pp.scandalMeter >= 70) {
            // 40% chance of investigation
            if (Math.random() < 0.4) {
                return this._triggerInvestigation(gameState, 'moderate');
            }
        }
        if (pp.scandalMeter >= 40) {
            // 10% chance
            if (Math.random() < 0.1) {
                return this._triggerInvestigation(gameState, 'minor');
            }
        }
        return null;
    },

    _triggerInvestigation(gameState, severity) {
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
        let result;

        switch (severity) {
            case 'minor':
                pp.politicalCapital = Math.max(0, pp.politicalCapital - 50);
                pp.scandalMeter = Math.max(0, pp.scandalMeter - 15);
                result = { severity, msg: "EC issues a warning. -50 political capital.", gameOver: false };
                break;
            case 'moderate':
                pp.politicalCapital = Math.max(0, pp.politicalCapital - 150);
                pp.greyMoney = Math.max(0, pp.greyMoney - 100);
                pp.scandalMeter = Math.max(0, pp.scandalMeter - 30);
                result = { severity, msg: "EC investigation! Fined heavily. -150 capital, -100 grey money.", gameOver: false };
                break;
            case 'severe':
                result = {
                    severity,
                    msg: "🚨 PARTY DISSOLUTION! The Election Commission dissolves your party for corruption!",
                    gameOver: true
                };
                break;
        }
        return result;
    }
};


// ─── CRISIS ENGINE ───────────────────────────────────────────
window.Game.Engine.Crisis = {

    /**
     * Crisis categories and their templates.
     * severity: 'minor' | 'moderate' | 'severe'
     * Each crisis has 2 response options with different risk/reward.
     */
    CRISIS_TEMPLATES: [
        // ── WAR / SECURITY ──
        {
            category: 'war',
            icon: '⚔️',
            name: 'วิกฤตชายแดน',
            engName: 'Border Conflict',
            description: 'A neighboring country has mobilized troops near the Thai border. Tensions are escalating rapidly.',
            severity: 'severe',
            options: [
                {
                    label: '🛡️ Military Mobilization',
                    thaiLabel: 'ส่งทหารไปชายแดน',
                    description: 'Deploy military to the border region. Shows strength but risks escalation.',
                    successChance: 0.55,
                    successEffects: { popularityAll: +3, capital: +30, regions: { "Northeast": +5, "East": +4 } },
                    failEffects: { popularityAll: -4, capital: -60, regions: { "Northeast": -5, "Bangkok": -3 } }
                },
                {
                    label: '🕊️ Diplomatic Resolution',
                    thaiLabel: 'เจรจาทางการทูต',
                    description: 'Seek a peaceful solution through diplomacy. Slower but safer.',
                    successChance: 0.65,
                    successEffects: { popularityAll: +2, capital: +40, regions: { "Bangkok": +3 } },
                    failEffects: { popularityAll: -2, capital: -30, regions: { "South": -2 } }
                }
            ]
        },
        {
            category: 'war',
            icon: '🚢',
            name: 'วิกฤตทะเลจีนใต้',
            engName: 'South China Sea Tensions',
            description: 'Thai fishing boats have been seized by a foreign navy near disputed waters. Public outrage is growing.',
            severity: 'moderate',
            options: [
                {
                    label: '🚢 Send Naval Escort',
                    thaiLabel: 'ส่งกองทัพเรือคุ้มกัน',
                    description: 'Deploy naval vessels to protect fishing boats.',
                    successChance: 0.50,
                    successEffects: { popularityAll: +3, capital: +20, regions: { "South": +4, "East": +3 } },
                    failEffects: { popularityAll: -3, capital: -40, regions: { "South": -3 } }
                },
                {
                    label: '📋 File International Protest',
                    thaiLabel: 'ยื่นประท้วงระหว่างประเทศ',
                    description: 'Lodge formal protest through ASEAN channels.',
                    successChance: 0.70,
                    successEffects: { popularityAll: +1, capital: +25, regions: { "Bangkok": +2 } },
                    failEffects: { popularityAll: -1, capital: -15, regions: {} }
                }
            ]
        },

        // ── ECONOMIC ──
        {
            category: 'economic',
            icon: '📉',
            name: 'วิกฤตเศรษฐกิจ',
            engName: 'Economic Recession',
            description: 'GDP growth has turned negative. Unemployment is rising rapidly nationwide.',
            severity: 'severe',
            options: [
                {
                    label: '💸 Stimulus Package',
                    thaiLabel: 'แจกเงินกระตุ้นเศรษฐกิจ',
                    description: 'Launch a massive government spending stimulus.',
                    successChance: 0.50,
                    successEffects: { popularityAll: +4, capital: -40, regions: { "Northeast": +5, "North": +4, "Central": +3 } },
                    failEffects: { popularityAll: -3, capital: -80, regions: { "Bangkok": -4 } }
                },
                {
                    label: '🏦 Austerity Measures',
                    thaiLabel: 'รัดเข็มขัดการคลัง',
                    description: 'Cut government spending to stabilize finances.',
                    successChance: 0.60,
                    successEffects: { popularityAll: +1, capital: +60, regions: { "Bangkok": +3 } },
                    failEffects: { popularityAll: -4, capital: -20, regions: { "Northeast": -5, "North": -4 } }
                }
            ]
        },
        {
            category: 'economic',
            icon: '🛢️',
            name: 'วิกฤตราคาน้ำมัน',
            engName: 'Oil Price Crisis',
            description: 'Global oil prices have spiked 80%. Fuel costs are crushing businesses and commuters.',
            severity: 'moderate',
            options: [
                {
                    label: '⛽ Fuel Subsidy',
                    thaiLabel: 'อุดหนุนราคาน้ำมัน',
                    description: 'Subsidize fuel prices at state expense.',
                    successChance: 0.70,
                    successEffects: { popularityAll: +3, capital: -50, regions: { "Central": +2, "Northeast": +3 } },
                    failEffects: { popularityAll: -2, capital: -60, regions: {} }
                },
                {
                    label: '🚌 Public Transport Push',
                    thaiLabel: 'ขยายขนส่งสาธารณะ',
                    description: 'Invest in public transport and green energy instead.',
                    successChance: 0.55,
                    successEffects: { popularityAll: +2, capital: +20, regions: { "Bangkok": +4 } },
                    failEffects: { popularityAll: -2, capital: -30, regions: { "Northeast": -2 } }
                }
            ]
        },

        // ── SOCIAL ──
        {
            category: 'social',
            icon: '✊',
            name: 'วิกฤตการประท้วง',
            engName: 'Mass Protests',
            description: 'Tens of thousands of protesters occupy central Bangkok demanding government reform.',
            severity: 'severe',
            options: [
                {
                    label: '🏳️ Negotiate with Protesters',
                    thaiLabel: 'เจรจากับผู้ชุมนุม',
                    description: 'Open dialogue and offer concessions.',
                    successChance: 0.60,
                    successEffects: { popularityAll: +3, capital: +20, regions: { "Bangkok": +5, "Central": +3 } },
                    failEffects: { popularityAll: -2, capital: -30, regions: { "Bangkok": -3 } }
                },
                {
                    label: '🚔 Enforce Public Order',
                    thaiLabel: 'บังคับใช้กฎหมาย',
                    description: 'Deploy riot police to disperse protests peacefully.',
                    successChance: 0.40,
                    successEffects: { popularityAll: +1, capital: +30, regions: { "South": +3 } },
                    failEffects: { popularityAll: -5, capital: -50, scandal: +10, regions: { "Bangkok": -6, "Central": -3 } }
                }
            ]
        },
        {
            category: 'social',
            icon: '📱',
            name: 'วิกฤตข่าวปลอม',
            engName: 'Fake News Crisis',
            description: 'A viral disinformation campaign is spreading fear and dividing communities across social media.',
            severity: 'minor',
            options: [
                {
                    label: '🔍 Fact-Check Campaign',
                    thaiLabel: 'รณรงค์แก้ข่าวปลอม',
                    description: 'Launch government fact-checking initiative.',
                    successChance: 0.65,
                    successEffects: { popularityAll: +2, capital: +10, regions: { "Bangkok": +2 } },
                    failEffects: { popularityAll: -1, capital: -10, regions: {} }
                },
                {
                    label: '🔒 Regulate Platforms',
                    thaiLabel: 'ควบคุมแพลตฟอร์ม',
                    description: 'Force social media companies to remove fake content.',
                    successChance: 0.50,
                    successEffects: { popularityAll: +1, capital: +20, regions: {} },
                    failEffects: { popularityAll: -2, capital: -15, scandal: +3, regions: { "Bangkok": -3 } }
                }
            ]
        },

        // ── COALITION ──
        {
            category: 'coalition',
            icon: '🤝',
            name: 'วิกฤตพรรคร่วม',
            engName: 'Coalition Split Threat',
            description: 'A coalition partner threatens to leave over policy disagreements and ministry demands.',
            severity: 'moderate',
            options: [
                {
                    label: '🎁 Offer Concessions',
                    thaiLabel: 'เสนอผลประโยชน์เพิ่ม',
                    description: 'Give them another ministry seat and budget allocation.',
                    successChance: 0.75,
                    successEffects: { popularityAll: +1, capital: -30, regions: {} },
                    failEffects: { popularityAll: -2, capital: -50, regions: {} }
                },
                {
                    label: '💪 Call Their Bluff',
                    thaiLabel: 'ท้าให้ออก',
                    description: 'Refuse concessions and dare them to leave.',
                    successChance: 0.45,
                    successEffects: { popularityAll: +3, capital: +30, regions: { "Bangkok": +2 } },
                    failEffects: { popularityAll: -4, capital: -40, regions: { "Central": -3 } }
                }
            ]
        },
        {
            category: 'coalition',
            icon: '💔',
            name: 'วิกฤตการแย่งกระทรวง',
            engName: 'Ministry Turf War',
            description: 'Two coalition partners both want control of a lucrative ministry. Both threaten to leave.',
            severity: 'minor',
            options: [
                {
                    label: '⚖️ Create New Ministry',
                    thaiLabel: 'ตั้งกระทรวงใหม่',
                    description: 'Create a new government body to satisfy both.',
                    successChance: 0.60,
                    successEffects: { popularityAll: +1, capital: -20, regions: {} },
                    failEffects: { popularityAll: -1, capital: -30, scandal: +3, regions: {} }
                },
                {
                    label: '🗳️ Let PM Decide',
                    thaiLabel: 'นายกฯ ตัดสิน',
                    description: 'The PM makes the final decision unilaterally.',
                    successChance: 0.55,
                    successEffects: { popularityAll: +2, capital: +15, regions: {} },
                    failEffects: { popularityAll: -2, capital: -15, regions: {} }
                }
            ]
        },

        // ── CRIME ──
        {
            category: 'crime',
            icon: '🔫',
            name: 'วิกฤตอาชญากรรม',
            engName: 'Crime Wave',
            description: 'A sharp rise in violent crime across major cities has the public demanding action.',
            severity: 'moderate',
            options: [
                {
                    label: '🚨 Massive Police Crackdown',
                    thaiLabel: 'ปราบปรามเข้มงวด',
                    description: 'Deploy extra police and empower law enforcement.',
                    successChance: 0.55,
                    successEffects: { popularityAll: +3, capital: +20, regions: { "Bangkok": +4, "Central": +3 } },
                    failEffects: { popularityAll: -2, capital: -30, scandal: +5, regions: { "Bangkok": -3 } }
                },
                {
                    label: '🏫 Root Cause Programs',
                    thaiLabel: 'แก้ปัญหารากฐาน',
                    description: 'Invest in education and jobs in high-crime areas.',
                    successChance: 0.60,
                    successEffects: { popularityAll: +2, capital: -20, regions: { "Northeast": +3, "North": +2 } },
                    failEffects: { popularityAll: -2, capital: -25, regions: {} }
                }
            ]
        },
        {
            category: 'crime',
            icon: '💊',
            name: 'วิกฤตยาเสพติด',
            engName: 'Drug Trafficking Crisis',
            description: 'A major drug network has been uncovered operating across the northern border.',
            severity: 'moderate',
            options: [
                {
                    label: '🎯 Special Operations',
                    thaiLabel: 'ปฏิบัติการพิเศษ',
                    description: 'Launch targeted raids against drug kingpins.',
                    successChance: 0.50,
                    successEffects: { popularityAll: +3, capital: +25, regions: { "North": +5, "Northeast": +3 } },
                    failEffects: { popularityAll: -2, capital: -35, scandal: +5, regions: { "North": -3 } }
                },
                {
                    label: '🤝 International Cooperation',
                    thaiLabel: 'ร่วมมือต่างประเทศ',
                    description: 'Work with neighboring countries to shut down supply routes.',
                    successChance: 0.65,
                    successEffects: { popularityAll: +2, capital: +15, regions: { "North": +3 } },
                    failEffects: { popularityAll: -1, capital: -15, regions: {} }
                }
            ]
        },

        // ── DISASTER ──
        {
            category: 'disaster',
            icon: '🌊',
            name: 'วิกฤตน้ำท่วม',
            engName: 'Catastrophic Flooding',
            description: 'Massive floods have devastated central Thailand. Hundreds of thousands are displaced.',
            severity: 'severe',
            options: [
                {
                    label: '🚁 Emergency Mobilization',
                    thaiLabel: 'ระดมช่วยเหลือฉุกเฉิน',
                    description: 'Mobilize military and agencies for rescue and relief.',
                    successChance: 0.55,
                    successEffects: { popularityAll: +4, capital: -40, regions: { "Central": +6, "Northeast": +4 } },
                    failEffects: { popularityAll: -4, capital: -60, regions: { "Central": -5, "Bangkok": -4 } }
                },
                {
                    label: '💰 Compensation Fund',
                    thaiLabel: 'ตั้งกองทุนชดเชย',
                    description: 'Set up immediate cash compensation for victims.',
                    successChance: 0.65,
                    successEffects: { popularityAll: +3, capital: -50, regions: { "Central": +4, "Northeast": +3 } },
                    failEffects: { popularityAll: -2, capital: -40, scandal: +3, regions: { "Central": -3 } }
                }
            ]
        },
        {
            category: 'disaster',
            icon: '🌋',
            name: 'วิกฤตมลพิษ PM2.5',
            engName: 'PM2.5 Haze Crisis',
            description: 'Northern Thailand is choking on toxic haze from forest fires. Air quality is dangerously bad.',
            severity: 'moderate',
            options: [
                {
                    label: '🚒 Emergency Fire Fighting',
                    thaiLabel: 'ดับไฟป่าฉุกเฉิน',
                    description: 'Deploy resources to fight forest fires immediately.',
                    successChance: 0.60,
                    successEffects: { popularityAll: +2, capital: -25, regions: { "North": +5, "Bangkok": +2 } },
                    failEffects: { popularityAll: -2, capital: -30, regions: { "North": -4 } }
                },
                {
                    label: '📋 Long-term Burn Ban',
                    thaiLabel: 'ประกาศห้ามเผาถาวร',
                    description: 'Implement strict burn ban and enforcement.',
                    successChance: 0.50,
                    successEffects: { popularityAll: +2, capital: +15, regions: { "North": +4 } },
                    failEffects: { popularityAll: -2, capital: -20, regions: { "North": -3, "Northeast": -2 } }
                }
            ]
        },

        // ── PARLIAMENT ──
        {
            category: 'parliament',
            icon: '🏛️',
            name: 'วิกฤตรัฐสภา',
            engName: 'Parliamentary Deadlock',
            description: 'The opposition is filibustering all legislation. No bills can pass. Public frustration grows.',
            severity: 'moderate',
            options: [
                {
                    label: '🤝 Cross-Party Summit',
                    thaiLabel: 'ประชุมข้ามพรรค',
                    description: 'Hold an all-party summit to find common ground.',
                    successChance: 0.60,
                    successEffects: { popularityAll: +2, capital: +30, regions: { "Bangkok": +3 } },
                    failEffects: { popularityAll: -2, capital: -20, regions: {} }
                },
                {
                    label: '📺 Public Pressure Campaign',
                    thaiLabel: 'กดดันผ่านสาธารณะ',
                    description: 'Go to the media and blame the opposition publicly.',
                    successChance: 0.50,
                    successEffects: { popularityAll: +3, capital: +10, regions: { "Bangkok": +2, "Central": +2 } },
                    failEffects: { popularityAll: -3, capital: -25, regions: { "Bangkok": -2 } }
                }
            ]
        },
        {
            category: 'parliament',
            icon: '📰',
            name: 'เรื่องอื้อฉาวในสภา',
            engName: 'Parliament Scandal',
            description: 'A leaked video shows coalition MPs in a corruption scandal. The media is in frenzy.',
            severity: 'moderate',
            options: [
                {
                    label: '⚖️ Expel Corrupt MPs',
                    thaiLabel: 'ขับ สส. ที่ทุจริต',
                    description: 'Immediately expel the involved MPs from the coalition.',
                    successChance: 0.70,
                    successEffects: { popularityAll: +3, capital: +20, scandal: -10, regions: { "Bangkok": +3 } },
                    failEffects: { popularityAll: -1, capital: -20, scandal: +5, regions: {} }
                },
                {
                    label: '🤫 Cover It Up',
                    thaiLabel: 'ปิดข่าว',
                    description: 'Use political influence to suppress the story.',
                    successChance: 0.35,
                    successEffects: { popularityAll: +1, capital: +10, regions: {} },
                    failEffects: { popularityAll: -5, capital: -40, scandal: +15, regions: { "Bangkok": -5, "Central": -3 } }
                }
            ]
        }
    ],

    calculateGovernmentStress(gameState) {
        const pp = (gameState.parties || []).find(p => p.id === gameState.playerPartyId);
        const scandal = pp ? (pp.scandalMeter || 0) : 0;
        const scandalPoints = Math.max(0, Math.floor(scandal / 20));
        const outcomes = Array.isArray(gameState.governmentBillOutcomeHistory)
            ? gameState.governmentBillOutcomeHistory
            : [];
        const recent = outcomes.slice(-5);
        const failedBillPoints = Math.min(4, recent.filter(x => x === false).length);
        const streakBonus = (gameState.governmentFailedBillStreak || 0) >= 3 ? 2 : 0;
        return {
            scandalPoints,
            failedBillPoints,
            streakBonus,
            total: scandalPoints + failedBillPoints + streakBonus
        };
    },

    _getGovernmentChainType(stress) {
        if ((stress.scandalPoints || 0) >= (stress.failedBillPoints || 0) + 1) return 'resignation';
        if ((stress.failedBillPoints || 0) >= (stress.scandalPoints || 0) + 1) return 'coalition_panic';
        return 'snap_reform';
    },

    _buildGovernmentCrisisChain(type, totalSteps) {
        const chains = {
            resignation: [
                {
                    category: 'parliament',
                    icon: '🧾',
                    name: 'แรงกดดันให้ปรับ ครม.',
                    engName: 'Resignation Pressure',
                    description: 'Public anger over scandals is surging. Coalition elders demand immediate resignations.',
                    severity: 'moderate',
                    options: [
                        {
                            label: '🔄 Reshuffle the cabinet now',
                            thaiLabel: 'ปรับคณะรัฐมนตรีทันที',
                            description: 'Cut loose tainted ministers to contain damage quickly.',
                            successChance: 0.62,
                            successEffects: { popularityAll: +1, capital: -20, scandal: -8, regions: { "Bangkok": +2 } },
                            failEffects: { popularityAll: -2, capital: -35, scandal: +5, regions: { "Bangkok": -2 } }
                        },
                        {
                            label: '🧱 Defend current ministers',
                            thaiLabel: 'ปกป้องรัฐมนตรีชุดเดิม',
                            description: 'Project unity and reject opposition pressure.',
                            successChance: 0.45,
                            successEffects: { popularityAll: +1, capital: +10, regions: { "South": +1 } },
                            failEffects: { popularityAll: -3, capital: -25, scandal: +8, regions: { "Bangkok": -3, "Central": -2 } }
                        }
                    ]
                },
                {
                    category: 'social',
                    icon: '📣',
                    name: 'ข้อเรียกร้องลาออกของนายกฯ',
                    engName: 'PM Resignation Calls',
                    description: 'Street rallies now demand the PM step down after weeks of scandal headlines.',
                    severity: 'severe',
                    options: [
                        {
                            label: '🗣️ Announce anti-corruption reset',
                            thaiLabel: 'ประกาศรีเซ็ตต้านคอร์รัปชัน',
                            description: 'Launch an emergency cleanup package and transparency pledge.',
                            successChance: 0.58,
                            successEffects: { popularityAll: +2, capital: -25, scandal: -10, regions: { "Bangkok": +2, "Central": +2 } },
                            failEffects: { popularityAll: -2, capital: -30, scandal: +6, regions: { "Bangkok": -2 } }
                        },
                        {
                            label: '📺 Counterattack in media',
                            thaiLabel: 'โต้กลับผ่านสื่อ',
                            description: 'Blame rivals for politicizing investigations.',
                            successChance: 0.4,
                            successEffects: { popularityAll: +1, capital: +15, regions: { "South": +2 } },
                            failEffects: { popularityAll: -3, capital: -20, scandal: +7, regions: { "Bangkok": -3 } }
                        }
                    ]
                },
                {
                    category: 'coalition',
                    icon: '🗳️',
                    name: 'มติไว้วางใจผู้นำรัฐบาล',
                    engName: 'Leadership Confidence Vote',
                    description: 'Coalition leaders demand a final confidence vote to keep the government together.',
                    severity: 'severe',
                    options: [
                        {
                            label: '🤝 Trade reforms for support',
                            thaiLabel: 'แลกปฏิรูปกับเสียงสนับสนุน',
                            description: 'Accept painful reforms to preserve coalition unity.',
                            successChance: 0.6,
                            successEffects: { popularityAll: +1, capital: -30, scandal: -6, regions: { "Central": +1 } },
                            failEffects: { popularityAll: -3, capital: -35, scandal: +6, regions: { "Central": -2 } }
                        },
                        {
                            label: '💪 Force party discipline',
                            thaiLabel: 'บังคับวินัยพรรคร่วม',
                            description: 'Use hard power to keep coalition MPs in line.',
                            successChance: 0.42,
                            successEffects: { popularityAll: +1, capital: +5, regions: { "South": +1 } },
                            failEffects: { popularityAll: -4, capital: -30, scandal: +8, regions: { "Bangkok": -2, "Central": -2 } }
                        }
                    ]
                }
            ],
            snap_reform: [
                {
                    category: 'parliament',
                    icon: '📜',
                    name: 'แรงกดดันปฏิรูปเร่งด่วน',
                    engName: 'Snap Reform Pressure',
                    description: 'Legislative failures and scandals are converging. The public demands immediate reform bills.',
                    severity: 'moderate',
                    options: [
                        {
                            label: '⚡ Fast-track reform package',
                            thaiLabel: 'เร่งรัดแพ็กเกจปฏิรูป',
                            description: 'Push a compact reform package through committee overnight.',
                            successChance: 0.57,
                            successEffects: { popularityAll: +2, capital: -35, scandal: -4, regions: { "Bangkok": +2, "Central": +1 } },
                            failEffects: { popularityAll: -2, capital: -25, scandal: +3, regions: { "Bangkok": -2 } }
                        },
                        {
                            label: '🧪 Pilot reforms in key regions',
                            thaiLabel: 'ทดลองปฏิรูปเฉพาะพื้นที่',
                            description: 'Run pilots before national rollout to reduce backlash.',
                            successChance: 0.64,
                            successEffects: { popularityAll: +1, capital: -20, regions: { "Bangkok": +1, "Central": +1 } },
                            failEffects: { popularityAll: -1, capital: -20, regions: { "Northeast": -1 } }
                        }
                    ]
                },
                {
                    category: 'social',
                    icon: '🏗️',
                    name: 'แรงต้านต่อการปฏิรูป',
                    engName: 'Reform Backlash',
                    description: 'Key groups resist implementation and threaten coordinated protests.',
                    severity: 'moderate',
                    options: [
                        {
                            label: '🫱 Build cross-sector pact',
                            thaiLabel: 'ทำข้อตกลงข้ามภาคส่วน',
                            description: 'Negotiate phased implementation with labor and business groups.',
                            successChance: 0.62,
                            successEffects: { popularityAll: +2, capital: -20, regions: { "Bangkok": +1, "Central": +1 } },
                            failEffects: { popularityAll: -2, capital: -20, scandal: +2, regions: { "Bangkok": -2 } }
                        },
                        {
                            label: '📢 Push through by mandate',
                            thaiLabel: 'ดันต่อโดยอ้างฉันทามติ',
                            description: 'Frame reform as non-negotiable national interest.',
                            successChance: 0.46,
                            successEffects: { popularityAll: +1, capital: +5, regions: { "South": +1 } },
                            failEffects: { popularityAll: -3, capital: -15, regions: { "Bangkok": -2, "Central": -1 } }
                        }
                    ]
                },
                {
                    category: 'parliament',
                    icon: '🧩',
                    name: 'ดีลสุดท้ายปฏิรูป',
                    engName: 'Final Reform Bargain',
                    description: 'A final parliamentary bargain can lock in reforms or collapse momentum.',
                    severity: 'severe',
                    options: [
                        {
                            label: '🤲 Offer transparent compromise',
                            thaiLabel: 'เสนอประนีประนอมโปร่งใส',
                            description: 'Concede some points publicly to secure durable support.',
                            successChance: 0.6,
                            successEffects: { popularityAll: +2, capital: -25, scandal: -4, regions: { "Bangkok": +1, "Central": +1 } },
                            failEffects: { popularityAll: -2, capital: -20, regions: { "Bangkok": -1 } }
                        },
                        {
                            label: '🗂️ Delay and regroup',
                            thaiLabel: 'ชะลอเพื่อรวบรวมเสียงใหม่',
                            description: 'Delay the vote to avoid a public collapse.',
                            successChance: 0.5,
                            successEffects: { popularityAll: +1, capital: +10, regions: {} },
                            failEffects: { popularityAll: -3, capital: -10, regions: { "Central": -1 } }
                        }
                    ]
                }
            ],
            coalition_panic: [
                {
                    category: 'coalition',
                    icon: '🧨',
                    name: 'แรงสั่นคลอนพรรคร่วม',
                    engName: 'Coalition Panic',
                    description: 'Repeated failed bills trigger panic among coalition partners and ministry factions.',
                    severity: 'moderate',
                    options: [
                        {
                            label: '🎁 Offer emergency concessions',
                            thaiLabel: 'ยื่นข้อเสนอฉุกเฉิน',
                            description: 'Offer budget and committee concessions to stabilize partners.',
                            successChance: 0.68,
                            successEffects: { popularityAll: +1, capital: -30, regions: { "Central": +1 } },
                            failEffects: { popularityAll: -2, capital: -35, regions: { "Central": -1 } }
                        },
                        {
                            label: '🧭 Replace key negotiators',
                            thaiLabel: 'เปลี่ยนทีมเจรจา',
                            description: 'Swap coalition managers to reset trust dynamics.',
                            successChance: 0.52,
                            successEffects: { popularityAll: +1, capital: -15, regions: {} },
                            failEffects: { popularityAll: -2, capital: -20, regions: { "Bangkok": -1 } }
                        }
                    ]
                },
                {
                    category: 'parliament',
                    icon: '📉',
                    name: 'เสียงโหวตหลุดจากวินัยพรรค',
                    engName: 'Whip Breakdown',
                    description: 'Coalition MPs are openly rebelling in parliamentary votes.',
                    severity: 'severe',
                    options: [
                        {
                            label: '📋 Enforce strict voting whip',
                            thaiLabel: 'บังคับวินัยการโหวตเข้มงวด',
                            description: 'Use formal sanctions to force attendance and discipline.',
                            successChance: 0.55,
                            successEffects: { popularityAll: +1, capital: -20, regions: { "South": +1 } },
                            failEffects: { popularityAll: -3, capital: -25, scandal: +4, regions: { "Bangkok": -2 } }
                        },
                        {
                            label: '🫱 Negotiate district by district',
                            thaiLabel: 'เจรจารายเขต',
                            description: 'Broker tailored district commitments to recover votes.',
                            successChance: 0.58,
                            successEffects: { popularityAll: +1, capital: -25, regions: { "Central": +1 } },
                            failEffects: { popularityAll: -2, capital: -25, regions: { "Central": -1 } }
                        }
                    ]
                },
                {
                    category: 'coalition',
                    icon: '💥',
                    name: 'ขีดสุดวิกฤตพรรคร่วม',
                    engName: 'Coalition Breaking Point',
                    description: 'One partner threatens to walk out unless a final deal is reached immediately.',
                    severity: 'severe',
                    options: [
                        {
                            label: '🪙 Buy time with final compromise',
                            thaiLabel: 'ประนีประนอมรอบสุดท้าย',
                            description: 'Pay a heavy political cost to hold coalition together.',
                            successChance: 0.6,
                            successEffects: { popularityAll: +1, capital: -35, regions: {} },
                            failEffects: { popularityAll: -3, capital: -35, regions: {}, dropWeakestPartner: true }
                        },
                        {
                            label: '🧱 Refuse and call the bluff',
                            thaiLabel: 'ปฏิเสธและท้าให้ออก',
                            description: 'Refuse concessions and force a showdown.',
                            successChance: 0.4,
                            successEffects: { popularityAll: +2, capital: +10, regions: { "Bangkok": +1 } },
                            failEffects: { popularityAll: -4, capital: -25, scandal: +4, regions: { "Bangkok": -2 }, dropWeakestPartner: true }
                        }
                    ]
                }
            ]
        };

        const selected = chains[type] || chains.snap_reform;
        const steps = selected.slice(0, Math.max(1, Math.min(3, totalSteps)));
        return steps.map((step, idx) => ({
            ...step,
            isGovernmentChain: true,
            chainType: type,
            chainStep: idx + 1,
            chainTotalSteps: steps.length,
            options: step.options.map(o => ({ ...o }))
        }));
    },

    maybeStartGovernmentCrisisChain(gameState, stress = null, threshold = 5) {
        const chain = gameState.governmentCrisisChain;
        if (chain && chain.active) {
            return this.getActiveGovernmentChainCrisis(gameState);
        }

        const computedStress = stress || this.calculateGovernmentStress(gameState);
        if (!computedStress || (computedStress.total || 0) < threshold) return null;

        const chainType = this._getGovernmentChainType(computedStress);
        const totalSteps = (computedStress.total || 0) >= 8 ? 3 : 2;
        const steps = this._buildGovernmentCrisisChain(chainType, totalSteps);
        if (!steps || steps.length === 0) return null;

        gameState.governmentCrisisChain = {
            id: `gov_chain_${Date.now()}`,
            type: chainType,
            active: true,
            currentStep: 1,
            totalSteps: steps.length,
            steps,
            startedYear: gameState.parliamentYear || 1
        };

        return this.getActiveGovernmentChainCrisis(gameState);
    },

    getActiveGovernmentChainCrisis(gameState) {
        const chain = gameState.governmentCrisisChain;
        if (!chain || !chain.active) return null;
        const idx = Math.max(0, (chain.currentStep || 1) - 1);
        if (!Array.isArray(chain.steps) || idx >= chain.steps.length) {
            chain.active = false;
            return null;
        }
        const step = chain.steps[idx];
        return {
            ...step,
            options: (step.options || []).map(o => ({ ...o })),
            chainStep: idx + 1,
            chainTotalSteps: chain.totalSteps || chain.steps.length,
            chainType: chain.type,
            isGovernmentChain: true
        };
    },

    _applySpecialCrisisEffects(gameState, effects, result) {
        if (!effects || !effects.dropWeakestPartner) return;
        const coalitionIds = Array.isArray(gameState.coalitionPartyIds) ? [...gameState.coalitionPartyIds] : [];
        if (coalitionIds.length <= 1) return;

        const totalSeats = (gameState.electionResults && gameState.electionResults.totalSeats) || {};
        let weakest = null;
        for (const pid of coalitionIds) {
            if (pid === gameState.playerPartyId) continue;
            const seats = totalSeats[pid] || 0;
            if (!weakest || seats < weakest.seats) weakest = { pid, seats };
        }
        if (!weakest) return;

        gameState.coalitionPartyIds = coalitionIds.filter(pid => pid !== weakest.pid);
        if (!Array.isArray(result.specialNotes)) result.specialNotes = [];
        result.specialNotes.push(`Coalition panic: ${weakest.pid} withdrew from government support.`);
    },

    /**
     * Generate a random crisis event. Called during advanceYear.
     * Returns null if no crisis happens (based on probability).
     */
    generateCrisis(gameState, chance = 0.70) {
        // Default: 70% chance a crisis occurs each year
        if (Math.random() > chance) return null;

        // Pick a random crisis
        const templates = this.CRISIS_TEMPLATES;
        let crisis = templates[Math.floor(Math.random() * templates.length)];

        // Don't repeat the same crisis in consecutive years
        if (gameState._lastCrisisName === crisis.engName) {
            // Pick a different one
            const filtered = templates.filter(c => c.engName !== crisis.engName);
            if (filtered.length > 0) {
                crisis = filtered[Math.floor(Math.random() * filtered.length)];
            }
        }

        gameState._lastCrisisName = crisis.engName;
        return { ...crisis, options: crisis.options.map(o => ({ ...o })) };
    },

    /**
     * Resolve a crisis based on the player's chosen option.
     * @param {Object} gameState
     * @param {Object} crisis - The crisis template
     * @param {number} optionIndex - 0 or 1
     * @returns {Object} Result with success/fail, effects applied, and message
     */
    resolveCrisis(gameState, crisis, optionIndex) {
        const option = crisis.options[optionIndex];
        const pp = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const roll = Math.random();
        const success = roll < option.successChance;

        const effects = success ? option.successEffects : option.failEffects;
        const result = {
            success,
            crisisName: crisis.engName,
            crisisIcon: crisis.icon,
            choiceName: option.label,
            choiceThaiLabel: option.thaiLabel,
            popularityChanges: {},
            capitalChange: 0,
            scandalChange: 0
        };

        // Apply base popularity change
        if (effects.popularityAll) {
            pp.basePopularity = Math.max(1, pp.basePopularity + effects.popularityAll);
            result.popularityChanges['National'] = effects.popularityAll;
        }

        // Apply capital change
        if (effects.capital) {
            pp.politicalCapital = Math.max(0, pp.politicalCapital + effects.capital);
            result.capitalChange = effects.capital;
        }

        // Apply scandal change
        if (effects.scandal) {
            pp.scandalMeter = Math.max(0, Math.min(100, pp.scandalMeter + effects.scandal));
            result.scandalChange = effects.scandal;
        }

        // Apply regional popularity changes
        if (effects.regions) {
            for (const [region, change] of Object.entries(effects.regions)) {
                if (pp.regionalPopMod[region] !== undefined) {
                    pp.regionalPopMod[region] += change;
                } else {
                    pp.regionalPopMod[region] = change;
                }
                result.popularityChanges[region] = change;
            }
        }

        this._applySpecialCrisisEffects(gameState, effects, result);

        if (crisis.isGovernmentChain) {
            const chain = gameState.governmentCrisisChain;
            if (chain && chain.active) {
                const chainStep = Math.max(1, chain.currentStep || 1);
                result.chainStep = chainStep;
                result.chainTotalSteps = chain.totalSteps || (Array.isArray(chain.steps) ? chain.steps.length : 1);
                result.chainType = chain.type;

                if (chainStep < result.chainTotalSteps) {
                    chain.currentStep = chainStep + 1;
                    result.chainHasNext = true;
                } else {
                    chain.active = false;
                    result.chainCompleted = true;
                }
            }
        }

        return result;
    }
};
