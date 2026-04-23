// ============================================================
// DATA MODELS — MP, Party, District, Bill
// ============================================================
window.Game = window.Game || {};
window.Game.Models = {};

function _resolveRoll(rollFn) {
  return (typeof rollFn === 'function') ? rollFn : Math.random;
}

function _toFiniteInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

// ─── MP (Member of Parliament) ───────────────────────────────
let mpIdCounter = 0;
class MP {
    constructor(opts) {
  opts = opts || {};
  const roll = _resolveRoll(opts.rollFn);
    const explicitId = (opts && Object.prototype.hasOwnProperty.call(opts, 'id')) ? opts.id : null;
    const numericId = _toFiniteInt(explicitId);
    if (numericId !== null) {
      this.id = numericId;
      mpIdCounter = Math.max(mpIdCounter, numericId);
    } else if (explicitId !== null && explicitId !== undefined && String(explicitId).trim() !== '') {
      this.id = explicitId;
    } else {
      this.id = (++mpIdCounter);
    }
        this.name = opts.name;
        this.partyId = opts.partyId;
        this.ideology = opts.ideology;           // 0-100 scale
        this.loyaltyToParty = Number.isFinite(opts.loyaltyToParty) ? opts.loyaltyToParty : 50 + Math.floor(roll() * 40); // 50-89
        this.corruptionLevel = Number.isFinite(opts.corruptionLevel) ? opts.corruptionLevel : Math.floor(roll() * 60);      // 0-59
        this.isBribedByPlayer = opts.isBribedByPlayer || false;
        this.isCobra = opts.isCobra || false;    // Permanent bribe (banana)
        this.districtId = opts.districtId || null;
        this.isPartyList = opts.isPartyList || false;
        this.localPopularity = Number.isFinite(opts.localPopularity) ? opts.localPopularity : Math.floor(roll() * 30);  // 0-29
        this.isSeated = false;  // Whether they won a seat
    }

    /**
     * Deterministic vote logic for a bill.
     * @param {Bill} bill - The bill being voted on
     * @param {string} partyLeaderPosition - 'aye' or 'nay' from party leader
     * @param {string} playerPosition - 'aye' or 'nay' — player's desired outcome
     * @param {Function} rollFn - Optional deterministic random function
     * @returns {'aye'|'nay'|'abstain'}
     */
    voteLogic(bill, partyLeaderPosition, playerPosition, rollFn) {
      const roll = _resolveRoll(rollFn);
        // Cobras ALWAYS vote with the player
        if (this.isCobra || this.isBribedByPlayer) {
            return playerPosition;
        }

        // High loyalty → follow party leader
        if (this.loyaltyToParty > 70) {
            return partyLeaderPosition;
        }

        // Low loyalty → vote personal ideology
        if (this.loyaltyToParty < 40) {
          return this._ideologyVote(bill, roll);
        }

        // Middle ground (40-70 loyalty): weighted chance
        // Higher loyalty = more likely to follow party
        const loyaltyWeight = (this.loyaltyToParty - 40) / 30; // 0.0 to 1.0
        const ideologyAlignment = this._getIdeologyAlignment(bill);

        // If ideology strongly aligns with party position, follow party
        if (ideologyAlignment > 0.7) {
            return partyLeaderPosition;
        }

        // Weighted decision
        const randomValue = roll();
        if (randomValue < loyaltyWeight * 0.7) {
            return partyLeaderPosition;
        }
        return this._ideologyVote(bill, roll);
    }

      _ideologyVote(bill, rollFn) {
        const roll = _resolveRoll(rollFn);
        // Bills with ideological position: lower = progressive, higher = conservative
        const dist = Math.abs(this.ideology - bill.ideologicalPosition);
        if (dist < 25) return 'aye';
        if (dist > 60) return 'nay';
        return roll() > 0.5 ? 'aye' : 'nay';
    }

    _getIdeologyAlignment(bill) {
        const dist = Math.abs(this.ideology - bill.ideologicalPosition);
        return 1 - (dist / 100);
    }
}

// ─── District ────────────────────────────────────────────────
let districtIdCounter = 0;
class District {
    constructor(opts) {
  opts = opts || {};
    const explicitId = (opts && Object.prototype.hasOwnProperty.call(opts, 'id')) ? opts.id : null;
    const numericId = _toFiniteInt(explicitId);
    if (numericId !== null) {
      this.id = numericId;
      districtIdCounter = Math.max(districtIdCounter, numericId);
    } else if (explicitId !== null && explicitId !== undefined && String(explicitId).trim() !== '') {
      this.id = explicitId;
    } else {
      this.id = (++districtIdCounter);
    }
        this.provinceName = opts.provinceName;
        this.seatIndex = opts.seatIndex;   // e.g., "Bangkok District 1"
        this.region = opts.region;
        this.localLeanings = opts.localLeanings || {};  // partyId → modifier (-20 to +20)
        this.incumbentPartyId = opts.incumbentPartyId || null;
        this.currentMPId = null;
        this.winningPartyId = null;
        this.ioDebuff = {};   // partyId → penalty amount
        this.campaignBuff = {}; // partyId → bonus amount
    }

    getDisplayName() {
        const total = window.Game.Data.PROVINCES[this.provinceName] || 1;
        if (total === 1) return this.provinceName;
        return `${this.provinceName} เขต ${this.seatIndex}`;
    }
}

// ─── Bill ────────────────────────────────────────────────────
let billIdCounter = 0;
class Bill {
    constructor(opts) {
  opts = opts || {};
    const explicitId = (opts && Object.prototype.hasOwnProperty.call(opts, 'id')) ? opts.id : null;
    const numericId = _toFiniteInt(explicitId);
    if (numericId !== null) {
      this.id = numericId;
      billIdCounter = Math.max(billIdCounter, numericId);
    } else if (explicitId !== null && explicitId !== undefined && String(explicitId).trim() !== '') {
      this.id = explicitId;
    } else {
      this.id = (++billIdCounter);
    }
        this.name = opts.name;
        this.description = opts.description || '';
        this.type = opts.type || 'legislation'; // 'legislation', 'budget', 'constitutional', 'no_confidence'
        this.ideologicalPosition = opts.ideologicalPosition; // 0-100
        this.capitalCost = opts.capitalCost || 50;
        this.effects = opts.effects || {};
        this.projectedAye = 0;
        this.projectedNay = 0;
        this.actualAye = 0;
        this.actualNay = 0;
        this.actualAbstain = 0;
        this.passed = null;
    }
}

// Export to global
window.Game.Models.MP = MP;
window.Game.Models.District = District;
window.Game.Models.Bill = Bill;
window.Game.Models.getCounters = function() {
  return {
    mp: mpIdCounter,
    district: districtIdCounter,
    bill: billIdCounter
  };
};
window.Game.Models.setCounters = function(counters = {}) {
  const mp = _toFiniteInt(counters.mp);
  const district = _toFiniteInt(counters.district);
  const bill = _toFiniteInt(counters.bill);
  mpIdCounter = (mp === null) ? 0 : mp;
  districtIdCounter = (district === null) ? 0 : district;
  billIdCounter = (bill === null) ? 0 : bill;
  return window.Game.Models.getCounters();
};
window.Game.Models.syncCounters = function(counters = {}) {
  const mp = _toFiniteInt(counters.mp);
  const district = _toFiniteInt(counters.district);
  const bill = _toFiniteInt(counters.bill);
  if (mp !== null) mpIdCounter = Math.max(mpIdCounter, mp);
  if (district !== null) districtIdCounter = Math.max(districtIdCounter, district);
  if (bill !== null) billIdCounter = Math.max(billIdCounter, bill);
  return window.Game.Models.getCounters();
};

// ─── Predefined Bills ────────────────────────────────────────
// Each bill has effects.popularityChanges (region→value), effects.capitalReward, effects.scandalChange
window.Game.Data.BILL_TEMPLATES = [
    { name: "พ.ร.บ. กระจายอำนาจท้องถิ่น", description: "Decentralize local government power", ideologicalPosition: 20, capitalCost: 80, type: 'legislation', promiseId: 'decentralize',
      effects: { popularityChanges: { "Northeast": 4, "North": 3, "South": 2, "Bangkok": -2 }, capitalReward: 20, scandalChange: 0 } },
    { name: "พ.ร.บ. ปฏิรูปที่ดิน", description: "Land reform and redistribution", ideologicalPosition: 15, capitalCost: 100, type: 'legislation', promiseId: 'land_reform',
      effects: { popularityChanges: { "Northeast": 5, "North": 4, "Central": -3 }, capitalReward: 30, scandalChange: 0 } },
    { name: "พ.ร.บ. งบประมาณกลาโหม", description: "Increase military budget", ideologicalPosition: 80, capitalCost: 60, type: 'budget', promiseId: 'military_budget',
      effects: { popularityChanges: { "Bangkok": -3, "Northeast": -2, "South": 2 }, capitalReward: 40, scandalChange: 0 } },
    { name: "พ.ร.บ. สวัสดิการประชาชน", description: "Universal welfare expansion", ideologicalPosition: 25, capitalCost: 90, type: 'budget', promiseId: 'welfare',
      effects: { popularityChanges: { "Northeast": 5, "North": 4, "East": 3, "Bangkok": 2, "Central": 2, "South": 2, "West": 2 }, capitalReward: 10, scandalChange: 0 } },
    { name: "พ.ร.บ. แก้ไขรัฐธรรมนูญ", description: "Constitutional amendment on senate powers", ideologicalPosition: 10, capitalCost: 150, type: 'constitutional', promiseId: 'constitution',
      effects: { popularityChanges: { "Bangkok": 5, "Central": 3, "North": 4, "Northeast": 4, "South": -3 }, capitalReward: 50, scandalChange: 0 } },
    { name: "พ.ร.บ. ส่งเสริมการลงทุน", description: "Investment promotion act", ideologicalPosition: 60, capitalCost: 50, type: 'legislation', promiseId: 'investment',
      effects: { popularityChanges: { "East": 4, "Bangkok": 3, "Central": 2, "Northeast": -1 }, capitalReward: 35, scandalChange: 0 } },
    { name: "พ.ร.บ. คุ้มครองสิ่งแวดล้อม", description: "Environmental protection law", ideologicalPosition: 30, capitalCost: 70, type: 'legislation', promiseId: 'environment',
      effects: { popularityChanges: { "Bangkok": 3, "South": 3, "North": 2, "East": -3 }, capitalReward: 15, scandalChange: 0 } },
    { name: "พ.ร.บ. ปราบปรามทุจริต", description: "Anti-corruption enforcement act", ideologicalPosition: 40, capitalCost: 85, type: 'legislation', promiseId: 'anti_corruption',
      effects: { popularityChanges: { "Bangkok": 4, "Central": 3, "North": 2, "Northeast": 2, "South": 2 }, capitalReward: 25, scandalChange: -10 } },
    { name: "พ.ร.บ. การศึกษาแห่งชาติ", description: "National education reform", ideologicalPosition: 35, capitalCost: 75, type: 'legislation', promiseId: 'education',
      effects: { popularityChanges: { "Bangkok": 2, "North": 3, "Northeast": 3, "Central": 2, "South": 2 }, capitalReward: 20, scandalChange: 0 } },
    { name: "พ.ร.บ. เศรษฐกิจดิจิทัล", description: "Digital economy act", ideologicalPosition: 45, capitalCost: 55, type: 'legislation', promiseId: 'digital_economy',
      effects: { popularityChanges: { "Bangkok": 4, "East": 3, "Central": 2, "Northeast": -1 }, capitalReward: 30, scandalChange: 0 } },
    { name: "พ.ร.บ. สุราก้าวหน้า", description: "Alcohol liberalization act", ideologicalPosition: 20, capitalCost: 40, type: 'legislation', promiseId: 'alcohol',
      effects: { popularityChanges: { "Bangkok": 3, "Central": 2, "South": -4 }, capitalReward: 10, scandalChange: 0 } },
    { name: "พ.ร.บ. สมรสเท่าเทียม", description: "Marriage equality act", ideologicalPosition: 10, capitalCost: 60, type: 'legislation', promiseId: 'marriage_equality',
      effects: { popularityChanges: { "Bangkok": 5, "Central": 2, "South": -3, "Northeast": -1 }, capitalReward: 15, scandalChange: 0 } },
    { name: "พ.ร.บ. ควบคุมสื่อสังคม", description: "Social media regulation act", ideologicalPosition: 75, capitalCost: 65, type: 'legislation', promiseId: 'social_media',
      effects: { popularityChanges: { "Bangkok": -4, "Central": -2, "North": -2, "South": 2 }, capitalReward: 20, scandalChange: 3 } },
    { name: "พ.ร.บ. ภาษีมรดก", description: "Inheritance tax reform", ideologicalPosition: 20, capitalCost: 90, type: 'budget', promiseId: 'inheritance_tax',
      effects: { popularityChanges: { "Northeast": 3, "North": 3, "Bangkok": -3, "Central": -2 }, capitalReward: 35, scandalChange: 0 } },
    { name: "พ.ร.บ. กัญชา", description: "Cannabis regulation act", ideologicalPosition: 30, capitalCost: 45, type: 'legislation', promiseId: 'cannabis',
      effects: { popularityChanges: { "Bangkok": 2, "North": 3, "South": -3, "Northeast": 1 }, capitalReward: 10, scandalChange: 0 } },
    { name: "พ.ร.บ. รถไฟความเร็วสูงแห่งชาติ", description: "National high-speed rail expansion", ideologicalPosition: 55, capitalCost: 120, type: 'budget', promiseId: 'high_speed_rail',
      effects: { popularityChanges: { "East": 4, "Central": 3, "Bangkok": 2, "North": 2, "Northeast": 1, "South": -1 }, capitalReward: 30, scandalChange: 1 } },
    { name: "พ.ร.บ. ประกันรายได้เกษตรกร", description: "Guaranteed income support for farmers", ideologicalPosition: 25, capitalCost: 95, type: 'budget', promiseId: 'farmer_income',
      effects: { popularityChanges: { "Northeast": 4, "North": 4, "Central": 2, "Bangkok": -1 }, capitalReward: 20, scandalChange: 0 } },
    { name: "พ.ร.บ. น้ำเพื่ออนาคต", description: "Water management and drought resilience act", ideologicalPosition: 35, capitalCost: 85, type: 'budget', promiseId: 'water_management',
      effects: { popularityChanges: { "Central": 3, "Northeast": 3, "North": 2, "West": 2, "Bangkok": 1 }, capitalReward: 15, scandalChange: 0 } },
    { name: "พ.ร.บ. ฟื้นฟูท่องเที่ยวชุมชน", description: "Community tourism recovery package", ideologicalPosition: 50, capitalCost: 70, type: 'legislation', promiseId: 'tourism_community',
      effects: { popularityChanges: { "South": 4, "West": 3, "North": 2, "Bangkok": 1, "Northeast": 1 }, capitalReward: 25, scandalChange: 0 } },
    { name: "พ.ร.บ. สิทธิแรงงานแพลตฟอร์ม", description: "Platform and gig worker protection law", ideologicalPosition: 22, capitalCost: 65, type: 'legislation', promiseId: 'gig_worker_rights',
      effects: { popularityChanges: { "Bangkok": 3, "Central": 2, "East": 2, "North": 1, "South": -1 }, capitalReward: 15, scandalChange: 0 } },
    { name: "พ.ร.บ. เขตนวัตกรรมท้องถิ่น", description: "Local innovation zones and startup incentives", ideologicalPosition: 48, capitalCost: 60, type: 'legislation', promiseId: 'local_innovation',
      effects: { popularityChanges: { "East": 3, "Central": 2, "North": 2, "Northeast": 2, "Bangkok": 2 }, capitalReward: 20, scandalChange: 0 } },
    { name: "พ.ร.บ. พลังงานสะอาดชุมชน", description: "Clean energy transition for local communities", ideologicalPosition: 32, capitalCost: 80, type: 'legislation', promiseId: 'clean_energy',
      effects: { popularityChanges: { "South": 3, "North": 3, "East": 2, "Bangkok": 2, "Central": 1 }, capitalReward: 18, scandalChange: -2 } },
    { name: "พ.ร.บ. ปฏิรูปตำรวจ", description: "Police reform and accountability act", ideologicalPosition: 28, capitalCost: 90, type: 'constitutional', promiseId: 'police_reform',
      effects: { popularityChanges: { "Bangkok": 4, "Central": 3, "North": 2, "Northeast": 2, "South": 1 }, capitalReward: 18, scandalChange: -6 } },
    { name: "พ.ร.บ. กองทุนผู้สูงอายุ", description: "Senior citizen pension and care fund", ideologicalPosition: 30, capitalCost: 88, type: 'budget', promiseId: 'elderly_fund',
      effects: { popularityChanges: { "Northeast": 3, "North": 3, "Central": 2, "South": 2, "Bangkok": 1 }, capitalReward: 8, scandalChange: 0 } },
    { name: "พ.ร.บ. ฟื้นฟู SME", description: "Small business recovery and credit guarantee program", ideologicalPosition: 52, capitalCost: 72, type: 'budget', promiseId: 'sme_revival',
      effects: { popularityChanges: { "Central": 3, "Bangkok": 2, "East": 2, "West": 2, "Northeast": 1 }, capitalReward: 22, scandalChange: 0 } },
];

// ─── Campaign Promise Templates ──────────────────────────────
// These are the promises players can make during the campaign.
// Each maps to a promiseId on a bill template.
window.Game.Data.PROMISE_TEMPLATES = [
    { promiseId: 'welfare', name: 'สวัสดิการถ้วนหน้า', engName: 'Universal Welfare', description: 'Promise to expand welfare for all citizens', popularityBoost: { "Northeast": 3, "North": 2, "Central": 1 }, icon: '🏥' },
    { promiseId: 'land_reform', name: 'ปฏิรูปที่ดิน', engName: 'Land Reform', description: 'Promise to redistribute land to farmers', popularityBoost: { "Northeast": 3, "North": 3 }, icon: '🌾' },
    { promiseId: 'education', name: 'ปฏิรูปการศึกษา', engName: 'Education Reform', description: 'Promise to reform national education', popularityBoost: { "Bangkok": 2, "North": 2, "Northeast": 2 }, icon: '📚' },
    { promiseId: 'anti_corruption', name: 'ปราบทุจริต', engName: 'Fight Corruption', description: 'Promise to crack down on corruption', popularityBoost: { "Bangkok": 3, "Central": 2, "North": 1 }, icon: '⚖️' },
    { promiseId: 'decentralize', name: 'กระจายอำนาจ', engName: 'Decentralization', description: 'Promise to give more power to local governments', popularityBoost: { "Northeast": 3, "North": 2, "South": 1 }, icon: '🏘️' },
    { promiseId: 'environment', name: 'คุ้มครองสิ่งแวดล้อม', engName: 'Protect Environment', description: 'Promise to pass environmental protections', popularityBoost: { "Bangkok": 2, "South": 2, "North": 1 }, icon: '🌿' },
    { promiseId: 'digital_economy', name: 'เศรษฐกิจดิจิทัล', engName: 'Digital Economy', description: 'Promise to modernize the economy', popularityBoost: { "Bangkok": 3, "East": 2 }, icon: '💻' },
    { promiseId: 'constitution', name: 'แก้รัฐธรรมนูญ', engName: 'Constitution Reform', description: 'Promise to amend the constitution', popularityBoost: { "Bangkok": 3, "North": 2, "Northeast": 2 }, icon: '📜' },
  { promiseId: 'military_budget', name: 'หนุนงบความมั่นคง', engName: 'Security Budget Boost', description: 'Promise to strengthen defense capacity', popularityBoost: { "South": 2, "East": 1, "Bangkok": -1 }, icon: '🛡️' },
  { promiseId: 'investment', name: 'ดึงการลงทุนใหม่', engName: 'Attract New Investment', description: 'Promise to bring in domestic and foreign investment', popularityBoost: { "East": 3, "Bangkok": 2, "Central": 1 }, icon: '📈' },
  { promiseId: 'alcohol', name: 'ปลดล็อกสุราก้าวหน้า', engName: 'Alcohol Liberalization', description: 'Promise to modernize alcohol regulation', popularityBoost: { "Bangkok": 2, "Central": 2, "North": 1 }, icon: '🍻' },
  { promiseId: 'marriage_equality', name: 'ผลักดันสมรสเท่าเทียม', engName: 'Marriage Equality', description: 'Promise to pass marriage equality rights', popularityBoost: { "Bangkok": 3, "Central": 1, "North": 1 }, icon: '🏳️‍🌈' },
  { promiseId: 'social_media', name: 'คุมแพลตฟอร์มออนไลน์', engName: 'Regulate Social Media', description: 'Promise tighter control of online platforms', popularityBoost: { "South": 2, "Central": 1, "Bangkok": -1 }, icon: '📱' },
  { promiseId: 'inheritance_tax', name: 'เก็บภาษีคนรวย', engName: 'Inheritance Tax Reform', description: 'Promise to tax inherited wealth more fairly', popularityBoost: { "Northeast": 2, "North": 2, "Central": 1 }, icon: '💸' },
  { promiseId: 'cannabis', name: 'นโยบายกัญชาใหม่', engName: 'Cannabis Policy Update', description: 'Promise clear and modern cannabis rules', popularityBoost: { "North": 2, "Bangkok": 1, "Northeast": 1 }, icon: '🌿' },
  { promiseId: 'high_speed_rail', name: 'รถไฟความเร็วสูงทั่วไทย', engName: 'High-Speed Rail', description: 'Promise rapid rail links between major regions', popularityBoost: { "East": 3, "Central": 2, "Bangkok": 1 }, icon: '🚄' },
  { promiseId: 'farmer_income', name: 'ประกันรายได้เกษตรกร', engName: 'Farmer Income Guarantee', description: 'Promise stable income support for farmers', popularityBoost: { "Northeast": 3, "North": 2, "Central": 1 }, icon: '🌾' },
  { promiseId: 'water_management', name: 'แก้น้ำแล้งน้ำท่วม', engName: 'Water Management', description: 'Promise better drought and flood infrastructure', popularityBoost: { "Central": 2, "Northeast": 2, "North": 1 }, icon: '💧' },
  { promiseId: 'tourism_community', name: 'ท่องเที่ยวชุมชนยั่งยืน', engName: 'Community Tourism Revival', description: 'Promise local tourism recovery and jobs', popularityBoost: { "South": 3, "West": 2, "North": 1 }, icon: '🧳' },
  { promiseId: 'gig_worker_rights', name: 'คุ้มครองแรงงานแพลตฟอร์ม', engName: 'Gig Worker Rights', description: 'Promise legal protection for app-based workers', popularityBoost: { "Bangkok": 2, "Central": 1, "East": 1 }, icon: '🛵' },
  { promiseId: 'local_innovation', name: 'เขตนวัตกรรมท้องถิ่น', engName: 'Local Innovation Zones', description: 'Promise startup hubs and local innovation funds', popularityBoost: { "East": 2, "Central": 1, "North": 1 }, icon: '🧪' },
  { promiseId: 'clean_energy', name: 'พลังงานสะอาดชุมชน', engName: 'Clean Energy Communities', description: 'Promise clean energy transition and lower bills', popularityBoost: { "South": 2, "North": 2, "Bangkok": 1 }, icon: '🔋' },
  { promiseId: 'police_reform', name: 'ปฏิรูปตำรวจโปร่งใส', engName: 'Police Reform', description: 'Promise stronger police accountability and reform', popularityBoost: { "Bangkok": 2, "Central": 2, "North": 1 }, icon: '🚨' },
  { promiseId: 'elderly_fund', name: 'กองทุนผู้สูงอายุ', engName: 'Senior Citizen Fund', description: 'Promise stronger pensions and care support', popularityBoost: { "Northeast": 2, "North": 2, "South": 1 }, icon: '👵' },
  { promiseId: 'sme_revival', name: 'ฟื้นฟูธุรกิจ SME', engName: 'SME Recovery', description: 'Promise financing and tax support for small firms', popularityBoost: { "Central": 2, "Bangkok": 1, "East": 1 }, icon: '🏪' },
];
