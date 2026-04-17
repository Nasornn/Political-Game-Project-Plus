// ============================================================
// UI MANAGER — Map Rendering, Screen Management, All UI Logic
// ============================================================
window.Game = window.Game || {};
window.Game.UI = {};

// ─── MAP RENDERER (D3.js) ────────────────────────────────────
window.Game.UI.Map = {
    svg: null,
    projection: null,
    path: null,
    tooltip: null,
    provinceFeatures: null,
    mapData: null,
    _currentContainerId: null,
    _mapGroup: null,
    _zoom: null,
    _nameCache: {},         // topoName → resolved name cache
    _hoveredProvince: null, // track currently hovered province

    /**
     * Move the map SVG to a different container element.
     */
    moveTo(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const mapEl = document.getElementById('map-container');
        if (mapEl && mapEl.parentElement) {
            // Physically move the map container
            container.appendChild(mapEl);
        }
    },

    async init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        this._currentContainerId = containerId;

        const width = container.clientWidth || 500;
        const height = container.clientHeight || 700;

        this.svg = d3.select('#' + containerId)
            .append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${width} ${height}`)
            .attr('preserveAspectRatio', 'xMidYMid meet');

        // Background
        this.svg.append('rect')
            .attr('width', width)
            .attr('height', height)
            .attr('fill', '#0a0e1a');

        // Create a group for all map content (zoom target)
        this._mapGroup = this.svg.append('g').attr('class', 'map-group');

        // Set up zoom behavior
        this._zoom = d3.zoom()
            .scaleExtent([1, 8])
            .translateExtent([[0, 0], [width, height]])
            .on('zoom', (event) => {
                this._mapGroup.attr('transform', event.transform);
            });
        this.svg.call(this._zoom);

        this.projection = d3.geoMercator()
            .center([101.0, 15.0])
            .scale(width * 2.5)
            .translate([width / 2, height / 2]);

        this.path = d3.geoPath().projection(this.projection);

        this.tooltip = d3.select('#tooltip');

        // Load TopoJSON
        try {
            const topo = await d3.json('https://raw.githubusercontent.com/cvibhagool/thailand-map/master/thailand-provinces.topojson');
            this.mapData = topo;

            const geojson = topojson.feature(topo, topo.objects.province);
            this.provinceFeatures = geojson.features;

            // Pre-cache all province name lookups
            for (const f of this.provinceFeatures) {
                this._nameCache[f.properties.NAME_1] = this._resolveProvinceName(f.properties.NAME_1);
            }

            // Draw provinces inside the zoom group with optimized rendering
            this._mapGroup.selectAll('path.province')
                .data(this.provinceFeatures)
                .enter()
                .append('path')
                .attr('class', 'province')
                .attr('d', this.path)
                .attr('fill', '#1e2740')
                .attr('stroke', '#2a3655')
                .attr('stroke-width', 0.5)
                .attr('shape-rendering', 'optimizeSpeed')
                .attr('vector-effect', 'non-scaling-stroke')
                .style('cursor', 'pointer')
                .style('will-change', 'fill')
                .on('mouseover', (event, d) => this._onHover(event, d))
                .on('mousemove', (event) => this._onMove(event))
                .on('mouseout', (event) => this._onOut(event))
                .on('click', (event, d) => this._onClick(event, d));

            // Draw province labels for large provinces (inside zoom group)
            this._mapGroup.selectAll('text.province-label')
                .data(this.provinceFeatures.filter(f => {
                    const name = this._resolveProvinceName(f.properties.NAME_1);
                    return (window.Game.Data.PROVINCES[name] || 0) >= 7;
                }))
                .enter()
                .append('text')
                .attr('class', 'province-label')
                .attr('transform', d => `translate(${this.path.centroid(d)})`)
                .attr('text-anchor', 'middle')
                .attr('dy', '.35em')
                .attr('fill', 'rgba(255,255,255,0.4)')
                .attr('font-size', '6px')
                .attr('pointer-events', 'none')
                .text(d => {
                    const name = this._resolveProvinceName(d.properties.NAME_1);
                    const seats = window.Game.Data.PROVINCES[name] || 0;
                    return seats > 0 ? seats : '';
                });

        } catch (err) {
            console.error('Failed to load map data:', err);
            container.innerHTML = '<p style="color:#e94560;padding:20px;">Map data failed to load. Check internet connection.</p>';
        }
    },

    _resolveProvinceName(topoName) {
        // Check cache first
        if (this._nameCache[topoName]) return this._nameCache[topoName];
        let resolved = topoName;
        if (window.Game.Data.PROVINCES[topoName]) {
            resolved = topoName;
        } else if (window.Game.Data.TOPOJSON_NAME_MAP[topoName]) {
            resolved = window.Game.Data.TOPOJSON_NAME_MAP[topoName];
        } else {
            const lower = topoName.toLowerCase().replace(/\s+/g, '');
            for (const p of Object.keys(window.Game.Data.PROVINCES)) {
                if (p.toLowerCase().replace(/\s+/g, '') === lower) { resolved = p; break; }
            }
        }
        this._nameCache[topoName] = resolved;
        return resolved;
    },

    _onHover(event, d) {
        const name = this._nameCache[d.properties.NAME_1] || this._resolveProvinceName(d.properties.NAME_1);
        this._hoveredProvince = event.currentTarget;
        const seats = window.Game.Data.PROVINCES[name] || '?';
        const region = window.Game.Data.PROVINCE_REGION[name] || 'Unknown';

        let html = `<div class="tooltip-title">${name}</div>
                     <div class="tooltip-region">${region} Region</div>
                     <div class="tooltip-seats">${seats} seats</div>`;

        // Show winning party if available
        if (window.Game.App && window.Game.App.state && window.Game.App.state.electionResults) {
            const districts = window.Game.App.state.districts.filter(dd => dd.provinceName === name);
            const wins = {};
            for (const dist of districts) {
                if (dist.winningPartyId) {
                    wins[dist.winningPartyId] = (wins[dist.winningPartyId] || 0) + 1;
                }
            }
            if (Object.keys(wins).length > 0) {
                html += '<div class="tooltip-results">';
                for (const [pid, count] of Object.entries(wins)) {
                    const party = window.Game.App.state.parties.find(p => p.id === pid);
                    if (party) {
                        html += `<span style="color:${party.hexColor}">● ${party.shortName}: ${count}</span> `;
                    }
                }
                html += '</div>';
            }
        }

        this.tooltip.html(html).classed('hidden', false);

        d3.select(event.currentTarget)
            .attr('stroke', '#d4a843')
            .attr('stroke-width', 2)
            .raise();
    },

    _onMove(event) {
        this.tooltip
            .style('left', (event.pageX + 15) + 'px')
            .style('top', (event.pageY - 10) + 'px');
    },

    _onOut(event) {
        this.tooltip.classed('hidden', true);
        // Only reset the specific element, not all provinces
        if (this._hoveredProvince) {
            d3.select(this._hoveredProvince)
                .attr('stroke', '#2a3655')
                .attr('stroke-width', 0.5);
            this._hoveredProvince = null;
        }
    },

    _onClick(event, d) {
        const name = this._resolveProvinceName(d.properties.NAME_1);
        if (window.Game.UI.Screens.onProvinceClick) {
            window.Game.UI.Screens.onProvinceClick(name);
        }
    },

    /**
     * Update map colors based on election results — with staggered wave animation.
     */
    updateMapColors(electionResults, parties, districts, animated = true) {
        const partyColorMap = {};
        for (const p of parties) {
            partyColorMap[p.id] = p.hexColor;
        }

        // Build province → dominant party map
        const provinceDominant = {};
        for (const d of districts) {
            if (!d.winningPartyId) continue;
            if (!provinceDominant[d.provinceName]) provinceDominant[d.provinceName] = {};
            provinceDominant[d.provinceName][d.winningPartyId] =
                (provinceDominant[d.provinceName][d.winningPartyId] || 0) + 1;
        }

        // Get dominant party per province
        const provinceColor = {};
        for (const [prov, wins] of Object.entries(provinceDominant)) {
            let best = null, bestCount = 0;
            for (const [pid, count] of Object.entries(wins)) {
                if (count > bestCount) { bestCount = count; best = pid; }
            }
            provinceColor[prov] = partyColorMap[best] || '#1e2740';
        }

        // Pre-compute sorted indices for wave animation (cached for performance)
        if (!this._sortedIndices) {
            const sorted = [...this.provinceFeatures].sort((a, b) => {
                const centA = this.path.centroid(a);
                const centB = this.path.centroid(b);
                return centB[1] - centA[1];
            });
            this._sortedIndices = {};
            sorted.forEach((f, idx) => { this._sortedIndices[f.properties.NAME_1] = idx; });
        }

        this._mapGroup.selectAll('path.province')
            .data(this.provinceFeatures, d => d.properties.NAME_1)
            .transition()
            .duration(animated ? 600 : 0)
            .delay((d) => {
                if (!animated) return 0;
                return (this._sortedIndices[d.properties.NAME_1] || 0) * 30;
            })
            .attr('fill', d => {
                const name = this._nameCache[d.properties.NAME_1] || this._resolveProvinceName(d.properties.NAME_1);
                return provinceColor[name] || '#1e2740';
            });

        // Update seat count labels
        this._mapGroup.selectAll('text.province-label')
            .transition()
            .delay(animated ? 2500 : 0)
            .attr('fill', 'rgba(255,255,255,0.7)');
    },

    /**
     * Reset map to neutral colors.
     */
    resetColors() {
        this._mapGroup.selectAll('path.province')
            .transition()
            .duration(400)
            .attr('fill', '#1e2740');

        this._mapGroup.selectAll('text.province-label')
            .attr('fill', 'rgba(255,255,255,0.4)');

        // Reset zoom
        if (this._zoom && this.svg) {
            this.svg.transition().duration(400).call(this._zoom.transform, d3.zoomIdentity);
        }
    },

    /**
     * Highlight a specific province.
     */
    highlightProvince(provinceName) {
        this._mapGroup.selectAll('path.province')
            .attr('stroke', d => {
                const name = this._resolveProvinceName(d.properties.NAME_1);
                return name === provinceName ? '#d4a843' : '#2a3655';
            })
            .attr('stroke-width', d => {
                const name = this._resolveProvinceName(d.properties.NAME_1);
                return name === provinceName ? 2.5 : 0.5;
            });
    },

    /**
     * Reset zoom to default position.
     */
    resetZoom() {
        if (this._zoom && this.svg) {
            this.svg.transition().duration(400).call(this._zoom.transform, d3.zoomIdentity);
        }
    }
};


// ─── SCREEN MANAGER ──────────────────────────────────────────
window.Game.UI.Screens = {
    currentScreen: null,
    onProvinceClick: null,  // callback set by each screen
    _metaToolbarBound: false,

    _setMetaToolbarButtonState(buttonId, enabled, lockedReason, hideWhenDisabled = false) {
        const btn = document.getElementById(buttonId);
        if (!btn) return;

        // For session-only locking, hide buttons entirely instead of leaving disabled controls visible.
        btn.classList.toggle('hidden', !!hideWhenDisabled && !enabled);
        btn.disabled = !enabled;

        if (hideWhenDisabled && !enabled) {
            btn.removeAttribute('title');
            return;
        }

        if (enabled) {
            btn.removeAttribute('title');
        } else {
            btn.title = lockedReason || 'Unavailable right now.';
        }
    },

    _updateMetaToolbarAvailability(screenId = this.currentScreen) {
        const isSessionScreen = !!screenId && screenId !== 'screen-setup' && screenId !== 'screen-menu';
        const setupOnlyToolsEnabled = !isSessionScreen;

        this._setMetaToolbarButtonState('btn-open-save-load', true);
        this._setMetaToolbarButtonState('btn-open-history', setupOnlyToolsEnabled, 'Run History is available in Setup only.', true);
        this._setMetaToolbarButtonState('btn-open-sandbox', setupOnlyToolsEnabled, 'Sandbox is available in Setup only.', true);
        this._setMetaToolbarButtonState('btn-open-scenario', setupOnlyToolsEnabled, 'Scenario Mod is available in Setup only.', true);
    },

    show(screenId) {
        // Hide all screens
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        // Show target
        const el = document.getElementById(screenId);
        if (el) {
            el.classList.remove('hidden');
            this.currentScreen = screenId;
        }
        this._updateMetaToolbarAvailability(screenId);
    },

    bindMetaToolbar() {
        if (this._metaToolbarBound) return;
        const btnSaveLoad = document.getElementById('btn-open-save-load');
        const btnHistory = document.getElementById('btn-open-history');
        const btnSandbox = document.getElementById('btn-open-sandbox');
        const btnScenario = document.getElementById('btn-open-scenario');

        if (btnSaveLoad) {
            btnSaveLoad.addEventListener('click', () => this.renderSaveLoadModal());
        }
        if (btnHistory) {
            btnHistory.addEventListener('click', () => this.renderRunHistoryModal());
        }
        if (btnSandbox) {
            btnSandbox.addEventListener('click', () => this.renderSandboxModal());
        }
        if (btnScenario) {
            btnScenario.addEventListener('click', () => this.renderCustomScenarioModal());
        }
        this._updateMetaToolbarAvailability(this.currentScreen || 'screen-menu');
        this._metaToolbarBound = true;
    },

    renderSaveLoadModal() {
        const modal = document.getElementById('modal');
        if (!modal) return;
        const app = window.Game.App;
        const slots = app.getSaveSlots();

        modal.innerHTML = `
            <div class="modal-content" style="max-width:700px;">
                <div class="modal-header">
                    <h3>💾 Save / Load</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div class="save-slot-grid" style="display:grid;gap:8px;">
                    ${slots.map(slot => {
                        const savedAt = slot.savedAt ? new Date(slot.savedAt).toLocaleString() : '-';
                        const meta = slot.meta || {};
                        return `
                            <div class="coalition-party-card" style="border-left-color:var(--gold);">
                                <div>
                                    <div class="cp-name">Slot ${slot.slot}</div>
                                    ${slot.empty ? '<div class="cp-you">Empty</div>' : `
                                        <div class="cp-you">${meta.partyName || 'Unknown Party'} • ${meta.electionCount || 1} election(s)</div>
                                        <div style="font-size:0.72rem;color:var(--text-secondary);">Saved: ${savedAt}</div>
                                        <div style="font-size:0.72rem;color:var(--text-dim);">State: ${slot.currentState || 'Unknown'} • Year ${meta.parliamentYear || 1}</div>
                                    `}
                                </div>
                                <div style="display:flex;gap:6px;min-width:220px;">
                                    <button class="btn-small btn-save-slot" data-slot="${slot.slot}" style="margin:0;text-align:center;">Save</button>
                                    <button class="btn-small btn-load-slot" data-slot="${slot.slot}" style="margin:0;text-align:center;" ${slot.empty ? 'disabled' : ''}>Load</button>
                                    <button class="btn-small btn-delete-slot" data-slot="${slot.slot}" style="margin:0;text-align:center;" ${slot.empty ? 'disabled' : ''}>Delete</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="font-size:0.72rem;color:var(--text-dim);margin-top:10px;">Saved game includes campaign data, parliament status, coalition negotiation, and run history.</p>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));

        modal.querySelectorAll('.btn-save-slot').forEach(btn => {
            btn.addEventListener('click', () => {
                const slot = parseInt(btn.dataset.slot, 10);
                const result = app.saveToSlot(slot);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                this.renderSaveLoadModal();
            });
        });

        modal.querySelectorAll('.btn-load-slot').forEach(btn => {
            btn.addEventListener('click', () => {
                const slot = parseInt(btn.dataset.slot, 10);
                const result = app.loadFromSlot(slot);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                if (result.success) modal.classList.add('hidden');
            });
        });

        modal.querySelectorAll('.btn-delete-slot').forEach(btn => {
            btn.addEventListener('click', () => {
                const slot = parseInt(btn.dataset.slot, 10);
                const result = app.deleteSaveSlot(slot);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                this.renderSaveLoadModal();
            });
        });
    },

    renderRunHistoryModal() {
        const modal = document.getElementById('modal');
        if (!modal) return;
        const filterType = this._runHistoryFilter || 'all';
        const analytics = window.Game.App.getRunHistoryAnalytics(filterType);
        const filterButtons = ['all', 'campaign', 'campaign-event', 'coalition', 'parliament', 'election', 'crisis', 'scenario', 'sandbox', 'save', 'load'];

        modal.innerHTML = `
            <div class="modal-content" style="max-width:860px;">
                <div class="modal-header">
                    <h3>📜 Run History Analytics</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
                    ${filterButtons.map(type => `
                        <button class="setup-scenario-btn run-filter-btn ${filterType === type ? 'active' : ''}" data-filter="${type}" style="padding:6px 8px;font-size:0.72rem;">${type}</button>
                    `).join('')}
                </div>
                <div style="display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;margin-bottom:10px;">
                    <div class="info-chip"><span class="info-label">Entries</span><span class="info-value" style="font-size:1rem;">${analytics.count}</span></div>
                    <div class="info-chip"><span class="info-label">Popularity Δ</span><span class="info-value" style="font-size:1rem;color:${analytics.popularityDelta >= 0 ? 'var(--success)' : 'var(--crimson)'};">${analytics.popularityDelta > 0 ? '+' : ''}${analytics.popularityDelta}</span></div>
                    <div class="info-chip"><span class="info-label">Seat Δ</span><span class="info-value" style="font-size:1rem;color:${analytics.seatDelta >= 0 ? 'var(--success)' : 'var(--crimson)'};">${analytics.seatDelta > 0 ? '+' : ''}${analytics.seatDelta}</span></div>
                    <div class="info-chip"><span class="info-label">Trust Δ</span><span class="info-value" style="font-size:1rem;color:${analytics.trustDelta >= 0 ? 'var(--success)' : 'var(--crimson)'};">${analytics.trustDelta > 0 ? '+' : ''}${analytics.trustDelta}</span></div>
                </div>
                <div style="font-size:0.76rem;color:var(--text-secondary);margin-bottom:8px;">Top turning points</div>
                <div class="mp-list" style="max-height:170px;margin-bottom:10px;">
                    ${analytics.topTurningPoints.length === 0
                        ? '<p class="placeholder-text" style="padding:12px;">No high-impact turning points yet.</p>'
                        : analytics.topTurningPoints.map(tp => `
                            <div class="mp-pick-card" style="cursor:default;">
                                <span class="mp-name">${tp.message}</span>
                                <span class="mp-loyalty">impact ${tp.impact}</span>
                                <span class="mp-corruption">${new Date(tp.at).toLocaleTimeString()}</span>
                            </div>
                        `).join('')
                    }
                </div>
                <div style="font-size:0.76rem;color:var(--text-secondary);margin-bottom:8px;">Timeline</div>
                <div class="mp-list" style="max-height:280px;">
                    ${analytics.filteredEntries.length === 0
                        ? '<p class="placeholder-text" style="padding:18px;">No timeline events yet.</p>'
                        : analytics.filteredEntries.map(entry => `
                            <div class="mp-pick-card" style="cursor:default;">
                                <span class="mp-name">${entry.message}</span>
                                <span class="mp-loyalty">${entry.type}</span>
                                <span class="mp-corruption">${new Date(entry.at).toLocaleTimeString()}</span>
                            </div>
                        `).join('')
                    }
                </div>
            </div>
        `;
        modal.classList.remove('hidden');
        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));

        modal.querySelectorAll('.run-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._runHistoryFilter = btn.dataset.filter;
                this.renderRunHistoryModal();
            });
        });
    },

    renderSandboxModal() {
        const modal = document.getElementById('modal');
        if (!modal) return;

        modal.innerHTML = `
            <div class="modal-content" style="max-width:860px;">
                <div class="modal-header">
                    <h3>🧪 Balance Sandbox</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
                    <label for="sandbox-iterations" style="font-size:0.8rem;color:var(--text-secondary);">Iterations</label>
                    <input id="sandbox-iterations" class="form-input form-input-short" type="number" min="5" max="500" value="120" style="max-width:120px;">
                    <button class="btn-primary" id="btn-run-sandbox" style="padding:9px 16px;">Run Simulation</button>
                </div>
                <div id="sandbox-results" class="mp-list" style="max-height:460px;"></div>
            </div>
        `;
        modal.classList.remove('hidden');
        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));

        const renderResults = (result) => {
            const target = document.getElementById('sandbox-results');
            if (!target) return;
            if (!result) {
                target.innerHTML = '<p class="placeholder-text" style="padding:14px;">Run the simulation to see win rates and seat distributions.</p>';
                return;
            }
            target.innerHTML = `
                <div class="results-table-header" style="grid-template-columns:1.2fr .9fr .8fr .7fr .7fr .7fr;">
                    <span>Party</span><span>Win Rate</span><span>Avg Seats</span><span>P10</span><span>P50</span><span>P90</span>
                </div>
                ${result.stats.map(row => `
                    <div class="results-row" style="grid-template-columns:1.2fr .9fr .8fr .7fr .7fr .7fr;">
                        <span>${row.thaiName} <small>${row.shortName}</small></span>
                        <span>${row.winRate}%</span>
                        <span>${row.avgSeats}</span>
                        <span>${row.p10}</span>
                        <span>${row.p50}</span>
                        <span>${row.p90}</span>
                    </div>
                    <div style="font-size:0.68rem;color:var(--text-dim);padding:0 12px 8px;">
                        Seat buckets: 0-99: ${row.buckets['0-99']} | 100-199: ${row.buckets['100-199']} | 200-250: ${row.buckets['200-250']} | 251+: ${row.buckets['251+']}
                    </div>
                `).join('')}
            `;
        };

        renderResults(null);
        document.getElementById('btn-run-sandbox').addEventListener('click', () => {
            const runs = parseInt(document.getElementById('sandbox-iterations').value, 10);
            const result = window.Game.App.runBalanceSandbox(runs);
            this.showNotification(`Sandbox complete: ${result.runs} runs.`, 'success');
            renderResults(result);
        });
    },

    async renderCustomScenarioModal() {
        const modal = document.getElementById('modal');
        if (!modal) return;
        const app = window.Game.App;
        const currentConfig = app.getCustomScenarioConfig();
        const jsonText = app.getCustomScenarioEditorJSON();

        modal.innerHTML = `
            <div class="modal-content" style="max-width:740px;">
                <div class="modal-header">
                    <h3>🧩 Custom Scenario Modding</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <p style="font-size:0.74rem;color:var(--text-secondary);margin-bottom:8px;line-height:1.35;">
                    Edit scenario JSON, then apply in Setup. Supports campaign tuning, base-party overrides, and custom parties.
                    ${currentConfig ? `<br><span style="color:var(--gold-light);">Active: ${currentConfig.name} (${currentConfig.baseMode})</span>` : ''}
                </p>
                <textarea id="custom-scenario-json" class="form-input form-textarea" rows="12" style="width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.74rem;line-height:1.35;">${jsonText}</textarea>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
                    <button class="btn-small" id="btn-scenario-template" style="margin:0;text-align:center;">Load Template</button>
                    <button class="btn-small" id="btn-scenario-export" style="margin:0;text-align:center;">Export Current</button>
                    <button class="btn-small" id="btn-scenario-apply" style="margin:0;text-align:center;">Apply Scenario</button>
                    <button class="btn-small" id="btn-scenario-disable" style="margin:0;text-align:center;" ${currentConfig ? '' : 'disabled'}>Disable Custom</button>
                </div>
                <p style="font-size:0.67rem;color:var(--text-dim);margin-top:6px;">
                    Apply/disable requires Setup screen. Export works anytime.
                </p>
                <div style="margin-top:10px;border-top:1px solid var(--border-subtle);padding-top:8px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                        <div style="font-family:var(--font-main);font-size:0.8rem;color:var(--gold);">Scenario Packs (scenarios folder)</div>
                        <button class="btn-small" id="btn-scenario-refresh-packs" style="margin:0;text-align:center;">Refresh Packs</button>
                    </div>
                    <div id="scenario-pack-list" class="mp-list" style="max-height:140px;margin-top:6px;"></div>
                    <p style="font-size:0.65rem;color:var(--text-dim);margin-top:5px;">Use Preview to load pack JSON into editor, or Quick Apply from Setup.</p>
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        const area = () => document.getElementById('custom-scenario-json');
        const packListEl = () => document.getElementById('scenario-pack-list');

        const renderPackList = (result) => {
            const target = packListEl();
            if (!target) return;

            if (!result || !result.success) {
                target.innerHTML = `<p class="placeholder-text" style="padding:12px;">${(result && result.msg) ? result.msg : 'No scenario packs available.'}</p>`;
                return;
            }

            if (!result.packs || result.packs.length === 0) {
                target.innerHTML = '<p class="placeholder-text" style="padding:12px;">No pack entries in scenarios/index.json.</p>';
                return;
            }

            target.innerHTML = result.packs.map(pack => `
                <div class="coalition-party-card" style="border-left-color:var(--gold);margin-bottom:6px;">
                    <div>
                        <div class="cp-name">${pack.name}</div>
                        <div class="cp-you" style="font-size:0.72rem;">id: ${pack.id} • ${pack.file}</div>
                        ${pack.description ? `<div style="font-size:0.71rem;color:var(--text-secondary);">${pack.description}</div>` : ''}
                        ${pack.author ? `<div style="font-size:0.67rem;color:var(--text-dim);">by ${pack.author}</div>` : ''}
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;min-width:200px;">
                        <button class="btn-small btn-pack-preview" data-pack-id="${pack.id}" style="margin:0;text-align:center;">Preview</button>
                        <button class="btn-small btn-pack-apply" data-pack-id="${pack.id}" style="margin:0;text-align:center;">Quick Apply</button>
                    </div>
                </div>
            `).join('');

            target.querySelectorAll('.btn-pack-preview').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const packId = btn.dataset.packId;
                    const preview = await app.getScenarioPackJSON(packId);
                    if (!preview.success) {
                        this.showNotification(preview.msg || 'Could not preview pack.', 'error');
                        return;
                    }
                    area().value = preview.jsonText;
                    this.showNotification(`Loaded ${preview.pack.name} into editor.`, 'info');
                });
            });

            target.querySelectorAll('.btn-pack-apply').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const packId = btn.dataset.packId;
                    const apply = await app.applyScenarioPack(packId);
                    this.showNotification(apply.msg || 'Failed to apply pack.', apply.success ? 'success' : 'error');
                    if (apply.success) {
                        area().value = apply.jsonText;
                        this.renderSetup(app.state);
                        await this.renderCustomScenarioModal();
                    }
                });
            });
        };

        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));

        document.getElementById('btn-scenario-template').addEventListener('click', () => {
            area().value = JSON.stringify(app.getCustomScenarioTemplate(), null, 2);
            this.showNotification('Scenario template loaded.', 'info');
        });

        document.getElementById('btn-scenario-export').addEventListener('click', () => {
            area().value = app.exportCurrentScenarioJSON();
            this.showNotification('Current scenario exported to editor.', 'success');
        });

        document.getElementById('btn-scenario-apply').addEventListener('click', () => {
            const result = app.applyCustomScenario(area().value);
            this.showNotification(result.msg, result.success ? 'success' : 'error');
            if (result.success) {
                this.renderSetup(app.state);
                this.renderCustomScenarioModal();
            }
        });

        document.getElementById('btn-scenario-disable').addEventListener('click', () => {
            const result = app.clearCustomScenario();
            this.showNotification(result.msg, result.success ? 'success' : 'error');
            if (result.success) {
                this.renderSetup(app.state);
                this.renderCustomScenarioModal();
            }
        });

        const refreshPacks = async (force = false) => {
            const target = packListEl();
            if (target) {
                target.innerHTML = '<p class="placeholder-text" style="padding:12px;">Loading scenario packs...</p>';
            }
            const list = await app.listScenarioPacks(force);
            renderPackList(list);
        };

        document.getElementById('btn-scenario-refresh-packs').addEventListener('click', () => refreshPacks(true));
        await refreshPacks(false);
    },

    // ─── MAIN MENU ──────────
    renderMainMenu() {
        this.show('screen-menu');
    },

    // ─── SETUP SCREEN ───────
    renderSetup(gameState) {
        this.show('screen-setup');
        const grid = document.getElementById('party-grid');
        const detail = document.getElementById('party-detail');
        if (!grid) return;

        grid.innerHTML = '';
        const scenarioMode = gameState.scenarioMode || 'realistic';
        const customScenario = window.Game.App.getCustomScenarioConfig();
        const difficultyMode = window.Game.Engine.Campaign.normalizeDifficultyMode(gameState.difficultyMode || 'medium');
        const difficulties = window.Game.Engine.Campaign.getDifficultyModes();

        const scenarioPanel = document.createElement('div');
        scenarioPanel.className = 'setup-scenario-panel';
        scenarioPanel.innerHTML = `
            <div class="setup-scenario-title">Scenario</div>
            <div class="setup-scenario-actions">
                <button class="setup-scenario-btn ${scenarioMode === 'realistic' ? 'active' : ''}" data-scenario="realistic">
                    Realistic (Current)
                </button>
                <button class="setup-scenario-btn ${scenarioMode === 'balanced' ? 'active' : ''}" data-scenario="balanced">
                    Balanced
                </button>
            </div>
            <div class="setup-scenario-actions" style="margin-top:8px;grid-template-columns:1fr;">
                <button class="setup-scenario-btn ${scenarioMode === 'custom' ? 'active' : ''}" id="btn-open-custom-scenario">
                    ${scenarioMode === 'custom' ? 'Custom Scenario Active' : 'Open Custom Scenario Editor'}
                </button>
                ${scenarioMode === 'custom' ? '<button class="setup-scenario-btn" id="btn-disable-custom-scenario">Disable Custom Scenario</button>' : ''}
            </div>
            <p class="setup-scenario-desc">
                ${scenarioMode === 'custom'
                    ? `${(customScenario && customScenario.name) ? customScenario.name : 'Custom Scenario'} (${(customScenario && customScenario.baseMode) ? customScenario.baseMode : 'realistic'} base).`
                    : scenarioMode === 'balanced'
                    ? 'All base parties are normalized for a fair match.'
                    : 'Uses current party strengths, regional power, and BanYai setup.'}
            </p>
        `;
        scenarioPanel.querySelectorAll('.setup-scenario-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.scenario;
                if ((gameState.scenarioMode || 'realistic') === mode) return;
                window.Game.App.setScenarioMode(mode);
                this.showNotification(`Scenario set to ${mode === 'balanced' ? 'Balanced' : 'Realistic'}.`, 'info');
                if (detail) {
                    detail.innerHTML = '<p class="placeholder-text">← Select a party to see details</p>';
                }
                this.renderSetup(gameState);
            });
        });

        const btnOpenCustomScenario = scenarioPanel.querySelector('#btn-open-custom-scenario');
        if (btnOpenCustomScenario) {
            btnOpenCustomScenario.addEventListener('click', () => this.renderCustomScenarioModal());
        }

        const btnDisableCustomScenario = scenarioPanel.querySelector('#btn-disable-custom-scenario');
        if (btnDisableCustomScenario) {
            btnDisableCustomScenario.addEventListener('click', () => {
                const result = window.Game.App.clearCustomScenario();
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                if (result.success) {
                    if (detail) {
                        detail.innerHTML = '<p class="placeholder-text">← Select a party to see details</p>';
                    }
                    this.renderSetup(gameState);
                }
            });
        }
        grid.appendChild(scenarioPanel);

        const difficultyPanel = document.createElement('div');
        difficultyPanel.className = 'setup-scenario-panel';
        difficultyPanel.innerHTML = `
            <div class="setup-scenario-title">Campaign Mode</div>
            <div class="setup-scenario-actions" style="grid-template-columns:1fr;gap:6px;">
                ${difficulties.map(d => `
                    <button class="setup-scenario-btn ${difficultyMode === d.id ? 'active' : ''}" data-difficulty="${d.id}">
                        ${d.label} (${d.tier})
                    </button>
                `).join('')}
            </div>
            <p class="setup-scenario-desc">
                ${(difficulties.find(d => d.id === difficultyMode) || difficulties[1]).description}
            </p>
        `;
        difficultyPanel.querySelectorAll('.setup-scenario-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.difficulty;
                if (difficultyMode === mode) return;
                window.Game.App.setDifficultyMode(mode);
                this.showNotification(`Campaign mode set to ${(difficulties.find(d => d.id === mode) || {}).label || mode}.`, 'info');
                if (detail) {
                    detail.innerHTML = '<p class="placeholder-text">← Select a party to see details</p>';
                }
                this.renderSetup(gameState);
            });
        });
        grid.appendChild(difficultyPanel);

        // Add "Create Custom Party" card at top
        const createCard = document.createElement('div');
        createCard.className = 'party-card party-card-create';
        createCard.style.borderColor = '#d4a843';
        createCard.innerHTML = `
            <div class="party-card-color" style="background:linear-gradient(180deg,#d4a843,#e94560)"></div>
            <div class="party-card-body">
                <h3>➕ สร้างพรรคใหม่</h3>
                <p class="party-eng-name">Create Custom Party</p>
                <div class="party-stats"><span>Design your own party</span></div>
                <p class="party-desc">Set name, color, stats, ideology, and add custom candidates.</p>
            </div>
        `;
        createCard.addEventListener('click', () => {
            document.querySelectorAll('.party-card').forEach(c => c.classList.remove('selected'));
            createCard.classList.add('selected');
            this._showPartyCreator(gameState);
        });
        grid.appendChild(createCard);

        for (const party of gameState.parties) {
            const card = document.createElement('div');
            card.className = 'party-card';
            card.style.borderColor = party.hexColor;
            card.innerHTML = `
                <div class="party-card-color" style="background:${party.hexColor}"></div>
                <div class="party-card-body">
                    <h3>${party.thaiName}${party.isCustom ? ' <span style="color:#d4a843;font-size:0.7rem">[CUSTOM]</span>' : ''}</h3>
                    <p class="party-eng-name">${party.name}</p>
                    <div class="party-stats">
                        <span>Pop: ${party.basePopularity}%</span>
                        <span>BanYai: ${party.banYaiPower}</span>
                    </div>
                    <p class="party-desc">${party.description}</p>
                </div>
            `;
            card.addEventListener('click', () => {
                document.querySelectorAll('.party-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this._showPartyDetail(party, gameState);
            });
            grid.appendChild(card);
        }
    },

    _showPartyDetail(party, gameState) {
        const detail = document.getElementById('party-detail');
        if (!detail) return;

        detail.innerHTML = `
            <div class="detail-header" style="border-left: 4px solid ${party.hexColor}">
                <h2>${party.thaiName} <span style="color:${party.hexColor}">${party.name}</span></h2>
            </div>
            <div class="detail-stats">
                <div class="stat-row"><span>Base Popularity</span><div class="stat-bar"><div class="stat-fill" style="width:${party.basePopularity}%;background:${party.hexColor}"></div></div><span>${party.basePopularity}%</span></div>
                <div class="stat-row"><span>BanYai Power</span><div class="stat-bar"><div class="stat-fill" style="width:${party.banYaiPower}%;background:#d4a843"></div></div><span>${party.banYaiPower}</span></div>
                <div class="stat-row"><span>Political Capital</span><span class="stat-value">${party.politicalCapital}</span></div>
                <div class="stat-row"><span>Grey Money</span><span class="stat-value">${party.greyMoney}</span></div>
                <div class="stat-row"><span>Scandal Meter</span><div class="stat-bar"><div class="stat-fill danger" style="width:${party.scandalMeter}%;background:#e94560"></div></div><span>${party.scandalMeter}/100</span></div>
                <div class="stat-row"><span>Ideology</span><span class="stat-value">${party.ideology < 30 ? '🕊 Progressive' : party.ideology < 60 ? '⚖️ Centrist' : '🦅 Conservative'}</span></div>
            </div>
            <div class="detail-regional">
                <h4>Regional Strength</h4>
                <div class="region-grid">
                    ${Object.entries(party.regionalPopMod || {}).map(([r, v]) => `
                        <div class="region-item">
                            <span>${r}</span>
                            <span class="${v > 0 ? 'positive' : v < 0 ? 'negative' : ''}">${v > 0 ? '+' : ''}${v}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            <button class="btn-primary btn-gold" id="btn-select-party" data-party-id="${party.id}">
                ▶ Play as ${party.thaiName}
            </button>
        `;

        document.getElementById('btn-select-party').addEventListener('click', () => {
            gameState.playerPartyId = party.id;
            window.Game.App.transition('STATE_CAMPAIGN');
        });
    },

    // ─── CUSTOM PARTY CREATOR ──────
    _showPartyCreator(gameState) {
        const detail = document.getElementById('party-detail');
        if (!detail) return;
        const eligibleBanYaiProvinces = Object.entries(window.Game.Data.PROVINCES)
            .filter(([, seats]) => seats <= 6)
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

        detail.innerHTML = `
            <div class="detail-header" style="border-left: 4px solid #d4a843">
                <h2>✨ สร้างพรรคใหม่ <span style="color:#d4a843">Create Custom Party</span></h2>
            </div>
            <div class="creator-form" id="creator-form">
                <div class="form-group">
                    <label>ชื่อพรรค (Thai Name)</label>
                    <input type="text" id="cp-thai-name" value="" placeholder="พรรคของฉัน" class="form-input">
                </div>
                <div class="form-group">
                    <label>English Name</label>
                    <input type="text" id="cp-eng-name" value="" placeholder="My Party" class="form-input">
                </div>
                <div class="form-group">
                    <label>Short Code (3 letters)</label>
                    <input type="text" id="cp-short" value="" placeholder="MYP" maxlength="4" class="form-input form-input-short">
                </div>
                <div class="form-group">
                    <label>Party Color <span id="cp-color-preview" style="display:inline-block;width:16px;height:16px;border-radius:3px;vertical-align:middle;margin-left:8px;background:#ff6b35;border:1px solid rgba(255,255,255,0.2)"></span></label>
                    <input type="color" id="cp-color" value="#ff6b35" class="form-color-input">
                </div>
                <div class="form-group">
                    <label>Base Popularity (1-35%)</label>
                    <input type="range" id="cp-pop" min="1" max="35" value="10" class="form-range">
                    <span id="cp-pop-val" class="range-val">10%</span>
                </div>
                <div class="form-group">
                    <label>BanYai Power (0-100)</label>
                    <input type="range" id="cp-banyai" min="0" max="100" value="30" class="form-range">
                    <span id="cp-banyai-val" class="range-val">30</span>
                </div>
                <div class="form-group">
                    <label>Provincial BanYai Power for selected provinces (0-100)</label>
                    <input type="range" id="cp-prov-banyai-power" min="0" max="100" value="75" class="form-range">
                    <span id="cp-prov-banyai-val" class="range-val">75</span>
                </div>
                <div class="form-group" style="border-top:1px solid var(--border-subtle);padding-top:12px;margin-top:4px;">
                    <label>Select BanYai Provinces (only provinces with 6 seats or fewer)</label>
                    <div class="prov-banyai-meta">
                        <span id="cp-prov-count">0 selected</span>
                        <span>${eligibleBanYaiProvinces.length} provinces available</span>
                    </div>
                    <div class="prov-banyai-grid" id="cp-prov-banyai-grid">
                        ${eligibleBanYaiProvinces.map(([province, seats]) => `
                            <label class="prov-banyai-item">
                                <input type="checkbox" class="cp-prov-banyai-check" data-province="${province}" data-seats="${seats}">
                                <span class="prov-banyai-name">${province}</span>
                                <span class="prov-banyai-seats">${seats} seats</span>
                            </label>
                        `).join('')}
                    </div>
                </div>
                <div class="form-group">
                    <label>Ideology: <span id="cp-ideology-label">⚖️ Centrist</span></label>
                    <input type="range" id="cp-ideology" min="0" max="100" value="50" class="form-range">
                    <span id="cp-ideology-val" class="range-val">50</span>
                </div>
                <div class="form-group">
                    <label>Political Capital</label>
                    <input type="number" id="cp-capital" value="150" min="50" max="500" class="form-input form-input-short">
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="cp-desc" rows="2" placeholder="Your party's story..." class="form-input form-textarea"></textarea>
                </div>

                <div class="form-group" style="border-top:1px solid var(--border-subtle);padding-top:12px;margin-top:8px;">
                    <label>🗺️ Regional Popularity Modifiers</label>
                    <div class="region-grid" style="margin-top:6px;">
                        ${['Bangkok','Central','North','Northeast','East','West','South'].map(r => `
                            <div class="region-item">
                                <span>${r}</span>
                                <input type="number" id="cp-reg-${r}" value="0" min="-15" max="20" class="form-input-tiny">
                            </div>
                        `).join('')}
                    </div>
                </div>

                <div class="form-group" style="border-top:1px solid var(--border-subtle);padding-top:12px;margin-top:8px;">
                    <label>👤 Custom Candidates (<span id="cp-cand-count">0</span> added)</label>
                    <button class="btn-small" id="btn-add-candidates" style="margin-top:6px;">+ Add Candidate Names</button>
                    <div id="candidates-list" style="max-height:120px;overflow-y:auto;margin-top:6px;font-size:0.8rem;"></div>
                </div>

                <button class="btn-primary btn-gold" id="btn-create-party" style="width:100%;margin-top:16px;">
                    ✨ Create Party & Play
                </button>
                <button class="btn-small" id="btn-create-only" style="margin-top:6px;text-align:center;">
                    Create Party Only (choose later)
                </button>
            </div>
        `;

        // ── Live preview bindings ──
        const colorInput = document.getElementById('cp-color');
        const colorPreview = document.getElementById('cp-color-preview');
        colorInput.addEventListener('input', () => { colorPreview.style.background = colorInput.value; });

        const popRange = document.getElementById('cp-pop');
        popRange.addEventListener('input', () => { document.getElementById('cp-pop-val').textContent = popRange.value + '%'; });

        const banyaiRange = document.getElementById('cp-banyai');
        banyaiRange.addEventListener('input', () => { document.getElementById('cp-banyai-val').textContent = banyaiRange.value; });

        const provBanyaiRange = document.getElementById('cp-prov-banyai-power');
        provBanyaiRange.addEventListener('input', () => { document.getElementById('cp-prov-banyai-val').textContent = provBanyaiRange.value; });

        const updateProvSelectionCount = () => {
            const selectedCount = detail.querySelectorAll('.cp-prov-banyai-check:checked').length;
            document.getElementById('cp-prov-count').textContent = `${selectedCount} selected`;
        };
        detail.querySelectorAll('.cp-prov-banyai-check').forEach((checkbox) => {
            checkbox.addEventListener('change', updateProvSelectionCount);
        });
        updateProvSelectionCount();

        const ideoRange = document.getElementById('cp-ideology');
        ideoRange.addEventListener('input', () => {
            const v = parseInt(ideoRange.value);
            document.getElementById('cp-ideology-val').textContent = v;
            document.getElementById('cp-ideology-label').textContent = v < 30 ? '🕊 Progressive' : v < 60 ? '⚖️ Centrist' : '🦅 Conservative';
        });

        // Candidate list management
        let customCandidates = [];

        const updateCandList = () => {
            const list = document.getElementById('candidates-list');
            document.getElementById('cp-cand-count').textContent = customCandidates.length;
            if (customCandidates.length === 0) {
                list.innerHTML = '<p style="color:var(--text-dim);font-size:0.75rem;">No custom candidates. Auto-generated names will be used.</p>';
            } else {
                list.innerHTML = customCandidates.map((n, i) => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                        <span>${i + 1}. ${n}</span>
                        <button class="cand-remove" data-idx="${i}" style="background:none;border:none;color:var(--crimson);cursor:pointer;font-size:0.8rem;">✕</button>
                    </div>
                `).join('');
                list.querySelectorAll('.cand-remove').forEach(btn => {
                    btn.addEventListener('click', () => {
                        customCandidates.splice(parseInt(btn.dataset.idx), 1);
                        updateCandList();
                    });
                });
            }
        };
        updateCandList();

        document.getElementById('btn-add-candidates').addEventListener('click', () => {
            this._showCandidateEditor(customCandidates, updateCandList);
        });

        // ── Create party handler ──
        const gatherPartyData = () => {
            const thaiName = document.getElementById('cp-thai-name').value.trim() || 'พรรคใหม่';
            const engName = document.getElementById('cp-eng-name').value.trim() || 'New Party';
            const shortName = document.getElementById('cp-short').value.trim().toUpperCase() || 'NEW';

            const regionalPopMod = {};
            ['Bangkok','Central','North','Northeast','East','West','South'].forEach(r => {
                regionalPopMod[r] = parseInt(document.getElementById('cp-reg-' + r).value) || 0;
            });

            const provincialBanYai = {};
            const invalidProvinceSelections = [];
            const provincialPower = parseInt(document.getElementById('cp-prov-banyai-power').value) || 0;
            detail.querySelectorAll('.cp-prov-banyai-check:checked').forEach((checkbox) => {
                const province = checkbox.dataset.province;
                const seatCount = parseInt(checkbox.dataset.seats) || 0;
                if (seatCount <= 6) {
                    provincialBanYai[province] = provincialPower;
                } else {
                    invalidProvinceSelections.push(province);
                }
            });
            if (invalidProvinceSelections.length > 0) {
                this.showNotification('Some invalid BanYai province selections (>6 seats) were ignored.', 'error');
            }

            return {
                name: engName,
                thaiName: thaiName,
                shortName: shortName,
                hexColor: document.getElementById('cp-color').value,
                basePopularity: parseInt(document.getElementById('cp-pop').value),
                banYaiPower: parseInt(document.getElementById('cp-banyai').value),
                ideology: parseInt(document.getElementById('cp-ideology').value),
                politicalCapital: parseInt(document.getElementById('cp-capital').value) || 150,
                greyMoney: 0,
                description: document.getElementById('cp-desc').value.trim() || 'A custom political party.',
                regionalPopMod: regionalPopMod,
                regionalBanYai: {},
                provincialBanYai: provincialBanYai,
                customCandidates: [...customCandidates]
            };
        };

        document.getElementById('btn-create-party').addEventListener('click', () => {
            const data = gatherPartyData();
            const newParty = window.Game.App.addCustomParty(data);
            gameState.playerPartyId = newParty.id;
            this.showNotification(`🎉 ${newParty.thaiName} created! Starting campaign...`, 'success');
            setTimeout(() => window.Game.App.transition('STATE_CAMPAIGN'), 600);
        });

        document.getElementById('btn-create-only').addEventListener('click', () => {
            const data = gatherPartyData();
            window.Game.App.addCustomParty(data);
            this.showNotification(`✅ Party added! Select it from the list.`, 'success');
            this.renderSetup(gameState);
        });
    },

    _showCandidateEditor(candidatesList, onUpdate) {
        const modal = document.getElementById('modal');
        modal.innerHTML = `
            <div class="modal-content mp-picker-modal">
                <div class="modal-header">
                    <h3>👤 Add Candidate Names</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:12px;">
                    Add up to 20 custom candidate names. These will be assigned as your party's top candidates.
                    Enter one name per line.
                </p>
                <textarea id="cand-bulk-input" rows="10" class="form-input form-textarea" style="width:100%;font-size:0.85rem;" placeholder="สมชาย ใจดี&#10;พรทิพย์ แสงทอง&#10;ธนกร ศรีสุข">${candidatesList.join('\n')}</textarea>
                <div style="display:flex;gap:8px;margin-top:12px;">
                    <button class="btn-primary" id="btn-save-candidates" style="flex:1;">💾 Save Candidates</button>
                    <button class="btn-small" id="btn-gen-random" style="flex:0.6;text-align:center;">🎲 Generate Random</button>
                </div>
                <p style="font-size:0.7rem;color:var(--text-dim);margin-top:8px;">
                    ${candidatesList.length}/20 candidates. Remaining slots will use auto-generated Thai names.
                </p>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));

        document.getElementById('btn-gen-random').addEventListener('click', () => {
            const area = document.getElementById('cand-bulk-input');
            const existing = area.value.trim();
            const names = window.Game.Data.generateRoster(5);
            area.value = existing ? existing + '\n' + names.join('\n') : names.join('\n');
        });

        document.getElementById('btn-save-candidates').addEventListener('click', () => {
            const text = document.getElementById('cand-bulk-input').value.trim();
            const names = text.split('\n').map(n => n.trim()).filter(n => n.length > 0).slice(0, 20);
            candidatesList.length = 0;
            candidatesList.push(...names);
            onUpdate();
            modal.classList.add('hidden');
            this.showNotification(`✅ ${names.length} candidates saved!`, 'success');
        });
    },

    // ─── CAMPAIGN SCREEN ────
    renderCampaign(gameState) {
        this.show('screen-campaign');

        // Make sure map is in the campaign screen
        const campaignScreen = document.getElementById('screen-campaign');
        const mapEl = document.getElementById('map-container');
        if (campaignScreen && mapEl) {
            // Insert map as first child of campaign screen
            campaignScreen.insertBefore(mapEl, campaignScreen.firstChild);
        }

        const sidebar = document.getElementById('campaign-sidebar');
        if (!sidebar) return;

        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const maxTurns = window.Game.Engine.Campaign.getMaxCampaignTurns(gameState);
        const apPerTurn = window.Game.Engine.Campaign.getAPPerTurn(gameState);
        const momentum = (gameState.campaignMomentum && gameState.campaignMomentum[gameState.playerPartyId]) || 0;
        const momentumColor = momentum > 0 ? 'var(--success)' : (momentum < 0 ? 'var(--crimson)' : 'var(--text-secondary)');

        sidebar.innerHTML = `
            <div class="campaign-header">
                <h2>📢 Campaign Season</h2>
                <div class="campaign-info-row">
                    <div class="info-chip">
                        <span class="info-label">Week</span>
                        <span class="info-value">${gameState.campaignTurn}/${maxTurns}</span>
                    </div>
                    <div class="info-chip">
                        <span class="info-label">AP</span>
                        <span class="info-value ap-value">${gameState.actionPoints}/${apPerTurn}</span>
                    </div>
                    <div class="info-chip">
                        <span class="info-label">Momentum</span>
                        <span class="info-value" style="color:${momentumColor}">${momentum > 0 ? '+' : ''}${momentum}</span>
                    </div>
                </div>
                <div class="player-party-badge" style="border-color:${playerParty.hexColor}">
                    <span style="color:${playerParty.hexColor}">${playerParty.thaiName}</span>
                    <span>Capital: ${playerParty.politicalCapital} | Grey: ${playerParty.greyMoney}</span>
                </div>
                ${gameState.pendingCampaignEvent ? '<p style="font-size:0.75rem;color:var(--gold);margin-bottom:8px;">Weekly event pending: choose a response to continue.</p>' : ''}
                <button class="btn-primary btn-end-turn" id="btn-end-campaign-turn">
                    ${gameState.campaignTurn >= maxTurns ? '🗳️ Hold Election' : '➡️ End Week'}
                </button>
            </div>
            <div class="action-cards" id="action-cards"></div>
            ${(gameState.campaignPromises && gameState.campaignPromises.length > 0) ? `
                <div class="promise-tracker">
                    <h4>📜 Campaign Promises</h4>
                    ${gameState.campaignPromises.map(p => `
                        <div class="promise-chip">${p.engName}</div>
                    `).join('')}
                </div>
            ` : ''}
        `;

        // Render action cards
        this._renderActionCards(gameState);

        // Province click handler for campaign
        this.onProvinceClick = (provinceName) => {
            this._showCampaignProvinceMenu(provinceName, gameState);
        };

        document.getElementById('btn-end-campaign-turn').addEventListener('click', () => {
            window.Game.App.endCampaignTurn();
        });

        if (gameState.pendingCampaignEvent) {
            setTimeout(() => this.renderCampaignEvent(gameState, gameState.pendingCampaignEvent), 60);
        }
    },

    renderCampaignEvent(gameState, event) {
        const modal = document.getElementById('modal');
        if (!modal || !event) return;

        modal.innerHTML = `
            <div class="modal-content" style="max-width:620px;">
                <div class="modal-header">
                    <h3>📰 Weekly Campaign Event</h3>
                </div>
                <div style="margin-bottom:10px;">
                    <div style="font-family:var(--font-main);font-size:1rem;color:var(--gold);">${event.title}</div>
                    <p style="font-size:0.85rem;color:var(--text-secondary);margin-top:4px;line-height:1.45;">${event.description}</p>
                </div>
                <div class="promise-list" style="max-height:none;">
                    ${event.options.map((opt, idx) => `
                        <button class="btn-party-pick campaign-event-option" data-idx="${idx}" style="width:100%;border-left-color:var(--gold);margin-bottom:8px;">
                            <div style="font-family:var(--font-main);font-size:0.92rem;">${opt.label}</div>
                            <div style="font-size:0.75rem;color:var(--text-dim);margin-top:4px;">Estimated success: ${Math.round(opt.successChance * 100)}%</div>
                        </button>
                    `).join('')}
                </div>
                <p style="font-size:0.72rem;color:var(--text-dim);margin-top:8px;">No skip option: campaign narrative moves every week.</p>
            </div>
        `;
        modal.classList.remove('hidden');

        modal.querySelectorAll('.campaign-event-option').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.classList.add('hidden');
                const optionIndex = parseInt(btn.dataset.idx, 10);
                window.Game.App.resolveCampaignEvent(optionIndex);
            });
        });
    },

    _renderActionCards(gameState) {
        const container = document.getElementById('action-cards');
        if (!container) return;
        container.innerHTML = '';

        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);

        for (const [key, action] of Object.entries(window.Game.Engine.Campaign.ACTIONS)) {
            const canAfford = gameState.actionPoints >= action.apCost;
            const hasGreyMoney = !action.requiresGreyMoney || playerParty.greyMoney >= action.requiresGreyMoney;
            const disabled = !canAfford || !hasGreyMoney;

            const card = document.createElement('div');
            card.className = `action-card ${disabled ? 'disabled' : ''}`;
            card.innerHTML = `
                <div class="action-icon">${action.icon}</div>
                <div class="action-info">
                    <div class="action-name">${action.thaiName}</div>
                    <div class="action-eng">${action.name}</div>
                    <div class="action-cost">
                        <span class="ap-cost">${action.apCost} AP</span>
                        ${action.requiresGreyMoney ? `<span class="grey-cost">${action.requiresGreyMoney} 💰</span>` : ''}
                    </div>
                </div>
            `;

            if (!disabled) {
                card.addEventListener('click', () => {
                    this._showActionTargeting(key, action, gameState);
                });
            }
            container.appendChild(card);
        }
    },

    _showCampaignProvinceMenu(provinceName, gameState) {
        const seats = window.Game.Data.PROVINCES[provinceName] || 0;
        const region = window.Game.Data.PROVINCE_REGION[provinceName] || 'Unknown';

        const modal = document.getElementById('modal');
        modal.innerHTML = `
            <div class="modal-content province-modal">
                <div class="modal-header">
                    <h3>${provinceName}</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div class="province-info">
                    <p>${region} Region • ${seats} Constituency Seats</p>
                </div>
                <div class="province-actions">
                    <button class="btn-small btn-rally" data-action="rally">📢 Rally Here (3 AP)</button>
                    <button class="btn-small btn-canvass" data-action="canvass">🚪 Canvass (2 AP)</button>
                    <button class="btn-small btn-attack" data-action="attackAd">⚔️ Attack Ad (4 AP)</button>
                    <button class="btn-small btn-io" data-action="ioOperation">🕵️ IO Op (5 AP, 30💰)</button>
                    <button class="btn-small btn-buy" data-action="buySupport">🤝 Buy Support (4 AP, 40💰)</button>
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => {
            modal.classList.add('hidden');
        });

        modal.querySelectorAll('.btn-small').forEach(btn => {
            btn.addEventListener('click', () => {
                const actionKey = btn.dataset.action;
                const action = window.Game.Engine.Campaign.ACTIONS[actionKey];
                if (!action) return;

                const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);

                if (gameState.actionPoints < action.apCost) {
                    this.showNotification("Not enough AP!", 'error');
                    return;
                }
                if (action.requiresGreyMoney && playerParty.greyMoney < action.requiresGreyMoney) {
                    this.showNotification("Not enough grey money!", 'error');
                    return;
                }

                if (actionKey === 'canvass') {
                    const provinceDistricts = (gameState.districts || []).filter(d => d.provinceName === provinceName);
                    if (provinceDistricts.length === 0) {
                        this.showNotification("No district found in this province.", 'error');
                        return;
                    }

                    const swing = window.Game.Engine.Campaign._pickBestSwingDistrict(gameState, gameState.playerPartyId);
                    const targetDistrict = (swing && swing.provinceName === provinceName)
                        ? swing
                        : provinceDistricts[Math.floor(Math.random() * provinceDistricts.length)];

                    const msg = action.execute(gameState, { districtId: targetDistrict.id });
                    gameState.actionPoints -= action.apCost;
                    this.showNotification(`${msg} (${provinceName} seat ${targetDistrict.seatIndex})`, 'success');
                    modal.classList.add('hidden');
                    this.renderCampaign(gameState);
                    return;
                }

                // For attack ad, need to pick a target party
                if (actionKey === 'attackAd' || actionKey === 'ioOperation') {
                    this._showTargetPartyPicker(gameState, (targetPartyId) => {
                        const msg = action.execute(gameState, { provinceName, targetPartyId });
                        gameState.actionPoints -= action.apCost;
                        this.showNotification(msg, 'success');
                        modal.classList.add('hidden');
                        this.renderCampaign(gameState);
                    });
                    return;
                }

                const msg = action.execute(gameState, { provinceName });
                gameState.actionPoints -= action.apCost;
                this.showNotification(msg, 'success');
                modal.classList.add('hidden');
                this.renderCampaign(gameState);
            });
        });
    },

    _showActionTargeting(actionKey, action, gameState) {
        if (['rally', 'canvass', 'attackAd', 'ioOperation', 'buySupport'].includes(actionKey)) {
            this.showNotification("Click a province on the map to target.", 'info');
            window.Game.UI.Map._mapGroup.selectAll('path.province').classed('targetable', true);
        } else if (actionKey === 'fundraise') {
            const msg = action.execute(gameState);
            gameState.actionPoints -= action.apCost;
            this.showNotification(msg, 'success');
            this.renderCampaign(gameState);
        } else if (actionKey === 'canvass') {
            this.showNotification("Click a province on the map to canvass.", 'info');
        } else if (actionKey === 'promisePolicy') {
            this._showPromisePicker(gameState);
        }
    },

    _showPromisePicker(gameState) {
        const modal = document.getElementById('modal');
        const promises = window.Game.Data.PROMISE_TEMPLATES;
        const existing = (gameState.campaignPromises || []).map(p => p.promiseId);

        modal.innerHTML = `
            <div class="modal-content mp-picker-modal">
                <div class="modal-header">
                    <h3>📜 Choose a Policy Promise</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:12px;">
                    Making a promise boosts popularity NOW but you must pass the matching law in government or lose trust!
                </p>
                <div class="promise-list">
                    ${promises.map(p => {
                        const alreadyPromised = existing.includes(p.promiseId);
                        return `
                            <div class="promise-pick-card ${alreadyPromised ? 'disabled' : ''}" data-pid="${p.promiseId}">
                                <div class="promise-icon">${p.icon}</div>
                                <div class="promise-info">
                                    <div class="promise-name">${p.name}</div>
                                    <div class="promise-eng">${p.engName}</div>
                                    <div class="promise-desc">${p.description}</div>
                                    <div class="promise-regions">Boosts: ${Object.entries(p.popularityBoost).map(([r,v]) => `${r} +${v}`).join(', ')}</div>
                                </div>
                                ${alreadyPromised ? '<span class="promise-done">✓ Promised</span>' : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));

        modal.querySelectorAll('.promise-pick-card:not(.disabled)').forEach(card => {
            card.addEventListener('click', () => {
                const promiseId = card.dataset.pid;
                const promise = promises.find(p => p.promiseId === promiseId);
                if (!promise) return;

                const action = window.Game.Engine.Campaign.ACTIONS.promisePolicy;
                if (gameState.actionPoints < action.apCost) {
                    this.showNotification("Not enough AP!", 'error');
                    return;
                }

                const msg = action.execute(gameState, { promise });
                gameState.actionPoints -= action.apCost;
                this.showNotification(msg, 'success');
                modal.classList.add('hidden');
                this.renderCampaign(gameState);
            });
        });
    },

    _showTargetPartyPicker(gameState, callback, options = {}) {
        const modal = document.getElementById('modal');
        const allowedPartyIds = Array.isArray(options.partyIds) ? new Set(options.partyIds) : null;
        const other = gameState.parties.filter(p =>
            p.id !== gameState.playerPartyId && (!allowedPartyIds || allowedPartyIds.has(p.id))
        );
        if (other.length === 0) {
            this.showNotification(options.emptyMessage || 'No available party targets.', 'error');
            return;
        }
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header"><h3>${options.title || 'Select Target Party'}</h3><button class="modal-close" id="modal-close">✕</button></div>
                <div class="party-picker">
                    ${other.map(p => `<button class="btn-party-pick" data-pid="${p.id}" style="border-color:${p.hexColor}">
                        <span style="color:${p.hexColor}">${p.thaiName}</span>
                    </button>`).join('')}
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));
        modal.querySelectorAll('.btn-party-pick').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.classList.add('hidden');
                callback(btn.dataset.pid);
            });
        });
    },

    // ─── ELECTION RESULTS SCREEN ───
    renderElectionResults(gameState) {
        this.show('screen-election');

        // Move map to election screen container
        const elMapContainer = document.getElementById('map-container-election');
        const mapEl = document.getElementById('map-container');
        if (elMapContainer && mapEl) {
            elMapContainer.innerHTML = '';
            elMapContainer.appendChild(mapEl);
        }

        const panel = document.getElementById('election-results-panel');
        if (!panel) return;

        const results = gameState.electionResults;
        const parties = gameState.parties;

        // Animate map
        window.Game.UI.Map.updateMapColors(results, parties, gameState.districts, true);

        // Sort parties by total seats
        const sorted = [...parties].sort((a, b) => results.totalSeats[b.id] - results.totalSeats[a.id]);

        panel.innerHTML = `
            <div class="results-header">
                <h2>🗳️ Election Results 2569</h2>
                <p class="results-subtitle">500-Seat Parliament</p>
            </div>
            <div class="results-chart" id="results-chart"></div>
            <div class="results-table">
                <div class="results-table-header">
                    <span>Party</span><span>Constituency</span><span>Party List</span><span>Total</span>
                </div>
                ${sorted.map(p => `
                    <div class="results-row ${p.id === gameState.playerPartyId ? 'player-row' : ''}">
                        <span class="results-party">
                            <span class="party-dot" style="background:${p.hexColor}"></span>
                            ${p.thaiName} <small>${p.shortName}</small>
                        </span>
                        <span>${results.constituencyWins[p.id]}</span>
                        <span>${results.partyListSeats[p.id]}</span>
                        <span class="results-total">${results.totalSeats[p.id]}</span>
                    </div>
                `).join('')}
            </div>
            <div class="results-footer">
                <div class="majority-line">
                    <span>Majority: 251 seats</span>
                    <div class="majority-bar">
                        ${sorted.map(p => `<div class="majority-segment" style="width:${results.totalSeats[p.id] / 5}%;background:${p.hexColor}" title="${p.shortName}: ${results.totalSeats[p.id]}"></div>`).join('')}
                        <div class="majority-marker" style="left:50.2%"></div>
                    </div>
                </div>
            </div>
            <button class="btn-primary btn-gold" id="btn-to-coalition">
                ➡️ Form Coalition
            </button>
        `;

        // Hemicycle chart
        this._renderHemicycle('results-chart', sorted, results);

        document.getElementById('btn-to-coalition').addEventListener('click', () => {
            window.Game.App.transition('STATE_COALITION');
        });
    },

    _renderHemicycle(containerId, sortedParties, results) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const width = 400, height = 220;
        const svg = d3.select('#' + containerId)
            .append('svg')
            .attr('width', '100%')
            .attr('viewBox', `0 0 ${width} ${height}`);

        const centerX = width / 2, centerY = height - 20;
        const innerR = 60, outerR = 180;
        const totalSeats = 500;

        // Pre-compute all seat positions
        const seatData = [];
        let seatIndex = 0;
        for (const party of sortedParties) {
            const count = results.totalSeats[party.id];
            for (let i = 0; i < count; i++) {
                const angle = Math.PI - (seatIndex / totalSeats) * Math.PI;
                const row = (seatIndex % 5);
                const r = innerR + (outerR - innerR) * (row / 5);
                seatData.push({
                    x: centerX + r * Math.cos(angle),
                    y: centerY - r * Math.sin(angle),
                    color: party.hexColor,
                    idx: seatIndex
                });
                seatIndex++;
            }
        }

        // Batch render all circles at once (much faster than 500 individual appends)
        svg.selectAll('circle.seat')
            .data(seatData)
            .enter()
            .append('circle')
            .attr('class', 'seat')
            .attr('cx', d => d.x)
            .attr('cy', d => d.y)
            .attr('r', 2.5)
            .attr('fill', d => d.color)
            .attr('opacity', 0)
            .transition()
            .delay(d => d.idx * 3)
            .duration(200)
            .attr('opacity', 0.9);
    },

    // ─── COALITION SCREEN ───────
    renderCoalition(gameState) {
        this.show('screen-coalition');
        const panel = document.getElementById('coalition-panel');
        if (!panel) return;

        const app = window.Game.App;
        const results = gameState.electionResults;
        const parties = gameState.parties;
        const sorted = [...parties].sort((a, b) => results.totalSeats[b.id] - results.totalSeats[a.id]);
        const coalitionSeats = (gameState.coalitionPartyIds || []).reduce(
            (sum, pid) => sum + (results.totalSeats[pid] || 0), 0
        );
        const formateurId = app.getCurrentFormateurId ? app.getCurrentFormateurId() : gameState.playerPartyId;
        const formateurParty = parties.find(p => p.id === formateurId);
        const isPlayerTurn = app.isPlayerCoalitionTurn ? app.isPlayerCoalitionTurn() : true;
        const pendingOffer = gameState.pendingCoalitionOffer || null;
        const hasGovernment = !!gameState.governmentPartyId;
        const governmentParty = parties.find(p => p.id === gameState.governmentPartyId);
        const offeringParty = pendingOffer ? parties.find(p => p.id === pendingOffer.formateurId) : null;
        const ministryPool = 20;
        const offeredMinistryTotal = app.getCoalitionOfferedMinistryTotal ? app.getCoalitionOfferedMinistryTotal() : 0;
        const remainingMinistries = Math.max(0, ministryPool - offeredMinistryTotal);
        const roundLabel = `Round ${gameState.coalitionAttempt || 1} / 2`;
        const orderNames = (gameState.coalitionOrder || [])
            .map(pid => {
                const p = parties.find(pp => pp.id === pid);
                if (!p) return '';
                const marker = pid === formateurId && !hasGovernment ? ' (Current)' : '';
                return `${p.shortName}${marker}`;
            })
            .filter(Boolean)
            .join(' -> ');

        panel.innerHTML = `
            <div class="coalition-header">
                <h2>Coalition Formation</h2>
                <p>You need <strong>251 seats</strong> to form government.</p>
                <p><strong>Mandate Order:</strong> ${orderNames || '-'}</p>
                <p><strong>Formateur:</strong> ${formateurParty ? formateurParty.thaiName : '-'} - ${roundLabel}</p>
                <p><strong>Ministry Pool:</strong> ${offeredMinistryTotal}/${ministryPool} allocated (${remainingMinistries} left)</p>
                ${pendingOffer ? `
                    <p class="coalition-warning" style="border-left-color:#f59e0b;">
                        Coalition Offer: <strong>${offeringParty ? offeringParty.thaiName : 'AI Party'}</strong> invites your party to join.
                    </p>
                ` : ''}
                <div class="coalition-counter ${coalitionSeats >= 251 ? 'viable' : ''}">
                    <span class="coalition-seats">${coalitionSeats}</span>
                    <span class="coalition-label">/ 251 required</span>
                </div>
                <div class="coalition-progress">
                    <div class="coalition-fill" style="width:${Math.min(100, coalitionSeats / 251 * 100)}%"></div>
                    <div class="coalition-marker"></div>
                </div>
            </div>
            <div class="coalition-parties">
                ${sorted.filter(p => results.totalSeats[p.id] > 0).map(p => {
                    const inCoalition = (gameState.coalitionPartyIds || []).includes(p.id);
                    const isPlayer = p.id === gameState.playerPartyId;
                    const isFormateur = p.id === formateurId;
                    const canToggleInvite = isPlayerTurn && !hasGovernment && !isPlayer;
                    const canAdjustOffer = canToggleInvite && !inCoalition;
                    const demand = (gameState.coalitionDemands || {})[p.id];
                    const offered = (gameState.coalitionMinistryOffers || {})[p.id] || 0;
                    const trustText = demand ? `Trust ${demand.trust}` : '';
                    const demandText = demand ? `Demand ${demand.ministryDemand}` : '';
                    const redLineNames = (demand && demand.redLinePartyIds && demand.redLinePartyIds.length > 0)
                        ? demand.redLinePartyIds.map(id => (parties.find(x => x.id === id) || { shortName: id }).shortName).join(', ')
                        : '-';
                    return `
                        <div class="coalition-party-card ${inCoalition ? 'in-coalition' : ''} ${isPlayer ? 'is-player' : ''} ${isFormateur ? 'is-formateur' : ''}" data-pid="${p.id}" style="border-color:${p.hexColor}">
                            <div class="cp-header">
                                <span class="party-dot" style="background:${p.hexColor}"></span>
                                <span class="cp-name">${p.thaiName}</span>
                                <span class="cp-seats">${results.totalSeats[p.id]} seats</span>
                            </div>
                            ${!isPlayer && demand ? `
                                <div style="font-size:0.72rem;color:var(--text-secondary);margin-left:4px;">
                                    ${trustText} • ${demandText} ministries • Offered ${offered}
                                </div>
                                <div style="font-size:0.68rem;color:var(--text-dim);margin-left:4px;">Red line: ${redLineNames}</div>
                            ` : ''}
                            ${isFormateur ? '<span class="cp-you">Lead Party</span>' : ''}
                            ${isPlayer ? '<span class="cp-you">Your Party</span>' : ''}
                            ${!isPlayer ? `
                                <div style="display:flex;gap:6px;align-items:center;">
                                    <button class="btn-small btn-ministry-offer" data-delta="-1" data-pid="${p.id}" style="width:34px;padding:6px 0;text-align:center;margin:0;" ${canAdjustOffer ? '' : 'disabled'}>-</button>
                                    <button class="btn-small btn-ministry-offer" data-delta="1" data-pid="${p.id}" style="width:34px;padding:6px 0;text-align:center;margin:0;" ${canAdjustOffer ? '' : 'disabled'}>+</button>
                                    <button class="btn-toggle-coalition ${inCoalition ? 'active' : ''}" data-pid="${p.id}" ${canToggleInvite ? '' : 'disabled'}>
                                        ${inCoalition ? 'Remove' : '+ Invite'}
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
            ${hasGovernment ? `
                <div class="coalition-warning" style="border-left-color:#22c55e">
                    Government formed by <strong>${governmentParty ? governmentParty.thaiName : gameState.governmentPartyId}</strong>.
                    You will play as <strong>${gameState.playerRole}</strong>.
                </div>
                <button class="btn-primary btn-gold" id="btn-continue-government">
                    Continue to Parliament
                </button>
            ` : pendingOffer ? `
                <div style="display:flex;gap:10px;">
                    <button class="btn-primary btn-gold" id="btn-accept-coalition-offer">Accept Invitation</button>
                    <button class="btn-danger" id="btn-reject-coalition-offer">Reject Invitation</button>
                </div>
            ` : isPlayerTurn ? `
                ${coalitionSeats >= 251 ? '' : `<p class="coalition-warning">Need ${251 - coalitionSeats} more seats to form government.</p>`}
                <button class="btn-primary btn-gold" id="btn-submit-coalition-attempt">
                    ${coalitionSeats >= 251 ? `Form Government (${coalitionSeats} seats)` : `Submit ${roundLabel}`}
                </button>
            ` : `
                <p class="coalition-warning">AI parties are negotiating coalition rounds.</p>
            `}
        `;

        panel.querySelectorAll('.btn-toggle-coalition').forEach(btn => {
            btn.addEventListener('click', () => {
                const pid = btn.dataset.pid;
                const result = app.tryInviteCoalitionParty(pid);
                if (!result.success && result.details) {
                    const d = result.details;
                    if (d.reason === 'ministry_shortfall') {
                        this.showNotification(
                            `${result.msg} [trust ${d.trust}, offered ${d.offered}/${d.required}, shortfall ${d.shortfall}, chance ${d.chancePercent}%]`,
                            'error'
                        );
                    } else if (d.reason === 'red_line') {
                        this.showNotification(
                            `${result.msg} [trust ${d.trust}, offered ${d.offered}/${d.required}, chance ${d.chancePercent}%]`,
                            'error'
                        );
                    } else if (d.reason === 'probability_reject') {
                        this.showNotification(
                            `${result.msg} [alliance ${d.allianceMemory}, chance ${d.chancePercent}%]`,
                            'error'
                        );
                    } else {
                        this.showNotification(result.msg, 'error');
                    }
                } else {
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                }
                this.renderCoalition(gameState);
            });
        });

        panel.querySelectorAll('.btn-ministry-offer').forEach(btn => {
            btn.addEventListener('click', () => {
                const pid = btn.dataset.pid;
                const delta = parseInt(btn.dataset.delta, 10);
                const result = app.adjustCoalitionOffer(pid, delta);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                this.renderCoalition(gameState);
            });
        });

        const submitBtn = document.getElementById('btn-submit-coalition-attempt');
        if (submitBtn) submitBtn.addEventListener('click', () => app.submitCoalitionAttempt());

        const continueBtn = document.getElementById('btn-continue-government');
        if (continueBtn) continueBtn.addEventListener('click', () => app.transition('STATE_PARLIAMENT_TERM'));

        const acceptOfferBtn = document.getElementById('btn-accept-coalition-offer');
        if (acceptOfferBtn) acceptOfferBtn.addEventListener('click', () => app.respondToCoalitionOffer(true));

        const rejectOfferBtn = document.getElementById('btn-reject-coalition-offer');
        if (rejectOfferBtn) rejectOfferBtn.addEventListener('click', () => app.respondToCoalitionOffer(false));
    },

    // ─── Update parliament stats header without full re-render ──────
    _updateParliamentStats(gameState) {
        const headerBar = document.querySelector('.parliament-header-bar');
        if (!headerBar) return;
        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        if (!playerParty) return;
        const isOpposition = gameState.playerRole === 'opposition';
        const parliamentEngine = window.Game.Engine.Parliament;
        const govBillStatus = !isOpposition
            ? parliamentEngine.getGovernmentBillSessionStatus(gameState)
            : null;
        const pmOpsStatus = !isOpposition
            ? (typeof parliamentEngine.getPMOperationSessionStatus === 'function'
                ? parliamentEngine.getPMOperationSessionStatus(gameState)
                : { used: 0, cap: 0, remaining: 0, allowed: false })
            : null;
        if (isOpposition) {
            if (gameState.oppositionActionSession !== gameState.sessionNumber) {
                gameState.oppositionActionSession = gameState.sessionNumber;
                gameState.oppositionActionsRemaining = 2;
            }
        }
        const displayedYear = Number.isInteger(gameState.parliamentYear)
            ? gameState.parliamentYear
            : gameState.parliamentYear.toFixed(1);
        const coalitionSeats = gameState.coalitionPartyIds.reduce(
            (sum, pid) => sum + (gameState.electionResults.totalSeats[pid] || 0), 0
        );
        const statsEl = headerBar.querySelector('.parl-stats');
        if (statsEl) {
            statsEl.innerHTML = `
                <div class="parl-stat" style="border-color:${playerParty.hexColor}">
                    <span>${playerParty.thaiName}</span>
                    <span>${isOpposition ? 'Role: Opposition' : `Coalition: ${coalitionSeats} seats`}</span>
                </div>
                <div class="parl-stat">Capital: <strong>${playerParty.politicalCapital}</strong></div>
                <div class="parl-stat">Grey: <strong>${playerParty.greyMoney}</strong></div>
                <div class="parl-stat danger-stat">Scandal: <strong>${playerParty.scandalMeter}</strong>/100</div>
                ${isOpposition ? '' : `<div class="parl-stat">Bills: <strong>${govBillStatus.used}/${govBillStatus.cap}</strong></div>`}
                ${isOpposition ? '' : `<div class="parl-stat">PM Ops: <strong>${pmOpsStatus.used}/${pmOpsStatus.cap}</strong></div>`}
            `;
        }
    },

    // ─── PARLIAMENT SCREEN ──────
    renderParliament(gameState) {
        this.show('screen-parliament');
        try {

        const parlMapContainer = document.getElementById('parliament-map-container');
        const mapEl = document.getElementById('map-container');
        if (parlMapContainer && mapEl) {
            parlMapContainer.innerHTML = '';
            parlMapContainer.appendChild(mapEl);
        }

        const main = document.getElementById('parliament-main');
        if (!main) return;

        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const hasElection = !!(gameState.electionResults && gameState.electionResults.totalSeats);
        if (!playerParty || !hasElection) {
            main.innerHTML = `
                <div class="parliament-header-bar">
                    <div class="parl-info">
                        <span class="parl-year">Parliament Unavailable</span>
                        <span class="parl-session">State data incomplete</span>
                    </div>
                </div>
                <div style="padding:16px;max-width:720px;">
                    <p class="placeholder-text">Could not enter governing screen because required election/player data is missing.</p>
                    <button class="btn-primary" id="btn-recover-to-campaign" style="margin-top:10px;">Return to Campaign</button>
                </div>
            `;
            const recoverBtn = document.getElementById('btn-recover-to-campaign');
            if (recoverBtn) recoverBtn.addEventListener('click', () => window.Game.App.transition('STATE_CAMPAIGN'));
            this.showNotification('Governing data was incomplete. Returned safe fallback view.', 'error');
            return;
        }
        const isOpposition = gameState.playerRole === 'opposition';
        const parliamentEngine = window.Game.Engine.Parliament;
        const govBillStatus = !isOpposition
            ? parliamentEngine.getGovernmentBillSessionStatus(gameState)
            : null;
        const pmOpsStatus = !isOpposition
            ? (typeof parliamentEngine.getPMOperationSessionStatus === 'function'
                ? parliamentEngine.getPMOperationSessionStatus(gameState)
                : { used: 0, cap: 0, remaining: 0, allowed: false })
            : null;
        const displayedYear = Number.isInteger(gameState.parliamentYear)
            ? gameState.parliamentYear
            : gameState.parliamentYear.toFixed(1);
        const coalitionSeats = (gameState.coalitionPartyIds || []).reduce(
            (sum, pid) => sum + (gameState.electionResults.totalSeats[pid] || 0), 0
        );
        const activeWalkout = isOpposition && gameState.oppositionWalkoutPlan &&
            gameState.oppositionWalkoutPlan.sessionNumber === gameState.sessionNumber;
        const activeSplit = isOpposition && gameState.oppositionSplitPlan &&
            gameState.oppositionSplitPlan.sessionNumber === gameState.sessionNumber;

        main.innerHTML = `
            <div class="parliament-header-bar">
                <div class="parl-info">
                    <span class="parl-year">Year ${displayedYear} / 4</span>
                    <span class="parl-session">Session ${gameState.sessionNumber}</span>
                </div>
                <div class="parl-stats">
                    <div class="parl-stat" style="border-color:${playerParty.hexColor}">
                        <span>${playerParty.thaiName}</span>
                        <span>${isOpposition ? 'Role: Opposition' : `Coalition: ${coalitionSeats} seats`}</span>
                    </div>
                    <div class="parl-stat">Capital: <strong>${playerParty.politicalCapital}</strong></div>
                    <div class="parl-stat">Grey: <strong>${playerParty.greyMoney}</strong></div>
                    <div class="parl-stat danger-stat">Scandal: <strong>${playerParty.scandalMeter}</strong>/100</div>
                    ${isOpposition ? '' : `<div class="parl-stat">Bills: <strong>${govBillStatus.used}/${govBillStatus.cap}</strong></div>`}
                    ${isOpposition ? '' : `<div class="parl-stat">PM Ops: <strong>${pmOpsStatus.used}/${pmOpsStatus.cap}</strong></div>`}
                </div>
            </div>

            ${(gameState.campaignPromises && gameState.campaignPromises.length > 0) ? `
                <div class="promise-tracker-full">
                    <h3>Campaign Promises</h3>
                    <div class="promise-chips">
                        ${gameState.campaignPromises.map(p => `
                            <div class="promise-chip-full ${p.fulfilled ? 'fulfilled' : ''} ${p.failed ? 'failed' : ''}">
                                <span>${p.engName}</span>
                                <span class="promise-status">${p.fulfilled ? 'Fulfilled' : p.failed ? 'Failed' : 'Pending'}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}

            <div class="parliament-grid">
                <div class="parl-col parl-bills">
                    <h3>${isOpposition ? 'Opposition Desk' : 'Propose a Bill'}</h3>
                    <div class="bill-list" id="bill-list">
                        ${isOpposition ? `
                            <div class="placeholder-text">You are in opposition. Government bills are not under your control.</div>
                            <div class="placeholder-text" style="margin-top:8px;">Opposition actions left this session: <strong>${gameState.oppositionActionsRemaining || 0}/2</strong></div>
                            <div class="placeholder-text" style="margin-top:6px;">${activeWalkout ? `Walkout primed: up to ${gameState.oppositionWalkoutPlan.swingSeats || 0} votes may abstain on next bill.` : 'No walkout primed this session.'}</div>
                            <div class="placeholder-text" style="margin-top:6px;">${activeSplit ? `Split primed: ${gameState.oppositionSplitPlan.targetPartyId} may abstain (${gameState.oppositionSplitPlan.abstainSeats || 0}).` : 'No coalition split primed this session.'}</div>
                            <button class="btn-shadow" id="btn-opp-scrutiny" style="margin-top:12px">Launch Scrutiny Campaign (-30 cap)</button>
                            <button class="btn-shadow" id="btn-opp-townhall" style="margin-top:8px">Hold Public Townhall (-20 cap)</button>
                            <button class="btn-shadow" id="btn-opp-walkout" style="margin-top:8px">Parliamentary Walkout (-25 cap)</button>
                            <button class="btn-shadow" id="btn-opp-split" style="margin-top:8px">Coalition Split Attempt (-25 cap, -40 grey)</button>
                        ` : ''}
                    </div>
                </div>
                <div class="parl-col parl-voting">
                    <h3>Voting Chamber</h3>
                    <div id="voting-area">
                        ${isOpposition ? `
                            <p class="placeholder-text">Government bills awaiting your vote:</p>
                            <div class="promise-chips">
                                ${(gameState.governmentBillQueue && gameState.governmentBillQueue.length > 0)
                                    ? gameState.governmentBillQueue.map(item => {
                                        const fSupport = window.Game.Engine.Parliament.projectGovernmentBillVote(gameState, item, 'support');
                                        const fOppose = window.Game.Engine.Parliament.projectGovernmentBillVote(gameState, item, 'oppose');
                                        const fAbstain = window.Game.Engine.Parliament.projectGovernmentBillVote(gameState, item, 'abstain');
                                        const forecastRow = (label, f, baseDelta) => {
                                            const regionSummary = Object.entries(f.regionalExpected || {})
                                                .map(([r, v]) => `${r} ${v > 0 ? '+' : ''}${v}`)
                                                .join(', ');
                                            const disruptionSummary = Array.isArray(f.disruptionSummary)
                                                ? f.disruptionSummary.join(' | ')
                                                : '';
                                            return `
                                            <div style="margin-top:6px;padding:6px;background:rgba(255,255,255,0.03);border-radius:6px;">
                                                <div style="display:flex;justify-content:space-between;font-size:0.75rem;">
                                                    <span>${label}</span>
                                                    <span>${f.passed ? 'Likely Pass' : 'Likely Fail'} · You ${baseDelta > 0 ? '+' : ''}${baseDelta}</span>
                                                </div>
                                                ${regionSummary ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:3px;">Regional: ${regionSummary}</div>` : ''}
                                                ${disruptionSummary ? `<div style="font-size:0.7rem;color:var(--gold);margin-top:3px;">Disruption: ${disruptionSummary}</div>` : ''}
                                                <div style="display:flex;height:7px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,0.06);margin-top:4px;">
                                                    <div style="width:${f.aye / 5}%;background:#22c55e"></div>
                                                    <div style="width:${f.nay / 5}%;background:#ef4444"></div>
                                                    <div style="width:${f.abstain / 5}%;background:#64748b"></div>
                                                </div>
                                            </div>
                                        `;
                                        };
                                        return `
                                            <div class="promise-chip-full">
                                                <span>${item.name}</span>
                                                <span class="promise-status">Pending Vote</span>
                                                <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px;">Decision forecast</div>
                                                ${forecastRow('Support', fSupport, fSupport.playerBaseDelta)}
                                                ${forecastRow('Oppose', fOppose, fOppose.playerBaseDelta)}
                                                ${forecastRow('Abstain', fAbstain, fAbstain.playerBaseDelta)}
                                                <div style="display:flex;gap:8px;margin-top:8px;">
                                                    <button class="btn-shadow btn-gov-vote" data-bill-id="${item.id}" data-stance="support">Support</button>
                                                    <button class="btn-shadow btn-gov-vote" data-bill-id="${item.id}" data-stance="oppose">Oppose</button>
                                                    <button class="btn-shadow btn-gov-vote" data-bill-id="${item.id}" data-stance="abstain">Abstain</button>
                                                </div>
                                            </div>
                                        `;
                                    }).join('')
                                    : '<div class="placeholder-text">No pending government bill right now.</div>'
                                }
                            </div>
                            <p class="placeholder-text" style="margin-top:12px;">Recent outcomes:</p>
                            <div class="promise-chips">
                                ${(gameState.governmentBillLog && gameState.governmentBillLog.length > 0)
                                    ? gameState.governmentBillLog.slice(0, 5).map(item => `
                                        <div class="promise-chip-full">
                                            <span>${item.name}</span>
                                            <span class="promise-status">${item.passed ? 'Passed' : 'Failed'}${item.stance ? ` - You: ${item.stance}` : ''}${item.disruptionApplied && item.disruptionApplied.length > 0 ? ' - Disrupted' : ''}</span>
                                        </div>
                                    `).join('')
                                    : '<div class="placeholder-text">No government bill has been resolved yet.</div>'
                                }
                            </div>
                        ` : '<p class="placeholder-text">Select a bill to propose</p>'}
                    </div>
                </div>
                <div class="parl-col parl-shadow">
                    <h3>${isOpposition ? 'Opposition Tools' : 'Shadow Politics'}</h3>
                    ${isOpposition ? '' : `
                        <div style="margin-bottom:12px;padding:10px;border:1px solid var(--border-subtle);border-radius:10px;background:rgba(255,255,255,0.02);">
                            <h4 style="margin:0 0 8px 0;font-size:0.84rem;color:var(--gold);">Prime Minister Operations</h4>
                            <div class="placeholder-text" style="margin-bottom:8px;">Session usage: <strong>${pmOpsStatus.used}/${pmOpsStatus.cap}</strong></div>
                            <div style="display:grid;gap:6px;">
                                <button class="btn-small" id="btn-pm-cabinet" ${pmOpsStatus.allowed ? '' : 'disabled'}>Cabinet Meeting (-38 cap)</button>
                                <button class="btn-small" id="btn-pm-inspection" ${pmOpsStatus.allowed ? '' : 'disabled'}>Field Inspection (-30 cap)</button>
                                <button class="btn-small" id="btn-pm-emergency" ${pmOpsStatus.allowed ? '' : 'disabled'}>Emergency Order (-55 cap)</button>
                            </div>
                            <div style="font-size:0.68rem;color:var(--text-dim);margin-top:6px;">Repeated use has diminishing returns.</div>
                        </div>
                    `}
                    <div class="shadow-actions">
                        <button class="btn-shadow" id="btn-siphon">Siphon Funds</button>
                        <button class="btn-shadow" id="btn-io-deploy">Deploy IO</button>
                        <button class="btn-shadow" id="btn-banana">Distribute Bananas</button>
                    </div>
                    <div id="shadow-result"></div>

                    <h4 style="margin-top:20px">Actions</h4>
                    <button class="btn-danger" id="btn-no-confidence">
                        ${isOpposition ? 'Launch No-Confidence Motion (-40 cap, 1 action)' : 'Test No-Confidence Survival'}
                    </button>
                    <button class="btn-primary" id="btn-next-half-year" style="margin-top:10px">
                        Next 6 Months
                    </button>
                    <button class="btn-primary" id="btn-next-year" style="margin-top:10px">
                        Next Year
                    </button>
                    ${isOpposition ? '' : `
                        <button class="btn-danger" id="btn-dissolve" style="margin-top:5px">
                            Dissolve Parliament
                        </button>
                    `}
                </div>
            </div>
        `;

        if (!isOpposition) {
            this._renderBillList(gameState);
        }

        const consumeOppositionAction = (capitalCost = 0, checkOnly = false) => {
            if (!isOpposition) return true;
            const left = gameState.oppositionActionsRemaining || 0;
            if (left <= 0) {
                this.showNotification('No opposition actions left this session. Advance time.', 'error');
                return false;
            }
            if (playerParty.politicalCapital < capitalCost) {
                this.showNotification(`Not enough political capital. Need ${capitalCost}.`, 'error');
                return false;
            }
            if (checkOnly) return true;
            playerParty.politicalCapital -= capitalCost;
            gameState.oppositionActionsRemaining = left - 1;
            return true;
        };

        document.getElementById('btn-siphon').addEventListener('click', () => {
            if (!consumeOppositionAction(0, true)) return;
            const result = window.Game.Engine.Shadow.siphonFunds(gameState, 50);
            if (result.success) consumeOppositionAction(0);
            document.getElementById('shadow-result').innerHTML = `<p class="${result.success ? 'success-text' : 'error-text'}">${result.msg}</p>`;
            this.renderParliament(gameState);
        });

        document.getElementById('btn-io-deploy').addEventListener('click', () => {
            if (!consumeOppositionAction(0, true)) return;
            this._showTargetPartyPicker(gameState, (targetPartyId) => {
                this.showNotification('Click a province on the map for IO target.', 'info');
                this.onProvinceClick = (provinceName) => {
                    const result = window.Game.Engine.Shadow.deployIO(gameState, targetPartyId, provinceName);
                    if (result.success) consumeOppositionAction(0);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                    this.onProvinceClick = null;
                };
            });
        });

        document.getElementById('btn-banana').addEventListener('click', () => {
            if (!consumeOppositionAction(0, true)) return;
            this._showMPPicker(gameState, (mpId) => {
                const result = window.Game.Engine.Shadow.distributeBanana(gameState, mpId);
                if (result.success) consumeOppositionAction(0);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                this.renderParliament(gameState);
            });
        });

        document.getElementById('btn-no-confidence').addEventListener('click', () => {
            if (!consumeOppositionAction(40)) return;
            const result = window.Game.Engine.Parliament.runNoConfidence(gameState);
            this._updateParliamentStats(gameState);
            window.Game.App.logRunEvent(
                'parliament',
                `No-confidence motion: ${result.motionPassed ? 'PASSED' : 'FAILED'} (${result.aye}-${result.nay}-${result.abstain}).`
            );
            this._showNoConfidenceResult(result, gameState);
        });

        if (!isOpposition) {
            const performPMOp = (operationId, opts = {}) => {
                if (typeof window.Game.Engine.Parliament.performPMOperation !== 'function') {
                    this.showNotification('PM operations unavailable. Please refresh once.', 'error');
                    return;
                }
                const result = window.Game.Engine.Parliament.performPMOperation(gameState, operationId, opts);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                if (result.success) {
                    window.Game.App.logRunEvent('parliament', `PM operation: ${operationId}.`, {
                        trustDelta: result.effects?.trustBoost || 0,
                        turningPointScore: 1.1
                    });
                }
                this.renderParliament(gameState);
            };

            const btnCabinet = document.getElementById('btn-pm-cabinet');
            if (btnCabinet) {
                btnCabinet.addEventListener('click', () => performPMOp('cabinet_meeting'));
            }

            const btnInspection = document.getElementById('btn-pm-inspection');
            if (btnInspection) {
                btnInspection.addEventListener('click', () => {
                    this.showNotification('Click a province on the map for field inspection.', 'info');
                    this.onProvinceClick = (provinceName) => {
                        performPMOp('field_inspection', { provinceName });
                        this.onProvinceClick = null;
                    };
                });
            }

            const btnEmergency = document.getElementById('btn-pm-emergency');
            if (btnEmergency) {
                btnEmergency.addEventListener('click', () => performPMOp('emergency_order'));
            }
        }

        if (isOpposition) {
            const player = gameState.parties.find(p => p.id === gameState.playerPartyId);
            document.querySelectorAll('.btn-gov-vote').forEach(btn => {
                btn.addEventListener('click', () => {
                    const billId = btn.dataset.billId;
                    const stance = btn.dataset.stance;
                    const result = window.Game.Engine.Parliament.resolveGovernmentBillVote(gameState, billId, stance);
                    if (!result) {
                        this.showNotification('Unable to resolve this vote.', 'error');
                        return;
                    }
                    window.Game.App.logRunEvent(
                        'parliament',
                        `Opposition vote on ${result.billName}: ${result.passed ? 'PASSED' : 'FAILED'} via ${stance}.`
                    );
                    const verdict = result.passed ? 'PASSED' : 'FAILED';
                    this.showNotification(
                        `${result.billName}: ${verdict} (${result.aye}-${result.nay}-${result.abstain})${result.disruptionApplied && result.disruptionApplied.length > 0 ? ` | ${result.disruptionApplied.join(' | ')}` : ''}`,
                        result.passed ? 'success' : 'info'
                    );
                    this.renderParliament(gameState);
                });
            });

            const updateOppPop = (rawGain, label) => {
                const yearlyCap = 2.5;
                if (!gameState.oppositionPopularityYearTracker) {
                    gameState.oppositionPopularityYearTracker = { year: 1, gain: 0 };
                }
                const currentYear = Math.max(1, Math.ceil(gameState.parliamentYear || 1));
                if (gameState.oppositionPopularityYearTracker.year !== currentYear) {
                    gameState.oppositionPopularityYearTracker = { year: currentYear, gain: 0 };
                }
                const tracker = gameState.oppositionPopularityYearTracker;
                const gain = Math.round((Math.min(rawGain, Math.max(0, yearlyCap - tracker.gain))) * 10) / 10;
                tracker.gain = Math.round((tracker.gain + gain) * 10) / 10;
                player.basePopularity = Math.max(1, Math.min(60, Math.round((player.basePopularity + gain) * 10) / 10));
                this.showNotification(`${label}: +${gain} popularity (${tracker.gain}/${yearlyCap} this year)`, gain > 0 ? 'success' : 'info');
                this.renderParliament(gameState);
            };

            const scrutinyBtn = document.getElementById('btn-opp-scrutiny');
            if (scrutinyBtn) scrutinyBtn.addEventListener('click', () => {
                if (!consumeOppositionAction(30)) return;
                updateOppPop(1, 'Scrutiny campaign');
            });

            const townhallBtn = document.getElementById('btn-opp-townhall');
            if (townhallBtn) townhallBtn.addEventListener('click', () => {
                if (!consumeOppositionAction(20)) return;
                updateOppPop(1, 'Public townhall');
            });

            const walkoutBtn = document.getElementById('btn-opp-walkout');
            if (walkoutBtn) walkoutBtn.addEventListener('click', () => {
                if (!consumeOppositionAction(25, true)) return;
                const result = window.Game.Engine.Parliament.launchParliamentaryWalkout(gameState);
                if (!result.success) {
                    this.showNotification(result.msg, 'error');
                    return;
                }
                consumeOppositionAction(25);
                this.showNotification(result.msg, 'success');
                this.renderParliament(gameState);
            });

            const splitBtn = document.getElementById('btn-opp-split');
            if (splitBtn) splitBtn.addEventListener('click', () => {
                if (!consumeOppositionAction(25, true)) return;
                const splitGreyCost = 40;
                if (player.greyMoney < splitGreyCost) {
                    this.showNotification(`Not enough grey money. Need ${splitGreyCost}.`, 'error');
                    return;
                }

                const coalitionPartners = (gameState.coalitionPartyIds || [])
                    .filter(pid => pid !== gameState.governmentPartyId);
                if (coalitionPartners.length === 0) {
                    this.showNotification('No coalition partner available to split.', 'error');
                    return;
                }

                this._showTargetPartyPicker(gameState, (targetPartyId) => {
                    player.greyMoney -= splitGreyCost;
                    consumeOppositionAction(25);
                    const result = window.Game.Engine.Parliament.attemptCoalitionSplit(gameState, targetPartyId);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                }, {
                    title: 'Select Coalition Partner to Split',
                    partyIds: coalitionPartners,
                    emptyMessage: 'No coalition partner available to split.'
                });
            });
        }

        document.getElementById('btn-next-year').addEventListener('click', () => {
            window.Game.App.advanceYear();
        });
        document.getElementById('btn-next-half-year').addEventListener('click', () => {
            window.Game.App.advanceHalfYear();
        });

        const dissolveBtn = document.getElementById('btn-dissolve');
        if (dissolveBtn) {
            dissolveBtn.addEventListener('click', () => {
                if (confirm('Dissolve Parliament and trigger a new election?')) {
                    window.Game.App.transition('STATE_CAMPAIGN');
                }
            });
        }
        } catch (err) {
            console.error('renderParliament failed:', err);
            const main = document.getElementById('parliament-main');
            if (main) {
                main.innerHTML = `
                    <div class="parliament-header-bar">
                        <div class="parl-info">
                            <span class="parl-year">Parliament Error</span>
                            <span class="parl-session">Render failed</span>
                        </div>
                    </div>
                    <div style="padding:16px;max-width:760px;">
                        <p class="placeholder-text">The governing screen hit an error and was recovered safely.</p>
                        <p class="placeholder-text" style="margin-top:8px;">Details: ${String(err && err.message ? err.message : err)}</p>
                        <div style="display:flex;gap:8px;margin-top:12px;">
                            <button class="btn-primary" id="btn-recover-coalition">Back to Coalition</button>
                            <button class="btn-primary" id="btn-recover-campaign">Back to Campaign</button>
                        </div>
                    </div>
                `;
                const toCoalition = document.getElementById('btn-recover-coalition');
                if (toCoalition) toCoalition.addEventListener('click', () => window.Game.App.transition('STATE_COALITION'));
                const toCampaign = document.getElementById('btn-recover-campaign');
                if (toCampaign) toCampaign.addEventListener('click', () => window.Game.App.transition('STATE_CAMPAIGN'));
            }
            this.showNotification('Parliament render error recovered. Check fallback panel.', 'error');
        }
    },
    _renderBillList(gameState) {
        const container = document.getElementById('bill-list');
        if (!container) return;

        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const sessionStatus = window.Game.Engine.Parliament.getGovernmentBillSessionStatus(gameState);
        const templates = window.Game.Data.BILL_TEMPLATES;
        container.innerHTML = '';

        const usageNote = document.createElement('p');
        usageNote.className = 'placeholder-text';
        usageNote.innerHTML = `Session bill usage: <strong>${sessionStatus.used}/${sessionStatus.cap}</strong>`;
        container.appendChild(usageNote);

        if (!sessionStatus.allowed) {
            const capReached = document.createElement('p');
            capReached.className = 'placeholder-text';
            capReached.textContent = 'Session cap reached. Advance time to open a new legislative session.';
            container.appendChild(capReached);
            return;
        }

        // Ensure passedBillNames exists
        if (!gameState.passedBillNames) gameState.passedBillNames = [];

        // Exclude already-passed bills, then pick 5 at random
        const unpassed = templates.filter(t => !gameState.passedBillNames.includes(t.name));
        if (unpassed.length === 0) {
            const allPassed = document.createElement('p');
            allPassed.className = 'placeholder-text';
            allPassed.textContent = 'All available bills have been passed this term.';
            container.appendChild(allPassed);
            return;
        }
        const available = [...unpassed].sort(() => Math.random() - 0.5).slice(0, 5);

        for (const tmpl of available) {
            const card = document.createElement('div');
            const canAfford = playerParty.politicalCapital >= tmpl.capitalCost;
            const isPromised = gameState.campaignPromises && gameState.campaignPromises.find(p => p.promiseId === tmpl.promiseId && !p.fulfilled);
            card.className = `bill-card ${canAfford ? '' : 'disabled'} ${isPromised ? 'bill-promised' : ''}`;

            // Build effects preview
            let effectsHtml = '';
            if (tmpl.effects && tmpl.effects.popularityChanges) {
                effectsHtml = '<div class="bill-effects">';
                for (const [region, change] of Object.entries(tmpl.effects.popularityChanges)) {
                    effectsHtml += `<span class="effect-chip ${change > 0 ? 'positive' : 'negative'}">${region} ${change > 0 ? '+' : ''}${change}</span>`;
                }
                if (tmpl.effects.capitalReward) effectsHtml += `<span class="effect-chip positive">+${tmpl.effects.capitalReward} cap</span>`;
                if (tmpl.effects.scandalChange) effectsHtml += `<span class="effect-chip ${tmpl.effects.scandalChange < 0 ? 'positive' : 'negative'}">${tmpl.effects.scandalChange > 0 ? '+' : ''}${tmpl.effects.scandalChange} scandal</span>`;
                effectsHtml += '</div>';
            }

            card.innerHTML = `
                <div class="bill-name">${tmpl.name} ${isPromised ? '<span class="promise-badge">📜 PROMISED</span>' : ''}</div>
                <div class="bill-desc">${tmpl.description}</div>
                ${effectsHtml}
                <div class="bill-cost">Cost: ${tmpl.capitalCost} capital</div>
            `;
            if (canAfford) {
                card.addEventListener('click', () => {
                    const bill = new window.Game.Models.Bill(tmpl);
                    this._showVotingPhase(gameState, bill);
                });
            }
            container.appendChild(card);
        }
    },

    _showVotingPhase(gameState, bill) {
        const area = document.getElementById('voting-area');
        if (!area) return;
        const sessionStatus = window.Game.Engine.Parliament.getGovernmentBillSessionStatus(gameState);
        if (!sessionStatus.allowed) {
            this.showNotification(`Session bill cap reached (${sessionStatus.used}/${sessionStatus.cap}). Advance time.`, 'error');
            this.renderParliament(gameState);
            return;
        }

        // Project votes
        const projection = window.Game.Engine.Parliament.projectVotes(gameState, bill);

        area.innerHTML = `
            <div class="vote-bill-header">
                <h3>${bill.name}</h3>
                <p>${bill.description}</p>
            </div>
            <div class="vote-projection">
                <h4>Projected Vote</h4>
                <div class="vote-bar">
                    <div class="vote-aye" style="width:${projection.aye / 5}%">${projection.aye} Aye</div>
                    <div class="vote-nay" style="width:${projection.nay / 5}%">${projection.nay} Nay</div>
                </div>
                <p class="vote-verdict ${projection.aye > projection.nay ? 'will-pass' : 'will-fail'}">
                    ${projection.aye > projection.nay ? '✅ Projected to PASS' : '❌ Projected to FAIL'}
                </p>
            </div>
            <div class="lobby-phase">
                <h4>⚡ Lobby Phase (${gameState.lobbyTurns || 3} turns remaining)</h4>
                <div class="lobby-actions">
                    <button class="btn-lobby" id="btn-quid">🤝 Quid Pro Quo (40 cap)</button>
                    <button class="btn-lobby" id="btn-whip">📋 Whip (25 cap)</button>
                    <button class="btn-lobby" id="btn-bribe-vote">💵 Bribe MP (50 grey)</button>
                </div>
            </div>
            <button class="btn-primary btn-gold" id="btn-call-vote" style="margin-top:15px">
                🔨 Call The Vote (The Gavel)
            </button>
        `;

        // Lobby actions
        document.getElementById('btn-quid').addEventListener('click', () => {
            this._showTargetPartyPicker(gameState, (targetPartyId) => {
                const msg = window.Game.Engine.Parliament.lobbyActions.quidProQuo.execute(gameState, targetPartyId);
                this.showNotification(msg, 'success');
                this._showVotingPhase(gameState, bill); // Refresh projection
            });
        });

        document.getElementById('btn-whip').addEventListener('click', () => {
            const msg = window.Game.Engine.Parliament.lobbyActions.whip.execute(gameState);
            this.showNotification(msg, 'success');
            this._showVotingPhase(gameState, bill);
        });

        document.getElementById('btn-bribe-vote').addEventListener('click', () => {
            this._showMPPicker(gameState, (mpId) => {
                const msg = window.Game.Engine.Parliament.lobbyActions.bribe.execute(gameState, mpId);
                this.showNotification(msg, 'success');
                this._showVotingPhase(gameState, bill);
            });
        });

        document.getElementById('btn-call-vote').addEventListener('click', () => {
            const latestSessionStatus = window.Game.Engine.Parliament.getGovernmentBillSessionStatus(gameState);
            if (!latestSessionStatus.allowed) {
                this.showNotification(`Session bill cap reached (${latestSessionStatus.used}/${latestSessionStatus.cap}). Advance time.`, 'error');
                this.renderParliament(gameState);
                return;
            }
            const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
            const cost = bill.capitalCost || 0;
            if (!playerParty || playerParty.politicalCapital < cost) {
                this.showNotification(`Not enough political capital to call vote. Need ${cost}.`, 'error');
                return;
            }

            // Deduct bill cost only when player actually calls the vote.
            playerParty.politicalCapital -= cost;
            const result = window.Game.Engine.Parliament.executeVote(gameState, bill);
            window.Game.Engine.Parliament.consumeGovernmentBillSessionSlot(gameState);
            this._updateParliamentStats(gameState);
            this._showVoteResult(result, bill, gameState);
        });
    },

    _showVoteResult(result, bill, gameState) {
        const area = document.getElementById('voting-area');
        if (!area) return;

        window.Game.App.logRunEvent(
            'parliament',
            `Government bill ${bill.name}: ${result.passed ? 'PASSED' : 'FAILED'} (${result.aye}-${result.nay}-${result.abstain}).`
        );
        if (window.Game.App && typeof window.Game.App.recordGovernmentBillOutcome === 'function') {
            window.Game.App.recordGovernmentBillOutcome(result.passed);
        }

        // Build effects report HTML
        let effectsHtml = '';
        if (result.effectsReport) {
            const rep = result.effectsReport;
            if (Object.keys(rep.popularityChanges).length > 0 || rep.capitalReward || rep.scandalChange) {
                effectsHtml += '<div class="vote-effects">';
                effectsHtml += `<h4>${result.passed ? '📊 Effects Applied' : '📊 Consequences'}</h4>`;
                for (const [region, change] of Object.entries(rep.popularityChanges)) {
                    effectsHtml += `<div class="effect-line"><span>${region}</span><span class="${change > 0 ? 'positive' : 'negative'}">${change > 0 ? '+' : ''}${change} popularity</span></div>`;
                }
                if (rep.capitalReward) effectsHtml += `<div class="effect-line"><span>Capital</span><span class="positive">+${rep.capitalReward}</span></div>`;
                if (rep.scandalChange) effectsHtml += `<div class="effect-line"><span>Scandal</span><span class="${rep.scandalChange < 0 ? 'positive' : 'negative'}">${rep.scandalChange > 0 ? '+' : ''}${rep.scandalChange}</span></div>`;
                if (rep.promiseFulfilled) effectsHtml += `<div class="promise-fulfilled">🎉 Campaign promise fulfilled: ${rep.promiseFulfilled}! BONUS popularity!</div>`;
                effectsHtml += '</div>';
            }
        }

        area.innerHTML = `
            <div class="vote-result ${result.passed ? 'passed' : 'failed'}">
                <h3>${result.passed ? '✅ BILL PASSED' : '❌ BILL DEFEATED'}</h3>
                <h4>${bill.name}</h4>
                <div class="vote-final-bar">
                    <div class="vote-aye" style="width:${result.aye / 5}%">${result.aye}</div>
                    <div class="vote-nay" style="width:${result.nay / 5}%">${result.nay}</div>
                </div>
                <div class="vote-breakdown">
                    <span class="aye-count">Aye: ${result.aye}</span>
                    <span class="nay-count">Nay: ${result.nay}</span>
                    <span class="abstain-count">Abstain: ${result.abstain}</span>
                </div>
                ${effectsHtml}
                <button class="btn-primary" id="btn-back-to-parliament" style="margin-top:15px;width:100%">
                    🏛️ Back to Parliament
                </button>
            </div>
        `;

        // Allow player to go back and propose more bills or advance year
        document.getElementById('btn-back-to-parliament').addEventListener('click', () => {
            this.renderParliament(gameState);
        });
    },

    _showNoConfidenceResult(result, gameState) {
        const modal = document.getElementById('modal');
        const isOpposition = gameState.playerRole === 'opposition';
        const playerWon = isOpposition ? !!result.motionPassed : !!result.survived;
        const triggerNewElection = isOpposition ? !!result.motionPassed : !result.survived;

        modal.innerHTML = `
            <div class="modal-content nc-result ${playerWon ? 'nc-survived' : 'nc-failed'}">
                <h2>${isOpposition ? (playerWon ? 'MOTION PASSED!' : 'MOTION FAILED!') : (result.survived ? 'SURVIVED!' : 'OUSTED!')}</h2>
                <h3>No-Confidence Motion</h3>
                <div class="nc-scores">
                    <div class="nc-for">Remove: ${result.aye}</div>
                    <div class="nc-against">Keep: ${result.nay}</div>
                    <div class="nc-abstain">Abstain: ${result.abstain}</div>
                </div>
                <p>${isOpposition
                    ? (playerWon ? 'You successfully toppled the government!' : 'The government survives this round.')
                    : (result.survived ? 'Your government survives! The coalition holds.' : 'The opposition has toppled your government!')}</p>
                <button class="btn-primary" id="btn-nc-close">
                    ${triggerNewElection ? 'New Election ->' : 'Continue'}
                </button>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('btn-nc-close').addEventListener('click', () => {
            modal.classList.add('hidden');
            if (triggerNewElection) {
                window.Game.App.transition('STATE_CAMPAIGN');
            }
        });
    },
    _showMPPicker(gameState, callback) {
        const modal = document.getElementById('modal');
        const oppositionMPs = (gameState.seatedMPs || [])
            .filter(mp => !gameState.coalitionPartyIds.includes(mp.partyId))
            .sort((a, b) => b.corruptionLevel - a.corruptionLevel)
            .slice(0, 20);

        modal.innerHTML = `
            <div class="modal-content mp-picker-modal">
                <div class="modal-header">
                    <h3>Select an Opposition MP</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div class="mp-list">
                    ${oppositionMPs.map(mp => {
                        const party = gameState.parties.find(p => p.id === mp.partyId);
                        return `
                            <div class="mp-pick-card" data-mpid="${mp.id}">
                                <span class="mp-name">${mp.name}</span>
                                <span class="party-dot" style="background:${party ? party.hexColor : '#666'}"></span>
                                <span class="mp-corruption">Corruption: ${mp.corruptionLevel}</span>
                                <span class="mp-loyalty">Loyalty: ${mp.loyaltyToParty}</span>
                                ${mp.isCobra ? '<span class="cobra-badge">🐍</span>' : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));
        modal.querySelectorAll('.mp-pick-card').forEach(card => {
            card.addEventListener('click', () => {
                modal.classList.add('hidden');
                callback(parseInt(card.dataset.mpid));
            });
        });
    },

    // ─── CRISIS EVENTS UI ─────
    renderCrisis(gameState, crisis) {
        if (gameState.playerRole === 'opposition') {
            this.showNotification('Government handles crisis response while you are in opposition.', 'info');
            if (window.Game.App && typeof window.Game.App.continueAfterCrisis === 'function') {
                window.Game.App.continueAfterCrisis();
            }
            return;
        }

        const modal = document.getElementById('modal');
        const severityColor = crisis.severity === 'severe' ? '#e94560' : crisis.severity === 'moderate' ? '#d4a843' : '#4a9eff';
        const severityLabel = crisis.severity === 'severe' ? '🔴 SEVERE' : crisis.severity === 'moderate' ? '🟡 MODERATE' : '🔵 MINOR';
        const categoryLabel = {
            war: '⚔️ Security', economic: '📉 Economic', social: '✊ Social',
            coalition: '🤝 Coalition', crime: '🔫 Crime', disaster: '🌊 Disaster', parliament: '🏛️ Parliament'
        }[crisis.category] || crisis.category;
        const chainBadge = crisis.isGovernmentChain
            ? `<div style="margin-top:8px;font-size:0.78rem;color:${severityColor};font-weight:600;">⛓️ Government Crisis Chain • Step ${crisis.chainStep || 1}/${crisis.chainTotalSteps || 1}</div>`
            : '';
        const stressSummary = (gameState.governmentStress && Number.isFinite(gameState.governmentStress.total))
            ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:6px;">Pressure index: ${gameState.governmentStress.total} (scandal ${gameState.governmentStress.scandalPoints || 0}, failed bills ${gameState.governmentStress.failedBillPoints || 0}, streak ${gameState.governmentStress.streakBonus || 0})</div>`
            : '';

        modal.innerHTML = `
            <div class="modal-content crisis-modal" style="max-width:650px;">
                <div class="crisis-header" style="border-bottom:2px solid ${severityColor};padding-bottom:16px;margin-bottom:16px;">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
                        <span style="font-size:2.5rem;">${crisis.icon}</span>
                        <div>
                            <div style="font-size:0.75rem;color:${severityColor};font-weight:600;letter-spacing:1px;text-transform:uppercase;">${categoryLabel} • ${severityLabel}</div>
                            <h2 style="margin:2px 0;font-size:1.4rem;color:var(--text-primary);">${crisis.name}</h2>
                            <div style="font-size:0.9rem;color:var(--text-secondary);">${crisis.engName}</div>
                        </div>
                    </div>
                    <p style="font-size:0.95rem;color:var(--text-primary);line-height:1.5;margin:12px 0 0;">${crisis.description}</p>
                    <div style="font-size:0.8rem;color:var(--text-dim);margin-top:8px;">
                        🏛️ Year ${gameState.parliamentYear} of government — How will you respond?
                    </div>
                    ${chainBadge}
                    ${stressSummary}
                </div>
                <div class="crisis-options" style="display:flex;flex-direction:column;gap:12px;">
                    ${crisis.options.map((opt, idx) => `
                        <div class="crisis-option-card" data-idx="${idx}" style="
                            background: var(--bg-card);
                            border: 1px solid var(--border-subtle);
                            border-radius: 10px;
                            padding: 16px;
                            cursor: pointer;
                            transition: all 0.2s ease;
                        ">
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);">${opt.label}</div>
                                <div style="font-size:0.75rem;color:var(--text-dim);background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">
                                    ${Math.round(opt.successChance * 100)}% success
                                </div>
                            </div>
                            <div style="font-size:0.85rem;color:var(--gold);margin:2px 0;">${opt.thaiLabel}</div>
                            <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:6px;">${opt.description}</div>
                            <div style="display:flex;gap:16px;margin-top:10px;font-size:0.75rem;">
                                <div style="color:#4ade80;">
                                    ✅ Win: Pop ${opt.successEffects.popularityAll > 0 ? '+' : ''}${opt.successEffects.popularityAll || 0}
                                    ${opt.successEffects.capital ? `, Cap ${opt.successEffects.capital > 0 ? '+' : ''}${opt.successEffects.capital}` : ''}
                                    ${Object.keys(opt.successEffects.regions || {}).length > 0 ? `, ${Object.entries(opt.successEffects.regions).map(([r,v]) => `${r} ${v > 0 ? '+' : ''}${v}`).join(', ')}` : ''}
                                </div>
                                <div style="color:#f87171;">
                                    ❌ Fail: Pop ${opt.failEffects.popularityAll > 0 ? '+' : ''}${opt.failEffects.popularityAll || 0}
                                    ${opt.failEffects.capital ? `, Cap ${opt.failEffects.capital > 0 ? '+' : ''}${opt.failEffects.capital}` : ''}
                                    ${opt.failEffects.scandal ? `, Scandal +${opt.failEffects.scandal}` : ''}
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        // Hover effects
        modal.querySelectorAll('.crisis-option-card').forEach(card => {
            card.addEventListener('mouseenter', () => {
                card.style.borderColor = severityColor;
                card.style.boxShadow = `0 0 20px ${severityColor}33`;
                card.style.transform = 'translateY(-2px)';
            });
            card.addEventListener('mouseleave', () => {
                card.style.borderColor = 'var(--border-subtle)';
                card.style.boxShadow = 'none';
                card.style.transform = 'none';
            });
            card.addEventListener('click', () => {
                modal.classList.add('hidden');
                window.Game.App.resolveCrisis(parseInt(card.dataset.idx));
            });
        });
    },

    renderCrisisResult(gameState, crisis, result) {
        const modal = document.getElementById('modal');
        const resultColor = result.success ? '#4ade80' : '#f87171';
        const resultIcon = result.success ? '✅' : '❌';
        const resultText = result.success ? 'CRISIS MANAGED SUCCESSFULLY' : 'RESPONSE FAILED';

        let effectsHtml = '';
        if (Object.keys(result.popularityChanges).length > 0 || result.capitalChange || result.scandalChange) {
            effectsHtml = '<div style="margin-top:16px;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;">';
            effectsHtml += '<h4 style="margin:0 0 8px;font-size:0.85rem;color:var(--text-secondary);">📊 Effects Applied</h4>';
            for (const [region, change] of Object.entries(result.popularityChanges)) {
                const color = change > 0 ? '#4ade80' : '#f87171';
                effectsHtml += `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.85rem;">
                    <span style="color:var(--text-secondary);">${region} Popularity</span>
                    <span style="color:${color};font-weight:600;">${change > 0 ? '+' : ''}${change}</span>
                </div>`;
            }
            if (result.capitalChange) {
                const color = result.capitalChange > 0 ? '#4ade80' : '#f87171';
                effectsHtml += `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.85rem;">
                    <span style="color:var(--text-secondary);">Political Capital</span>
                    <span style="color:${color};font-weight:600;">${result.capitalChange > 0 ? '+' : ''}${result.capitalChange}</span>
                </div>`;
            }
            if (result.scandalChange) {
                const color = result.scandalChange < 0 ? '#4ade80' : '#f87171';
                effectsHtml += `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.85rem;">
                    <span style="color:var(--text-secondary);">Scandal</span>
                    <span style="color:${color};font-weight:600;">${result.scandalChange > 0 ? '+' : ''}${result.scandalChange}</span>
                </div>`;
            }
            effectsHtml += '</div>';
        }

        let chainHtml = '';
        if (result.chainHasNext) {
            chainHtml = `<div style="margin-top:12px;padding:10px;border-radius:8px;background:rgba(233,69,96,0.12);color:#fca5a5;font-size:0.85rem;">⛓️ Government Crisis Chain continues: step ${Math.min((result.chainStep || 1) + 1, result.chainTotalSteps || 1)}/${result.chainTotalSteps || 1} is coming next.</div>`;
        } else if (result.chainCompleted) {
            chainHtml = '<div style="margin-top:12px;padding:10px;border-radius:8px;background:rgba(74,158,255,0.12);color:#93c5fd;font-size:0.85rem;">✅ Government Crisis Chain resolved for now. Parliament can proceed.</div>';
        }
        if (Array.isArray(result.specialNotes) && result.specialNotes.length > 0) {
            chainHtml += `<div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(255,255,255,0.04);color:var(--text-secondary);font-size:0.82rem;">${result.specialNotes.map(note => `• ${note}`).join('<br/>')}</div>`;
        }

        modal.innerHTML = `
            <div class="modal-content crisis-modal" style="max-width:500px;text-align:center;">
                <div style="font-size:3rem;margin-bottom:8px;">${result.crisisIcon}</div>
                <div style="font-size:0.8rem;color:var(--text-dim);letter-spacing:1px;text-transform:uppercase;">${result.crisisName}</div>
                <h2 style="color:${resultColor};margin:8px 0;font-size:1.4rem;">${resultIcon} ${resultText}</h2>
                <div style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:4px;">
                    Your choice: <strong style="color:var(--text-primary);">${result.choiceName}</strong>
                </div>
                <div style="font-size:0.85rem;color:var(--gold);">${result.choiceThaiLabel}</div>
                ${effectsHtml}
                ${chainHtml}
                <button class="btn-primary btn-gold" id="btn-crisis-continue" style="margin-top:20px;width:100%;">
                    ➡️ ${result.chainHasNext ? 'Continue — Next Crisis Step' : 'Continue — Advance Year'}
                </button>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('btn-crisis-continue').addEventListener('click', () => {
            modal.classList.add('hidden');
            window.Game.App.continueAfterCrisis();
        });
    },

    // ─── NOTIFICATIONS ──────
    showNotification(message, type = 'info') {
        const existing = document.querySelector('.notification');
        if (existing) existing.remove();

        const notif = document.createElement('div');
        notif.className = `notification notif-${type}`;
        notif.textContent = message;
        document.body.appendChild(notif);

        setTimeout(() => notif.classList.add('show'), 10);
        setTimeout(() => {
            notif.classList.remove('show');
            setTimeout(() => notif.remove(), 300);
        }, 3000);
    },

    // ─── GAME OVER ──────────
    renderGameOver(message) {
        this.show('screen-menu');
        const menu = document.getElementById('screen-menu');
        menu.innerHTML = `
            <div class="game-over">
                <h1>🏛️ Game Over</h1>
                <p class="game-over-msg">${message}</p>
                <button class="btn-primary btn-gold" onclick="location.reload()">🔄 Play Again</button>
            </div>
        `;
    }
};
