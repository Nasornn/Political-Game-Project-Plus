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

    _isCoarsePointerInput() {
        return !!(window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches));
    },

    _extractPointerCoordinates(event) {
        if (!event) return null;
        if (event.touches && event.touches.length > 0) {
            return { x: event.touches[0].clientX, y: event.touches[0].clientY };
        }
        if (event.changedTouches && event.changedTouches.length > 0) {
            return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
        }
        if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            return { x: event.clientX, y: event.clientY };
        }
        return null;
    },

    _getPanTranslateExtent(width, height) {
        const w = Math.max(320, Number(width) || 320);
        const h = Math.max(280, Number(height) || 280);
        return [[-w * 2, -h * 2], [w * 3, h * 3]];
    },

    /**
     * Move the map SVG to a different container element.
     */
    moveTo(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const mapEl = document.getElementById('map-container');
        if (mapEl && mapEl.parentElement) {
            // Physically move the map container
            if (container.id === 'screen-campaign') {
                const sidebar = container.querySelector('#campaign-sidebar');
                if (sidebar) {
                    container.insertBefore(mapEl, sidebar);
                } else {
                    container.insertBefore(mapEl, container.firstChild);
                }
            } else {
                container.appendChild(mapEl);
            }
            requestAnimationFrame(() => this.refreshLayout(containerId));
        }
    },

    refreshLayout(containerId = this._currentContainerId) {
        const container = document.getElementById(containerId || this._currentContainerId || '');
        if (!container || !this.svg || !this.projection || !this._mapGroup) return;

        const width = Math.max(320, container.clientWidth || 500);
        const height = Math.max(280, container.clientHeight || 700);

        this._currentContainerId = container.id;
        this.svg
            .attr('viewBox', `0 0 ${width} ${height}`)
            .attr('preserveAspectRatio', 'xMidYMid meet');

        this.svg.select('rect.map-bg')
            .attr('width', width)
            .attr('height', height);

        this.projection
            .center([101.0, 15.0])
            .scale(width * 2.5)
            .translate([width / 2, height / 2]);

        this.path = d3.geoPath().projection(this.projection);
        this._sortedIndices = null;

        this._mapGroup.selectAll('path.province').attr('d', this.path);
        this._mapGroup.selectAll('text.province-label')
            .attr('transform', d => `translate(${this.path.centroid(d)})`);

        if (this._zoom && this.svg) {
            this._zoom.translateExtent(this._getPanTranslateExtent(width, height));
            const current = d3.zoomTransform(this.svg.node());
            this.svg.call(this._zoom.transform, current || d3.zoomIdentity);
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
            .attr('class', 'map-bg')
            .attr('width', width)
            .attr('height', height)
            .attr('fill', '#0a0e1a');

        // Create a group for all map content (zoom target)
        this._mapGroup = this.svg.append('g').attr('class', 'map-group');

        // Set up zoom behavior
        this._zoom = d3.zoom()
            .scaleExtent([1, 8])
            .translateExtent(this._getPanTranslateExtent(width, height))
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
                .on('pointerenter', (event, d) => this._onHover(event, d))
                .on('pointermove', (event) => this._onMove(event))
                .on('pointerleave', (event) => this._onOut(event))
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

            this.refreshLayout(containerId);

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
        if (this._isCoarsePointerInput()) return;

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
        if (!this.tooltip || this.tooltip.classed('hidden')) return;

        const point = this._extractPointerCoordinates(event);
        if (!point) return;

        const node = this.tooltip.node();
        const tipWidth = node ? (node.offsetWidth || 220) : 220;
        const tipHeight = node ? (node.offsetHeight || 120) : 120;
        const viewportWidth = window.innerWidth || 1024;
        const viewportHeight = window.innerHeight || 768;

        let left = point.x + 15;
        let top = point.y - 10;

        if ((left + tipWidth + 10) > viewportWidth) {
            left = Math.max(8, point.x - tipWidth - 15);
        }
        if ((top + tipHeight + 10) > viewportHeight) {
            top = Math.max(8, viewportHeight - tipHeight - 10);
        }
        if (top < 8) top = 8;

        this.tooltip
            .style('left', `${left + window.scrollX}px`)
            .style('top', `${top + window.scrollY}px`);
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
        if (this._isCoarsePointerInput()) {
            this.tooltip.classed('hidden', true);
        }
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
    _parliamentKeyHandler: null,
    _parliamentKeyboardIndex: 0,
    _setupThemeVariant: 'gold-chamber',
    _setupParallaxBound: false,
    _setupParallaxHandlers: null,
    _setupParallaxState: null,
    _setupParallaxFrame: 0,
    _campaignNotificationState: null,
    _campaignNotificationTimer: 0,
    _campaignMobileView: 'map',
    _campaignSwipeBound: false,
    _campaignSwipeHandlers: null,
    _parliamentMobileView: 'main',
    _parliamentSwipeBound: false,
    _parliamentSwipeHandlers: null,
    _responsiveWatcherBound: false,
    _responsiveWatcher: null,
    _multiplayerConnectPending: false,
    _multiplayerNameSeed: 'Player',

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

    _isMultiplayerSessionActive() {
        const app = window.Game && window.Game.App;
        return !!(app && app.state && app.state.multiplayer && app.state.multiplayer.enabled);
    },

    _updateMetaToolbarAvailability(screenId = this.currentScreen) {
        const isSessionScreen = !!screenId && screenId !== 'screen-setup' && screenId !== 'screen-menu';
        const setupOnlyToolsEnabled = !isSessionScreen;
        const multiplayerActive = this._isMultiplayerSessionActive();

        const saveEnabled = !multiplayerActive;
        const sandboxEnabled = setupOnlyToolsEnabled && !multiplayerActive;
        const scenarioEnabled = setupOnlyToolsEnabled && !multiplayerActive;

        this._setMetaToolbarButtonState('btn-open-save-load', saveEnabled, 'Save/Load is disabled during multiplayer.');
        this._setMetaToolbarButtonState('btn-open-history', setupOnlyToolsEnabled, 'Run History is available in Setup only.', true);
        this._setMetaToolbarButtonState('btn-open-sandbox', sandboxEnabled, multiplayerActive ? 'Sandbox is disabled during multiplayer.' : 'Sandbox is available in Setup only.', true);
        this._setMetaToolbarButtonState('btn-open-scenario', scenarioEnabled, multiplayerActive ? 'Scenario Mod is disabled during multiplayer.' : 'Scenario Mod is available in Setup only.', true);
        this._setMetaToolbarButtonState('btn-open-multiplayer', true);
    },

    _getSetupThemeVariants() {
        return [
            { id: 'gold-chamber', label: 'Gold Chamber', tone: 'Warm cinematic gold' },
            { id: 'ice-blue', label: 'Ice Blue', tone: 'Cool crystal intelligence' },
            { id: 'neutral-executive', label: 'Neutral Executive', tone: 'Clean boardroom steel' }
        ];
    },

    _applySetupThemeVariant(variantId = this._setupThemeVariant) {
        const allowed = new Set(this._getSetupThemeVariants().map(v => v.id));
        const next = allowed.has(variantId) ? variantId : 'gold-chamber';
        this._setupThemeVariant = next;

        const el = document.getElementById('screen-setup');
        if (!el) return;

        allowed.forEach(id => el.classList.remove(`setup-theme-${id}`));
        el.classList.add(`setup-theme-${next}`);
    },

    _bindSetupParallaxMotion() {
        if (this._setupParallaxBound) return;
        const el = document.getElementById('screen-setup');
        if (!el) return;

        this._setupParallaxState = {
            targetX: 0,
            targetY: 0,
            currentX: 0,
            currentY: 0,
            intensity: 0.72,
            smoothing: 0.16
        };

        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

        const applyFromPointer = (event) => {
            if (this.currentScreen !== 'screen-setup') return;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
            const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
            const state = this._setupParallaxState;
            if (!state) return;

            state.targetX = ((x - 0.5) * 2) * state.intensity;
            state.targetY = ((y - 0.5) * 2) * state.intensity;
            this._startSetupParallaxLoop();
        };

        const resetPointer = () => {
            const state = this._setupParallaxState;
            if (!state) return;
            state.targetX = 0;
            state.targetY = 0;
            this._startSetupParallaxLoop();
        };

        el.addEventListener('pointermove', applyFromPointer, { passive: true });
        el.addEventListener('pointerleave', resetPointer, { passive: true });
        el.addEventListener('pointercancel', resetPointer, { passive: true });

        this._setupParallaxHandlers = { applyFromPointer, resetPointer };
        this._setupParallaxBound = true;
        this._resetSetupParallaxMotion();
    },

    _startSetupParallaxLoop() {
        if (this._setupParallaxFrame) return;
        const el = document.getElementById('screen-setup');
        if (!el) return;

        const step = () => {
            this._setupParallaxFrame = 0;
            const state = this._setupParallaxState;
            if (!state) return;

            state.currentX += (state.targetX - state.currentX) * state.smoothing;
            state.currentY += (state.targetY - state.currentY) * state.smoothing;

            const nearTargetX = Math.abs(state.targetX - state.currentX) < 0.0004;
            const nearTargetY = Math.abs(state.targetY - state.currentY) < 0.0004;
            if (nearTargetX) state.currentX = state.targetX;
            if (nearTargetY) state.currentY = state.targetY;

            el.style.setProperty('--setup-parallax-x', state.currentX.toFixed(4));
            el.style.setProperty('--setup-parallax-y', state.currentY.toFixed(4));

            const stillMoving = !nearTargetX || !nearTargetY;
            const shouldContinue = this.currentScreen === 'screen-setup' && stillMoving;
            if (shouldContinue) {
                this._setupParallaxFrame = requestAnimationFrame(step);
            }
        };

        this._setupParallaxFrame = requestAnimationFrame(step);
    },

    _stopSetupParallaxLoop() {
        if (!this._setupParallaxFrame) return;
        cancelAnimationFrame(this._setupParallaxFrame);
        this._setupParallaxFrame = 0;
    },

    _resetSetupParallaxMotion() {
        const state = this._setupParallaxState;
        if (state) {
            state.targetX = 0;
            state.targetY = 0;
            state.currentX = 0;
            state.currentY = 0;
        }
        const el = document.getElementById('screen-setup');
        if (!el) return;
        el.style.setProperty('--setup-parallax-x', '0');
        el.style.setProperty('--setup-parallax-y', '0');
    },

    _syncCampaignNotificationBar() {
        const slot = document.getElementById('campaign-notification-slot');
        if (!slot) return;
        const content = slot.querySelector('.campaign-notification-content');
        if (!content) return;

        const state = this._campaignNotificationState;
        const hasActiveState = !!(state && state.expiresAt > Date.now());
        if (!hasActiveState) {
            slot.classList.remove('has-active');
            content.className = 'campaign-notification-content';
            content.textContent = 'No notifications yet.';
            return;
        }

        slot.classList.add('has-active');
        content.className = `campaign-notification-content notif-${state.type || 'info'}`;
        content.textContent = state.message;
    },

    _getNotificationDuration(message, isCampaign = false) {
        const length = String(message || '').trim().length;
        const base = isCampaign ? 5200 : 3400;
        const perChar = isCampaign ? 42 : 28;
        const max = isCampaign ? 14000 : 9000;
        return Math.max(base, Math.min(max, base + (length * perChar)));
    },

    _isMobileLayout() {
        return !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
    },

    _bindResponsiveWatcher() {
        if (this._responsiveWatcherBound) return;
        this._responsiveWatcher = () => {
            this._syncResponsiveMode();
            if (this.currentScreen === 'screen-campaign') {
                this._setupCampaignMobileNavigation();
            } else if (this.currentScreen === 'screen-parliament') {
                this._setupParliamentMobileNavigation();
            }

            if (window.Game && window.Game.UI && window.Game.UI.Map && typeof window.Game.UI.Map.refreshLayout === 'function') {
                const mapEl = document.getElementById('map-container');
                if (mapEl && mapEl.parentElement && mapEl.parentElement.id) {
                    window.Game.UI.Map.refreshLayout(mapEl.parentElement.id);
                }
            }
        };
        window.addEventListener('resize', this._responsiveWatcher, { passive: true });
        this._responsiveWatcherBound = true;
    },

    _syncResponsiveMode() {
        const isMobile = this._isMobileLayout();
        document.body.classList.toggle('ui-mobile', isMobile);
        document.body.classList.toggle('ui-desktop', !isMobile);

        if (!isMobile) {
            this._campaignMobileView = 'map';
            const campaignScreen = document.getElementById('screen-campaign');
            if (campaignScreen) {
                campaignScreen.classList.remove('mobile-view-map', 'mobile-view-sidebar');
            }

            this._parliamentMobileView = 'main';
            const parliamentScreen = document.getElementById('screen-parliament');
            if (parliamentScreen) {
                parliamentScreen.classList.remove('mobile-parliament-main', 'mobile-parliament-map');
            }
        }
    },

    _setCampaignMobileView(view = 'map') {
        const campaignScreen = document.getElementById('screen-campaign');
        if (!campaignScreen) return;

        const safeView = view === 'sidebar' ? 'sidebar' : 'map';
        this._campaignMobileView = safeView;

        campaignScreen.classList.toggle('mobile-view-map', safeView === 'map');
        campaignScreen.classList.toggle('mobile-view-sidebar', safeView === 'sidebar');

        const controls = document.getElementById('campaign-mobile-controls');
        if (!controls) return;

        controls.querySelectorAll('.campaign-mobile-toggle').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === safeView);
            btn.setAttribute('aria-selected', btn.dataset.view === safeView ? 'true' : 'false');
        });
    },

    _canBeginHorizontalSwipe(event, screenId) {
        if (!event || !event.touches || event.touches.length !== 1) return false;
        const touch = event.touches[0];
        const target = event.target;

        if (!(target instanceof Element)) return true;
        if (target.closest('#modal:not(.hidden)')) return false;
        if (target.closest('input, textarea, select, button, a, label')) return false;

        const edgePad = 26;
        const viewportWidth = window.innerWidth || 360;

        if (screenId === 'screen-campaign') {
            if (target.closest('#campaign-mobile-controls')) return false;
            const inMap = target.closest('#map-container');
            const inSidebar = target.closest('#campaign-sidebar');
            if (inMap || inSidebar) {
                return (touch.clientX <= edgePad || touch.clientX >= (viewportWidth - edgePad));
            }
        }

        if (screenId === 'screen-parliament') {
            if (target.closest('#parliament-mobile-controls')) return false;
            const inMain = target.closest('#parliament-main');
            const inMapSidebar = target.closest('#parliament-map-sidebar');
            if (inMain || inMapSidebar) {
                return (touch.clientX <= edgePad || touch.clientX >= (viewportWidth - edgePad));
            }
        }

        return true;
    },

    _bindCampaignSwipeNavigation() {
        if (this._campaignSwipeBound) return;
        const campaignScreen = document.getElementById('screen-campaign');
        if (!campaignScreen) return;

        let startX = 0;
        let startY = 0;
        let startTs = 0;
        let peakDX = 0;
        let peakDY = 0;
        let allowSwipe = false;

        const onStart = (event) => {
            if (this.currentScreen !== 'screen-campaign' || !this._isMobileLayout()) return;
            if (!this._canBeginHorizontalSwipe(event, 'screen-campaign')) {
                allowSwipe = false;
                return;
            }

            const t = event.touches[0];
            startX = t.clientX;
            startY = t.clientY;
            startTs = Date.now();
            peakDX = 0;
            peakDY = 0;
            allowSwipe = true;
        };

        const onMove = (event) => {
            if (!allowSwipe || !event.touches || event.touches.length !== 1) return;
            const t = event.touches[0];
            peakDX = Math.max(peakDX, Math.abs(t.clientX - startX));
            peakDY = Math.max(peakDY, Math.abs(t.clientY - startY));
        };

        const onEnd = (event) => {
            if (this.currentScreen !== 'screen-campaign' || !this._isMobileLayout()) return;
            if (!allowSwipe) return;
            if (!event.changedTouches || event.changedTouches.length === 0) return;

            const t = event.changedTouches[0];
            const dx = t.clientX - startX;
            const dy = t.clientY - startY;
            const dt = Date.now() - startTs;
            const absDx = Math.max(Math.abs(dx), peakDX);
            const absDy = Math.max(Math.abs(dy), peakDY);
            allowSwipe = false;

            if (dt > 480) return;
            if (absDx < 72) return;
            if (absDx < (absDy * 1.6)) return;

            if (dx < 0) {
                this._setCampaignMobileView('sidebar');
            } else {
                this._setCampaignMobileView('map');
            }
        };

        const onCancel = () => {
            allowSwipe = false;
        };

        campaignScreen.addEventListener('touchstart', onStart, { passive: true });
        campaignScreen.addEventListener('touchmove', onMove, { passive: true });
        campaignScreen.addEventListener('touchend', onEnd, { passive: true });
        campaignScreen.addEventListener('touchcancel', onCancel, { passive: true });

        this._campaignSwipeHandlers = { onStart, onMove, onEnd, onCancel };
        this._campaignSwipeBound = true;
    },

    _setupCampaignMobileNavigation() {
        const campaignScreen = document.getElementById('screen-campaign');
        if (!campaignScreen) return;

        const isMobile = this._isMobileLayout();
        let controls = document.getElementById('campaign-mobile-controls');

        if (!controls) {
            controls = document.createElement('div');
            controls.id = 'campaign-mobile-controls';
            controls.className = 'campaign-mobile-controls';
            controls.innerHTML = `
                <div class="campaign-mobile-switch" role="tablist" aria-label="Campaign mobile view switch">
                    <button class="campaign-mobile-toggle active" data-view="map" role="tab" aria-selected="true">🗺️ Map</button>
                    <button class="campaign-mobile-toggle" data-view="sidebar" role="tab" aria-selected="false">🎛️ Command</button>
                </div>
                <div class="campaign-mobile-hint">Swipe left/right to switch views</div>
            `;
            campaignScreen.appendChild(controls);
        }

        if (!controls.dataset.bound) {
            controls.addEventListener('click', (event) => {
                const btn = event.target.closest('.campaign-mobile-toggle');
                if (!btn) return;
                this._setCampaignMobileView(btn.dataset.view || 'map');
            });
            controls.dataset.bound = '1';
        }

        if (!isMobile) {
            controls.classList.remove('active');
            controls.setAttribute('aria-hidden', 'true');
            campaignScreen.classList.remove('mobile-view-map', 'mobile-view-sidebar');
            this._campaignMobileView = 'map';
            return;
        }

        controls.classList.add('active');
        controls.setAttribute('aria-hidden', 'false');
        this._setCampaignMobileView(this._campaignMobileView || 'map');
        this._bindCampaignSwipeNavigation();
    },

    _setParliamentMobileView(view = 'main') {
        const parliamentScreen = document.getElementById('screen-parliament');
        if (!parliamentScreen) return;

        const safeView = view === 'map' ? 'map' : 'main';
        this._parliamentMobileView = safeView;

        parliamentScreen.classList.toggle('mobile-parliament-main', safeView === 'main');
        parliamentScreen.classList.toggle('mobile-parliament-map', safeView === 'map');

        const controls = document.getElementById('parliament-mobile-controls');
        if (!controls) return;
        controls.querySelectorAll('.parliament-mobile-toggle').forEach(btn => {
            const active = btn.dataset.view === safeView;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    },

    _bindParliamentSwipeNavigation() {
        if (this._parliamentSwipeBound) return;
        const parliamentScreen = document.getElementById('screen-parliament');
        if (!parliamentScreen) return;

        let startX = 0;
        let startY = 0;
        let startTs = 0;
        let peakDX = 0;
        let peakDY = 0;
        let allowSwipe = false;

        const onStart = (event) => {
            if (this.currentScreen !== 'screen-parliament' || !this._isMobileLayout()) return;
            if (!this._canBeginHorizontalSwipe(event, 'screen-parliament')) {
                allowSwipe = false;
                return;
            }

            const t = event.touches[0];
            startX = t.clientX;
            startY = t.clientY;
            startTs = Date.now();
            peakDX = 0;
            peakDY = 0;
            allowSwipe = true;
        };

        const onMove = (event) => {
            if (!allowSwipe || !event.touches || event.touches.length !== 1) return;
            const t = event.touches[0];
            peakDX = Math.max(peakDX, Math.abs(t.clientX - startX));
            peakDY = Math.max(peakDY, Math.abs(t.clientY - startY));
        };

        const onEnd = (event) => {
            if (this.currentScreen !== 'screen-parliament' || !this._isMobileLayout()) return;
            if (!allowSwipe) return;
            if (!event.changedTouches || event.changedTouches.length === 0) return;

            const t = event.changedTouches[0];
            const dx = t.clientX - startX;
            const dy = t.clientY - startY;
            const dt = Date.now() - startTs;
            const absDx = Math.max(Math.abs(dx), peakDX);
            const absDy = Math.max(Math.abs(dy), peakDY);
            allowSwipe = false;

            if (dt > 480) return;
            if (absDx < 72) return;
            if (absDx < (absDy * 1.6)) return;

            if (dx < 0) {
                this._setParliamentMobileView('map');
            } else {
                this._setParliamentMobileView('main');
            }
        };

        const onCancel = () => {
            allowSwipe = false;
        };

        parliamentScreen.addEventListener('touchstart', onStart, { passive: true });
        parliamentScreen.addEventListener('touchmove', onMove, { passive: true });
        parliamentScreen.addEventListener('touchend', onEnd, { passive: true });
        parliamentScreen.addEventListener('touchcancel', onCancel, { passive: true });

        this._parliamentSwipeHandlers = { onStart, onMove, onEnd, onCancel };
        this._parliamentSwipeBound = true;
    },

    _setupParliamentMobileNavigation() {
        const parliamentScreen = document.getElementById('screen-parliament');
        if (!parliamentScreen) return;

        const isMobile = this._isMobileLayout();
        let controls = document.getElementById('parliament-mobile-controls');

        if (!controls) {
            controls = document.createElement('div');
            controls.id = 'parliament-mobile-controls';
            controls.className = 'parliament-mobile-controls';
            controls.innerHTML = `
                <div class="parliament-mobile-switch" role="tablist" aria-label="Parliament mobile view switch">
                    <button class="parliament-mobile-toggle active" data-view="main" role="tab" aria-selected="true">🏛️ Chamber</button>
                    <button class="parliament-mobile-toggle" data-view="map" role="tab" aria-selected="false">🗺️ Map</button>
                </div>
                <div class="parliament-mobile-hint">Swipe left/right to switch views</div>
            `;
            parliamentScreen.appendChild(controls);
        }

        if (!controls.dataset.bound) {
            controls.addEventListener('click', (event) => {
                const btn = event.target.closest('.parliament-mobile-toggle');
                if (!btn) return;
                this._setParliamentMobileView(btn.dataset.view || 'main');
            });
            controls.dataset.bound = '1';
        }

        if (!isMobile) {
            controls.classList.remove('active');
            controls.setAttribute('aria-hidden', 'true');
            parliamentScreen.classList.remove('mobile-parliament-main', 'mobile-parliament-map');
            this._parliamentMobileView = 'main';
            return;
        }

        controls.classList.add('active');
        controls.setAttribute('aria-hidden', 'false');
        this._setParliamentMobileView(this._parliamentMobileView || 'main');
        this._bindParliamentSwipeNavigation();
    },

    show(screenId) {
        this._bindResponsiveWatcher();
        // Hide all screens
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        // Show target
        const el = document.getElementById(screenId);
        if (el) {
            el.classList.remove('hidden');
            this.currentScreen = screenId;
        }
        this._syncResponsiveMode();
        if (screenId !== 'screen-parliament') {
            this._clearParliamentKeyboardShortcuts();
        }
        if (screenId === 'screen-setup') {
            this._applySetupThemeVariant(this._setupThemeVariant);
            this._bindSetupParallaxMotion();
        } else {
            this._stopSetupParallaxLoop();
            this._resetSetupParallaxMotion();
        }
        this._updateMetaToolbarAvailability(screenId);
    },

    _clearParliamentKeyboardShortcuts() {
        if (this._parliamentKeyHandler) {
            document.removeEventListener('keydown', this._parliamentKeyHandler);
            this._parliamentKeyHandler = null;
        }
    },

    _bindParliamentKeyboardShortcuts(gameState) {
        this._clearParliamentKeyboardShortcuts();
        this._parliamentKeyboardIndex = 0;

        this._parliamentKeyHandler = (event) => {
            if (this.currentScreen !== 'screen-parliament') return;

            const targetTag = String(event.target && event.target.tagName ? event.target.tagName : '').toLowerCase();
            if (targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select') return;

            const modal = document.getElementById('modal');
            if (modal && !modal.classList.contains('hidden')) return;

            const key = String(event.key || '').toLowerCase();
            if (key === 'q') {
                const btn = document.getElementById('btn-end-question-time');
                if (btn && !btn.disabled) {
                    event.preventDefault();
                    btn.click();
                }
                return;
            }

            if (key === 'a') {
                const proceed = document.getElementById('btn-proceed-adjournment');
                const advance = document.getElementById('btn-advance-from-adjournment');
                const btn = (proceed && !proceed.disabled) ? proceed : ((advance && !advance.disabled) ? advance : null);
                if (btn) {
                    event.preventDefault();
                    btn.click();
                }
                return;
            }

        };

        document.addEventListener('keydown', this._parliamentKeyHandler);
    },

    _getCoalitionTrendHistory(gameState, partyId, currentScore) {
        if (!gameState.coalitionSatisfactionHistory) gameState.coalitionSatisfactionHistory = {};
        if (!gameState.coalitionSatisfactionHistory[partyId]) gameState.coalitionSatisfactionHistory[partyId] = [];

        const history = gameState.coalitionSatisfactionHistory[partyId];
        const session = Number.isFinite(gameState.sessionNumber) ? gameState.sessionNumber : 1;
        const score = Math.max(0, Math.min(100, Math.round((currentScore || 50) * 10) / 10));
        const last = history[history.length - 1];
        if (last && last.session === session) {
            last.score = score;
        } else {
            history.push({ session, score });
            if (history.length > 10) history.shift();
        }

        return history;
    },

    _renderSparkline(history) {
        const points = Array.isArray(history) ? history : [];
        if (points.length < 2) {
            return '<div class="trend-empty">Need 2+ sessions for trend.</div>';
        }

        const width = 150;
        const height = 38;
        const step = points.length > 1 ? width / (points.length - 1) : width;
        const polyline = points.map((p, idx) => {
            const x = Math.round(idx * step * 100) / 100;
            const normalized = Math.max(0, Math.min(100, Number(p.score) || 0));
            const y = Math.round((height - ((normalized / 100) * height)) * 100) / 100;
            return `${x},${y}`;
        }).join(' ');

        return `
            <svg class="coalition-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
                <polyline points="${polyline}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
            </svg>
        `;
    },

    _renderCoalitionDynamicsPanel(gameState) {
        if (!gameState || gameState.playerRole === 'opposition') return '';
        const coalitionHealth = window.Game.Engine.Parliament.getCoalitionHealth(gameState);
        const partyEntries = Object.entries(coalitionHealth.parties || {});
        if (partyEntries.length === 0) return '';

        const cards = partyEntries.map(([pid, data]) => {
            const history = this._getCoalitionTrendHistory(gameState, pid, data.score);
            const last = history[history.length - 1] || { score: data.score };
            const backIndex = Math.max(0, history.length - 3);
            const earlier = history[backIndex] || last;
            const delta = Math.round((last.score - earlier.score) * 10) / 10;
            const driftingDown = delta <= -6;
            const walkoutRisk = data.score < 18 || (data.score < 25 && delta <= -4);
            const warningText = walkoutRisk
                ? 'Walkout risk: high'
                : (driftingDown ? 'Warning: partner drifting down' : 'Stable trajectory');
            const warningClass = walkoutRisk ? 'risk-high' : (driftingDown ? 'risk-medium' : 'risk-low');
            const warningToneClass = walkoutRisk ? 'warning-high' : (driftingDown ? 'warning-medium' : 'warning-low');

            return `
                <div class="coalition-live-card ${warningClass}">
                    <div class="coalition-live-head">
                        <span class="live-name">${data.name}</span>
                        <span class="live-score">${Math.round(data.score)}%</span>
                    </div>
                    <div class="coalition-live-trend">
                        ${this._renderSparkline(history)}
                        <div class="trend-delta ${delta < 0 ? 'trend-down' : delta > 0 ? 'trend-up' : 'trend-flat'}">
                            ${delta > 0 ? '+' : ''}${delta} (last 2 sessions)
                        </div>
                    </div>
                    <div class="coalition-live-warning ${warningToneClass}">${warningText}</div>
                </div>
            `;
        }).join('');

        return `
            <div class="coalition-live-dashboard">
                <div class="coalition-live-title-row">
                    <h3>Coalition Dynamics Live</h3>
                    <span class="coalition-live-meta">Track drift and walkout pressure in real time</span>
                </div>
                <div class="coalition-live-grid">${cards}</div>
            </div>
        `;
    },

    _renderCoalitionNegotiationPanel(gameState) {
        if (!gameState || gameState.playerRole === 'opposition') return '';
        const summary = window.Game.Engine.Parliament.generateAdjournmentSummary(gameState);
        const parties = Object.entries((summary.coalitionHealth && summary.coalitionHealth.parties) || {});
        if (parties.length === 0) return '';

        return `
            <div class="coalition-review-section" style="margin-top:14px;">
                <h4>🤝 Coalition Negotiation Console</h4>
                <div class="coalition-partner-cards">
                    ${parties.map(([pid, data]) => {
                        const party = gameState.parties.find(p => p.id === pid);
                        const statusColors = { loyal: '#4ade80', uneasy: '#d4a843', unhappy: '#f59e0b', critical: '#ef4444' };
                        const statusColor = statusColors[data.status] || '#666';
                        const statusClass = `status-${data.status || 'unknown'}`;
                        const ministries = (gameState.coalitionMinistryOffers || {})[pid] || 0;
                        return `
                            <div class="coalition-partner-card" data-party-id="${pid}">
                                <div class="partner-header">
                                    <span class="partner-dot" style="background:${party ? party.hexColor : '#666'}"></span>
                                    <span class="partner-name">${data.name}</span>
                                    <span class="partner-status ${statusClass}" style="color:${statusColor}">${data.status.toUpperCase()}</span>
                                </div>
                                <div class="satisfaction-bar-container">
                                    <div class="satisfaction-bar" style="width:${data.score}%;background:${statusColor}"></div>
                                    <span class="satisfaction-value">${data.score}%</span>
                                </div>
                                <div style="font-size:0.7rem;color:var(--text-dim);margin:4px 0;">Ministries: ${ministries}</div>
                                ${data.demands.length > 0 ? `
                                    <div class="partner-demands">
                                        ${data.demands.map(d => `
                                            <div class="demand-item">
                                                <span class="demand-label">${d.label}</span>
                                                <span class="demand-deadline">⏰ ${d.remainingSessions} session(s)</span>
                                                ${d.capitalCost ? `<button class="btn-small btn-fulfill-demand" data-party-id="${pid}" data-demand-id="${d.instanceId}">Fulfill (${d.capitalCost} cap)</button>` : ''}
                                                ${d.type === 'endorsement' ? `<button class="btn-small btn-fulfill-demand" data-party-id="${pid}" data-demand-id="${d.instanceId}">Fulfill (${d.capitalCost || 25} cap)</button>` : ''}
                                                ${d.type === 'ministry' ? `<button class="btn-small btn-demand-ministry" data-party-id="${pid}" data-demand-id="${d.instanceId}">Offer +1 Ministry (-30 cap)</button>` : ''}
                                            </div>
                                        `).join('')}
                                    </div>
                                ` : '<div style="font-size:0.72rem;color:var(--text-dim)">No active demands.</div>'}
                                <div class="partner-actions" style="margin-top:6px;display:flex;gap:6px;">
                                    <button class="btn-small btn-reshuffle-up" data-party-id="${pid}" title="Give more ministries (+satisfaction, -30 cap)">+ Ministry</button>
                                    <button class="btn-small btn-reshuffle-down" data-party-id="${pid}" title="Take away ministry (-satisfaction, -30 cap)">- Ministry</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    },

    _renderOppositionTacticsPanel(gameState) {
        if (!gameState || gameState.playerRole === 'opposition') return '';
        const engine = window.Game.Engine.Parliament;
        if (typeof engine.getActiveOppositionTactics !== 'function') return '';

        const tactics = engine.getActiveOppositionTactics(gameState);
        const active = tactics.filter(t => t.active);
        if (active.length === 0) {
            return `
                <div class="opposition-tactics-panel">
                    <h4>Opposition Tactics Counter</h4>
                    <p class="placeholder-text" style="padding:12px;">No active opposition tactics detected this session.</p>
                </div>
            `;
        }

        const rows = active.map(t => {
            const scopeLabel = t.scope === 'no_confidence' ? 'No-Confidence' : 'Bill Vote';
            const severityLabel = t.severity >= 3 ? 'High' : t.severity === 2 ? 'Medium' : 'Low';
            const severityClass = t.severity >= 3 ? 'sev-high' : (t.severity === 2 ? 'sev-medium' : 'sev-low');
            const pressure = Math.max(0, Math.round(t.effectiveStrength || 0));
            const pressureClass = pressure >= 18 ? 'pressure-high' : (pressure >= 10 ? 'pressure-medium' : 'pressure-low');
            const canTable = t.scope === 'bill_vote';
            return `
                <div class="opposition-tactic-card">
                    <div class="opposition-tactic-head">
                        <span class="tactic-name">${t.label}</span>
                        <span class="tactic-scope">${scopeLabel}</span>
                    </div>
                    <div class="tactic-desc">${t.description}</div>
                    <div class="tactic-metrics">
                        <span class="tactic-severity ${severityClass}">Severity: <strong>${severityLabel}</strong></span>
                        <span class="tactic-pressure ${pressureClass}">Pressure: <strong>${pressure}</strong></span>
                    </div>
                    <div class="tactic-actions">
                        <button class="btn-small btn-counter-tactic" data-maneuver="table_counter_motion" data-tactic-id="${t.instanceId}" ${canTable ? '' : 'disabled'}>Table Counter-Motion (-22 cap)</button>
                        <button class="btn-small btn-counter-tactic" data-maneuver="whip_operation" data-tactic-id="${t.instanceId}">Whip Maneuver (-30 cap)</button>
                        <button class="btn-small btn-counter-tactic" data-maneuver="media_rebuttal" data-tactic-id="${t.instanceId}">Media Rebuttal (-18 cap)</button>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="opposition-tactics-panel">
                <h4>Opposition Tactics Counter</h4>
                <div class="opposition-tactics-list">${rows}</div>
            </div>
        `;
    },

    _renderCabinetGradeAPanel(gameState) {
        if (!gameState || gameState.playerRole === 'opposition') return '';
        const engine = window.Game.Engine.Parliament;
        if (typeof engine.getCabinetAssignmentStatus !== 'function') return '';

        const status = engine.getCabinetAssignmentStatus(gameState);
        if (!status) return '';

        const ministryRows = (status.ministries || []).map(ministry => {
            const selected = status.assignments[ministry] || '';
            const selectedParty = (status.parties || []).find(p => p.partyId === selected);
            const targetHint = selectedParty
                ? `Seat-share target for ${selectedParty.shortName}: ${selectedParty.target}`
                : 'Assign this ministry before finalizing cabinet.';
            const optionMarkup = (status.parties || []).map(row =>
                `<option value="${row.partyId}" ${selected === row.partyId ? 'selected' : ''}>${row.partyName} (${row.seats} seats)</option>`
            ).join('');
            return `
                <div class="cabinet-gradea-row">
                    <div class="cabinet-gradea-name">${ministry}</div>
                    <select class="cabinet-ministry-select" data-ministry="${ministry}" ${status.finalized ? 'disabled' : ''}>
                        <option value="" ${selected ? '' : 'selected'}>Unassigned</option>
                        ${optionMarkup}
                    </select>
                    <div class="cabinet-gradea-target">${targetHint}</div>
                </div>
            `;
        }).join('');

        const seatShareRows = (status.parties || []).map(row => {
            const deltaClass = row.delta < 0 ? 'delta-short' : row.delta > 0 ? 'delta-over' : 'delta-even';
            const deltaLabel = row.delta > 0 ? `+${row.delta}` : `${row.delta}`;
            return `
                <div class="cabinet-seatshare-row ${deltaClass}">
                    <span>${row.partyName}</span>
                    <span>${row.assigned}/${row.target}</span>
                    <span>${deltaLabel}</span>
                </div>
            `;
        }).join('');

        const statusText = status.finalized
            ? `Finalized in session ${status.finalizedSession || gameState.sessionNumber}.`
            : `${status.completion}% assigned. ${status.unassigned.length} ministry slot(s) still open.`;

        return `
            <div class="cabinet-gradea-panel ${status.finalized ? 'finalized' : 'open'}">
                <div class="cabinet-gradea-head">
                    <h3>Grade-A Cabinet Assignment</h3>
                    <span>${statusText}</span>
                </div>
                <p class="cabinet-gradea-desc">Assign Interior, Finance, Defense, and Transport by coalition seat share before parliamentary operations continue.</p>
                <div class="cabinet-gradea-grid">${ministryRows}</div>
                <div class="cabinet-seatshare-table">${seatShareRows}</div>
                <div class="cabinet-gradea-actions">
                    <button class="btn-small" id="btn-auto-cabinet-portfolios" ${status.finalized ? 'disabled' : ''}>Auto-Assign by Seat Share</button>
                    <button class="btn-primary btn-gold" id="btn-finalize-cabinet-portfolios" ${status.finalized || status.unassigned.length > 0 ? 'disabled' : ''}>Finalize Grade-A Cabinet</button>
                </div>
            </div>
        `;
    },

    _renderMinisterialScandalPanel(gameState) {
        if (!gameState || gameState.playerRole === 'opposition') return '';
        const event = gameState.pendingMinisterialScandal;
        if (!event) return '';

        const severityLabel = event.severity >= 3 ? 'High' : event.severity === 2 ? 'Medium' : 'Low';
        const severityClass = event.severity >= 3 ? 'severity-high' : (event.severity === 2 ? 'severity-medium' : 'severity-low');
        return `
            <div class="ministerial-scandal-panel">
                <div class="ministerial-scandal-head">
                    <h4>Ministerial Scandal Event</h4>
                    <span class="scandal-severity ${severityClass}">${severityLabel}</span>
                </div>
                <div class="ministerial-scandal-body">
                    <div><strong>${event.ministry}</strong> - ${event.targetPartyName}</div>
                    <p>${event.headline}</p>
                    <p>Choice: protect the minister and absorb costs, or fire them and risk coalition backlash.</p>
                </div>
                <div class="ministerial-scandal-actions">
                    <button class="btn-small btn-ministerial-decision" data-decision="protect">Protect Minister (-${event.protectCapitalCost} cap)</button>
                    <button class="btn-small btn-ministerial-decision" data-decision="fire">Fire Minister (-${event.fireSatisfactionPenalty} partner satisfaction)</button>
                </div>
            </div>
        `;
    },

    bindMetaToolbar() {
        if (this._metaToolbarBound) return;
        const btnSaveLoad = document.getElementById('btn-open-save-load');
        const btnHistory = document.getElementById('btn-open-history');
        const btnSandbox = document.getElementById('btn-open-sandbox');
        const btnScenario = document.getElementById('btn-open-scenario');
        const btnMultiplayer = document.getElementById('btn-open-multiplayer');

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
        if (btnMultiplayer) {
            btnMultiplayer.addEventListener('click', () => this.renderMultiplayerModal());
        }
        this._updateMetaToolbarAvailability(this.currentScreen || 'screen-menu');
        this._metaToolbarBound = true;
    },

    _getMultiplayerState() {
        const app = window.Game && window.Game.App;
        if (!app || !app.state) return null;
        return app.state.multiplayer || null;
    },

    _getMultiplayerStatusLabel(mpState) {
        if (!mpState) return 'Offline';
        if (mpState.status === 'connected' && mpState.roomId) {
            return `Connected · Room ${mpState.roomId}`;
        }
        if (mpState.status === 'connected') return 'Connected';
        if (mpState.status === 'disconnected') return 'Disconnected';
        return 'Offline';
    },

    _shouldRenderMultiplayerChat(gameState) {
        const app = window.Game.App;
        return !!(
            app
            && app.isMultiplayerActive
            && app.isMultiplayerActive()
            && gameState
            && gameState.multiplayer
            && gameState.multiplayer.roomId
        );
    },

    _renderMultiplayerChatBox(gameState, channel = 'global') {
        if (!this._shouldRenderMultiplayerChat(gameState)) return '';
        const mpState = gameState.multiplayer || {};
        const rows = Array.isArray(mpState.chatMessages) ? mpState.chatMessages.slice(-24) : [];
        const channelKey = String(channel || 'global').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'global';
        const boxId = `mp-chat-box-${channelKey}`;
        const logId = `mp-chat-log-${channelKey}`;
        const inputId = `mp-chat-input-${channelKey}`;
        const sendId = `mp-chat-send-${channelKey}`;
        const escapeHtml = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        return `
            <div class="setup-scenario-panel" id="${boxId}" style="margin-top:10px;">
                <div class="setup-scenario-title">Room Chat</div>
                <div class="mp-list" id="${logId}" style="max-height:150px;margin-bottom:8px;">
                    ${rows.length === 0
                        ? '<p class="placeholder-text" style="padding:10px;">No messages yet.</p>'
                        : rows.map(row => `
                            <div class="mp-pick-card" style="cursor:default;">
                                <span class="mp-name">${escapeHtml(row.name || 'Player')}${row.playerId === mpState.playerId ? ' (You)' : ''}</span>
                                <span class="mp-loyalty">${escapeHtml(row.channel || channel)}</span>
                                <span class="mp-corruption">${escapeHtml(row.text || '')}</span>
                            </div>
                        `).join('')
                    }
                </div>
                <div style="display:grid;grid-template-columns:1fr auto;gap:8px;">
                    <input class="form-input" id="${inputId}" placeholder="Type message..." maxlength="280">
                    <button class="btn-small" id="${sendId}" style="margin:0;text-align:center;">Send</button>
                </div>
            </div>
        `;
    },

    _bindMultiplayerChatBox(gameState, channel = 'global') {
        if (!this._shouldRenderMultiplayerChat(gameState)) return;
        const channelKey = String(channel || 'global').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'global';
        const input = document.getElementById(`mp-chat-input-${channelKey}`);
        const sendBtn = document.getElementById(`mp-chat-send-${channelKey}`);
        if (!input || !sendBtn) return;

        const submit = () => {
            const value = input.value.trim();
            if (!value) return;
            const result = window.Game.App.sendMultiplayerChatMessage(value, channel);
            if (!result.success) {
                this.showNotification(result.msg, 'error');
                return;
            }
            input.value = '';
        };

        sendBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            submit();
        });
    },

    async renderMultiplayerModal() {
        const modal = document.getElementById('modal');
        if (!modal) return;

        const app = window.Game.App;
        const mpClient = window.Game.Multiplayer;
        const mpState = this._getMultiplayerState() || {};
        const roomPlayers = Array.isArray(mpState.players) ? mpState.players : [];
        const inRoom = !!mpState.roomId;
        const isHost = !!(inRoom && mpState.playerId && mpState.ownerPlayerId && mpState.playerId === mpState.ownerPlayerId);
        const configuredEndpoint = String((mpClient && mpClient.configuredEndpoint) || '').trim();
        const endpointLocked = !!(mpClient && mpClient.endpointLocked && configuredEndpoint);
        const me = roomPlayers.find(p => p.playerId === mpState.playerId);
        const meReady = !!(me && me.ready);

        modal.innerHTML = `
            <div class="modal-content" style="max-width:760px;">
                <div class="modal-header">
                    <h3>🌐 Multiplayer Session</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>

                <div class="run-summary-grid" style="margin-bottom:10px;">
                    <div class="info-chip"><span class="info-label">Status</span><span class="info-value" style="font-size:0.94rem;">${this._getMultiplayerStatusLabel(mpState)}</span></div>
                    <div class="info-chip"><span class="info-label">Seat</span><span class="info-value" style="font-size:0.94rem;">${mpState.seat || '-'}</span></div>
                    <div class="info-chip"><span class="info-label">Room State</span><span class="info-value" style="font-size:0.94rem;">${mpState.roomState || '-'}</span></div>
                    <div class="info-chip"><span class="info-label">Turns</span><span class="info-value" style="font-size:0.94rem;">${mpState.myTurnsCompleted || 0}/${mpState.campaignRequiredTurns || 8}</span></div>
                </div>

                <div class="setup-scenario-panel" style="margin-bottom:10px;">
                    <div class="setup-scenario-title">Quick Steps</div>
                    <p class="setup-scenario-desc" style="margin-bottom:8px;">
                        1) Host room, 2) Copy Join Key, 3) Friends paste key and tap Join, 4) Ready + start, 5) Party lock and play.
                    </p>
                    <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;">
                        <div class="form-input" style="display:flex;align-items:center;">Room Code: <strong style="margin-left:6px;">${mpState.roomId || '—'}</strong></div>
                        <button class="btn-small" id="btn-mp-copy-room" style="margin:0;text-align:center;" ${inRoom ? '' : 'disabled'}>Copy Code</button>
                        <button class="btn-small" id="btn-mp-copy-key" style="margin:0;text-align:center;" ${inRoom ? '' : 'disabled'}>Copy Join Key</button>
                        <button class="btn-small" id="btn-mp-copy-invite" style="margin:0;text-align:center;" ${inRoom ? '' : 'disabled'}>Copy Invite Link</button>
                    </div>
                </div>

                ${endpointLocked ? `
                    <div class="setup-scenario-panel" style="margin-bottom:10px;">
                        <div class="setup-scenario-title">Server</div>
                        <p class="setup-scenario-desc" style="margin:0;">Configured for auto-connect. Players can host/join directly.</p>
                    </div>
                ` : `
                    <div class="setup-scenario-panel" style="margin-bottom:10px;">
                        <div class="setup-scenario-title">Connection</div>
                        <div style="display:grid;grid-template-columns:1fr auto;gap:8px;">
                            <input id="mp-endpoint" class="form-input" value="${(mpState.endpoint || (mpClient && mpClient.endpoint) || 'ws://localhost:8787').replace(/"/g, '&quot;')}" placeholder="ws://localhost:8787">
                            <button class="btn-small" id="btn-mp-connect" style="margin:0;text-align:center;">Connect</button>
                        </div>
                    </div>
                `}

                <div class="setup-scenario-panel" style="margin-bottom:10px;">
                    <div class="setup-scenario-title">Lobby Actions</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                        <input id="mp-player-name" class="form-input" value="${(mpState.playerName || this._multiplayerNameSeed || 'Player').replace(/"/g, '&quot;')}" placeholder="Player name">
                        <input id="mp-room-id" class="form-input" value="" placeholder="Room code, Join Key, or invite link">
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;">
                        <button class="btn-small" id="btn-mp-host" style="margin:0;text-align:center;" ${inRoom ? 'disabled' : ''}>Host Room</button>
                        <button class="btn-small" id="btn-mp-join" style="margin:0;text-align:center;" ${inRoom ? 'disabled' : ''}>Join Room</button>
                        <button class="btn-small" id="btn-mp-match" style="margin:0;text-align:center;" ${inRoom ? 'disabled' : ''}>Matchmaking</button>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px;">
                        <button class="btn-small" id="btn-mp-ready" style="margin:0;text-align:center;" ${inRoom ? '' : 'disabled'}>${meReady ? 'Set Unready' : 'Set Ready'}</button>
                        <button class="btn-small" id="btn-mp-leave" style="margin:0;text-align:center;" ${inRoom ? '' : 'disabled'}>Leave Room</button>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px;">
                        <button class="btn-small" id="btn-mp-start" style="margin:0;text-align:center;" ${(inRoom && isHost && (mpState.roomState || 'lobby') === 'lobby') ? '' : 'disabled'}>
                            Start Match (Host)
                        </button>
                    </div>
                </div>

                <div class="setup-scenario-panel" style="margin-bottom:0;">
                    <div class="setup-scenario-title">Players</div>
                    <div class="mp-list" style="max-height:220px;">
                        ${roomPlayers.length === 0
                            ? '<p class="placeholder-text" style="padding:12px;">Not in a room yet.</p>'
                            : roomPlayers.map(p => `
                                <div class="mp-pick-card" style="cursor:default;">
                                    <span class="mp-name">Seat ${p.seat}: ${p.name}${p.playerId === mpState.playerId ? ' (You)' : ''}</span>
                                    <span class="mp-loyalty">${p.ready ? 'Ready' : 'Not Ready'}</span>
                                    <span class="mp-corruption">${p.turnsCompleted || 0}/${mpState.campaignRequiredTurns || 8}</span>
                                </div>
                            `).join('')
                        }
                    </div>
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));

        const copyBtn = document.getElementById('btn-mp-copy-room');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                if (!mpState.roomId) return;
                try {
                    await navigator.clipboard.writeText(mpState.roomId);
                    this.showNotification('Room code copied.', 'success');
                } catch (_) {
                    this.showNotification(`Room code: ${mpState.roomId}`, 'info');
                }
            });
        }

        const warnIfLocalEndpoint = () => {
            const endpoint = String((mpState.endpoint || (mpClient && mpClient.endpoint) || '')).toLowerCase();
            if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
                this.showNotification('Endpoint is localhost. Use LAN/public endpoint for other devices.', 'info');
            }
        };

        const copyKeyBtn = document.getElementById('btn-mp-copy-key');
        if (copyKeyBtn) {
            copyKeyBtn.addEventListener('click', async () => {
                if (!mpState.roomId) return;
                const nameInput = document.getElementById('mp-player-name');
                const seedName = (nameInput && nameInput.value.trim()) || mpState.playerName || 'Player';
                const joinKey = (mpClient && mpClient.buildJoinKey)
                    ? mpClient.buildJoinKey(mpState.roomId, { name: seedName })
                    : '';

                if (!joinKey) {
                    this.showNotification('Could not build join key.', 'error');
                    return;
                }

                try {
                    await navigator.clipboard.writeText(joinKey);
                    this.showNotification('Join key copied. Friends can paste it and press Join.', 'success');
                } catch (_) {
                    this.showNotification(joinKey, 'info');
                }

                warnIfLocalEndpoint();
            });
        }

        const copyInviteBtn = document.getElementById('btn-mp-copy-invite');
        if (copyInviteBtn) {
            copyInviteBtn.addEventListener('click', async () => {
                if (!mpState.roomId) return;
                const nameInput = document.getElementById('mp-player-name');
                const seedName = (nameInput && nameInput.value.trim()) || mpState.playerName || 'Player';
                const inviteLink = (mpClient && mpClient.buildInviteLink)
                    ? mpClient.buildInviteLink(mpState.roomId, { name: seedName })
                    : '';

                if (!inviteLink) {
                    this.showNotification('Could not build invite link.', 'error');
                    return;
                }

                try {
                    await navigator.clipboard.writeText(inviteLink);
                    this.showNotification('Invite link copied. Friends can open it to auto-join.', 'success');
                } catch (_) {
                    this.showNotification(inviteLink, 'info');
                }

                warnIfLocalEndpoint();
            });
        }

        const getName = () => {
            const raw = document.getElementById('mp-player-name').value.trim();
            const name = raw || 'Player';
            this._multiplayerNameSeed = name;
            if (app && app.state && app.state.multiplayer) {
                app.state.multiplayer.playerName = name;
            }
            return name;
        };

        const connectBtn = document.getElementById('btn-mp-connect');
        if (connectBtn) {
            connectBtn.addEventListener('click', async () => {
                if (this._multiplayerConnectPending) return;
                this._multiplayerConnectPending = true;
                const endpointInput = document.getElementById('mp-endpoint');
                const endpoint = endpointInput ? endpointInput.value.trim() : '';
                if (endpoint) mpClient.setEndpoint(endpoint);
                const result = await mpClient.connect();
                this._multiplayerConnectPending = false;
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                if (!modal.classList.contains('hidden')) this.renderMultiplayerModal();
            });
        }

        document.getElementById('btn-mp-host').addEventListener('click', async () => {
            const result = await mpClient.createRoom({ name: getName(), maxPlayers: 4 });
            this.showNotification(result.msg, result.success ? 'success' : 'error');
        });

        document.getElementById('btn-mp-join').addEventListener('click', async () => {
            const roomOrKey = document.getElementById('mp-room-id').value.trim();
            if (!roomOrKey) {
                this.showNotification('Enter room code, join key, or invite link first.', 'error');
                return;
            }

            const joinMeta = (mpClient && mpClient.decodeJoinKey)
                ? mpClient.decodeJoinKey(roomOrKey)
                : null;

            const result = joinMeta
                ? await mpClient.joinWithKey({ joinKey: roomOrKey, fallbackName: getName() })
                : await mpClient.joinRoom({ roomId: roomOrKey.toUpperCase(), name: getName() });

            this.showNotification(result.msg, result.success ? 'success' : 'error');
        });

        document.getElementById('btn-mp-match').addEventListener('click', async () => {
            const result = await mpClient.joinMatchmaking({ name: getName() });
            this.showNotification(result.msg, result.success ? 'success' : 'error');
        });

        document.getElementById('btn-mp-ready').addEventListener('click', () => {
            const me = roomPlayers.find(p => p.playerId === mpState.playerId);
            const next = !(me && me.ready);
            mpClient.setReady(next);
            this.showNotification(next ? 'Ready signal sent.' : 'Unready signal sent.', 'info');
        });

        document.getElementById('btn-mp-leave').addEventListener('click', () => {
            mpClient.leaveRoom();
            this.showNotification('Left room.', 'info');
            setTimeout(() => {
                if (!modal.classList.contains('hidden')) this.renderMultiplayerModal();
            }, 80);
        });

        const startBtn = document.getElementById('btn-mp-start');
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                const appState = (app && app.state) ? app.state : null;
                const roomConfig = {
                    difficultyMode: appState && appState.difficultyMode ? appState.difficultyMode : 'medium',
                    scenarioMode: appState && appState.scenarioMode ? appState.scenarioMode : 'realistic'
                };
                if (window.Game.Engine && window.Game.Engine.Campaign && typeof window.Game.Engine.Campaign.getEmergentPartyChance === 'function') {
                    roomConfig.emergentPartyChance = window.Game.Engine.Campaign.getEmergentPartyChance(appState || {});
                }
                mpClient.startMatch({ roomConfig });
                this.showNotification('Start signal sent. Party selection will open for room players.', 'info');
            });
        }
    },

    renderSaveLoadModal() {
        const modal = document.getElementById('modal');
        if (!modal) return;
        const app = window.Game.App;
        if (app && app.isMultiplayerActive && app.isMultiplayerActive()) {
            this.showNotification('Save/Load is disabled during multiplayer session.', 'error');
            return;
        }
        const slots = app.getSaveSlots();

        modal.innerHTML = `
            <div class="modal-content save-load-modal" style="max-width:700px;">
                <div class="modal-header">
                    <h3>💾 Save / Load</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div class="save-slot-grid">
                    ${slots.map(slot => {
                        const savedAt = slot.savedAt ? new Date(slot.savedAt).toLocaleString() : '-';
                        const meta = slot.meta || {};
                        return `
                            <div class="coalition-party-card" style="border-left-color:var(--gold);">
                                <div class="save-slot-meta">
                                    <div class="cp-name">Slot ${slot.slot}</div>
                                    ${slot.empty ? '<div class="cp-you">Empty</div>' : `
                                        <div class="cp-you">${meta.partyName || 'Unknown Party'} • ${meta.electionCount || 1} election(s)</div>
                                        <div style="font-size:0.72rem;color:var(--text-secondary);">Saved: ${savedAt}</div>
                                        <div style="font-size:0.72rem;color:var(--text-dim);">State: ${slot.currentState || 'Unknown'} • Year ${meta.parliamentYear || 1}</div>
                                    `}
                                </div>
                                <div class="save-slot-actions">
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
        const filterButtons = ['all', 'campaign', 'campaign-event', 'coalition', 'parliament', 'election', 'crisis', 'multiplayer', 'scenario', 'sandbox', 'save', 'load'];

        modal.innerHTML = `
            <div class="modal-content run-history-modal" style="max-width:860px;">
                <div class="modal-header">
                    <h3>📜 Run History Analytics</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div class="run-filter-row" style="margin-bottom:10px;">
                    ${filterButtons.map(type => `
                        <button class="setup-scenario-btn run-filter-btn ${filterType === type ? 'active' : ''}" data-filter="${type}" style="padding:6px 8px;font-size:0.72rem;">${type}</button>
                    `).join('')}
                </div>
                <div class="run-summary-grid" style="margin-bottom:10px;">
                    <div class="info-chip"><span class="info-label">Entries</span><span class="info-value" style="font-size:1rem;">${analytics.count}</span></div>
                    <div class="info-chip"><span class="info-label">Popularity Δ</span><span class="info-value" style="font-size:1rem;color:${analytics.popularityDelta >= 0 ? 'var(--success)' : 'var(--crimson)'};">${analytics.popularityDelta > 0 ? '+' : ''}${analytics.popularityDelta}</span></div>
                    <div class="info-chip"><span class="info-label">Seat Δ</span><span class="info-value" style="font-size:1rem;color:${analytics.seatDelta >= 0 ? 'var(--success)' : 'var(--crimson)'};">${analytics.seatDelta > 0 ? '+' : ''}${analytics.seatDelta}</span></div>
                    <div class="info-chip"><span class="info-label">Trust Δ</span><span class="info-value" style="font-size:1rem;color:${analytics.trustDelta >= 0 ? 'var(--success)' : 'var(--crimson)'};">${analytics.trustDelta > 0 ? '+' : ''}${analytics.trustDelta}</span></div>
                </div>
                <div class="run-section-label" style="font-size:0.76rem;color:var(--text-secondary);margin-bottom:8px;">Top turning points</div>
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
                <div class="run-section-label" style="font-size:0.76rem;color:var(--text-secondary);margin-bottom:8px;">Timeline</div>
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
            <div class="modal-content sandbox-modal" style="max-width:860px;">
                <div class="modal-header">
                    <h3>🧪 Balance Sandbox</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div class="sandbox-controls" style="margin-bottom:10px;">
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
                <div class="results-table-header sandbox-results-header">
                    <span>Party</span><span>Win Rate</span><span>Avg Seats</span><span>P10</span><span>P50</span><span>P90</span>
                </div>
                ${result.stats.map(row => `
                    <div class="results-row sandbox-results-row">
                        <span>${row.thaiName} <small>${row.shortName}</small></span>
                        <span>${row.winRate}%</span>
                        <span>${row.avgSeats}</span>
                        <span>${row.p10}</span>
                        <span>${row.p50}</span>
                        <span>${row.p90}</span>
                    </div>
                    <div class="sandbox-results-buckets" style="font-size:0.68rem;color:var(--text-dim);padding:0 12px 8px;">
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
            <div class="modal-content scenario-modal">
                <div class="modal-header scenario-modal-header">
                    <h3>🧩 Custom Scenario Modding</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <p class="scenario-modal-subtitle">
                    Edit scenario JSON, then apply in Setup. Supports campaign tuning, base-party overrides, and custom parties.
                    ${currentConfig ? `<br><span class="scenario-active-badge">Active: ${currentConfig.name} (${currentConfig.baseMode})</span>` : ''}
                </p>

                <div class="scenario-modal-layout">
                    <section class="scenario-editor-pane">
                        <div class="scenario-section-title">Scenario JSON Editor</div>
                        <textarea id="custom-scenario-json" class="form-input form-textarea scenario-json-editor" rows="15">${jsonText}</textarea>
                        <div class="scenario-editor-actions">
                            <button class="btn-small" id="btn-scenario-template">Load Template</button>
                            <button class="btn-small" id="btn-scenario-export">Export Current</button>
                            <button class="btn-small" id="btn-scenario-apply">Apply Scenario</button>
                            <button class="btn-small" id="btn-scenario-disable" ${currentConfig ? '' : 'disabled'}>Disable Custom</button>
                        </div>
                        <p class="scenario-footnote">Apply/disable requires Setup screen. Export works anytime.</p>
                    </section>

                    <aside class="scenario-pack-pane">
                        <div class="scenario-pack-head">
                            <div class="scenario-section-title">Scenario Packs</div>
                            <button class="btn-small" id="btn-scenario-refresh-packs">Refresh Packs</button>
                        </div>
                        <div class="scenario-pack-subtitle">Select mod pack from scenarios folder</div>
                        <div id="scenario-pack-list" class="mp-list scenario-pack-list"></div>
                        <p class="scenario-footnote">Use Preview to load pack JSON into editor, or Quick Apply directly from Setup.</p>
                    </aside>
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
                <div class="scenario-pack-card">
                    <div class="scenario-pack-main">
                        <div class="scenario-pack-name">${pack.name}</div>
                        <div class="scenario-pack-meta">id: ${pack.id} • ${pack.file}</div>
                        ${pack.description ? `<div class="scenario-pack-desc">${pack.description}</div>` : ''}
                        ${pack.author ? `<div class="scenario-pack-author">by ${pack.author}</div>` : ''}
                    </div>
                    <div class="scenario-pack-actions">
                        <button class="btn-small btn-pack-preview" data-pack-id="${pack.id}">Preview</button>
                        <button class="btn-small btn-pack-apply" data-pack-id="${pack.id}">Quick Apply</button>
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
                target.innerHTML = '<p class="placeholder-text scenario-pack-loading">Loading scenario packs...</p>';
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
        const app = window.Game.App;
        const multiplayerActive = !!(app && app.isMultiplayerActive && app.isMultiplayerActive());
        const multiplayerPartySelection = !!(multiplayerActive && app.isMultiplayerPartySelectionActive && app.isMultiplayerPartySelectionActive());
        const mpState = gameState.multiplayer || {};
        const mpSelections = (multiplayerActive && app.getMultiplayerPartySelections)
            ? app.getMultiplayerPartySelections()
            : {};
        const setupThemes = this._getSetupThemeVariants();
        let setupCardIndex = 0;
        const markSetupCard = (el) => {
            if (!el) return;
            const idx = setupCardIndex++;
            el.style.setProperty('--setup-index', String(idx));
            el.style.setProperty('--setup-depth', `${(4 + (idx * 0.55)).toFixed(2)}px`);
        };
        const totalParties = gameState.parties.length;
        const customPartyCount = gameState.parties.filter(p => p.isCustom).length;
        const avgPopularity = totalParties > 0
            ? Math.round((gameState.parties.reduce((sum, p) => sum + (p.basePopularity || 0), 0) / totalParties) * 10) / 10
            : 0;
        const topBanYai = gameState.parties.reduce((best, p) => {
            if (!best || (p.banYaiPower || 0) > (best.banYaiPower || 0)) return p;
            return best;
        }, null);

        const setupHero = document.createElement('div');
        setupHero.className = 'setup-hero-glass';
        setupHero.innerHTML = `
            <div class="setup-hero-head">
                <div>
                    <h2>Command Center</h2>
                    <p>Build your power base before the first campaign week starts.</p>
                </div>
            </div>
            <div class="setup-hero-grid">
                <div class="setup-glass-metric">
                    <span class="setup-metric-label">Total Parties</span>
                    <span class="setup-metric-value">${totalParties}</span>
                </div>
                <div class="setup-glass-metric">
                    <span class="setup-metric-label">Custom Parties</span>
                    <span class="setup-metric-value">${customPartyCount}</span>
                </div>
                <div class="setup-glass-metric">
                    <span class="setup-metric-label">Avg Popularity</span>
                    <span class="setup-metric-value">${avgPopularity}%</span>
                </div>
                <div class="setup-glass-metric">
                    <span class="setup-metric-label">Strongest BanYai</span>
                    <span class="setup-metric-value">${topBanYai ? (topBanYai.shortName || topBanYai.thaiName) : '-'}</span>
                </div>
            </div>
            <div class="setup-theme-switcher">
                <span class="setup-theme-label">Cinematic Variant</span>
                <div class="setup-theme-options">
                    ${setupThemes.map(theme => `
                        <button class="setup-theme-btn ${this._setupThemeVariant === theme.id ? 'active' : ''}" data-setup-theme="${theme.id}">
                            <span class="setup-theme-btn-title">${theme.label}</span>
                            <span class="setup-theme-btn-tone">${theme.tone}</span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
        markSetupCard(setupHero);
        grid.appendChild(setupHero);
        setupHero.querySelectorAll('.setup-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const nextTheme = btn.dataset.setupTheme;
                if (!nextTheme || nextTheme === this._setupThemeVariant) return;
                this._applySetupThemeVariant(nextTheme);
                setupHero.querySelectorAll('.setup-theme-btn').forEach(row => {
                    row.classList.toggle('active', row.dataset.setupTheme === this._setupThemeVariant);
                });
            });
        });

        const scenarioPanel = document.createElement('div');
        scenarioPanel.className = 'setup-scenario-panel setup-mode-panel';
        scenarioPanel.innerHTML = `
            <div class="setup-scenario-title">Scenario</div>
            <div class="setup-scenario-actions">
                <button class="setup-scenario-btn ${scenarioMode === 'realistic' ? 'active' : ''}" data-scenario="realistic">
                    <span class="setup-scenario-btn-label">Realistic</span>
                    <span class="setup-scenario-btn-meta">Current strengths</span>
                </button>
                <button class="setup-scenario-btn ${scenarioMode === 'balanced' ? 'active' : ''}" data-scenario="balanced">
                    <span class="setup-scenario-btn-label">Balanced</span>
                    <span class="setup-scenario-btn-meta">Normalized race</span>
                </button>
            </div>
            <div class="setup-scenario-actions" style="margin-top:8px;grid-template-columns:1fr;">
                <button class="setup-scenario-btn ${scenarioMode === 'custom' ? 'active' : ''}" id="btn-open-custom-scenario">
                    <span class="setup-scenario-btn-label">${scenarioMode === 'custom' ? 'Custom Scenario Active' : 'Open Custom Scenario Editor'}</span>
                    <span class="setup-scenario-btn-meta">Import or tweak JSON packs</span>
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
        markSetupCard(scenarioPanel);
        grid.appendChild(scenarioPanel);

        const difficultyPanel = document.createElement('div');
        difficultyPanel.className = 'setup-scenario-panel setup-difficulty-panel';
        difficultyPanel.innerHTML = `
            <div class="setup-scenario-title">Campaign Mode</div>
            <div class="setup-scenario-actions" style="grid-template-columns:1fr;gap:6px;">
                ${difficulties.map(d => `
                    <button class="setup-scenario-btn ${difficultyMode === d.id ? 'active' : ''}" data-difficulty="${d.id}">
                        <span class="setup-scenario-btn-label">${d.label}</span>
                        <span class="setup-scenario-btn-meta">${d.tier}</span>
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
        markSetupCard(difficultyPanel);
        grid.appendChild(difficultyPanel);

        if (multiplayerActive) {
            const roomPanel = document.createElement('div');
            roomPanel.className = 'setup-scenario-panel setup-mode-panel';
            roomPanel.innerHTML = `
                <div class="setup-scenario-title">Multiplayer Room</div>
                <p class="setup-scenario-desc">
                    ${multiplayerPartySelection
                        ? 'Room is in party selection. Lock one unique party per player.'
                        : `Room state: ${(mpState.roomState || 'none').toUpperCase()}. Open multiplayer panel for host/start controls.`}
                </p>
                <div class="mp-list" style="max-height:180px;">
                    ${(Array.isArray(mpState.players) ? mpState.players : []).map(player => {
                        const sel = mpSelections[player.playerId] || null;
                        const selectionText = sel ? `Party: ${sel.partyName || sel.partyId}` : 'Party: Not selected';
                        return `
                            <div class="mp-pick-card" style="cursor:default;">
                                <span class="mp-name">Seat ${player.seat}: ${player.name}${player.playerId === mpState.playerId ? ' (You)' : ''}</span>
                                <span class="mp-loyalty">${player.ready ? 'Ready' : 'Not Ready'}</span>
                                <span class="mp-corruption">${selectionText}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
            markSetupCard(roomPanel);
            grid.appendChild(roomPanel);
        }

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
            if (multiplayerPartySelection) {
                this.showNotification('Custom party creation is disabled during multiplayer room party selection.', 'error');
                return;
            }
            document.querySelectorAll('.party-card').forEach(c => c.classList.remove('selected'));
            createCard.classList.add('selected');
            this._showPartyCreator(gameState);
        });
        markSetupCard(createCard);
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
                if (multiplayerPartySelection) {
                    const owner = Object.values(mpSelections).find(row => row.partyId === party.id);
                    if (owner && owner.playerId !== mpState.playerId) {
                        this.showNotification(`${owner.name || 'Another player'} already locked this party.`, 'error');
                    }
                }
                this._showPartyDetail(party, gameState);
            });
            markSetupCard(card);
            grid.appendChild(card);
        }
    },

    _showPartyDetail(party, gameState) {
        const detail = document.getElementById('party-detail');
        if (!detail) return;

        const app = window.Game.App;
        const multiplayerActive = !!(app && app.isMultiplayerActive && app.isMultiplayerActive());
        const multiplayerPartySelection = !!(multiplayerActive && app.isMultiplayerPartySelectionActive && app.isMultiplayerPartySelectionActive());
        const mpState = gameState.multiplayer || {};
        const selections = (multiplayerActive && app.getMultiplayerPartySelections)
            ? app.getMultiplayerPartySelections()
            : {};
        const owner = Object.values(selections).find(row => row.partyId === party.id) || null;
        const takenByOther = !!(owner && owner.playerId !== mpState.playerId);
        const selectedByMe = !!(owner && owner.playerId === mpState.playerId);
        const buttonLabel = multiplayerPartySelection
            ? (takenByOther
                ? `🔒 Locked by ${owner.name || 'Seat ' + owner.seat}`
                : (selectedByMe ? '✅ Party Locked (You)' : `🔐 Lock ${party.thaiName} For Room`))
            : `▶ Play as ${party.thaiName}`;

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
                ${buttonLabel}
            </button>
        `;

        document.getElementById('btn-select-party').addEventListener('click', () => {
            if (multiplayerPartySelection) {
                if (takenByOther) {
                    this.showNotification(`${owner.name || 'Another player'} already locked this party.`, 'error');
                    return;
                }
                const result = window.Game.App.submitMultiplayerPartySelection(party.id);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                if (result.success) {
                    this.renderSetup(gameState);
                }
                return;
            }

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
            <div class="modal-content mp-picker-modal candidate-editor-modal">
                <div class="modal-header">
                    <h3>👤 Add Candidate Names</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:12px;">
                    Add up to 20 custom candidate names. These will be assigned as your party's top candidates.
                    Enter one name per line.
                </p>
                <textarea id="cand-bulk-input" rows="10" class="form-input form-textarea" style="width:100%;font-size:0.85rem;" placeholder="สมชาย ใจดี&#10;พรทิพย์ แสงทอง&#10;ธนกร ศรีสุข">${candidatesList.join('\n')}</textarea>
                <div class="candidate-editor-actions" style="display:flex;gap:8px;margin-top:12px;">
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
        window.Game.UI.Map.moveTo('screen-campaign');

        const sidebar = document.getElementById('campaign-sidebar');
        if (!sidebar) return;

        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const app = window.Game.App;
        const multiplayerActive = !!(app && app.isMultiplayerActive && app.isMultiplayerActive());
        const multiplayerState = gameState.multiplayer || {};
        const maxTurns = multiplayerActive
            ? (app.getMultiplayerCampaignTurnTarget ? app.getMultiplayerCampaignTurnTarget() : (multiplayerState.campaignRequiredTurns || 8))
            : window.Game.Engine.Campaign.getMaxCampaignTurns(gameState);
        const apPerTurn = window.Game.Engine.Campaign.getAPPerTurn(gameState);
        const momentum = (gameState.campaignMomentum && gameState.campaignMomentum[gameState.playerPartyId]) || 0;
        const momentumColor = momentum > 0 ? 'var(--success)' : (momentum < 0 ? 'var(--crimson)' : 'var(--text-secondary)');
        const waitingForOthers = !!(multiplayerActive && multiplayerState.waitingForOthers);
        const myProgress = Number(multiplayerState.myTurnsCompleted || 0);
        const progressRows = Object.entries(multiplayerState.progressByPlayerId || {});

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
                <div class="campaign-party-block">
                    <div class="player-party-badge" style="border-color:${playerParty.hexColor}">
                        <span style="color:${playerParty.hexColor}">${playerParty.thaiName}</span>
                        <span>Capital: ${playerParty.politicalCapital} | Grey: ${playerParty.greyMoney}</span>
                    </div>
                    ${multiplayerActive ? `
                        <div class="campaign-notification-slot" style="margin-bottom:8px;">
                            <div class="campaign-notification-title">Multiplayer Progress</div>
                            <div class="campaign-notification-content notif-info" style="display:block;">
                                <div>You: ${myProgress}/${maxTurns}</div>
                                <div style="margin-top:6px;display:grid;gap:4px;">
                                    ${progressRows.length === 0
                                        ? '<span style="font-size:0.75rem;color:var(--text-dim);">Waiting for room updates...</span>'
                                        : progressRows.map(([pid, row]) => `<span style="font-size:0.74rem;">Seat ${row.seat || '-'} · ${row.name}${pid === multiplayerState.playerId ? ' (You)' : ''}: ${row.turnsCompleted}/${maxTurns}${row.completed ? ' ✓' : ''}</span>`).join('')
                                    }
                                </div>
                            </div>
                        </div>
                    ` : ''}
                    <div class="campaign-notification-slot" id="campaign-notification-slot">
                        <div class="campaign-notification-title">Notification Bar</div>
                        <div class="campaign-notification-content">No notifications yet.</div>
                    </div>
                </div>
                ${gameState.pendingCampaignEvent ? '<p class="campaign-event-hint">Weekly event pending: choose a response to continue.</p>' : ''}
                ${waitingForOthers ? '<p class="campaign-event-hint">You completed 8/8 turns. Waiting for all players to finish.</p>' : ''}
                <button class="btn-primary btn-end-turn" id="btn-end-campaign-turn" ${waitingForOthers ? 'disabled' : ''}>
                    ${multiplayerActive
                        ? (gameState.campaignTurn >= maxTurns ? '⏳ Finish & Wait' : '➡️ End Week (Sync)')
                        : (gameState.campaignTurn >= maxTurns ? '🗳️ Hold Election' : '➡️ End Week')}
                </button>
                ${waitingForOthers ? `
                    <div class="setup-scenario-panel" style="margin-top:10px;">
                        <div class="setup-scenario-title">Waiting Room</div>
                        <p class="setup-scenario-desc">You finished your campaign turns. Chat while waiting for all players to complete ${maxTurns}/${maxTurns}.</p>
                    </div>
                ` : ''}
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

        this._syncCampaignNotificationBar();

        // Render action cards
        this._renderActionCards(gameState);
        this._setupCampaignMobileNavigation();

        // Prevent duplicate chat nodes when campaign rerenders.
        const oldCampaignChat = document.querySelector('#screen-campaign .campaign-chat-dock');
        if (oldCampaignChat) oldCampaignChat.remove();

        if (this._shouldRenderMultiplayerChat(gameState)) {
            const chatMarkup = this._renderMultiplayerChatBox(gameState, 'campaign');
            if (chatMarkup) {
                const chatWrap = document.createElement('div');
                chatWrap.innerHTML = chatMarkup;
                if (chatWrap.firstElementChild) {
                    chatWrap.firstElementChild.classList.add('campaign-chat-dock');
                    const campaignScreen = document.getElementById('screen-campaign');
                    if (campaignScreen) {
                        campaignScreen.appendChild(chatWrap.firstElementChild);
                    } else {
                        sidebar.appendChild(chatWrap.firstElementChild);
                    }
                    this._bindMultiplayerChatBox(gameState, 'campaign');
                }
            }
        }

        // Province click handler for campaign
        this.onProvinceClick = (provinceName) => {
            if (waitingForOthers) {
                this.showNotification('You already completed 8/8 turns. Waiting for other players.', 'info');
                return;
            }
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
            <div class="modal-content campaign-event-modal">
                <div class="modal-header campaign-event-header">
                    <h3>📰 Weekly Campaign Event</h3>
                </div>
                <div class="campaign-event-body">
                    <div class="campaign-event-title">${event.title}</div>
                    <p class="campaign-event-description">${event.description}</p>
                </div>
                <div class="campaign-event-options">
                    ${event.options.map((opt, idx) => {
                        const successPct = Math.round((opt.successChance || 0) * 100);
                        const toneClass = successPct >= 70 ? 'high' : (successPct >= 50 ? 'medium' : 'low');
                        return `
                            <button class="campaign-event-option ${toneClass}" data-idx="${idx}">
                                <span class="campaign-event-option-label">${opt.label}</span>
                                <span class="campaign-event-option-meta">Estimated success: <strong>${successPct}%</strong></span>
                            </button>
                        `;
                    }).join('')}
                </div>
                <p class="campaign-event-footnote">No skip option: campaign narrative moves every week.</p>
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
        const app = window.Game.App;
        const multiplayerLocked = !!(app && app.isMultiplayerActive && app.isMultiplayerActive() && gameState.multiplayer && gameState.multiplayer.waitingForOthers);

        for (const [key, action] of Object.entries(window.Game.Engine.Campaign.ACTIONS)) {
            const canAfford = gameState.actionPoints >= action.apCost;
            const hasGreyMoney = !action.requiresGreyMoney || playerParty.greyMoney >= action.requiresGreyMoney;
            const disabled = multiplayerLocked || !canAfford || !hasGreyMoney;

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
        const app = window.Game.App;
        const multiplayerLocked = !!(app && app.isMultiplayerActive && app.isMultiplayerActive() && gameState.multiplayer && gameState.multiplayer.waitingForOthers);
        if (multiplayerLocked) {
            this.showNotification('You already completed 8/8 turns. Waiting for other players.', 'info');
            return;
        }

        const seats = window.Game.Data.PROVINCES[provinceName] || 0;
        const region = window.Game.Data.PROVINCE_REGION[provinceName] || 'Unknown';
        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        const notifyServerAction = (actionKey, payload = {}) => {
            if (!(app && app.isMultiplayerActive && app.isMultiplayerActive())) return;
            if (window.Game.Multiplayer) {
                window.Game.Multiplayer.reportCampaignAction(actionKey, payload);
            }
        };

        const actionCatalog = window.Game.Engine.Campaign.ACTIONS || {};
        const actionRows = [
            { key: 'rally', icon: '📢', label: 'Rally Here', hint: 'Boost local momentum and visibility.' },
            { key: 'canvass', icon: '🚪', label: 'Canvass', hint: 'Focus one key district in this province.' },
            { key: 'attackAd', icon: '⚔️', label: 'Attack Ad', hint: 'Pressure a rival party in this province.' },
            { key: 'ioOperation', icon: '🕵️', label: 'IO Operation', hint: 'Deploy high-impact information ops.' },
            { key: 'buySupport', icon: '🤝', label: 'Buy Support', hint: 'Convert support quickly using grey funds.' }
        ].map(row => {
            const action = actionCatalog[row.key];
            if (!action) return null;
            const canAffordAp = gameState.actionPoints >= action.apCost;
            const canAffordGrey = !action.requiresGreyMoney || (playerParty && playerParty.greyMoney >= action.requiresGreyMoney);
            return {
                ...row,
                action,
                disabled: !canAffordAp || !canAffordGrey
            };
        }).filter(Boolean);

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
                <div class="province-resources">
                    <span class="province-resource province-resource-ap">AP: ${gameState.actionPoints}</span>
                    <span class="province-resource province-resource-grey">Grey: ${playerParty ? playerParty.greyMoney : 0}</span>
                </div>
                <div class="province-actions">
                    ${actionRows.map(row => `
                        <button class="province-action-btn ${row.disabled ? 'disabled' : ''}" data-action="${row.key}" ${row.disabled ? 'disabled' : ''}>
                            <span class="province-action-icon">${row.icon}</span>
                            <span class="province-action-main">
                                <span class="province-action-title">${row.label}</span>
                                <span class="province-action-hint">${row.hint}</span>
                            </span>
                            <span class="province-action-cost">
                                <span class="province-ap-chip">${row.action.apCost} AP</span>
                                ${row.action.requiresGreyMoney ? `<span class="province-grey-chip">${row.action.requiresGreyMoney} 💰</span>` : ''}
                            </span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        document.getElementById('modal-close').addEventListener('click', () => {
            modal.classList.add('hidden');
        });

        modal.querySelectorAll('.province-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
            if (btn.disabled) return;
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
                    notifyServerAction(actionKey, { provinceName, districtId: targetDistrict.id });
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
                        notifyServerAction(actionKey, { provinceName, targetPartyId });
                        this.showNotification(msg, 'success');
                        modal.classList.add('hidden');
                        this.renderCampaign(gameState);
                    });
                    return;
                }

                const msg = action.execute(gameState, { provinceName });
                gameState.actionPoints -= action.apCost;
                notifyServerAction(actionKey, { provinceName });
                this.showNotification(msg, 'success');
                modal.classList.add('hidden');
                this.renderCampaign(gameState);
            });
        });
    },

    _showActionTargeting(actionKey, action, gameState) {
        const app = window.Game.App;
        const multiplayerLocked = !!(app && app.isMultiplayerActive && app.isMultiplayerActive() && gameState.multiplayer && gameState.multiplayer.waitingForOthers);
        if (multiplayerLocked) {
            this.showNotification('You already completed 8/8 turns. Waiting for other players.', 'info');
            return;
        }

        if (['rally', 'canvass', 'attackAd', 'ioOperation', 'buySupport'].includes(actionKey)) {
            this.showNotification("Click a province on the map to target.", 'info');
            window.Game.UI.Map._mapGroup.selectAll('path.province').classed('targetable', true);
        } else if (actionKey === 'fundraise') {
            const msg = action.execute(gameState);
            gameState.actionPoints -= action.apCost;
            if (app && app.isMultiplayerActive && app.isMultiplayerActive() && window.Game.Multiplayer) {
                window.Game.Multiplayer.reportCampaignAction(actionKey, {});
            }
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
        const promiseAction = window.Game.Engine.Campaign.ACTIONS.promisePolicy;
        const app = window.Game.App;

        modal.innerHTML = `
            <div class="modal-content promise-modal">
                <div class="modal-header promise-modal-header">
                    <h3>📜 Choose a Policy Promise</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <p class="promise-modal-intro">
                    Making a promise boosts popularity NOW but you must pass the matching law in government or lose trust!
                </p>
                <div class="promise-modal-meta">
                    <span class="promise-modal-chip">AP Cost: ${promiseAction ? promiseAction.apCost : 0}</span>
                    <span class="promise-modal-chip">Already Promised: ${existing.length}</span>
                </div>
                <div class="promise-list promise-list-chooser">
                    ${promises.map(p => {
                        const alreadyPromised = existing.includes(p.promiseId);
                        const boosts = Object.entries(p.popularityBoost || {}).map(([r, v]) => `${r} +${v}`).join(', ');
                        return `
                            <div class="promise-pick-card ${alreadyPromised ? 'disabled' : ''}" data-pid="${p.promiseId}">
                                <div class="promise-icon-wrap">
                                    <div class="promise-icon">${p.icon}</div>
                                </div>
                                <div class="promise-info">
                                    <div class="promise-name">${p.name}</div>
                                    <div class="promise-eng">${p.engName}</div>
                                    <div class="promise-desc">${p.description}</div>
                                    <div class="promise-regions">Boosts: ${boosts}</div>
                                </div>
                                ${alreadyPromised
                                    ? '<span class="promise-done">✓ Promised</span>'
                                    : '<span class="promise-pick-cta">Select</span>'}
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
                if (app && app.isMultiplayerActive && app.isMultiplayerActive() && window.Game.Multiplayer) {
                    window.Game.Multiplayer.reportCampaignAction('promisePolicy', { promiseId: promise.promiseId });
                }
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

    renderElectionPending(gameState) {
        this.show('screen-election');
        window.Game.UI.Map.moveTo('map-container-election');

        const panel = document.getElementById('election-results-panel');
        if (!panel) return;

        const app = window.Game.App;
        const isHost = !!(app && app.isMultiplayerHost && app.isMultiplayerHost());
        const seed = (gameState.multiplayer && gameState.multiplayer.electionSeed) || null;

        panel.innerHTML = `
            <div class="results-header">
                <h2>🗳️ Election Processing</h2>
                <p class="results-subtitle">Synchronizing room results before coalition</p>
            </div>
            <div class="setup-scenario-panel" style="margin-top:10px;">
                <div class="setup-scenario-title">Room Sync Status</div>
                <p class="setup-scenario-desc">
                    ${isHost
                        ? 'You are host. Computing and locking election results for everyone...'
                        : 'Waiting for host to lock election results for the room...'}
                </p>
                <p class="setup-scenario-desc" style="margin-top:6px;color:var(--text-dim);font-size:0.78rem;">
                    ${seed ? `Election seed: ${seed}` : 'Election seed pending...'}
                </p>
            </div>
        `;
    },

    // ─── ELECTION RESULTS SCREEN ───
    renderElectionResults(gameState) {
        this.show('screen-election');

        // Move map to election screen container
        window.Game.UI.Map.moveTo('map-container-election');

        const panel = document.getElementById('election-results-panel');
        if (!panel) return;

        const app = window.Game.App;
        const multiplayerActive = !!(app && app.isMultiplayerActive && app.isMultiplayerActive());
        const mpState = gameState.multiplayer || {};
        const roomState = String(mpState.roomState || '').toLowerCase();
        const isHost = !!(multiplayerActive && app && app.isMultiplayerHost && app.isMultiplayerHost());
        const coalitionBtnLabel = multiplayerActive
            ? (roomState === 'coalition'
                ? '➡️ Enter Coalition'
                : (isHost ? '➡️ Start Coalition (Room)' : '⏳ Waiting for Host to Start Coalition'))
            : '➡️ Form Coalition';

        const results = gameState.electionResults;
        const parties = gameState.parties;
        this._clearElectionRevealEffects();

        // Animate map
        window.Game.UI.Map.updateMapColors(results, parties, gameState.districts, true);

        // Sort parties by total seats
        const sorted = [...parties].sort((a, b) => results.totalSeats[b.id] - results.totalSeats[a.id]);
        const topParty = sorted[0] || null;
        const topSeats = topParty ? (results.totalSeats[topParty.id] || 0) : 0;
        const majorityNeeded = 251;
        const majorityGap = Math.max(0, majorityNeeded - topSeats);
        const hasMajority = topSeats >= majorityNeeded;

        panel.innerHTML = `
            <div class="results-header">
                <h2>🗳️ Election Results 2569</h2>
                <p class="results-subtitle">500-Seat Parliament</p>
            </div>
            <div class="results-spotlight">
                <div class="spotlight-card winner">
                    <span class="spotlight-label">Leading Party</span>
                    <strong class="spotlight-party" style="color:${topParty ? topParty.hexColor : '#f8fafc'}">
                        ${topParty ? `${topParty.thaiName} (${topParty.shortName})` : 'No Leader'}
                    </strong>
                    <div class="spotlight-metric">
                        <span class="spotlight-number" data-roll-to="${topSeats}">0</span>
                        <span class="spotlight-unit">seats</span>
                    </div>
                </div>
                <div class="spotlight-card ${hasMajority ? 'secure' : 'chasing'}">
                    <span class="spotlight-label">Majority Status</span>
                    <strong class="spotlight-party">${hasMajority ? 'Majority Secured' : 'Needs Coalition'}</strong>
                    <div class="spotlight-metric">
                        <span class="spotlight-number" data-roll-to="${hasMajority ? topSeats : majorityGap}">0</span>
                        <span class="spotlight-unit">${hasMajority ? 'seats held' : 'seats short'}</span>
                    </div>
                </div>
            </div>
            <div class="results-chart" id="results-chart"></div>
            <div class="results-table">
                <div class="results-table-header">
                    <span>Party</span><span>Constituency</span><span>Party List</span><span>Total</span>
                </div>
                ${sorted.map((p, index) => `
                    <div class="results-row ${p.id === gameState.playerPartyId ? 'player-row' : ''}" style="--row-index:${index};">
                        <span class="results-party">
                            <span class="party-dot" style="background:${p.hexColor}"></span>
                            ${p.thaiName} <small>${p.shortName}</small>
                        </span>
                        <span class="results-value" data-roll-to="${results.constituencyWins[p.id] || 0}">0</span>
                        <span class="results-value" data-roll-to="${results.partyListSeats[p.id] || 0}">0</span>
                        <span class="results-total" data-roll-to="${results.totalSeats[p.id] || 0}">0</span>
                    </div>
                `).join('')}
            </div>
            <div class="results-footer">
                <div class="majority-line">
                    <span>Majority: 251 seats</span>
                    <div class="majority-bar">
                        ${sorted.map((p, index) => `<div class="majority-segment" style="--segment-index:${index};background:${p.hexColor}" data-target-width="${results.totalSeats[p.id] / 5}" title="${p.shortName}: ${results.totalSeats[p.id]}"></div>`).join('')}
                        <div class="majority-marker" style="left:50.2%"></div>
                    </div>
                </div>
            </div>
            <button class="btn-primary btn-gold" id="btn-to-coalition">
                ${coalitionBtnLabel}
            </button>
        `;

        // Hemicycle chart
        this._renderHemicycle('results-chart', sorted, results);
        this._runElectionReveal(panel, topParty ? topParty.hexColor : '#d4a843');

        document.getElementById('btn-to-coalition').addEventListener('click', () => {
            const result = (window.Game.App && typeof window.Game.App.requestCoalitionPhaseFromElection === 'function')
                ? window.Game.App.requestCoalitionPhaseFromElection()
                : { success: true };
            if (result && result.success === false) {
                this.showNotification(result.msg || 'Cannot enter coalition yet.', 'info');
            }
        });
    },

    _runElectionReveal(panel, winnerColor = '#d4a843') {
        if (!panel) return;

        const values = Array.from(panel.querySelectorAll('[data-roll-to]'));
        const segments = Array.from(panel.querySelectorAll('.majority-segment'));
        const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        panel.classList.remove('is-revealing');
        panel.classList.remove('finale-hit');

        for (const el of values) {
            el.textContent = '0';
        }

        for (const segment of segments) {
            segment.style.width = '0%';
        }

        requestAnimationFrame(() => {
            panel.classList.add('is-revealing');
            this._playElectionRevealCue('intro');

            for (const segment of segments) {
                const target = Number(segment.dataset.targetWidth || 0);
                segment.style.width = `${Math.max(0, Math.min(100, target))}%`;
            }

            let revealCompleteMs = 320;
            values.forEach((el, index) => {
                const target = Math.max(0, Number(el.dataset.rollTo || 0));
                const baseDelay = 220 + (index * 65);
                const duration = 700 + Math.min(1200, target * 8);
                revealCompleteMs = Math.max(revealCompleteMs, baseDelay + duration);
                this._animateNumber(el, target, duration, baseDelay);
            });

            this._scheduleElectionFinale(panel, revealCompleteMs + 180, winnerColor, reducedMotion);
        });
    },

    _scheduleElectionFinale(panel, delayMs, winnerColor, reducedMotion) {
        if (!panel) return;
        if (this._electionRevealFinaleTimer) {
            clearTimeout(this._electionRevealFinaleTimer);
            this._electionRevealFinaleTimer = null;
        }

        this._electionRevealFinaleTimer = setTimeout(() => {
            panel.classList.add('finale-hit');
            if (this._electionRevealPulseTimer) {
                clearTimeout(this._electionRevealPulseTimer);
                this._electionRevealPulseTimer = null;
            }
            this._electionRevealPulseTimer = setTimeout(() => {
                panel.classList.remove('finale-hit');
            }, 760);

            this._playElectionRevealCue('finale');
            if (!reducedMotion) {
                this._spawnElectionWinnerBurst(panel, winnerColor);
            }
        }, Math.max(450, Math.round(delayMs)));
    },

    _spawnElectionWinnerBurst(panel, winnerColor) {
        if (!panel) return;

        const existing = panel.querySelector('.election-burst');
        if (existing) existing.remove();

        const burst = document.createElement('div');
        burst.className = 'election-burst';

        const ring = document.createElement('span');
        ring.className = 'election-burst-ring';
        ring.style.setProperty('--burst-color', winnerColor || '#d4a843');
        burst.appendChild(ring);

        const particles = 26;
        for (let i = 0; i < particles; i++) {
            const particle = document.createElement('span');
            particle.className = 'election-burst-particle';

            const angle = (Math.PI * 2 * i) / particles + ((Math.random() - 0.5) * 0.28);
            const distance = 52 + Math.random() * 92;
            const dx = Math.cos(angle) * distance;
            const dy = Math.sin(angle) * distance;
            const size = 4 + (Math.random() * 7);
            const delay = Math.round(Math.random() * 120);

            particle.style.setProperty('--dx', `${dx.toFixed(2)}px`);
            particle.style.setProperty('--dy', `${dy.toFixed(2)}px`);
            particle.style.setProperty('--size', `${size.toFixed(2)}px`);
            particle.style.setProperty('--delay', `${delay}ms`);
            particle.style.setProperty('--burst-color', (i % 4 === 0) ? '#f8d57a' : (winnerColor || '#d4a843'));
            burst.appendChild(particle);
        }

        panel.appendChild(burst);
        setTimeout(() => burst.remove(), 1250);
    },

    _playElectionRevealCue(type = 'intro') {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;

        if (!this._audioCtx) {
            try {
                this._audioCtx = new Ctx();
            } catch (_) {
                return;
            }
        }

        const ctx = this._audioCtx;
        if (!ctx) return;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        const now = ctx.currentTime + 0.01;
        const notes = type === 'finale'
            ? [
                { freq: 523.25, at: 0.00, dur: 0.10 },
                { freq: 659.25, at: 0.08, dur: 0.10 },
                { freq: 783.99, at: 0.16, dur: 0.14 }
            ]
            : [
                { freq: 293.66, at: 0.00, dur: 0.06 },
                { freq: 369.99, at: 0.06, dur: 0.08 }
            ];

        for (const note of notes) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type === 'finale' ? 'triangle' : 'sine';
            osc.frequency.setValueAtTime(note.freq, now + note.at);

            gain.gain.setValueAtTime(0.0001, now + note.at);
            gain.gain.exponentialRampToValueAtTime(type === 'finale' ? 0.038 : 0.025, now + note.at + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.dur);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(now + note.at);
            osc.stop(now + note.at + note.dur + 0.02);
        }
    },

    _clearElectionRevealEffects() {
        if (this._electionRevealFinaleTimer) {
            clearTimeout(this._electionRevealFinaleTimer);
            this._electionRevealFinaleTimer = null;
        }
        if (this._electionRevealPulseTimer) {
            clearTimeout(this._electionRevealPulseTimer);
            this._electionRevealPulseTimer = null;
        }

        const panel = document.getElementById('election-results-panel');
        if (!panel) return;

        panel.classList.remove('finale-hit');
        const existing = panel.querySelector('.election-burst');
        if (existing) existing.remove();
    },

    _animateNumber(el, target, duration = 900, delay = 0) {
        if (!el) return;
        const safeDuration = Math.max(300, duration);
        const start = performance.now() + Math.max(0, delay);

        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
        const step = (now) => {
            if (now < start) {
                requestAnimationFrame(step);
                return;
            }

            const progress = Math.min(1, (now - start) / safeDuration);
            const eased = easeOutCubic(progress);
            const value = Math.round(target * eased);
            el.textContent = String(value);

            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = String(target);
            }
        };

        requestAnimationFrame(step);
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
        const multiplayerActive = !!(app && app.isMultiplayerActive && app.isMultiplayerActive());
        const realtimePendingOffer = (multiplayerActive && app.getMyMultiplayerPendingCoalitionOffer)
            ? app.getMyMultiplayerPendingCoalitionOffer()
            : null;
        const pendingOffer = realtimePendingOffer || gameState.pendingCoalitionOffer || null;
        const hasGovernment = !!gameState.governmentPartyId;
        const governmentParty = parties.find(p => p.id === gameState.governmentPartyId);
        const offeringPlayer = realtimePendingOffer
            ? (gameState.multiplayer && Array.isArray(gameState.multiplayer.players)
                ? gameState.multiplayer.players.find(p => p.playerId === realtimePendingOffer.fromPlayerId)
                : null)
            : null;
        const offeringParty = (pendingOffer && !realtimePendingOffer)
            ? parties.find(p => p.id === pendingOffer.formateurId)
            : null;
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
                        Coalition Offer: <strong>${realtimePendingOffer ? (offeringPlayer ? offeringPlayer.name : 'Player') : (offeringParty ? offeringParty.thaiName : 'AI Party')}</strong> invites your party to join.
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
                <p class="coalition-warning">Waiting for coalition lead or incoming realtime offer.</p>
            `}
        `;

        if (this._shouldRenderMultiplayerChat(gameState)) {
            const chatMarkup = this._renderMultiplayerChatBox(gameState, 'coalition');
            if (chatMarkup) {
                const chatWrap = document.createElement('div');
                chatWrap.innerHTML = chatMarkup;
                if (chatWrap.firstElementChild) {
                    panel.appendChild(chatWrap.firstElementChild);
                    this._bindMultiplayerChatBox(gameState, 'coalition');
                }
            }
        }

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
        if (acceptOfferBtn) {
            acceptOfferBtn.addEventListener('click', () => {
                if (realtimePendingOffer && realtimePendingOffer.offerId && app.respondMultiplayerCoalitionOffer) {
                    const result = app.respondMultiplayerCoalitionOffer(realtimePendingOffer.offerId, true);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderCoalition(gameState);
                    return;
                }
                app.respondToCoalitionOffer(true);
            });
        }

        const rejectOfferBtn = document.getElementById('btn-reject-coalition-offer');
        if (rejectOfferBtn) {
            rejectOfferBtn.addEventListener('click', () => {
                if (realtimePendingOffer && realtimePendingOffer.offerId && app.respondMultiplayerCoalitionOffer) {
                    const result = app.respondMultiplayerCoalitionOffer(realtimePendingOffer.offerId, false);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderCoalition(gameState);
                    return;
                }
                app.respondToCoalitionOffer(false);
            });
        }
    },

    _animateCounterValue(node, targetValue, suffix = '') {
        if (!(node instanceof HTMLElement)) return;
        const target = Number(targetValue);
        if (!Number.isFinite(target)) {
            node.textContent = `${targetValue}${suffix}`;
            return;
        }

        const previous = Number(node.dataset.counterCurrent);
        const start = Number.isFinite(previous) ? previous : 0;
        const decimals = Number.isInteger(target) ? 0 : 1;
        const duration = 460;
        const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        const tick = (now) => {
            const elapsed = Math.max(0, now - startedAt);
            const t = Math.min(1, elapsed / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            const value = start + ((target - start) * eased);
            node.textContent = `${value.toFixed(decimals)}${suffix}`;

            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                node.textContent = `${target.toFixed(decimals)}${suffix}`;
                node.dataset.counterCurrent = String(target);
            }
        };

        requestAnimationFrame(tick);
    },

    _runParliamentStatAnimations(scopeEl = document) {
        if (!scopeEl || typeof scopeEl.querySelectorAll !== 'function') return;
        const counters = scopeEl.querySelectorAll('[data-counter-value]');
        counters.forEach((node) => {
            const target = Number(node.getAttribute('data-counter-value'));
            const suffix = node.getAttribute('data-counter-suffix') || '';
            this._animateCounterValue(node, target, suffix);
        });
    },

    // ─── Update parliament stats header without full re-render ──────
    _updateParliamentStats(gameState) {
        const headerBar = document.querySelector('.parliament-header-bar');
        if (!headerBar) return;
        const playerParty = gameState.parties.find(p => p.id === gameState.playerPartyId);
        if (!playerParty) return;
        const isOpposition = gameState.playerRole === 'opposition';
        const showKeyboardHint = !this._isMobileLayout();
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
                    <span>${isOpposition ? 'Role: Opposition' : `Coalition: <span class="counter-inline" data-counter-value="${coalitionSeats}">${coalitionSeats}</span> seats`}</span>
                </div>
                <div class="parl-stat">Capital: <strong data-counter-value="${playerParty.politicalCapital}">${playerParty.politicalCapital}</strong></div>
                <div class="parl-stat">Grey: <strong data-counter-value="${playerParty.greyMoney}">${playerParty.greyMoney}</strong></div>
                <div class="parl-stat danger-stat">Scandal: <strong data-counter-value="${playerParty.scandalMeter}">${playerParty.scandalMeter}</strong>/100</div>
                ${isOpposition ? '' : `<div class="parl-stat">Bills: <strong>${govBillStatus.used}/${govBillStatus.cap}</strong></div>`}
                ${isOpposition ? '' : `<div class="parl-stat">PM Ops: <strong>${pmOpsStatus.used}/${pmOpsStatus.cap}</strong></div>`}
            `;
            this._runParliamentStatAnimations(statsEl);
        }
    },

    // ─── PARLIAMENT SCREEN ──────
    renderParliament(gameState) {
        this.show('screen-parliament');
        try {

        window.Game.UI.Map.moveTo('parliament-map-container');

        const main = document.getElementById('parliament-main');
        if (!main) return;
        this._setupParliamentMobileNavigation();

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
        const showKeyboardHint = !this._isMobileLayout();
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

        const phaseInfo = window.Game.Engine.Parliament.getSessionPhaseInfo(gameState);
        if (!isOpposition && phaseInfo.phase === 'legislative' && typeof parliamentEngine.generateOppositionTacticsPlan === 'function') {
            parliamentEngine.generateOppositionTacticsPlan(gameState);
        }
        const coalitionHealth = !isOpposition ? window.Game.Engine.Parliament.getCoalitionHealth(gameState) : null;
        const cabinetStatus = !isOpposition && typeof parliamentEngine.getCabinetAssignmentStatus === 'function'
            ? parliamentEngine.getCabinetAssignmentStatus(gameState)
            : null;
        const cabinetNeedsSetup = !!(cabinetStatus && !cabinetStatus.finalized);
        const healthColor = coalitionHealth
            ? (coalitionHealth.average >= 70 ? '#4ade80' : coalitionHealth.average >= 45 ? '#d4a843' : coalitionHealth.average >= 25 ? '#f59e0b' : '#ef4444')
            : '#666';
        const healthLabel = coalitionHealth
            ? (coalitionHealth.average >= 70 ? 'Stable' : coalitionHealth.average >= 45 ? 'Uneasy' : coalitionHealth.average >= 25 ? 'Strained' : 'Critical')
            : 'N/A';
        const showCoalitionNegotiation = !isOpposition && !cabinetNeedsSetup && phaseInfo.phase === 'legislative';
        const coalitionNegotiationPanel = showCoalitionNegotiation ? this._renderCoalitionNegotiationPanel(gameState) : '';
        const coalitionDynamicsPanel = !isOpposition ? this._renderCoalitionDynamicsPanel(gameState) : '';
        const coalitionToneClass = coalitionHealth
            ? (coalitionHealth.average >= 70 ? 'coalition-tone-stable' : coalitionHealth.average >= 45 ? 'coalition-tone-uneasy' : coalitionHealth.average >= 25 ? 'coalition-tone-strained' : 'coalition-tone-critical')
            : 'coalition-tone-unknown';

        const app = window.Game.App;
        const multiplayerState = gameState.multiplayer || {};
        const multiplayerParliamentWaiting = !!(
            app
            && app.isMultiplayerActive
            && app.isMultiplayerActive()
            && String(multiplayerState.roomState || '').toLowerCase() === 'parliament'
            && multiplayerState.parliamentWaitingForOthers
        );
        const parliamentProgressMap = (multiplayerState.parliamentProgressByPlayerId && typeof multiplayerState.parliamentProgressByPlayerId === 'object')
            ? multiplayerState.parliamentProgressByPlayerId
            : {};
        const parliamentProgressRows = Array.isArray(multiplayerState.players)
            ? multiplayerState.players.map((player) => {
                const row = parliamentProgressMap[player.playerId] || {};
                return {
                    playerId: player.playerId,
                    name: player.name || player.playerId,
                    completed: !!row.completed,
                    connected: row.connected !== false && player.connected !== false,
                    role: row.role || player.role || null
                };
            })
            : [];

        if (multiplayerParliamentWaiting) {
            main.innerHTML = `
                <div class="parliament-header-bar">
                    <div class="parl-info">
                        <span class="parl-year">Year ${displayedYear} / 4</span>
                        <span class="parl-session">Session ${gameState.sessionNumber}</span>
                    </div>
                    <div class="parl-stats">
                        <div class="parl-stat" style="border-color:${playerParty.hexColor}">
                            <span>${playerParty.thaiName}</span>
                            <span>${isOpposition ? 'Role: Opposition' : `Coalition: <span class="counter-inline" data-counter-value="${coalitionSeats}">${coalitionSeats}</span> seats`}</span>
                        </div>
                        <div class="parl-stat">Capital: <strong data-counter-value="${playerParty.politicalCapital}">${playerParty.politicalCapital}</strong></div>
                        <div class="parl-stat">Grey: <strong data-counter-value="${playerParty.greyMoney}">${playerParty.greyMoney}</strong></div>
                        <div class="parl-stat danger-stat">Scandal: <strong data-counter-value="${playerParty.scandalMeter}">${playerParty.scandalMeter}</strong>/100</div>
                    </div>
                </div>

                <div class="setup-scenario-card" style="margin-top:16px;">
                    <div class="setup-scenario-title">Waiting For Room Parliament Completion</div>
                    <p class="setup-scenario-desc">You finished the 4-year term. You are now locked in waiting mode until every player completes this parliament phase.</p>
                    <div class="campaign-progress-table" style="margin-top:8px;">
                        ${parliamentProgressRows.map((row) => `
                            <div class="campaign-progress-row ${row.completed ? 'done' : ''}" style="grid-template-columns: minmax(110px, 1.5fr) minmax(80px, 1fr) minmax(90px, 1fr) minmax(140px, 1fr);">
                                <span class="campaign-progress-name">${row.name}</span>
                                <span>${row.role ? row.role.toUpperCase() : 'PLAYER'}</span>
                                <span>${row.connected ? 'Online' : 'Offline'}</span>
                                <span>${row.completed ? 'Complete' : 'In Progress'}</span>
                            </div>
                        `).join('') || '<div class="placeholder-text">Waiting for parliament progress updates from server...</div>'}
                    </div>
                </div>
            `;

            this._runParliamentStatAnimations(main);
            if (this._shouldRenderMultiplayerChat(gameState)) {
                const chatMarkup = this._renderMultiplayerChatBox(gameState, 'parliament');
                if (chatMarkup) {
                    const chatWrap = document.createElement('div');
                    chatWrap.innerHTML = chatMarkup;
                    if (chatWrap.firstElementChild) {
                        main.appendChild(chatWrap.firstElementChild);
                        this._bindMultiplayerChatBox(gameState, 'parliament');
                    }
                }
            }
            return;
        }

        main.innerHTML = `
            <div class="parliament-header-bar">
                <div class="parl-info">
                    <span class="parl-year">Year ${displayedYear} / 4</span>
                    <span class="parl-session">Session ${gameState.sessionNumber}</span>
                </div>
                <div class="parl-stats">
                    <div class="parl-stat" style="border-color:${playerParty.hexColor}">
                        <span>${playerParty.thaiName}</span>
                        <span>${isOpposition ? 'Role: Opposition' : `Coalition: <span class="counter-inline" data-counter-value="${coalitionSeats}">${coalitionSeats}</span> seats`}</span>
                    </div>
                    <div class="parl-stat">Capital: <strong data-counter-value="${playerParty.politicalCapital}">${playerParty.politicalCapital}</strong></div>
                    <div class="parl-stat">Grey: <strong data-counter-value="${playerParty.greyMoney}">${playerParty.greyMoney}</strong></div>
                    <div class="parl-stat danger-stat">Scandal: <strong data-counter-value="${playerParty.scandalMeter}">${playerParty.scandalMeter}</strong>/100</div>
                    ${isOpposition ? '' : `<div class="parl-stat">Bills: <strong>${govBillStatus.used}/${govBillStatus.cap}</strong></div>`}
                    ${isOpposition ? '' : `<div class="parl-stat">PM Ops: <strong>${pmOpsStatus.used}/${pmOpsStatus.cap}</strong></div>`}
                    ${!isOpposition && coalitionHealth ? `<div class="parl-stat coalition-health-chip ${coalitionToneClass}" style="border-color:${healthColor}">Coalition: <strong style="color:${healthColor}" data-counter-value="${coalitionHealth.average}" data-counter-suffix="%">${coalitionHealth.average}%</strong> <span style="font-size:0.65rem;color:${healthColor}">${healthLabel}</span></div>` : ''}
                </div>
            </div>

            ${!isOpposition ? `
            <div class="session-phase-bar">
                <div class="phase-steps">
                    ${window.Game.Engine.Parliament.SESSION_PHASES.map((p, i) => {
                        const info = { question_time: { icon: '❓', name: 'Question Time' }, legislative: { icon: '📜', name: 'Legislative Floor' }, adjournment: { icon: '🔔', name: 'Adjournment' } }[p];
                        const isCurrent = p === phaseInfo.phase;
                        const isDone = i < phaseInfo.phaseIndex;
                        return `<div class="phase-step ${isCurrent ? 'phase-active' : ''} ${isDone ? 'phase-done' : ''}">
                            <span class="phase-icon">${isDone ? '✅' : info.icon}</span>
                            <span class="phase-label">${info.name}</span>
                        </div>`;
                    }).join('<div class="phase-connector"></div>')}
                </div>
            </div>` : ''}


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

            ${!isOpposition ? this._renderCabinetGradeAPanel(gameState) : ''}
            ${showCoalitionNegotiation ? `
                <div class="coalition-ops-row">
                    <div class="coalition-ops-left">${coalitionNegotiationPanel}</div>
                    <div class="coalition-ops-right">${coalitionDynamicsPanel}</div>
                </div>
            ` : coalitionDynamicsPanel}
            ${!isOpposition ? this._renderMinisterialScandalPanel(gameState) : ''}
            ${(!isOpposition && cabinetNeedsSetup) ? '<div class="cabinet-lock-note">Finalize Grade-A cabinet assignments to unlock question time, legislative action, and adjournment controls.</div>' : ''}

            ${(!isOpposition && !cabinetNeedsSetup && phaseInfo.phase === 'question_time') ? `
            <div class="question-time-container" id="question-time-area">
                <div class="qt-header">
                    <h3>❓ Question Time — ตั้งกระทู้ถาม</h3>
                    <p class="qt-desc">Opposition MPs challenge the PM on pressing national issues. Each answer shapes public opinion and coalition trust.</p>
                </div>
                <div class="qt-questions" id="qt-questions">
                    <div class="placeholder-text">Loading questions...</div>
                </div>
                <button class="btn-primary btn-gold" id="btn-end-question-time" style="margin-top:16px;width:100%;">
                    📜 Proceed to Legislative Floor →
                </button>
            </div>` : ''}

            ${(!isOpposition && !cabinetNeedsSetup && phaseInfo.phase === 'adjournment') ? (() => {
                const summary = window.Game.Engine.Parliament.generateAdjournmentSummary(gameState);
                const collapse = gameState._coalitionCollapseResult;
                return `
                <div class="adjournment-container" id="adjournment-area">
                    <div class="adj-header">
                        <h3>🔔 Session Adjournment — ปิดสมัยประชุม</h3>
                        <p class="adj-desc">Review the session's outcomes before advancing time.</p>
                    </div>
                    ${collapse ? `
                    <div class="coalition-collapse-alert">
                        <span style="font-size:1.5rem;">💥</span>
                        <div><strong>${collapse.partyName}</strong> has left the coalition!</div>
                        <div style="font-size:0.8rem;color:var(--text-dim);">Remaining seats: ${collapse.remainingSeats}. ${collapse.remainingSeats < 251 ? '⚠️ You are now a MINORITY government!' : ''}</div>
                    </div>` : ''}
                    <div class="adj-grid">
                        <div class="adj-card">
                            <h4>📰 Session Headlines</h4>
                            ${(summary.headlines.length > 0) ? summary.headlines.map(h => `<div class="headline-item">• ${h}</div>`).join('') : '<div class="placeholder-text">A quiet session.</div>'}
                        </div>
                        <div class="adj-card">
                            <h4>📊 Session Stats</h4>
                            <div class="adj-stat-row"><span>Bills voted</span><span>${summary.billsVoted}</span></div>
                            <div class="adj-stat-row"><span>Scandal</span><span style="color:${summary.scandalLevel > 50 ? '#ef4444' : '#4ade80'}">${summary.scandalLevel}/100</span></div>
                            <div class="adj-stat-row"><span>Capital</span><span>${summary.capitalRemaining}</span></div>
                        </div>
                    </div>

                    <div class="coalition-review-section">
                        <h4>🤝 Coalition Health Review</h4>
                        <div class="coalition-partner-cards">
                            ${Object.entries(summary.coalitionHealth.parties || {}).map(([pid, data]) => {
                                const party = gameState.parties.find(p => p.id === pid);
                                const statusColors = { loyal: '#4ade80', uneasy: '#d4a843', unhappy: '#f59e0b', critical: '#ef4444' };
                                const statusColor = statusColors[data.status] || '#666';
                                const statusClass = `status-${data.status || 'unknown'}`;
                                const ministries = (gameState.coalitionMinistryOffers || {})[pid] || 0;
                                return `
                                <div class="coalition-partner-card" data-party-id="${pid}">
                                    <div class="partner-header">
                                        <span class="partner-dot" style="background:${party ? party.hexColor : '#666'}"></span>
                                        <span class="partner-name">${data.name}</span>
                                        <span class="partner-status ${statusClass}" style="color:${statusColor}">${data.status.toUpperCase()}</span>
                                    </div>
                                    <div class="satisfaction-bar-container">
                                        <div class="satisfaction-bar" style="width:${data.score}%;background:${statusColor}"></div>
                                        <span class="satisfaction-value">${data.score}%</span>
                                    </div>
                                    <div style="font-size:0.7rem;color:var(--text-dim);margin:4px 0;">Ministries: ${ministries}</div>
                                    ${data.demands.length > 0 ? `
                                        <div class="partner-demands">
                                            ${data.demands.map(d => `
                                                <div class="demand-item">
                                                    <span class="demand-label">${d.label}</span>
                                                    <span class="demand-deadline">⏰ ${d.remainingSessions} session(s)</span>
                                                    ${d.capitalCost ? `<button class="btn-small btn-fulfill-demand" data-party-id="${pid}" data-demand-id="${d.instanceId}">Fulfill (${d.capitalCost} cap)</button>` : ''}
                                                    ${d.type === 'endorsement' ? `<button class="btn-small btn-fulfill-demand" data-party-id="${pid}" data-demand-id="${d.instanceId}">Fulfill (${d.capitalCost || 25} cap)</button>` : ''}
                                                    ${d.type === 'ministry' ? `<button class="btn-small btn-demand-ministry" data-party-id="${pid}" data-demand-id="${d.instanceId}">Offer +1 Ministry (-30 cap)</button>` : ''}
                                                </div>
                                            `).join('')}
                                        </div>
                                    ` : '<div style="font-size:0.72rem;color:var(--text-dim)">No active demands.</div>'}
                                    <div class="partner-actions" style="margin-top:6px;display:flex;gap:6px;">
                                        <button class="btn-small btn-reshuffle-up" data-party-id="${pid}" title="Give more ministries (+satisfaction, -30 cap)">+ Ministry</button>
                                        <button class="btn-small btn-reshuffle-down" data-party-id="${pid}" title="Take away ministry (-satisfaction, -30 cap)">- Ministry</button>
                                    </div>
                                </div>`;
                            }).join('')}
                        </div>
                    </div>

                    <button class="btn-primary btn-gold" id="btn-advance-from-adjournment" style="margin-top:16px;width:100%;">
                        ➡️ Advance to Next Session
                    </button>
                </div>`;
            })() : ''}

            ${(isOpposition || (!cabinetNeedsSetup && phaseInfo.phase === 'legislative')) ? `
            <div class="parliament-grid">
                <div class="parl-col parl-bills">
                    <h3><span class="parl-sec-icon">${isOpposition ? '🧭' : '🧾'}</span>${isOpposition ? 'Opposition Desk' : 'Propose a Bill'}</h3>
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
                    <h3><span class="parl-sec-icon">🗳️</span>Voting Chamber</h3>
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

                    <h4 style="margin-top:20px">🎛️ Actions</h4>
                    <div style="font-size:0.68rem;color:var(--text-dim);margin-bottom:8px;">${showKeyboardHint ? 'Shortcuts: Q = end Question Time, A = adjourn.' : 'Use touch controls below to progress session phases.'}</div>
                    <button class="btn-danger" id="btn-no-confidence">
                        ${isOpposition ? 'Launch No-Confidence Motion (-40 cap, 1 action)' : 'Test No-Confidence Survival'}
                    </button>
                    ${!isOpposition ? `<button class="btn-primary btn-gold" id="btn-proceed-adjournment" style="margin-top:10px">
                        🔔 Proceed to Adjournment →
                    </button>` : ''}
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
                <div class="parl-col parl-shadow">
                    <h3><span class="parl-sec-icon">${isOpposition ? '📣' : '🕶️'}</span>${isOpposition ? 'Opposition Tools' : 'Shadow Politics'}</h3>
                    <div class="shadow-actions">
                        <button class="btn-shadow" id="btn-siphon">Siphon Funds</button>
                        <button class="btn-shadow" id="btn-io-deploy">Deploy IO</button>
                        <button class="btn-shadow" id="btn-banana">Distribute Bananas</button>
                    </div>
                    <div id="shadow-result"></div>
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
                    ${(!isOpposition && phaseInfo.phase === 'legislative') ? this._renderOppositionTacticsPanel(gameState) : ''}
                </div>
            </div>` : ''}
        `;

        this._runParliamentStatAnimations(main);

        if (this._shouldRenderMultiplayerChat(gameState)) {
            const chatMarkup = this._renderMultiplayerChatBox(gameState, 'parliament');
            if (chatMarkup) {
                const chatWrap = document.createElement('div');
                chatWrap.innerHTML = chatMarkup;
                if (chatWrap.firstElementChild) {
                    main.appendChild(chatWrap.firstElementChild);
                    this._bindMultiplayerChatBox(gameState, 'parliament');
                }
            }
        }

        if (!isOpposition) {
            this._renderBillList(gameState);
        }

        if (!isOpposition) {
            document.querySelectorAll('.cabinet-ministry-select').forEach(select => {
                select.addEventListener('change', () => {
                    const ministry = select.dataset.ministry;
                    const partyId = select.value || null;
                    const result = window.Game.App.assignCabinetMinistry(ministry, partyId);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                });
            });

            const autoCabinetBtn = document.getElementById('btn-auto-cabinet-portfolios');
            if (autoCabinetBtn) {
                autoCabinetBtn.addEventListener('click', () => {
                    const result = window.Game.App.autoAssignCabinetMinistries();
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                });
            }

            const finalizeCabinetBtn = document.getElementById('btn-finalize-cabinet-portfolios');
            if (finalizeCabinetBtn) {
                finalizeCabinetBtn.addEventListener('click', () => {
                    const result = window.Game.App.finalizeCabinetAssignments();
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                });
            }

            document.querySelectorAll('.btn-ministerial-decision').forEach(btn => {
                btn.addEventListener('click', () => {
                    const decision = btn.dataset.decision;
                    const result = window.Game.App.resolveMinisterialScandalDecision(decision);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                });
            });
        }

        // ─── SESSION PHASE EVENT HANDLERS ─────────────────────────
        // Question Time Phase
        if (!isOpposition && phaseInfo.phase === 'question_time') {
            const qtArea = document.getElementById('qt-questions');
            if (qtArea) {
                if (!gameState.pendingInterpellations || gameState.pendingInterpellations.length === 0) {
                    gameState.pendingInterpellations = window.Game.Engine.Parliament.generateInterpellations(gameState, 2);
                }
                const questions = gameState.pendingInterpellations;
                qtArea.innerHTML = questions.map((q, qi) => `
                    <div class="qt-card" data-question-idx="${qi}">
                        <div class="qt-card-header">
                            <span class="qt-icon">${q.icon}</span>
                            <div>
                                <div class="qt-topic">${q.topic} — ${q.thaiTopic}</div>
                                <div class="qt-question">${q.question}</div>
                            </div>
                        </div>
                        <div class="qt-options">
                            ${q.options.map((opt, oi) => {
                                const eff = opt.effect;
                                const effectParts = [];
                                if (eff.popularity) effectParts.push(`Pop ${eff.popularity > 0 ? '+' : ''}${eff.popularity}`);
                                if (eff.coalitionTrust) effectParts.push(`Trust ${eff.coalitionTrust > 0 ? '+' : ''}${eff.coalitionTrust}`);
                                if (eff.capital) effectParts.push(`Cap ${eff.capital > 0 ? '+' : ''}${eff.capital}`);
                                if (eff.scandal) effectParts.push(`Scandal ${eff.scandal > 0 ? '+' : ''}${eff.scandal}`);
                                return `<button class="qt-option-btn" data-qi="${qi}" data-oi="${oi}">
                                    <span class="qt-option-label">${opt.label}</span>
                                    <span class="qt-option-effect">${effectParts.join(' · ')}</span>
                                </button>`;
                            }).join('')}
                        </div>
                    </div>
                `).join('');

                qtArea.querySelectorAll('.qt-option-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const qi = parseInt(btn.dataset.qi);
                        const oi = parseInt(btn.dataset.oi);
                        const question = gameState.pendingInterpellations[qi];
                        if (!question) return;
                        const result = window.Game.Engine.Parliament.resolveInterpellation(gameState, question, oi);
                        if (result) {
                            const parts = [];
                            if (result.effects.popularity) parts.push(`Popularity ${result.effects.popularity > 0 ? '+' : ''}${result.effects.popularity}`);
                            if (result.effects.coalitionTrust) parts.push(`Coalition Trust ${result.effects.coalitionTrust > 0 ? '+' : ''}${result.effects.coalitionTrust}`);
                            if (result.effects.capital) parts.push(`Capital ${result.effects.capital > 0 ? '+' : ''}${result.effects.capital}`);
                            this.showNotification(`${question.topic}: ${parts.join(', ')}`, result.effects.popularity >= 0 ? 'success' : 'info');
                        }
                        // Remove answered question
                        gameState.pendingInterpellations.splice(qi, 1);
                        if (gameState.pendingInterpellations.length === 0) {
                            // Auto-advance to legislative when all questions answered
                            window.Game.App.advanceSessionPhase();
                        } else {
                            this.renderParliament(gameState);
                        }
                    });
                });
            }
            const btnEndQT = document.getElementById('btn-end-question-time');
            if (btnEndQT) {
                btnEndQT.addEventListener('click', () => {
                    gameState.pendingInterpellations = [];
                    window.Game.App.advanceSessionPhase();
                });
            }
        }

        // Adjournment Phase
        if (!isOpposition && phaseInfo.phase === 'adjournment') {
            const btnAdvance = document.getElementById('btn-advance-from-adjournment');
            if (btnAdvance) {
                btnAdvance.addEventListener('click', () => {
                    gameState._coalitionCollapseResult = null;
                    window.Game.App.advanceSessionPhase();
                });
            }
        }

        if (!isOpposition) {
            document.querySelectorAll('.btn-fulfill-demand').forEach(btn => {
                btn.addEventListener('click', () => {
                    const partyId = btn.dataset.partyId;
                    const demandId = btn.dataset.demandId;
                    const result = window.Game.Engine.Parliament.fulfillCoalitionDemand(gameState, partyId, demandId);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                });
            });

            document.querySelectorAll('.btn-demand-ministry').forEach(btn => {
                btn.addEventListener('click', () => {
                    const partyId = btn.dataset.partyId;
                    const demandId = btn.dataset.demandId;
                    const reshuffle = window.Game.Engine.Parliament.reshuffleCabinet(gameState, partyId, 1);
                    if (!reshuffle.success) {
                        this.showNotification(reshuffle.msg, 'error');
                        return;
                    }
                    const fulfill = window.Game.Engine.Parliament.fulfillCoalitionDemand(gameState, partyId, demandId);
                    this.showNotification(
                        fulfill.success
                            ? `${reshuffle.msg} ${fulfill.msg}`
                            : `${reshuffle.msg} ${fulfill.msg}`,
                        fulfill.success ? 'success' : 'info'
                    );
                    this.renderParliament(gameState);
                });
            });

            document.querySelectorAll('.btn-reshuffle-up').forEach(btn => {
                btn.addEventListener('click', () => {
                    const result = window.Game.Engine.Parliament.reshuffleCabinet(gameState, btn.dataset.partyId, 1);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                });
            });

            document.querySelectorAll('.btn-reshuffle-down').forEach(btn => {
                btn.addEventListener('click', () => {
                    const result = window.Game.Engine.Parliament.reshuffleCabinet(gameState, btn.dataset.partyId, -1);
                    this.showNotification(result.msg, result.success ? 'success' : 'error');
                    this.renderParliament(gameState);
                });
            });
        }

        // Legislative Phase — proceed to adjournment
        const btnProceedAdj = document.getElementById('btn-proceed-adjournment');
        if (btnProceedAdj) {
            btnProceedAdj.addEventListener('click', () => {
                window.Game.App.advanceSessionPhase();
            });
        }

        // Coalition events popup (during legislative phase)
        if (!isOpposition && phaseInfo.phase === 'legislative' && (gameState.pendingCoalitionEvents || []).length > 0) {
            const evt = gameState.pendingCoalitionEvents[0];
            setTimeout(() => {
                this._showCoalitionEventModal(gameState, evt.partyId, evt.event);
            }, 400);
        }

        if (!isOpposition && phaseInfo.phase === 'legislative') {
            document.querySelectorAll('.btn-counter-tactic').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (btn.disabled) return;
                    const tacticId = btn.dataset.tacticId;
                    const maneuver = btn.dataset.maneuver;
                    const result = window.Game.Engine.Parliament.counterOppositionTactic(gameState, tacticId, maneuver);
                    this.showNotification(result.msg, result.success ? 'success' : 'info');
                    this.renderParliament(gameState);
                });
            });
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

        const btnSiphon = document.getElementById('btn-siphon');
        if (btnSiphon) btnSiphon.addEventListener('click', () => {
            if (!consumeOppositionAction(0, true)) return;
            const result = window.Game.Engine.Shadow.siphonFunds(gameState, 50);
            if (result.success) consumeOppositionAction(0);
            const sr = document.getElementById('shadow-result');
            if (sr) sr.innerHTML = `<p class="${result.success ? 'success-text' : 'error-text'}">${result.msg}</p>`;
            this.renderParliament(gameState);
        });

        const btnIO = document.getElementById('btn-io-deploy');
        if (btnIO) btnIO.addEventListener('click', () => {
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

        const btnBanana = document.getElementById('btn-banana');
        if (btnBanana) btnBanana.addEventListener('click', () => {
            if (!consumeOppositionAction(0, true)) return;
            this._showMPPicker(gameState, (mpId) => {
                const result = window.Game.Engine.Shadow.distributeBanana(gameState, mpId);
                if (result.success) consumeOppositionAction(0);
                this.showNotification(result.msg, result.success ? 'success' : 'error');
                this.renderParliament(gameState);
            });
        });

        const btnNC = document.getElementById('btn-no-confidence');
        if (btnNC) btnNC.addEventListener('click', () => {
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
            document.querySelectorAll('.btn-gov-vote').forEach(btn => {
                btn.addEventListener('click', () => {
                    const billId = btn.dataset.billId;
                    const stance = btn.dataset.stance;

                    const realtimeMultiplayerVote = !!(
                        app
                        && app.isMultiplayerParliamentRealtimeVotingEnabled
                        && app.isMultiplayerParliamentRealtimeVotingEnabled()
                    );

                    let result = null;
                    if (realtimeMultiplayerVote) {
                        const sync = app.submitMultiplayerGovernmentBillVote(billId, stance);
                        if (!sync.success) {
                            this.showNotification(sync.msg || 'Unable to resolve this vote.', 'error');
                            return;
                        }
                        result = sync.result;
                    } else {
                        result = window.Game.Engine.Parliament.resolveGovernmentBillVote(gameState, billId, stance);
                        if (result && result.error) {
                            this.showNotification(result.error, 'error');
                            return;
                        }
                        if (!result) {
                            this.showNotification('Unable to resolve this vote.', 'error');
                            return;
                        }
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

            const updateOppPop = (actionId, rawGain, label) => {
                const outcome = window.Game.App.resolveOppositionPublicAction(actionId, rawGain);
                if (!outcome || !outcome.success) {
                    this.showNotification(outcome?.msg || 'Could not apply opposition popularity change.', 'error');
                    return;
                }
                const gain = Number.isFinite(outcome.gain) ? outcome.gain : 0;
                this.showNotification(`${label}: ${gain > 0 ? '+' : ''}${gain} popularity`, gain > 0 ? 'success' : 'info');
                this.renderParliament(gameState);
            };

            const scrutinyBtn = document.getElementById('btn-opp-scrutiny');
            if (scrutinyBtn) scrutinyBtn.addEventListener('click', () => {
                if (!consumeOppositionAction(30)) return;
                updateOppPop('scrutiny', 1, 'Scrutiny campaign');
            });

            const townhallBtn = document.getElementById('btn-opp-townhall');
            if (townhallBtn) townhallBtn.addEventListener('click', () => {
                if (!consumeOppositionAction(20)) return;
                updateOppPop('townhall', 1, 'Public townhall');
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
                if (playerParty.greyMoney < splitGreyCost) {
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
                    playerParty.greyMoney -= splitGreyCost;
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

        const btnNextYear = document.getElementById('btn-next-year');
        if (btnNextYear) btnNextYear.addEventListener('click', () => {
            window.Game.App.advanceYear();
        });
        const btnNextHalf = document.getElementById('btn-next-half-year');
        if (btnNextHalf) btnNextHalf.addEventListener('click', () => {
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

        this._bindParliamentKeyboardShortcuts(gameState);
        } catch (err) {
            console.error('renderParliament failed:', err);
            this._clearParliamentKeyboardShortcuts();
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

    _showCoalitionEventModal(gameState, partyId, event) {
        const modal = document.getElementById('modal');
        const party = (gameState.parties || []).find(p => p.id === partyId);
        const partyName = party ? party.thaiName : partyId;
        const partyColor = party ? party.hexColor : '#666';
        modal.innerHTML = `
            <div class="modal-content coalition-event-modal">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border-subtle);">
                    <span style="font-size:2.2rem;">${event.icon}</span>
                    <div>
                        <div style="font-size:0.75rem;color:${partyColor};font-weight:600;letter-spacing:1px;text-transform:uppercase;">COALITION EVENT • ${partyName}</div>
                        <h2 style="margin:2px 0;font-size:1.3rem;color:var(--text-primary);">${event.label}</h2>
                        <div style="font-size:0.85rem;color:var(--gold);">${event.thaiLabel}</div>
                    </div>
                </div>
                <p style="font-size:0.9rem;color:var(--text-secondary);line-height:1.5;margin-bottom:16px;">${event.description}</p>
                <div class="coalition-event-options">
                    ${event.options.map((opt, idx) => {
                        const eff = opt.effect;
                        const parts = [];
                        if (eff.partnerSatisfaction) parts.push(`Partner ${eff.partnerSatisfaction > 0 ? '+' : ''}${eff.partnerSatisfaction}`);
                        if (eff.capital) parts.push(`Capital ${eff.capital > 0 ? '+' : ''}${eff.capital}`);
                        if (eff.scandal) parts.push(`Scandal ${eff.scandal > 0 ? '+' : ''}${eff.scandal}`);
                        if (eff.popularity) parts.push(`Pop ${eff.popularity > 0 ? '+' : ''}${eff.popularity}`);
                        if (eff.riskWalkout) parts.push('⚠️ Risk walkout');
                        return `
                        <div class="crisis-option-card coalition-evt-option" data-idx="${idx}">
                            <div style="font-size:1rem;font-weight:600;color:var(--text-primary);">${opt.label}</div>
                            <div style="font-size:0.75rem;color:var(--text-dim);margin-top:4px;">${parts.join(' · ')}</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>
        `;
        modal.classList.remove('hidden');

        let selected = false;
        modal.querySelectorAll('.coalition-evt-option').forEach(card => {
            const applyActive = () => {
                card.style.borderColor = partyColor;
                card.style.boxShadow = `0 0 15px ${partyColor}33`;
                card.style.transform = 'translateY(-2px)';
            };

            const clearActive = () => {
                card.style.borderColor = 'var(--border-subtle)';
                card.style.boxShadow = 'none';
                card.style.transform = 'none';
            };

            card.addEventListener('pointerenter', applyActive);
            card.addEventListener('pointerleave', clearActive);
            card.addEventListener('touchstart', applyActive, { passive: true });
            card.addEventListener('focus', applyActive);
            card.addEventListener('blur', clearActive);

            card.addEventListener('click', () => {
                if (selected) return;
                selected = true;
                modal.classList.add('hidden');
                window.Game.App.resolveCoalitionEventChoice(partyId, event, parseInt(card.dataset.idx));
            });
        });
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
            const playerIdeology = Number.isFinite(playerParty.ideology) ? playerParty.ideology : 50;
            const billIdeology = Number.isFinite(tmpl.ideologicalPosition) ? tmpl.ideologicalPosition : 50;
            const ideologyDistance = Math.abs(playerIdeology - billIdeology);
            const ideologyFit = ideologyDistance <= 18
                ? 'match'
                : ideologyDistance <= 32
                ? 'lean'
                : 'off';

            card.className = `bill-card ${canAfford ? '' : 'disabled'} ${isPromised ? 'bill-promised' : ''} ${ideologyFit === 'match' ? 'bill-ideology-match' : ''} ${ideologyFit === 'lean' ? 'bill-ideology-lean' : ''}`;

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
                <div class="bill-name">${tmpl.name}
                    ${isPromised ? '<span class="promise-badge">📜 PROMISED</span>' : ''}
                    ${ideologyFit === 'match' ? '<span class="promise-badge ideology-badge ideology-match">🧭 IDEOLOGY MATCH</span>' : ''}
                    ${ideologyFit === 'lean' ? '<span class="promise-badge ideology-badge ideology-lean">🧭 IDEOLOGY LEAN</span>' : ''}
                </div>
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
        const pressureSummary = (projection.oppositionPressure && Array.isArray(projection.oppositionPressure.summary))
            ? projection.oppositionPressure.summary
            : [];

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
                ${pressureSummary.length > 0 ? `<div class="vote-pressure-warning">⚠️ Opposition pressure: ${pressureSummary.join(' | ')}</div>` : ''}
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

            const app = window.Game.App;
            const realtimeMultiplayerVote = !!(
                app
                && app.isMultiplayerParliamentRealtimeVotingEnabled
                && app.isMultiplayerParliamentRealtimeVotingEnabled()
            );

            if (realtimeMultiplayerVote) {
                const submit = app.submitMultiplayerGovernmentBillProposal(bill);
                this.showNotification(submit.msg, submit.success ? 'success' : 'error');
                this._updateParliamentStats(gameState);
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
        if (result.passed && window.Game.App && typeof window.Game.App.reportMultiplayerGovernmentBillPassed === 'function') {
            window.Game.App.reportMultiplayerGovernmentBillPassed(bill.name);
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
        const pressureApplied = (result.oppositionPressureApplied && Array.isArray(result.oppositionPressureApplied.summary))
            ? result.oppositionPressureApplied.summary
            : [];

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
                ${pressureApplied.length > 0 ? `<div class="vote-pressure-warning">⚠️ Opposition tactic triggered: ${pressureApplied.join(' | ')}</div>` : ''}
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
        const pressureApplied = (result.oppositionPressureApplied && Array.isArray(result.oppositionPressureApplied.summary))
            ? result.oppositionPressureApplied.summary
            : [];

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
                ${pressureApplied.length > 0 ? `<p class="vote-pressure-warning" style="margin-top:8px;">Opposition pressure used: ${pressureApplied.join(' | ')}</p>` : ''}
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
        const coalitionIds = new Set(gameState.coalitionPartyIds || []);
        const targetGovernmentSide = gameState.playerRole === 'opposition';
        const targetMPs = (gameState.seatedMPs || [])
            .filter(mp => {
                if (!mp) return false;
                const isCoalitionMP = coalitionIds.has(mp.partyId);
                return targetGovernmentSide ? isCoalitionMP : !isCoalitionMP;
            })
            .sort((a, b) => b.corruptionLevel - a.corruptionLevel)
            .slice(0, 20);
        const targetLabel = targetGovernmentSide ? 'Government MP' : 'Opposition MP';
        const emptyHint = targetGovernmentSide
            ? 'No government MPs are available to target right now.'
            : 'No opposition MPs are available to target right now.';

        modal.innerHTML = `
            <div class="modal-content mp-picker-modal">
                <div class="modal-header">
                    <h3>Select a ${targetLabel}</h3>
                    <button class="modal-close" id="modal-close">✕</button>
                </div>
                <div class="mp-list">
                    ${targetMPs.length === 0 ? `<div class="placeholder-text">${emptyHint}</div>` : targetMPs.map(mp => {
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
                <div class="crisis-options">
                    ${crisis.options.map((opt, idx) => `
                        <div class="crisis-option-card" data-idx="${idx}">
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
        let selected = false;
        modal.querySelectorAll('.crisis-option-card').forEach(card => {
            const applyActive = () => {
                card.style.borderColor = severityColor;
                card.style.boxShadow = `0 0 20px ${severityColor}33`;
                card.style.transform = 'translateY(-2px)';
            };

            const clearActive = () => {
                card.style.borderColor = 'var(--border-subtle)';
                card.style.boxShadow = 'none';
                card.style.transform = 'none';
            };

            card.addEventListener('pointerenter', applyActive);
            card.addEventListener('pointerleave', clearActive);
            card.addEventListener('touchstart', applyActive, { passive: true });
            card.addEventListener('focus', applyActive);
            card.addEventListener('blur', clearActive);

            card.addEventListener('click', () => {
                if (selected) return;
                selected = true;
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
        const isCampaignScreen = this.currentScreen === 'screen-campaign';
        const duration = this._getNotificationDuration(message, isCampaignScreen);
        if (isCampaignScreen) {
            this._campaignNotificationState = {
                message,
                type,
                expiresAt: Date.now() + duration
            };
            this._syncCampaignNotificationBar();

            if (this._campaignNotificationTimer) {
                clearTimeout(this._campaignNotificationTimer);
                this._campaignNotificationTimer = 0;
            }
            this._campaignNotificationTimer = setTimeout(() => {
                this._campaignNotificationState = null;
                this._syncCampaignNotificationBar();
            }, duration);
            return;
        }

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
        }, duration);
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
