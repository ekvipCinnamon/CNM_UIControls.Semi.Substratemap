// ============================================================================
//  WaferMap - TwinCAT HMI framework control
//  Renders a SEMI-standard wafer (primary/secondary flats or notch). The wafer
//  identity (type, size, ...) is exposed as bindable attributes so it can be
//  driven from MES / a recipe database via server-symbol bindings.
// ============================================================================
// ---------------------------------------------------------------------------
//  SEMI standard specifications
//  primary/secondary: flat length in mm; secAngle: angle secondary->primary (deg)
//  notchDepth: midpoint of 1.00-1.25 mm
// ---------------------------------------------------------------------------
export const WAFER_SPECS = [
    { type: 'P-111', inch: 2, dia: 50.8, shape: '1flat', secAngle: null, primary: 15.88, secondary: null },
    { type: 'N-111', inch: 2, dia: 50.8, shape: '2flats', secAngle: 45, primary: 15.88, secondary: 8.00 },
    { type: 'P-100', inch: 2, dia: 50.8, shape: '2flats', secAngle: 90, primary: 15.88, secondary: 8.00 },
    { type: 'N-100', inch: 2, dia: 50.8, shape: '2flats', secAngle: 180, primary: 15.88, secondary: 8.00 },
    { type: 'P-111', inch: 3, dia: 76.2, shape: '1flat', secAngle: null, primary: 22.22, secondary: null },
    { type: 'N-111', inch: 3, dia: 76.2, shape: '2flats', secAngle: 45, primary: 22.22, secondary: 11.18 },
    { type: 'P-100', inch: 3, dia: 76.2, shape: '2flats', secAngle: 90, primary: 22.22, secondary: 11.18 },
    { type: 'N-100', inch: 3, dia: 76.2, shape: '2flats', secAngle: 180, primary: 22.22, secondary: 11.18 },
    { type: 'P-111', inch: 4, dia: 100.0, shape: '1flat', secAngle: null, primary: 32.50, secondary: null },
    { type: 'N-111', inch: 4, dia: 100.0, shape: '2flats', secAngle: 45, primary: 32.50, secondary: 18.00 },
    { type: 'P-100', inch: 4, dia: 100.0, shape: '2flats', secAngle: 90, primary: 32.50, secondary: 18.00 },
    { type: 'N-100', inch: 4, dia: 100.0, shape: '2flats', secAngle: 180, primary: 32.50, secondary: 18.00 },
    { type: 'P-111', inch: 5, dia: 125.0, shape: '1flat', secAngle: null, primary: 42.50, secondary: null },
    { type: 'N-111', inch: 5, dia: 125.0, shape: '2flats', secAngle: 45, primary: 42.50, secondary: 27.50 },
    { type: 'P-100', inch: 5, dia: 125.0, shape: '2flats', secAngle: 90, primary: 42.50, secondary: 27.50 },
    { type: 'N-100', inch: 5, dia: 125.0, shape: '2flats', secAngle: 180, primary: 42.50, secondary: 27.50 },
    { type: 'P-111', inch: 6, dia: 150.0, shape: '1flat', secAngle: null, primary: 57.50, secondary: null },
    { type: 'N-111', inch: 6, dia: 150.0, shape: '2flats', secAngle: 45, primary: 57.50, secondary: 37.50 },
    { type: 'P-100', inch: 6, dia: 150.0, shape: '2flats', secAngle: 90, primary: 57.50, secondary: 37.50 },
    { type: 'N-100', inch: 6, dia: 150.0, shape: '2flats', secAngle: 180, primary: 57.50, secondary: 37.50 },
    { type: 'All types', inch: 8, dia: 200.0, shape: 'notch', notchDepth: 1.125 },
    { type: 'All types', inch: 12, dia: 300.0, shape: 'notch', notchDepth: 1.125 },
    { type: 'All types', inch: 18, dia: 450.0, shape: 'notch', notchDepth: 1.125 },
];
export const FLAT_TYPES = ['P-111', 'N-111', 'P-100', 'N-100'];
export const SIZES = [...new Set(WAFER_SPECS.map(s => s.inch))];
const DEFAULTS = {
    waferType: 'N-100',
    sizeInch: 4,
    secDir: 'cw',
    notchScale: 12,
    showDemoChips: true,
};
// ---------------------------------------------------------------------------
//  Geometry (pure functions)
// ---------------------------------------------------------------------------
function waferMapRadius(cfg) {
    return Math.min(cfg.width, cfg.height) / 2 - cfg.margin;
}
function norm(a) { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; }
function getSpec(inch, type) {
    // For notch sizes (>=8") the type is irrelevant to the geometry.
    const spec = WAFER_SPECS.find(s => s.inch === inch && s.type === type)
        ?? WAFER_SPECS.find(s => s.inch === inch);
    if (!spec) {
        throw new Error('No wafer spec for ' + inch + '" ' + type);
    }
    return spec;
}
function nearestSize(inch) {
    let best = SIZES[0];
    let bestDelta = Math.abs(inch - best);
    for (const s of SIZES) {
        const d = Math.abs(inch - s);
        if (d < bestDelta) {
            best = s;
            bestDelta = d;
        }
    }
    return best;
}
// Flats as {center, half} in canvas radians (y points down => CW positive).
// Primary flat points down (center = PI/2). Secondary offset by secAngle.
function computeFlats(spec, secDir) {
    if (spec.shape === 'notch') {
        return [];
    }
    const aP = Math.asin(Math.min(1, spec.primary / spec.dia)); // half-angle of the chord
    const flats = [{ center: Math.PI / 2, half: aP }];
    if (spec.shape === '2flats' && spec.secondary != null && spec.secAngle != null) {
        const aS = Math.asin(Math.min(1, spec.secondary / spec.dia));
        const theta = spec.secAngle * Math.PI / 180;
        const center = secDir === 'cw' ? (Math.PI / 2 + theta) : (Math.PI / 2 - theta);
        flats.push({ center, half: aS });
    }
    return flats;
}
// Path: disc with 0..n flats (chords).
function pathDiscWithFlats(c, cx, cy, R, flats) {
    c.beginPath();
    if (flats.length === 0) {
        c.arc(cx, cy, R, 0, 2 * Math.PI);
        c.closePath();
        return;
    }
    const sorted = flats.map(f => ({ center: norm(f.center), half: f.half }))
        .sort((a, b) => a.center - b.center);
    const pt = (a) => ({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    const p0 = pt(sorted[0].center + sorted[0].half);
    c.moveTo(p0.x, p0.y);
    for (let k = 1; k <= sorted.length; k++) {
        const prev = sorted[k - 1];
        const cur = sorted[k % sorted.length];
        const arcStart = prev.center + prev.half;
        let arcEnd = cur.center - cur.half;
        while (arcEnd < arcStart) {
            arcEnd += 2 * Math.PI;
        }
        c.arc(cx, cy, R, arcStart, arcEnd, false); // arc between flats
        const trailing = pt(cur.center + cur.half);
        c.lineTo(trailing.x, trailing.y); // chord (flat)
    }
    c.closePath();
}
// Path: disc with a V-notch at the bottom.
function pathDiscWithNotch(c, cx, cy, R, depth, halfWidth) {
    const a0 = Math.PI / 2 - halfWidth;
    const a1 = Math.PI / 2 + halfWidth;
    c.beginPath();
    c.arc(cx, cy, R, a1, a0 + 2 * Math.PI, false);
    c.lineTo(cx, cy + (R - depth)); // notch tip (radially inward)
    c.lineTo(cx + R * Math.cos(a1), cy + R * Math.sin(a1));
    c.closePath();
}
function buildWaferPath(c, cx, cy, R, spec, secDir, notchScale) {
    if (spec.shape === 'notch') {
        const trueDepth = (spec.notchDepth / (spec.dia / 2)) * R; // true depth in display units
        const depth = trueDepth * notchScale;
        pathDiscWithNotch(c, cx, cy, R, depth, depth / R); // keep a ~90deg V
    }
    else {
        pathDiscWithFlats(c, cx, cy, R, computeFlats(spec, secDir));
    }
}
function waferCoordToMapCoord(pos, wafer, cfg) {
    const s = waferMapRadius(cfg) / wafer.settings.radius;
    return { x: cfg.center.x + pos.x * s, y: cfg.center.y - pos.y * s }; // canvas y down, wafer y up
}
function mapCoordToWaferCoord(pos, wafer, cfg) {
    const s = wafer.settings.radius / waferMapRadius(cfg);
    return { x: (pos.x - cfg.center.x) * s, y: (cfg.center.y - pos.y) * s };
}
function drawWaferMap(c, cfg, wafer, spec, secDir, notchScale, colors) {
    const R = waferMapRadius(cfg);
    const cx = cfg.center.x;
    const cy = cfg.center.y;
    c.clearRect(0, 0, cfg.width, cfg.height);
    if (colors.bg !== '') {
        c.fillStyle = colors.bg;
        c.fillRect(0, 0, cfg.width, cfg.height);
    }
    if (R <= 0) {
        return;
    }
    // wafer disc (shape depends on type) - always drawn to full radius (= 100%)
    buildWaferPath(c, cx, cy, R, spec, secDir, notchScale);
    c.fillStyle = colors.wafer;
    c.fill();
    // clip optional demo chips to the wafer shape so flats/notch cut the grid
    if (wafer) {
        const scale = R / wafer.settings.radius;
        c.save();
        buildWaferPath(c, cx, cy, R, spec, secDir, notchScale);
        c.clip();
        for (const chip of wafer.chips) {
            c.fillStyle = chip === wafer.inFov ? colors.chipFov : colors.chip;
            const tl = waferCoordToMapCoord({ x: chip.x - wafer.settings.chipWidth / 2, y: chip.y + wafer.settings.chipHeight / 2 }, wafer, cfg);
            c.fillRect(tl.x, tl.y, wafer.settings.chipWidth * scale, wafer.settings.chipHeight * scale);
        }
        if (wafer.selected) {
            c.strokeStyle = colors.outline;
            c.lineWidth = 2;
            const tl = waferCoordToMapCoord({ x: wafer.selected.x - wafer.settings.chipWidth / 2, y: wafer.selected.y + wafer.settings.chipHeight / 2 }, wafer, cfg);
            c.strokeRect(tl.x - 2, tl.y - 2, wafer.settings.chipWidth * scale + 4, wafer.settings.chipHeight * scale + 4);
        }
        c.restore();
    }
    // wafer edge
    buildWaferPath(c, cx, cy, R, spec, secDir, notchScale);
    c.strokeStyle = colors.edge;
    c.lineWidth = 2;
    c.stroke();
}
// ---------------------------------------------------------------------------
//  Demo chips (random grid placeholder; real die data would be its own attribute)
// ---------------------------------------------------------------------------
function getTestChips(radius, numRows) {
    const step = (radius * 2) / numRows;
    const inR = (p) => (p.x * p.x + p.y * p.y) <= radius * radius;
    const chips = [];
    for (let i = 0; i < numRows; i++) {
        for (let j = 0; j < numRows; j++) {
            if (Math.random() < 0.4) {
                continue;
            }
            const corners = [
                { x: -radius + i * step, y: -radius + j * step },
                { x: -radius + i * step, y: -radius + (j + 1) * step },
                { x: -radius + (i + 1) * step, y: -radius + j * step },
                { x: -radius + (i + 1) * step, y: -radius + (j + 1) * step },
            ];
            if (corners.every(inR)) {
                chips.push({ x: -radius + (i + 0.5) * step, y: -radius + (j + 0.5) * step });
            }
        }
    }
    return chips;
}
function buildChips() {
    const cell = 30 + 10 * Math.floor(Math.random() * 7);
    const chipSize = cell * 0.9;
    const radius = cell * (3 + Math.floor(Math.random() * 4));
    const numRows = (radius * 2) / cell;
    const chips = getTestChips(radius, numRows);
    return {
        settings: { chipWidth: chipSize, chipHeight: chipSize, radius },
        chips,
        inFov: chips[Math.floor(chips.length * Math.random())] ?? null,
        selected: chips[Math.floor(chips.length * Math.random())] ?? null,
    };
}
function getChipAtPos(mapPos, wafer, cfg) {
    const w = mapCoordToWaferCoord(mapPos, wafer, cfg);
    for (const chip of wafer.chips) {
        const left = chip.x - wafer.settings.chipWidth / 2;
        const right = chip.x + wafer.settings.chipWidth / 2;
        const top = chip.y + wafer.settings.chipHeight / 2; // wafer y up
        const bottom = chip.y - wafer.settings.chipHeight / 2;
        if (w.x >= left && w.x <= right && w.y <= top && w.y >= bottom) {
            return chip;
        }
    }
    return null;
}
// ===========================================================================
//  The framework control
// ===========================================================================
export class WaferMap extends TcHmi.Controls.System.TcHmiControl {
    __elementTemplateRoot;
    // ---- runtime state (per instance; never module-global) ----
    __canvas = null;
    __ctx = null;
    __resizeObserver = null;
    __wafer = null;
    __onPointerUp = null;
    // ---- attribute backing fields (defaults mirror Description.json) ----
    __waferType = DEFAULTS.waferType;
    __sizeInch = DEFAULTS.sizeInch;
    __secDir = DEFAULTS.secDir;
    __notchScale = DEFAULTS.notchScale;
    __showDemoChips = DEFAULTS.showDemoChips;
    constructor(element, pcElement, attrs) {
        super(element, pcElement, attrs);
    }
    __previnit() {
        this.__elementTemplateRoot = this.__element.find('.TcHmi_Controls_WaferMap_WaferMap-Template');
        if (this.__elementTemplateRoot.length === 0) {
            throw new Error('Invalid Template.html');
        }
        super.__previnit();
    }
    __init() {
        super.__init();
    }
    __attach() {
        super.__attach();
        const root = this.__elementTemplateRoot[0];
        const canvas = document.createElement('canvas');
        canvas.className = 'TcHmi_Controls_WaferMap_WaferMap-Canvas';
        canvas.style.display = 'block';
        root.appendChild(canvas);
        this.__canvas = canvas;
        this.__ctx = canvas.getContext('2d');
        this.__rebuildChips();
        // Re-render on size changes of the control.
        this.__resizeObserver = new ResizeObserver(() => this.__render());
        this.__resizeObserver.observe(root);
        // Demo interaction: click selects a die. Remove if not needed.
        this.__onPointerUp = (ev) => this.__handlePointerUp(ev);
        canvas.addEventListener('pointerup', this.__onPointerUp);
        this.__render();
    }
    __detach() {
        if (this.__resizeObserver) {
            this.__resizeObserver.disconnect();
            this.__resizeObserver = null;
        }
        if (this.__canvas && this.__onPointerUp) {
            this.__canvas.removeEventListener('pointerup', this.__onPointerUp);
        }
        if (this.__canvas && this.__canvas.parentNode) {
            this.__canvas.parentNode.removeChild(this.__canvas);
        }
        this.__canvas = null;
        this.__ctx = null;
        this.__onPointerUp = null;
        super.__detach();
    }
    destroy() {
        if (this.__keepAlive) {
            return;
        }
        super.destroy();
    }
    // -----------------------------------------------------------------------
    //  Attributes  (each: convert -> default fallback -> change-detect ->
    //               notify -> process). Setters are safe before __attach;
    //               __render() simply no-ops until the canvas exists.
    // -----------------------------------------------------------------------
    setWaferType(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || FLAT_TYPES.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('WaferType');
        }
        if (tchmi_equal(v, this.__waferType)) {
            return;
        }
        this.__waferType = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'WaferType' });
        this.__render();
    }
    getWaferType() {
        return this.__waferType;
    }
    setWaferSizeInch(valueNew) {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('WaferSizeInch');
        }
        n = nearestSize(n);
        if (tchmi_equal(n, this.__sizeInch)) {
            return;
        }
        this.__sizeInch = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'WaferSizeInch' });
        this.__render();
    }
    getWaferSizeInch() {
        return this.__sizeInch;
    }
    setSecondaryFlatDirection(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v !== 'cw' && v !== 'ccw') {
            v = this.getAttributeDefaultValueInternal('SecondaryFlatDirection');
        }
        if (tchmi_equal(v, this.__secDir)) {
            return;
        }
        this.__secDir = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SecondaryFlatDirection' });
        this.__render();
    }
    getSecondaryFlatDirection() {
        return this.__secDir;
    }
    setNotchExaggeration(valueNew) {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('NotchExaggeration');
        }
        if (n < 1) {
            n = 1;
        }
        if (tchmi_equal(n, this.__notchScale)) {
            return;
        }
        this.__notchScale = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NotchExaggeration' });
        this.__render();
    }
    getNotchExaggeration() {
        return this.__notchScale;
    }
    setShowDemoChips(valueNew) {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowDemoChips');
        }
        if (tchmi_equal(b, this.__showDemoChips)) {
            return;
        }
        this.__showDemoChips = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowDemoChips' });
        this.__rebuildChips();
        this.__render();
    }
    getShowDemoChips() {
        return this.__showDemoChips;
    }
    // -----------------------------------------------------------------------
    //  Rendering
    // -----------------------------------------------------------------------
    __rebuildChips() {
        this.__wafer = this.__showDemoChips ? buildChips() : null;
    }
    __readColors() {
        const cs = window.getComputedStyle(this.__element[0]);
        const read = (name, fallback) => {
            const value = cs.getPropertyValue(name).trim();
            return value !== '' ? value : fallback;
        };
        return {
            bg: read('--wafermap-background', ''),
            wafer: read('--wafermap-wafer-color', 'rgb(220, 220, 220)'),
            chip: read('--wafermap-chip-color', 'rgb(150, 150, 150)'),
            chipFov: read('--wafermap-chip-fov-color', 'rgb(0, 170, 0)'),
            outline: read('--wafermap-selection-color', 'rgb(210, 0, 0)'),
            edge: read('--wafermap-edge-color', 'rgb(110, 110, 110)'),
        };
    }
    __makeConfig() {
        const root = this.__elementTemplateRoot[0];
        const w = root.clientWidth;
        const h = root.clientHeight;
        if (w <= 0 || h <= 0) {
            return null;
        }
        return { center: { x: w / 2, y: h / 2 }, width: w, height: h, margin: 8 };
    }
    __render() {
        if (!this.__canvas || !this.__ctx) {
            return;
        }
        const cfg = this.__makeConfig();
        if (!cfg) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const pxW = Math.round(cfg.width * dpr);
        const pxH = Math.round(cfg.height * dpr);
        if (this.__canvas.width !== pxW || this.__canvas.height !== pxH) {
            this.__canvas.width = pxW;
            this.__canvas.height = pxH;
            this.__canvas.style.width = cfg.width + 'px';
            this.__canvas.style.height = cfg.height + 'px';
        }
        this.__ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const spec = getSpec(this.__sizeInch, this.__waferType);
        drawWaferMap(this.__ctx, cfg, this.__wafer, spec, this.__secDir, this.__notchScale, this.__readColors());
    }
    __handlePointerUp(ev) {
        if (!this.__canvas || !this.__wafer) {
            return;
        }
        const cfg = this.__makeConfig();
        if (!cfg) {
            return;
        }
        const rect = this.__canvas.getBoundingClientRect();
        const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const chip = getChipAtPos(p, this.__wafer, cfg);
        if (chip) {
            this.__wafer.selected = chip;
            this.__render();
        }
    }
}
/*
 * Register Control class object for control
 */
TcHmi.Controls.registerEx('WaferMap', 'TcHmi.Controls.WaferMap', WaferMap);
//# sourceMappingURL=WaferMap.js.map