/* eslint-disable no-console */
const path = require('path');

function load(relativePath) {
    require(path.join(__dirname, '..', relativePath));
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createTestRandom(seed) {
    const stateful = window.Game.Core.RNG.createStateful(seed);
    const roll = () => stateful.roll();
    roll.getState = stateful.getState;
    roll.setState = stateful.setState;
    roll.getSeed = stateful.getSeed;
    return roll;
}

function loadRuntime() {
    global.window = global.window || {};
    window.Game = window.Game || {};

    load('core/rng.js');
    load('core/event-bus.js');
    load('core/state-machine.js');
    load('data/provinces.js');
    load('data/parties.js');
    load('models.js');
    load('engine.js');
}

function buildElectionState(seed) {
    const setupRandom = createTestRandom(seed);
    const parties = window.Game.Data.PARTIES.slice(0, 4).map(p => ({
        id: p.id,
        thaiName: p.thaiName,
        shortName: p.shortName,
        hexColor: p.hexColor,
        basePopularity: p.basePopularity,
        banYaiPower: p.banYaiPower || 0,
        regionalBanYai: { ...(p.regionalBanYai || {}) },
        provincialBanYai: { ...(p.provincialBanYai || {}) },
        regionalPopMod: { ...(p.regionalPopMod || {}) },
        politicalCapital: p.politicalCapital || 0,
        greyMoney: p.greyMoney || 0,
        scandalMeter: p.scandalMeter || 0,
        ideology: p.ideology || 50,
        partyListVoteWeight: 1
    }));

    const districts = [];
    const partyMPs = {};
    for (const party of parties) {
        partyMPs[party.id] = [];
    }

    const provinceRows = Object.entries(window.Game.Data.PROVINCES).slice(0, 16);
    let districtId = 1;
    for (const [provinceName, seats] of provinceRows) {
        const region = window.Game.Data.PROVINCE_REGION[provinceName] || 'Central';
        const seatCount = Math.max(1, Math.min(2, seats));
        for (let seatIndex = 1; seatIndex <= seatCount; seatIndex++) {
            const localLeanings = {};
            for (const party of parties) {
                localLeanings[party.id] = Math.round((setupRandom() - 0.5) * 8);
            }

            districts.push(new window.Game.Models.District({
                id: districtId,
                provinceName,
                seatIndex,
                region,
                localLeanings
            }));
            districtId += 1;
        }
    }

    for (const district of districts) {
        for (const party of parties) {
            partyMPs[party.id].push(new window.Game.Models.MP({
                name: `${party.id}-${district.id}`,
                partyId: party.id,
                ideology: party.ideology,
                loyaltyToParty: 65,
                corruptionLevel: 20,
                districtId: district.id,
                isPartyList: false,
                localPopularity: 1 + Math.floor(setupRandom() * 25)
            }));
        }
    }

    for (const party of parties) {
        for (let i = 0; i < 120; i++) {
            partyMPs[party.id].push(new window.Game.Models.MP({
                name: `${party.id}-list-${i}`,
                partyId: party.id,
                ideology: party.ideology,
                loyaltyToParty: 70,
                corruptionLevel: 20,
                isPartyList: true,
                localPopularity: 1
            }));
        }
    }

    const random = createTestRandom(seed);

    return {
        parties,
        districts,
        partyMPs,
        random
    };
}

function testDeterministicElection() {
    const a = buildElectionState(20260422);
    const b = buildElectionState(20260422);

    const r1 = window.Game.Engine.Election.runElection(a);
    const r2 = window.Game.Engine.Election.runElection(b);

    const totals1 = JSON.stringify(r1.totalSeats);
    const totals2 = JSON.stringify(r2.totalSeats);
    assert(totals1 === totals2, 'Election results should be deterministic with the same seed.');
}

function testCampaignActionContracts() {
    const seed = createTestRandom(77);
    const parties = window.Game.Data.PARTIES.slice(0, 3).map(p => ({
        id: p.id,
        thaiName: p.thaiName,
        shortName: p.shortName,
        basePopularity: p.basePopularity,
        regionalPopMod: { ...(p.regionalPopMod || {}) },
        banYaiPower: p.banYaiPower || 0,
        politicalCapital: 100,
        greyMoney: 100,
        scandalMeter: 0,
        ideology: p.ideology || 50
    }));

    const provinceName = Object.keys(window.Game.Data.PROVINCES)[0];
    const region = window.Game.Data.PROVINCE_REGION[provinceName];
    const districts = [new window.Game.Models.District({
        id: 999,
        provinceName,
        seatIndex: 1,
        region,
        localLeanings: { [parties[0].id]: 0, [parties[1].id]: 0, [parties[2].id]: 0 }
    })];

    const state = {
        playerPartyId: parties[0].id,
        parties,
        districts,
        campaignPromises: [],
        actionPoints: 10,
        electionResults: { totalSeats: {} },
        random: seed
    };

    const fundraise = window.Game.Engine.Campaign.ACTIONS.fundraise.execute(state);
    assert(typeof fundraise === 'object' && fundraise.success === true, 'Fundraise must return a success object.');
    assert(typeof fundraise.message === 'string' && fundraise.message.length > 0, 'Fundraise must include a message.');

    const canvassFail = window.Game.Engine.Campaign.ACTIONS.canvass.execute(state, { districtId: -1 });
    assert(typeof canvassFail === 'object' && canvassFail.success === false, 'Canvass failure should return { success: false }.');

    const promise = window.Game.Data.PROMISE_TEMPLATES[0];
    const promiseOk = window.Game.Engine.Campaign.ACTIONS.promisePolicy.execute(state, { promise });
    const promiseDup = window.Game.Engine.Campaign.ACTIONS.promisePolicy.execute(state, { promise });
    assert(promiseOk.success === true, 'Promise policy should succeed on first pick.');
    assert(promiseDup.success === false, 'Promise policy should fail on duplicate pick.');
}

function testLobbyResourceGuards() {
    const parties = window.Game.Data.PARTIES.slice(0, 2).map(p => ({
        id: p.id,
        thaiName: p.thaiName,
        politicalCapital: 10,
        greyMoney: 10,
        scandalMeter: 0
    }));

    const state = {
        playerPartyId: parties[0].id,
        parties,
        seatedMPs: [new window.Game.Models.MP({
            id: 6001,
            name: 'Target MP',
            partyId: parties[1].id,
            ideology: 50,
            loyaltyToParty: 50,
            corruptionLevel: 60,
            localPopularity: 10
        })],
        coalitionPartyIds: [parties[0].id, parties[1].id]
    };

    const beforeCapital = parties[0].politicalCapital;
    const beforeGrey = parties[0].greyMoney;

    const quid = window.Game.Engine.Parliament.lobbyActions.quidProQuo.execute(state, parties[1].id);
    const whip = window.Game.Engine.Parliament.lobbyActions.whip.execute(state);
    const bribe = window.Game.Engine.Parliament.lobbyActions.bribe.execute(state, 6001);

    assert(typeof quid === 'string' && quid.toLowerCase().includes('not enough'), 'Quid pro quo should fail when capital is low.');
    assert(typeof whip === 'string' && whip.toLowerCase().includes('not enough'), 'Whip should fail when capital is low.');
    assert(typeof bribe === 'string' && bribe.toLowerCase().includes('not enough'), 'Bribe should fail when grey money is low.');
    assert(parties[0].politicalCapital === beforeCapital, 'Capital must not change on failed lobby actions.');
    assert(parties[0].greyMoney === beforeGrey, 'Grey money must not change on failed bribe.');
}

function testCoalitionEventAuthoritativeResolution() {
    const parties = window.Game.Data.PARTIES.slice(0, 2).map(p => ({
        id: p.id,
        thaiName: p.thaiName,
        politicalCapital: 120,
        greyMoney: 0,
        scandalMeter: 8,
        basePopularity: p.basePopularity,
        regionalPopMod: { ...(p.regionalPopMod || {}) },
        ideology: p.ideology || 50
    }));

    const playerId = parties[0].id;
    const partnerId = parties[1].id;
    const eventTemplate = clone(window.Game.Engine.Parliament.COALITION_EVENT_TEMPLATES.find(t => t.id === 'partner_walkout_threat'));

    const state = {
        playerPartyId: playerId,
        parties,
        coalitionPartyIds: [playerId, partnerId],
        coalitionSatisfaction: {
            [partnerId]: {
                score: 18,
                demands: [],
                lastEventSession: 0,
                totalDemandsMet: 0,
                totalDemandsFailed: 0
            }
        },
        coalitionSatisfactionHistory: {},
        cabinetPortfolioState: {
            assignments: {
                Interior: partnerId,
                Finance: null,
                Defense: null,
                'Foreign Affairs': null
            },
            finalized: true,
            finalizedSession: 1
        },
        electionResults: {
            totalSeats: {
                [playerId]: 260,
                [partnerId]: 40
            }
        },
        sessionNumber: 3,
        parliamentYear: 2,
        pendingCoalitionEvents: [{ partyId: partnerId, event: eventTemplate }],
        random: () => 0
    };

    const result = window.Game.Engine.Parliament.resolveCoalitionEvent(state, partnerId, eventTemplate, 1);
    assert(result && result.applied === true, 'Coalition event should resolve through the engine.');
    assert(result.walkoutTriggered === true, 'Risk walkout branch should trigger with deterministic low roll.');
    assert(!state.coalitionPartyIds.includes(partnerId), 'Walkout should remove partner from coalition.');
}

function run() {
    loadRuntime();

    testDeterministicElection();
    testCampaignActionContracts();
    testLobbyResourceGuards();
    testCoalitionEventAuthoritativeResolution();

    console.log('Smoke checks passed.');
}

try {
    run();
} catch (error) {
    console.error('Smoke check failed:', error.message);
    process.exitCode = 1;
}
