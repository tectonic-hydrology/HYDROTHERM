// --- GLOBALS ---
let fileText = null;          // kept for "is a file loaded?" checks; cleared after parse
let timeIndex = {};           // legacy (retained for compatibility); unused after parse
let timePoints = [];
let currentTimeIndex = 0;
let currentDataRange = { min: 0, max: 100 };
let customColorbarRange = null;
let currentXRange = { min: 0, max: 100 };
let currentZRange = { min: 0, max: 100 };
let customXRange = null;
let customZRange = null;
let plottedPoints = []; // [{id, x, z, color}]
let vectorData = null; // current timestep vector data
let vectorFileText = null;
let vectorTimeIndex = {};
let vectorTimePoints = [];
let vectorType = 'water';
let arrowScale = -2.0; // log10 scale
let currentTheme = 'dark';
let arrowColor = '#ffffff';
let nextPointSlot = 1; // for click-to-select

// Structured (typed-array) representations of the loaded files.
// Built once at upload time; every render path reads from these instead of
// re-splitting the original text. This is what makes Plot_*.convectMars-sized
// files responsive in the browser.
let parsedScalar = null;      // { timePoints, xCoords, zCoords, xIndex, zIndex,
                              //   nx, nz, cellsPerStep, gridded:{var->Float32Array(nt*nz*nx)} }
let parsedVector = null;      // similar shape with xw,yw,zw,xs,ys,zs gridded fields

const DERIVED_VECTOR_FIELDS = [
    'water_flux_mag',
    'steam_flux_mag',
    'total_flux_mag',
    'heat_flux_density',
    'heat_per_cell'
];

const POINT_COLORS = ['#20bf6b', '#0fb9b1', '#26de81', '#45aaf2'];

// ============================================================
// Thermodynamic lookup tables for pure water / steam
// Specific enthalpy h(T) along the saturation curve, in kJ/kg.
// Source: IAPWS-IF97 saturation values, rounded.
//
// We use saturation enthalpies because HYDROTHERM is solving two-phase
// H₂O hydrothermal flow, and along the saturation curve the enthalpy
// jump between liquid and vapor is exactly the latent heat — which is
// the dominant contribution to advective heat transport in geothermal
// systems. For supercritical conditions (T > ~374 °C) values plateau
// near the critical-point enthalpy, which is a reasonable approximation
// for teaching but not a substitute for full IAPWS-IF97 evaluation.
// ============================================================

const WATER_H_TABLE = [
    { T: 0,   h: 0     },
    { T: 25,  h: 105   },
    { T: 50,  h: 209   },
    { T: 75,  h: 314   },
    { T: 100, h: 419   },
    { T: 125, h: 525   },
    { T: 150, h: 632   },
    { T: 175, h: 741   },
    { T: 200, h: 853   },
    { T: 225, h: 967   },
    { T: 250, h: 1086  },
    { T: 275, h: 1210  },
    { T: 300, h: 1345  },
    { T: 325, h: 1494  },
    { T: 350, h: 1672  },
    { T: 374, h: 2086  }
];

const STEAM_H_TABLE = [
    { T: 0,   h: 2501  },
    { T: 25,  h: 2547  },
    { T: 50,  h: 2592  },
    { T: 75,  h: 2636  },
    { T: 100, h: 2675  },
    { T: 125, h: 2713  },
    { T: 150, h: 2746  },
    { T: 175, h: 2773  },
    { T: 200, h: 2792  },
    { T: 225, h: 2801  },
    { T: 250, h: 2802  },
    { T: 275, h: 2785  },
    { T: 300, h: 2749  },
    { T: 325, h: 2683  },
    { T: 350, h: 2570  },
    { T: 374, h: 2086  }
];

function interpolateTable(T, table, key) {
    if (T <= table[0].T) return table[0][key];
    if (T >= table[table.length - 1].T) return table[table.length - 1][key];
    for (let i = 0; i < table.length - 1; i++) {
        const a = table[i];
        const b = table[i + 1];
        if (T >= a.T && T <= b.T) {
            const f = (T - a.T) / (b.T - a.T);
            return a[key] + f * (b[key] - a[key]);
        }
    }
    return table[table.length - 1][key];
}

// Saturated liquid water enthalpy at temperature T (°C). Returns kJ/kg.
function getWaterEnthalpy(tempC) {
    return interpolateTable(tempC, WATER_H_TABLE, 'h');
}

// Saturated water vapor enthalpy at temperature T (°C). Returns kJ/kg.
function getSteamEnthalpy(tempC) {
    return interpolateTable(tempC, STEAM_H_TABLE, 'h');
}

// ============================================================
// Basic helpers
// ============================================================

function mag3(a, b, c) {
    return Math.sqrt(a * a + b * b + c * c);
}

function isDerivedVectorField(variable) {
    return DERIVED_VECTOR_FIELDS.includes(variable);
}

function getClosestTimeValue(targetTime, availableTimes) {
    if (!availableTimes || availableTimes.length === 0) return null;
    return availableTimes.reduce((prev, curr) =>
        Math.abs(curr - targetTime) < Math.abs(prev - targetTime) ? curr : prev
    );
}

// Min/max over a (possibly very large) typed array, without using
// `Math.min(...arr)` — that pattern crashes browsers past ~100k–1M args.
function arrayMinMaxFinite(arr) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
    }
    if (lo === Infinity) return { min: 0, max: 1 };
    return { min: lo, max: hi };
}

function buildTemperatureLookup(timeData) {
    const lookup = new Map();
    for (const row of timeData) {
        lookup.set(`${row.x}|${row.z}`, row.temperature);
    }
    return lookup;
}

function createMeshGridFromXYZ(rows) {
    const xVals = [...new Set(rows.map(d => d.x))].sort((a, b) => a - b);
    const yVals = [...new Set(rows.map(d => d.y))].sort((a, b) => a - b);

    const xIndex = new Map(xVals.map((v, i) => [v, i]));
    const yIndex = new Map(yVals.map((v, i) => [v, i]));

    const zGrid = Array.from({ length: yVals.length }, () => Array(xVals.length).fill(NaN));

    for (const row of rows) {
        const ix = xIndex.get(row.x);
        const iy = yIndex.get(row.y);
        if (ix !== undefined && iy !== undefined) {
            zGrid[iy][ix] = row.z;
        }
    }

    return { x: xVals, y: yVals, z: zGrid };
}

function getVectorComponentsForPlot(row, type) {
    if (type === 'steam') {
        return { u: row.xs, w: row.zs };
    } else if (type === 'total') {
        return { u: row.xw + row.xs, w: row.zw + row.zs };
    }
    return { u: row.xw, w: row.zw };
}

function computeTypicalCellAreaM2FromVectorRows(vectorRows) {
    if (!vectorRows || vectorRows.length === 0) return 1.0;

    const xVals = [...new Set(vectorRows.map(r => r.x))].sort((a, b) => a - b);
    const zVals = [...new Set(vectorRows.map(r => r.z))].sort((a, b) => a - b);

    let dxKm = null;
    let dzKm = null;

    for (let i = 1; i < xVals.length; i++) {
        const d = Math.abs(xVals[i] - xVals[i - 1]);
        if (d > 0) {
            dxKm = d;
            break;
        }
    }

    for (let i = 1; i < zVals.length; i++) {
        const d = Math.abs(zVals[i] - zVals[i - 1]);
        if (d > 0) {
            dzKm = d;
            break;
        }
    }

    if (dxKm === null || dzKm === null) return 1.0;

    const dxM = dxKm * 1000.0;
    const dzM = dzKm * 1000.0;

    return dxM * dzM;
}

// Advective heat flux density (W/m²) carried by water + steam through a
// surface, based on specific-enthalpy weighting:
//
//   q = m_water · h_water(T)  +  m_steam · h_steam(T)
//
// where m is mass flux (kg/s/m²) and h is specific enthalpy (J/kg).
// HYDROTHERM mass flux units are g/s/cm² — multiply by 10 to get SI
// (g/s/cm² × 1 kg/1000 g × 10000 cm²/1 m² = kg/s/m² × 10).
//
// This formula is the right object to multiply by an area to get a heat
// power across that area. For a per-cell heat balance (W in/out per cell)
// you take the divergence of the vector field q and multiply by cell
// volume — see computeHeatPerCellMW below.
function computeHeatFluxDensityWm2(waterFluxHydro, steamFluxHydro, tempC) {
    const hWater = getWaterEnthalpy(tempC) * 1000; // kJ/kg → J/kg
    const hSteam = getSteamEnthalpy(tempC) * 1000;
    return 10.0 * (waterFluxHydro * hWater + steamFluxHydro * hSteam);
}

// Estimate cell width (in metres) for cell index `i` along a sorted
// coordinate axis (in km). Interior cells use the half-distance to each
// neighbour; edge cells fall back to the full distance to the one
// neighbour they have.
function getCellWidthM(coords, i) {
    const n = coords.length;
    if (n <= 1) return 1000.0;                  // single cell, default 1 km
    if (i <= 0)        return (coords[1]   - coords[0])   * 1000.0;
    if (i >= n - 1)    return (coords[n-1] - coords[n-2]) * 1000.0;
    return (coords[i+1] - coords[i-1]) / 2 * 1000.0;
}

// Net advective heat in/out of every cell, in MW. Positive = net inflow
// (cell is gaining energy); negative = net outflow.
//
// Implementation: at each cell evaluate q = ρv·h(T) (vector, W/m²),
// then approximate ∇·q via central differences over the (x, z) plane,
// multiply by cell volume to get W, divide by 1e6 → MW. Sign flipped so
// positive == inflow per the conservation equation ∂E/∂t + ∇·q = 0.
//
// dyMeters is the model thickness in y. For 2D HYDROTHERM runs (one y
// value) this comes from the user via the y-thickness input; for 3D runs
// (multiple y) it's derived from the actual y spacing (TODO: full 3D).
function computeHeatPerCellMW(parsedScalar, parsedVector, scalarSlice, vectorSlice, dyMeters) {
    const { nx, nz, xCoords, zCoords } = parsedVector;
    const cps = nx * nz;

    // Build heat-flux vector grids (W/m²) from mass flux + temperature.
    const Fx = new Float32Array(cps); Fx.fill(NaN);
    const Fz = new Float32Array(cps); Fz.fill(NaN);

    const sNx = parsedScalar.nx;
    const tempBuf = scalarSlice.temperature;

    for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
            const off = iz * nx + ix;
            // Find the nearest scalar cell for the temperature lookup.
            const sIx = nearestIndex(parsedScalar.xCoords, xCoords[ix]);
            const sIz = nearestIndex(parsedScalar.zCoords, zCoords[iz]);
            const T = tempBuf[sIz * sNx + sIx];
            if (!Number.isFinite(T)) continue;

            const hW = getWaterEnthalpy(T) * 1000; // J/kg
            const hS = getSteamEnthalpy(T) * 1000;
            Fx[off] = 10.0 * (vectorSlice.xw[off] * hW + vectorSlice.xs[off] * hS);
            Fz[off] = 10.0 * (vectorSlice.zw[off] * hW + vectorSlice.zs[off] * hS);
        }
    }

    // Per-cell power balance via central differences.
    const out = new Float32Array(cps); out.fill(NaN);
    for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
            const off = iz * nx + ix;
            const dx = getCellWidthM(xCoords, ix);
            const dz = getCellWidthM(zCoords, iz);
            const V = dx * dyMeters * dz; // m³

            const ixL = Math.max(0, ix - 1);
            const ixR = Math.min(nx - 1, ix + 1);
            const izD = Math.max(0, iz - 1);
            const izU = Math.min(nz - 1, iz + 1);
            const dxSpanM = (xCoords[ixR] - xCoords[ixL]) * 1000.0;
            const dzSpanM = (zCoords[izU] - zCoords[izD]) * 1000.0;
            if (dxSpanM <= 0 || dzSpanM <= 0) continue;

            const dFx = Fx[iz * nx + ixR] - Fx[iz * nx + ixL];
            const dFz = Fz[izU * nx + ix] - Fz[izD * nx + ix];
            if (!Number.isFinite(dFx) || !Number.isFinite(dFz)) continue;

            const div = dFx / dxSpanM + dFz / dzSpanM;        // W/m³
            const powerW = -div * V;                          // W (+ = inflow)
            out[off] = powerW / 1.0e6;                        // MW
        }
    }
    return out;
}

// Small helper: read the y-thickness control (km) and convert to metres.
// Falls back to 1000 m if the input is missing or invalid.
function getYThicknessMeters() {
    const el = document.getElementById('yThicknessKm');
    if (!el) return 1000.0;
    const v = parseFloat(el.value);
    if (!Number.isFinite(v) || v <= 0) return 1000.0;
    return v * 1000.0;
}

// Per-cell derived-field values. Handles the cell-local fields:
// water_flux_mag, steam_flux_mag, total_flux_mag, heat_flux_density.
// "heat_per_cell" requires neighbour information for the divergence, so
// it's computed separately by computeHeatPerCellMW (called from plotData).
function deriveVectorField(vectorRows, fieldName, tempLookup = null) {
    return vectorRows.map(row => {
        const waterMag = mag3(row.xw, row.yw, row.zw);
        const steamMag = mag3(row.xs, row.ys, row.zs);
        const totalMag = waterMag + steamMag;

        let value = NaN;

        if (fieldName === 'water_flux_mag') {
            value = waterMag;
        } else if (fieldName === 'steam_flux_mag') {
            value = steamMag;
        } else if (fieldName === 'total_flux_mag') {
            value = totalMag;
        } else if (fieldName === 'heat_flux_density') {
            // Magnitude of the advective heat flux vector at this cell.
            const key = `${row.x}|${row.z}`;
            const tempC = tempLookup ? tempLookup.get(key) : undefined;
            if (tempC !== undefined && !isNaN(tempC)) {
                const hW = getWaterEnthalpy(tempC) * 1000; // J/kg
                const hS = getSteamEnthalpy(tempC) * 1000;
                const Fx = 10.0 * (row.xw * hW + row.xs * hS);
                const Fy = 10.0 * (row.yw * hW + row.ys * hS);
                const Fz = 10.0 * (row.zw * hW + row.zs * hS);
                value = Math.sqrt(Fx*Fx + Fy*Fy + Fz*Fz); // W/m²
            }
        }
        // heat_per_cell is handled grid-wise in plotData via
        // computeHeatPerCellMW(); no per-row computation here.

        return { x: row.x, y: row.z, z: value };
    });
}

// Fast nearest-cell lookup: binary search the sorted xCoords/zCoords.
function nearestIndex(sortedArr, value) {
    if (!sortedArr || sortedArr.length === 0) return -1;
    let lo = 0, hi = sortedArr.length - 1;
    if (value <= sortedArr[lo]) return lo;
    if (value >= sortedArr[hi]) return hi;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (sortedArr[mid] < value) lo = mid;
        else hi = mid;
    }
    return (value - sortedArr[lo] < sortedArr[hi] - value) ? lo : hi;
}

function findClosestScalarPoint(timeData, x, z) {
    let closestPoint = null;
    let minDistance = Infinity;

    for (const dataPoint of timeData) {
        const distance = Math.sqrt(
            Math.pow(dataPoint.x - x, 2) +
            Math.pow(dataPoint.z - z, 2)
        );

        if (distance < minDistance) {
            minDistance = distance;
            closestPoint = dataPoint;
        }
    }

    return { closestPoint, minDistance };
}

function findClosestVectorPoint(vectorRows, x, z) {
    let closestPoint = null;
    let minDistance = Infinity;

    for (const dataPoint of vectorRows) {
        const distance = Math.sqrt(
            Math.pow(dataPoint.x - x, 2) +
            Math.pow(dataPoint.z - z, 2)
        );

        if (distance < minDistance) {
            minDistance = distance;
            closestPoint = dataPoint;
        }
    }

    return { closestPoint, minDistance };
}

function computeDerivedValueAtPoint(fieldName, vectorPoint, scalarPoint /*, cellAreaM2 unused */) {
    if (!vectorPoint) return NaN;

    const waterMag = mag3(vectorPoint.xw, vectorPoint.yw, vectorPoint.zw);
    const steamMag = mag3(vectorPoint.xs, vectorPoint.ys, vectorPoint.zs);
    const totalMag = waterMag + steamMag;

    if (fieldName === 'water_flux_mag') return waterMag;
    if (fieldName === 'steam_flux_mag') return steamMag;
    if (fieldName === 'total_flux_mag') return totalMag;

    if (fieldName === 'heat_flux_density') {
        if (!scalarPoint) return NaN;
        const T = scalarPoint.temperature;
        const hW = getWaterEnthalpy(T) * 1000;
        const hS = getSteamEnthalpy(T) * 1000;
        const Fx = 10.0 * (vectorPoint.xw * hW + vectorPoint.xs * hS);
        const Fy = 10.0 * (vectorPoint.yw * hW + vectorPoint.ys * hS);
        const Fz = 10.0 * (vectorPoint.zw * hW + vectorPoint.zs * hS);
        return Math.sqrt(Fx*Fx + Fy*Fy + Fz*Fz);
    }
    // heat_per_cell needs grid neighbours and is not available cell-locally.
    return NaN;
}

// ============================================================
// Robust HYDROTHERM parsing helpers
// Heading-independent parser:
// - ignores title/comment/header/unit lines
// - accepts arbitrary run names like .Heap12, .ht10, .convectMars
// - detects scalar rows from numeric structure
// - detects vector rows from numeric structure
// ============================================================

function splitHydroLines(text) {
    return String(text || '').split(/\r\n|\n|\r/);
}

function parseHydroNumber(value) {
    if (value === undefined || value === null) return NaN;

    const normalized = String(value)
        .replace(/ /g, '')
        .replace(/ /g, ' ')
        .replace(/−/g, '-')
        .replace(/[dD]/g, 'E')
        .replace(/,/g, '')
        .trim();

    if (normalized === '') return NaN;

    // Require the token to begin like a number, not merely contain a number.
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/.test(normalized)) {
        return NaN;
    }

    const n = Number(normalized);
    return Number.isFinite(n) ? n : NaN;
}

function splitHydroFields(line) {
    return String(line || '')
        .replace(/ /g, '')
        .replace(/ /g, ' ')
        .trim()
        .split(/[\t ]+/)
        .filter(Boolean);
}

function getNumericParts(line) {
    const parts = splitHydroFields(line);
    const nums = parts.map(parseHydroNumber);

    // A real data row should be all numeric tokens.
    // Header/unit/title lines will fail here.
    if (parts.length === 0) return null;
    if (nums.some(v => Number.isNaN(v))) return null;

    return nums;
}

function looksLikeHydroDataLine(line, minCols) {
    const nums = getNumericParts(line);
    return nums && nums.length >= minCols;
}

function detectHydroFileKind(text) {
    const lines = splitHydroLines(text);

    let scalarRows = 0;
    let vectorRows = 0;
    let firstScalarLine = null;
    let firstVectorLine = null;

    for (let i = 0; i < lines.length; i++) {
        const nums = getNumericParts(lines[i]);
        if (!nums) continue;

        // Vector output has at least 10 numeric columns:
        // x y z time xw yw zw xs ys zs
        if (nums.length >= 10) {
            vectorRows++;
            if (firstVectorLine === null) firstVectorLine = i;
        }

        // Scalar output has at least 8 numeric columns:
        // x y z time temperature pressure saturation phase
        // It may have a 9th field, e.g., Cell Nusselt No.
        if (nums.length >= 8) {
            scalarRows++;
            if (firstScalarLine === null) firstScalarLine = i;
        }
    }

    let kind = 'unknown';
    if (vectorRows > 0 && vectorRows >= scalarRows * 0.5) {
        kind = 'vector';
    } else if (scalarRows > 0) {
        kind = 'scalar';
    }

    return {
        kind,
        scalarRows,
        vectorRows,
        firstScalarLine,
        firstVectorLine
    };
}

function tryParseScalarRow(line) {
    const nums = getNumericParts(line);
    if (!nums || nums.length < 8) return null;

    // Do not accidentally parse vector rows as scalar rows.
    if (nums.length >= 10) return null;

    const [x, y, z, time, temperature, pressure, saturation, phase] = nums;

    return {
        x,
        y,
        z,
        time,
        temperature,
        pressure,
        saturation,
        phase,
        nusselt: nums.length >= 9 ? nums[8] : NaN
    };
}

function tryParseVectorRow(line) {
    const nums = getNumericParts(line);
    if (!nums || nums.length < 10) return null;

    const [x, y, z, time, xw, yw, zw, xs, ys, zs] = nums;

    return {
        x,
        y,
        z,
        time,
        xw,
        yw,
        zw,
        xs,
        ys,
        zs
    };
}

// ============================================================
// Structured parser (typed arrays, single pass)
// ============================================================
//
// Splits the file into lines once, parses each row once, and lays the result
// out into typed arrays grouped by timestep. Coordinate maps and per-variable
// gridded matrices are built so every later operation (heatmap, time series,
// GIF export) is O(1) per cell rather than O(file size).
//
// Memory footprint for the gridded matrices on a 2155-step / 1680-cell scalar
// file: ~72 MB across the 5 scalar variables. The original file string can
// be freed afterwards to keep the tab well under typical memory budgets.

const SCALAR_VARS = ['temperature', 'pressure', 'saturation', 'phase', 'nusselt'];
const VECTOR_VARS = ['xw', 'yw', 'zw', 'xs', 'ys', 'zs'];

function _firstTimestepCoords(rowParser, lines) {
    const xs = new Set();
    const zs = new Set();
    let firstTime = null;
    for (let i = 0; i < lines.length; i++) {
        const row = rowParser(lines[i]);
        if (!row) continue;
        if (firstTime === null) firstTime = row.time;
        if (row.time !== firstTime) break;
        xs.add(row.x);
        zs.add(row.z);
    }
    return {
        xCoords: Float64Array.from([...xs].sort((a, b) => a - b)),
        zCoords: Float64Array.from([...zs].sort((a, b) => a - b))
    };
}

function _buildIndexMap(coords) {
    const map = new Map();
    for (let i = 0; i < coords.length; i++) map.set(coords[i], i);
    return map;
}

function buildStructuredScalar(text) {
    const lines = splitHydroLines(text);

    const { xCoords, zCoords } = _firstTimestepCoords(tryParseScalarRow, lines);
    const xIndex = _buildIndexMap(xCoords);
    const zIndex = _buildIndexMap(zCoords);
    const nx = xCoords.length;
    const nz = zCoords.length;

    if (nx === 0 || nz === 0) {
        throw new Error('Could not detect a regular x/z grid from the scalar file.');
    }

    const cellsPerStep = nx * nz;

    // First pass: collect unique times in encounter order.
    const seenTimes = new Set();
    const timeOrder = [];
    for (let i = 0; i < lines.length; i++) {
        const row = tryParseScalarRow(lines[i]);
        if (!row) continue;
        if (!seenTimes.has(row.time)) {
            seenTimes.add(row.time);
            timeOrder.push(row.time);
        }
    }

    const timesSorted = timeOrder.slice().sort((a, b) => a - b);
    const nt = timesSorted.length;
    const tIndex = new Map(timesSorted.map((t, i) => [t, i]));

    const gridded = {};
    for (const v of SCALAR_VARS) {
        gridded[v] = new Float32Array(nt * cellsPerStep);
        gridded[v].fill(NaN);
    }

    // Second pass: fill grids.
    for (let i = 0; i < lines.length; i++) {
        const row = tryParseScalarRow(lines[i]);
        if (!row) continue;
        const ti = tIndex.get(row.time);
        const ix = xIndex.get(row.x);
        const iz = zIndex.get(row.z);
        if (ti === undefined || ix === undefined || iz === undefined) continue;
        const off = ti * cellsPerStep + iz * nx + ix;
        gridded.temperature[off] = row.temperature;
        gridded.pressure[off] = row.pressure;
        gridded.saturation[off] = row.saturation;
        gridded.phase[off] = row.phase;
        gridded.nusselt[off] = row.nusselt;
    }

    return {
        kind: 'scalar',
        timePoints: timesSorted,
        xCoords, zCoords, xIndex, zIndex, nx, nz,
        cellsPerStep,
        gridded
    };
}

function buildStructuredVector(text) {
    const lines = splitHydroLines(text);

    const { xCoords, zCoords } = _firstTimestepCoords(tryParseVectorRow, lines);
    const xIndex = _buildIndexMap(xCoords);
    const zIndex = _buildIndexMap(zCoords);
    const nx = xCoords.length;
    const nz = zCoords.length;

    if (nx === 0 || nz === 0) {
        throw new Error('Could not detect a regular x/z grid from the vector file.');
    }

    const cellsPerStep = nx * nz;

    const seenTimes = new Set();
    const timeOrder = [];
    for (let i = 0; i < lines.length; i++) {
        const row = tryParseVectorRow(lines[i]);
        if (!row) continue;
        if (!seenTimes.has(row.time)) {
            seenTimes.add(row.time);
            timeOrder.push(row.time);
        }
    }

    const timesSorted = timeOrder.slice().sort((a, b) => a - b);
    const nt = timesSorted.length;
    const tIndex = new Map(timesSorted.map((t, i) => [t, i]));

    const gridded = {};
    for (const v of VECTOR_VARS) {
        gridded[v] = new Float32Array(nt * cellsPerStep);
        gridded[v].fill(NaN);
    }

    for (let i = 0; i < lines.length; i++) {
        const row = tryParseVectorRow(lines[i]);
        if (!row) continue;
        const ti = tIndex.get(row.time);
        const ix = xIndex.get(row.x);
        const iz = zIndex.get(row.z);
        if (ti === undefined || ix === undefined || iz === undefined) continue;
        const off = ti * cellsPerStep + iz * nx + ix;
        for (const v of VECTOR_VARS) gridded[v][off] = row[v];
    }

    return {
        kind: 'vector',
        timePoints: timesSorted,
        xCoords, zCoords, xIndex, zIndex, nx, nz,
        cellsPerStep,
        gridded
    };
}

// ============================================================
// Lazy index + on-demand slice loading (for files of any size)
// ============================================================
//
// V8's max string length is ~1.07 GB on 64-bit, and File.text() needs
// ~3x the file size in RAM to materialize a string. Plot_*.convectEarth
// (~1 GB) doesn't fit; multi-GB files certainly don't.
//
// We avoid that limit by NEVER reading the whole file. The first pass
// walks the file once via Blob.stream(), records the byte offset where
// each timestep begins, and detects the (x, z) grid from the first
// timestep. That metadata is small (KB), regardless of file size.
//
// Subsequent reads use file.slice(startByte, endByte).text() to load
// exactly one timestep's worth of bytes — typically a few hundred KB —
// parse it, and cache the result. The heatmap, time series, and GIF
// export all go through this path, so total memory stays bounded by the
// LRU cache size rather than the file size.

// Build an index of byte offsets per timestep in `file`, plus the (x, z)
// grid (read from the first timestep). Does NOT load any field values.
// Returns a small object plus a cache structure for on-demand slice loads.
async function buildLazyIndex(file, kind, onProgress) {
    if (typeof file.stream !== 'function') {
        throw new Error('This browser does not support streaming file reads.');
    }
    const rowParser = (kind === 'scalar') ? tryParseScalarRow : tryParseVectorRow;
    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8');

    // Stitching state: we read raw byte chunks so we know exact byte offsets
    // for each line. carryBytes holds bytes after the last newline in the
    // previous chunk; carryStartByte is its absolute position in the file.
    let carryBytes = new Uint8Array(0);
    let carryStartByte = 0;
    let totalBytesRead = 0;

    let firstTime = null;
    const xsSet = new Set();
    const zsSet = new Set();
    const timePoints = [];
    const timeByteOffsets = []; // start byte of each timestep block
    let curTime = null;
    let rowsScanned = 0;
    let lastYieldRows = 0;

    function processLine(lineBytes, lineStartByte) {
        // Decode just this line (cheap for ASCII files like HYDROTHERM)
        const line = decoder.decode(lineBytes);
        const row = rowParser(line);
        if (!row) return;
        rowsScanned++;
        if (firstTime === null) firstTime = row.time;
        if (timePoints.length === 0 || row.time === firstTime) {
            xsSet.add(row.x);
            zsSet.add(row.z);
        }
        if (row.time !== curTime) {
            curTime = row.time;
            timePoints.push(curTime);
            timeByteOffsets.push(lineStartByte);
        }
    }

    while (true) {
        const { value, done } = await reader.read();
        if (value && value.length > 0) {
            // Concat carry + new chunk
            const merged = new Uint8Array(carryBytes.length + value.length);
            merged.set(carryBytes, 0);
            merged.set(value, carryBytes.length);
            // Scan for newlines (byte 0x0A), peeling off complete lines.
            let lineStart = 0;
            for (let i = 0; i < merged.length; i++) {
                if (merged[i] === 0x0A) {
                    let lineEnd = i;
                    if (lineEnd > lineStart && merged[lineEnd - 1] === 0x0D) lineEnd--;
                    processLine(
                        merged.subarray(lineStart, lineEnd),
                        carryStartByte + lineStart
                    );
                    lineStart = i + 1;
                }
            }
            // Anything past the last newline becomes the new carry.
            carryBytes = merged.slice(lineStart);
            carryStartByte += lineStart;
            totalBytesRead += value.length;

            if (rowsScanned - lastYieldRows >= 200000) {
                lastYieldRows = rowsScanned;
                if (onProgress) onProgress({
                    bytesRead: totalBytesRead, totalBytes: file.size, rowsParsed: rowsScanned
                });
                await new Promise(r => setTimeout(r, 0));
            }
        }
        if (done) break;
    }
    // Final line without trailing newline.
    if (carryBytes.length > 0) {
        let lineEnd = carryBytes.length;
        if (lineEnd > 0 && carryBytes[lineEnd - 1] === 0x0D) lineEnd--;
        processLine(carryBytes.subarray(0, lineEnd), carryStartByte);
    }

    // Sentinel end-byte for the last timestep.
    timeByteOffsets.push(file.size);

    const xCoords = Float64Array.from([...xsSet].sort((a, b) => a - b));
    const zCoords = Float64Array.from([...zsSet].sort((a, b) => a - b));
    if (xCoords.length === 0 || zCoords.length === 0 || timePoints.length === 0) {
        throw new Error(`Could not detect a regular x/z grid from the ${kind} file.`);
    }
    if (onProgress) onProgress({
        bytesRead: totalBytesRead, totalBytes: file.size, rowsParsed: rowsScanned, done: true
    });

    return {
        kind,
        file,
        timePoints,
        timeByteOffsets,
        xCoords,
        zCoords,
        xIndex: _buildIndexMap(xCoords),
        zIndex: _buildIndexMap(zCoords),
        nx: xCoords.length,
        nz: zCoords.length,
        cellsPerStep: xCoords.length * zCoords.length,
        // LRU cache: ti -> { var: Float32Array(cps), ... }
        sliceCache: new Map(),
        sliceCacheCap: 96,
        // Cell time series cache: "ix|iz|var" -> Float32Array(nt)
        seriesCache: new Map()
    };
}

// Read one timestep's worth of bytes from the file and parse all variables
// into per-variable Float32Arrays of length cellsPerStep. Cached LRU-style
// so repeated heatmap renders / click-throughs don't re-read the same chunk.
async function ensureSlice(p, ti) {
    if (!p || ti < 0 || ti >= p.timePoints.length) return null;
    const cache = p.sliceCache;
    const existing = cache.get(ti);
    if (existing) {
        // LRU bump: re-insert moves to end of insertion order.
        cache.delete(ti);
        cache.set(ti, existing);
        return existing;
    }
    const startByte = p.timeByteOffsets[ti];
    const endByte = p.timeByteOffsets[ti + 1];
    const text = await p.file.slice(startByte, endByte).text();
    const slice = (p.kind === 'scalar')
        ? {
            temperature: new Float32Array(p.cellsPerStep).fill(NaN),
            pressure:    new Float32Array(p.cellsPerStep).fill(NaN),
            saturation:  new Float32Array(p.cellsPerStep).fill(NaN),
            phase:       new Float32Array(p.cellsPerStep).fill(NaN),
            nusselt:     new Float32Array(p.cellsPerStep).fill(NaN)
        }
        : {
            xw: new Float32Array(p.cellsPerStep).fill(NaN),
            yw: new Float32Array(p.cellsPerStep).fill(NaN),
            zw: new Float32Array(p.cellsPerStep).fill(NaN),
            xs: new Float32Array(p.cellsPerStep).fill(NaN),
            ys: new Float32Array(p.cellsPerStep).fill(NaN),
            zs: new Float32Array(p.cellsPerStep).fill(NaN)
        };
    const rowParser = (p.kind === 'scalar') ? tryParseScalarRow : tryParseVectorRow;
    const lines = splitHydroLines(text);
    const nx = p.nx;
    for (let li = 0; li < lines.length; li++) {
        const row = rowParser(lines[li]);
        if (!row) continue;
        const ix = p.xIndex.get(row.x);
        const iz = p.zIndex.get(row.z);
        if (ix === undefined || iz === undefined) continue;
        const off = iz * nx + ix;
        if (p.kind === 'scalar') {
            slice.temperature[off] = row.temperature;
            slice.pressure[off] = row.pressure;
            slice.saturation[off] = row.saturation;
            slice.phase[off] = row.phase;
            slice.nusselt[off] = row.nusselt;
        } else {
            slice.xw[off] = row.xw;
            slice.yw[off] = row.yw;
            slice.zw[off] = row.zw;
            slice.xs[off] = row.xs;
            slice.ys[off] = row.ys;
            slice.zs[off] = row.zs;
        }
    }
    // Evict oldest if full
    if (cache.size >= p.sliceCacheCap) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
    cache.set(ti, slice);
    return slice;
}

// Walk every timestep once, extracting a single cell's value for one
// variable. Cached. The first call for a given (cell, variable) is the
// "expensive" one — typically tens of seconds for a 1 GB file — but the
// result is small (4 bytes per timestep) and reused for repeat plots.
async function getCellTimeSeries(p, ix, iz, varName, onProgress) {
    const key = `${ix}|${iz}|${varName}`;
    if (p.seriesCache.has(key)) return p.seriesCache.get(key);
    const nt = p.timePoints.length;
    const out = new Float32Array(nt);
    out.fill(NaN);
    for (let ti = 0; ti < nt; ti++) {
        const slice = await ensureSlice(p, ti);
        if (slice && slice[varName]) {
            out[ti] = slice[varName][iz * p.nx + ix];
        }
        if (onProgress && (ti % 64 === 0 || ti === nt - 1)) {
            onProgress({ ti, total: nt });
            // Yield occasionally so the UI can repaint.
            await new Promise(r => setTimeout(r, 0));
        }
    }
    p.seriesCache.set(key, out);
    return out;
}

// Materialize one timestep as the array-of-objects shape derived-field
// helpers and the vector overlay code expect. ~nx*nz objects per call —
// fine for a per-render path (heatmap, click handler). Now async because
// the slice may need to be loaded from the file.
async function materializeScalarStep(p, ti) {
    if (!p || ti < 0 || ti >= p.timePoints.length) return [];
    const slice = await ensureSlice(p, ti);
    if (!slice) return [];
    const out = new Array(p.cellsPerStep);
    const time = p.timePoints[ti];
    let k = 0;
    for (let iz = 0; iz < p.nz; iz++) {
        for (let ix = 0; ix < p.nx; ix++) {
            const off = iz * p.nx + ix;
            out[k++] = {
                x: p.xCoords[ix],
                y: 0,
                z: p.zCoords[iz],
                time,
                temperature: slice.temperature[off],
                pressure: slice.pressure[off],
                saturation: slice.saturation[off],
                phase: slice.phase[off],
                nusselt: slice.nusselt[off]
            };
        }
    }
    return out;
}

async function materializeVectorStep(p, ti) {
    if (!p || ti < 0 || ti >= p.timePoints.length) return [];
    const slice = await ensureSlice(p, ti);
    if (!slice) return [];
    const out = new Array(p.cellsPerStep);
    const time = p.timePoints[ti];
    let k = 0;
    for (let iz = 0; iz < p.nz; iz++) {
        for (let ix = 0; ix < p.nx; ix++) {
            const off = iz * p.nx + ix;
            out[k++] = {
                x: p.xCoords[ix],
                y: 0,
                z: p.zCoords[iz],
                time,
                xw: slice.xw[off],
                yw: slice.yw[off],
                zw: slice.zw[off],
                xs: slice.xs[off],
                ys: slice.ys[off],
                zs: slice.zs[off]
            };
        }
    }
    return out;
}

// ============================================================
// File loading and validation
// ============================================================

// Pull the loading text node out of the spinner block so we can update it
// with parse progress on big files.
function _setLoadingMessage(msg) {
    const loading = document.getElementById('loading');
    if (!loading) return;
    let p = loading.querySelector('p');
    if (!p) {
        p = document.createElement('p');
        p.className = 'mt-3';
        loading.appendChild(p);
    }
    p.textContent = msg;
}

function _formatBytes(n) {
    if (!n || !Number.isFinite(n)) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function _onParseProgress(label) {
    return ({ bytesRead, totalBytes, rowsParsed, done }) => {
        const pct = totalBytes ? `${((bytesRead / totalBytes) * 100).toFixed(1)}%` : '';
        const msg = done
            ? `Indexing ${label} grid…`
            : `Reading ${label} file… ${_formatBytes(bytesRead)}` +
              (totalBytes ? ` of ${_formatBytes(totalBytes)} (${pct})` : '') +
              ` — ${rowsParsed.toLocaleString()} rows`;
        _setLoadingMessage(msg);
    };
}

async function loadAndProcessFile() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    if (!file) {
        showErrorCard({
            title: 'No file selected',
            body: 'Pick a HYDROTHERM Plot_scalar.* output file to start.',
            kind: 'info'
        });
        return;
    }

    if (!/plot[_ ]?scalar/i.test(file.name)) {
        console.warn('Filename does not match expected Plot_scalar pattern:', file.name);
    }
    clearErrorCard();

    showLoading(true);
    _setLoadingMessage(`Reading scalar file… (${_formatBytes(file.size)})`);

    try {
        console.log(`file name: ${file.name}, size: ${_formatBytes(file.size)}`);

        const t0 = performance.now();
        parsedScalar = await buildLazyIndex(file, 'scalar', _onParseProgress('scalar'));
        console.log(
            `indexed scalar in ${((performance.now() - t0) / 1000).toFixed(1)} s: ` +
            `nt=${parsedScalar.timePoints.length}, nx=${parsedScalar.nx}, nz=${parsedScalar.nz}`
        );

        if (parsedScalar.timePoints.length === 0) {
            throw new Error('No valid time-indexed data found in file.');
        }

        // Sentinel so legacy "is a file loaded?" checks still work.
        fileText = '__loaded__';
        timePoints = parsedScalar.timePoints;
        currentTimeIndex = 0;

        setupTimeSlider();
        _setLoadingMessage('Loading first timestep…');
        await plotData();
        showTimeSeriesSection();
        showLoading(false);
    } catch (error) {
        console.error('Error processing file:', error);
        showLoading(false);
        showErrorCard({
            title: 'Could not load that scalar file',
            body: error.message,
            kind: 'error',
            suggestions: [
                'It might be a Plot_vector file — those go in the second file picker, not the first.',
                'Check the run completed at least one PRINT step (otherwise the data section is empty).',
                'Make sure the file isn’t truncated — re-download or re-export from the simulation.',
                'The first 5 lines should be the title block (run name, comments, run id, column names, units).'
            ]
        });
    }
}

function validateFileFormat(text) {
    // Cheap check: scan a prefix; full validation happens when the structured
    // parser runs and either produces a grid or throws.
    const prefix = text.length > 200000 ? text.slice(0, 200000) : text;
    const lines = splitHydroLines(prefix);
    let validDataLines = 0;
    const examples = [];

    for (let i = 0; i < lines.length; i++) {
        const parsed = tryParseScalarRow(lines[i]);
        if (parsed) {
            validDataLines++;
            if (examples.length < 5) {
                examples.push({ lineNumber: i + 1, raw: lines[i], parsed });
            }
        }
    }

    console.log('HYDROTHERM scalar validation summary:', {
        prefixScanned: prefix.length,
        validDataLines,
        examples
    });

    if (validDataLines === 0) {
        return {
            isValid: false,
            error: 'No valid scalar data rows were found in the first 200 KB of the file.'
        };
    }

    return { isValid: true, error: null };
}

// Legacy shim: callers that still ask for a timestep by float-time get the
// materialized object array for that step. Backed by typed arrays now.
async function parseTimeStepData(_unused, time) {
    if (!parsedScalar) return [];
    const ti = parsedScalar.timePoints.indexOf(time);
    if (ti === -1) return [];
    return materializeScalarStep(parsedScalar, ti);
}

// ============================================================
// Vector file handling
// ============================================================

async function loadVectorFile() {
    const vectorFileInput = document.getElementById('vectorFileInput');
    const vectorTypeSelect = document.getElementById('vectorTypeSelect');
    const arrowScaleSlider = document.getElementById('arrowScaleSlider');

    const file = vectorFileInput.files[0];
    if (!file) {
        showErrorCard({
            title: 'No vector file selected',
            body: 'Pick a HYDROTHERM Plot_vector.* file. Vector overlays and ' +
                'flux-derived fields need this on top of the scalar file.',
            kind: 'info'
        });
        return;
    }

    if (!/plot[_ ]?vector/i.test(file.name)) {
        console.warn('Filename does not match expected Plot_vector pattern:', file.name);
    }

    showLoading(true);
    _setLoadingMessage(`Reading vector file… (${_formatBytes(file.size)})`);

    try {
        console.log(`vector file name: ${file.name}, size: ${_formatBytes(file.size)}`);

        const t0 = performance.now();
        parsedVector = await buildLazyIndex(file, 'vector', _onParseProgress('vector'));
        console.log(
            `indexed vector in ${((performance.now() - t0) / 1000).toFixed(1)} s: ` +
            `nt=${parsedVector.timePoints.length}, nx=${parsedVector.nx}, nz=${parsedVector.nz}`
        );

        if (parsedVector.timePoints.length === 0) {
            throw new Error('No valid time-indexed data found in vector file.');
        }

        vectorFileText = '__loaded__';
        vectorTimePoints = parsedVector.timePoints;

        const currentTime = timePoints[currentTimeIndex];
        const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
        const bestTi = bestVectorTime !== null
            ? vectorTimePoints.indexOf(bestVectorTime) : -1;
        vectorData = bestTi >= 0 ? await materializeVectorStep(parsedVector, bestTi) : [];

        vectorType = vectorTypeSelect.value;
        arrowScale = parseFloat(arrowScaleSlider.value);

        showLoading(false);
        plotData();
    } catch (error) {
        console.error('Error processing vector file:', error);
        showLoading(false);
        showErrorCard({
            title: 'Could not load that vector file',
            body: error.message,
            kind: 'error',
            suggestions: [
                'This slot wants Plot_vector, not Plot_scalar — flip them if you swapped.',
                'The vector file should be from the same run as the scalar file (matching run id).',
                'Make sure the file isn’t truncated.'
            ]
        });
    }
}

function validateVectorFileFormat(text) {
    const prefix = text.length > 200000 ? text.slice(0, 200000) : text;
    const lines = splitHydroLines(prefix);
    let validDataLines = 0;
    const examples = [];

    for (let i = 0; i < lines.length; i++) {
        const parsed = tryParseVectorRow(lines[i]);
        if (parsed) {
            validDataLines++;
            if (examples.length < 5) {
                examples.push({ lineNumber: i + 1, raw: lines[i], parsed });
            }
        }
    }

    console.log('HYDROTHERM vector validation summary:', {
        prefixScanned: prefix.length,
        validDataLines,
        examples
    });

    if (validDataLines === 0) {
        return {
            isValid: false,
            error: 'No valid vector data rows were found in the first 200 KB of the file.'
        };
    }

    return { isValid: true, error: null };
}

// Legacy shim, mirroring parseTimeStepData.
async function parseVectorTimeStepData(_unused, time) {
    if (!parsedVector) return [];
    const ti = parsedVector.timePoints.indexOf(time);
    if (ti === -1) return [];
    return materializeVectorStep(parsedVector, ti);
}

function clearVectors() {
    vectorData = null;
    vectorFileText = null;
    vectorTimeIndex = {};
    vectorTimePoints = [];
    parsedVector = null;
    plotData();
}

// ============================================================
// UI setup
// ============================================================

function setupTimeSlider() {
    const timeSlider = document.getElementById('timeSlider');
    const timeRange = document.getElementById('timeRange');

    timeRange.max = timePoints.length - 1;
    timeRange.value = 0;
    timeRange.oninput = async function () {
        currentTimeIndex = parseInt(this.value, 10);
        updateTimeDisplay();
        await plotData();
    };

    updateTimeDisplay();
    timeSlider.style.display = 'block';

    setupColorbarControls();
    setupAxisControls();
    setupVectorControls();
}

function setupColorbarControls() {
    const colorbarControls = document.getElementById('colorbarControls');

    $("#slider-range").slider({
        range: true,
        min: 0,
        max: 100,
        values: [0, 100],
        slide: function (event, ui) {
            const minPercent = ui.values[0];
            const maxPercent = ui.values[1];
            const dataRange = currentDataRange.max - currentDataRange.min;

            customColorbarRange = {
                min: currentDataRange.min + (dataRange * minPercent / 100),
                max: currentDataRange.min + (dataRange * maxPercent / 100)
            };

            updateRangeDisplay();
            plotData();
        }
    });

    updateRangeDisplay();
    // The "Customize colors & axes" toggle row was hidden in HTML until a
    // file loaded — surface it now so the user can expand the panel.
    const toggleRow = document.getElementById('customizeToggleRow');
    if (toggleRow) toggleRow.style.display = 'block';
}

function setupAxisControls() {
    const axisControls = document.getElementById('axisControls');

    $("#x-slider-range").slider({
        range: true,
        min: 0,
        max: 100,
        values: [0, 100],
        slide: function (event, ui) {
            const minPercent = ui.values[0];
            const maxPercent = ui.values[1];
            const xRange = currentXRange.max - currentXRange.min;

            customXRange = {
                min: currentXRange.min + (xRange * minPercent / 100),
                max: currentXRange.min + (xRange * maxPercent / 100)
            };

            updateXRangeDisplay();
            plotData();
        }
    });

    $("#z-slider-range").slider({
        range: true,
        min: 0,
        max: 100,
        values: [0, 100],
        slide: function (event, ui) {
            const minPercent = ui.values[0];
            const maxPercent = ui.values[1];
            const zRange = currentZRange.max - currentZRange.min;

            customZRange = {
                min: currentZRange.min + (zRange * minPercent / 100),
                max: currentZRange.min + (zRange * maxPercent / 100)
            };

            updateZRangeDisplay();
            plotData();
        }
    });

    updateXRangeDisplay();
    updateZRangeDisplay();
    // Axis controls live inside the same collapse as the colorbar; the
    // toggle row is already shown by setupColorbarControls.
}

function setupVectorControls() {
    const arrowScaleSlider = document.getElementById('arrowScaleSlider');
    const arrowScaleDisplay = document.getElementById('arrowScaleDisplay');
    const vectorTypeSelect = document.getElementById('vectorTypeSelect');
    const arrowColorSelect = document.getElementById('arrowColorSelect');

    arrowScaleSlider.value = -2.0;

    arrowScaleSlider.oninput = function () {
        arrowScale = parseFloat(this.value);
        updateArrowScaleDisplay(arrowScaleDisplay);
        if (parsedVector) plotData();
    };

    updateArrowScaleDisplay(arrowScaleDisplay);

    vectorTypeSelect.addEventListener('change', function () {
        vectorType = this.value;
        if (parsedVector) {
            const currentTime = timePoints[currentTimeIndex];
            const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
            const bestTi = bestVectorTime !== null
                ? vectorTimePoints.indexOf(bestVectorTime) : -1;
            (async () => {
                vectorData = bestTi >= 0
                    ? await materializeVectorStep(parsedVector, bestTi)
                    : [];
                plotData();
            })();
        }
    });

    arrowColor = arrowColorSelect.value;
    arrowColorSelect.addEventListener('change', function () {
        arrowColor = this.value;
        if (parsedVector) plotData();
    });
}

function updateArrowScaleDisplay(arrowScaleDisplay) {
    const actualScale = Math.pow(10, arrowScale);
    let displayText;

    if (actualScale >= 1000000) {
        displayText = `Scale: ${(actualScale / 1000000).toFixed(1)}Mx`;
    } else if (actualScale >= 1000) {
        displayText = `Scale: ${(actualScale / 1000).toFixed(1)}Kx`;
    } else if (actualScale < 1) {
        displayText = `Scale: ${actualScale.toExponential(1)}x`;
    } else {
        displayText = `Scale: ${actualScale.toFixed(1)}x`;
    }

    arrowScaleDisplay.textContent = displayText;
}

function updateRangeDisplay() {
    const amount = document.getElementById('amount');
    if (customColorbarRange) {
        amount.value = `${customColorbarRange.min.toFixed(3)} - ${customColorbarRange.max.toFixed(3)}`;
    } else {
        amount.value = `${currentDataRange.min.toFixed(3)} - ${currentDataRange.max.toFixed(3)}`;
    }
}

function updateXRangeDisplay() {
    const xRangeAmount = document.getElementById('xRangeAmount');
    if (customXRange) {
        xRangeAmount.value = `${customXRange.min.toFixed(3)} - ${customXRange.max.toFixed(3)} km`;
    } else {
        xRangeAmount.value = `${currentXRange.min.toFixed(3)} - ${currentXRange.max.toFixed(3)} km`;
    }
}

function updateZRangeDisplay() {
    const zRangeAmount = document.getElementById('zRangeAmount');
    if (customZRange) {
        zRangeAmount.value = `${customZRange.min.toFixed(3)} - ${customZRange.max.toFixed(3)} km`;
    } else {
        zRangeAmount.value = `${currentZRange.min.toFixed(3)} - ${currentZRange.max.toFixed(3)} km`;
    }
}

function resetColorbar() {
    customColorbarRange = null;
    $("#slider-range").slider("values", [0, 100]);
    updateRangeDisplay();
    plotData();
}

function resetAxes() {
    customXRange = null;
    customZRange = null;
    $("#x-slider-range").slider("values", [0, 100]);
    $("#z-slider-range").slider("values", [0, 100]);
    updateXRangeDisplay();
    updateZRangeDisplay();
    plotData();
}

function updateTimeDisplay() {
    const timeDisplay = document.getElementById('timeDisplay');
    const currentTime = timePoints[currentTimeIndex];
    timeDisplay.textContent = Number.isFinite(currentTime)
        ? `Time: ${currentTime.toFixed(5)} years`
        : 'Time: N/A';
}

// ============================================================
// Plotting
// ============================================================

// Build the heatmap z-matrix from a single timestep slice. The slice is
// loaded lazily from disk via ensureSlice() — typically a few hundred KB
// for a Plot_*.convectEarth-class file — and cached LRU.
async function buildScalarMesh(p, variable, ti) {
    const slice = await ensureSlice(p, ti);
    if (!slice || !slice[variable]) return { x: [], y: [], z: [] };
    const arr = slice[variable];
    const { nx, nz, xCoords, zCoords } = p;
    const z = new Array(nz);
    for (let iz = 0; iz < nz; iz++) {
        const row = new Array(nx);
        const base = iz * nx;
        for (let ix = 0; ix < nx; ix++) {
            const v = arr[base + ix];
            row[ix] = Number.isFinite(v) ? v : NaN;
        }
        z[iz] = row;
    }
    return {
        x: Array.from(xCoords),
        y: Array.from(zCoords),
        z
    };
}

async function plotData() {
    if (!parsedScalar || timePoints.length === 0) return;

    const variableSelect = document.getElementById('variableSelect');
    const colormapSelect = document.getElementById('colormapSelect');
    const selectedVariable = variableSelect.value;
    const selectedColormap = colormapSelect.value;
    const currentTime = timePoints[currentTimeIndex];

    if (parsedVector) {
        const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
        const bestTi = bestVectorTime !== null
            ? vectorTimePoints.indexOf(bestVectorTime) : -1;
        vectorData = bestTi >= 0 ? await materializeVectorStep(parsedVector, bestTi) : [];
    }

    let meshData;
    if (isDerivedVectorField(selectedVariable)) {
        if (!parsedVector || !vectorData || vectorData.length === 0) {
            showErrorCard({
                title: 'Need a vector file',
                body:
                    'This field is derived from mass-flux components. ' +
                    'Load a Plot_vector file (the matching one for this run) to plot it.',
                kind: 'info'
            });
            return;
        }
        if (selectedVariable === 'heat_per_cell') {
            // Grid-wise: needs neighbour info for divergence.
            const scalarSlice = await ensureSlice(parsedScalar, currentTimeIndex);
            const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
            const vectorTi = bestVectorTime !== null
                ? vectorTimePoints.indexOf(bestVectorTime) : 0;
            const vectorSlice = await ensureSlice(parsedVector, vectorTi);
            const dyM = getYThicknessMeters();
            const perCellMW = computeHeatPerCellMW(
                parsedScalar, parsedVector, scalarSlice, vectorSlice, dyM
            );
            // Build mesh manually from the (nz × nx) MW array.
            const { nx, nz, xCoords, zCoords } = parsedVector;
            const z = new Array(nz);
            for (let iz = 0; iz < nz; iz++) {
                const row = new Array(nx);
                for (let ix = 0; ix < nx; ix++) row[ix] = perCellMW[iz * nx + ix];
                z[iz] = row;
            }
            meshData = { x: Array.from(xCoords), y: Array.from(zCoords), z };
        } else {
            const timeData = await materializeScalarStep(parsedScalar, currentTimeIndex);
            const tempLookup = buildTemperatureLookup(timeData);
            const derivedRows = deriveVectorField(vectorData, selectedVariable, tempLookup);
            meshData = createMeshGridFromXYZ(derivedRows);
        }
    } else {
        meshData = await buildScalarMesh(parsedScalar, selectedVariable, currentTimeIndex);
    }

    // Compute color/axis ranges without spread-into-Math.min — works at any size.
    {
        let lo = Infinity, hi = -Infinity;
        for (const row of meshData.z) {
            for (let j = 0; j < row.length; j++) {
                const v = row[j];
                if (Number.isFinite(v)) {
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
            }
        }
        if (lo !== Infinity) currentDataRange = { min: lo, max: hi };
    }

    if (meshData.x.length > 0) {
        const xLo = meshData.x[0], xHi = meshData.x[meshData.x.length - 1];
        currentXRange = { min: Math.min(xLo, xHi), max: Math.max(xLo, xHi) };
    }
    if (meshData.y.length > 0) {
        const zLo = meshData.y[0], zHi = meshData.y[meshData.y.length - 1];
        currentZRange = { min: Math.min(zLo, zHi), max: Math.max(zLo, zHi) };
    }

    const colorbarRange = customColorbarRange || currentDataRange;
    const xAxisRange = customXRange || currentXRange;
    const zAxisRange = customZRange || currentZRange;

    const traces = [];

    traces.push({
        z: meshData.z,
        x: meshData.x,
        y: meshData.y,
        type: 'heatmap',
        colorscale: selectedColormap,
        zmin: colorbarRange.min,
        zmax: colorbarRange.max,
        colorbar: {
            title: getVariableLabel(selectedVariable),
            tickfont: { color: currentTheme === 'dark' ? '#ffffff' : '#222222' },
            titlefont: { color: currentTheme === 'dark' ? '#ffffff' : '#222222' }
        },
        hoverongaps: false,
        hovertemplate:
            'X: %{x:.3f} km<br>' +
            'Z: %{y:.3f} km<br>' +
            `${getVariableLabel(selectedVariable)}: %{z:.3f}<br>` +
            '<extra></extra>'
    });

    if (plottedPoints.length > 0) {
        for (const point of plottedPoints) {
            traces.push({
                x: [point.x],
                y: [point.z],
                type: 'scatter',
                mode: 'markers+text',
                marker: {
                    size: 12,
                    color: point.color,
                    line: { color: 'white', width: 2 },
                    symbol: 'circle'
                },
                text: [`P${point.id}`],
                textposition: 'top center',
                textfont: { color: point.color, size: 12 },
                name: `Point ${point.id} (${point.x.toFixed(3)}, ${point.z.toFixed(3)})`,
                showlegend: false,
                hovertemplate:
                    `Point ${point.id}<br>` +
                    'X: %{x:.3f} km<br>' +
                    'Z: %{y:.3f} km<br>' +
                    '<extra></extra>'
            });
        }
    }

    if (vectorData && vectorData.length > 0) {
        const sampleStep = Math.max(1, Math.floor(vectorData.length / 1000));
        const sampledData = vectorData.filter((_, index) => index % sampleStep === 0);

        let arrowX = [];
        let arrowY = [];
        let headX = [];
        let headY = [];

        sampledData.forEach(d => {
            const comp = getVectorComponentsForPlot(d, vectorType);

            const x0 = d.x;
            const y0 = d.z;
            const u = comp.u;
            const v = comp.w;

            const mag = Math.sqrt(u * u + v * v);
            if (mag <= 0) return;

            const logMag = Math.log10(mag + 1e-30);
            const shiftedMag = logMag + 12;

            const ux = u / mag;
            const uy = v / mag;

            const scale = Math.pow(10, arrowScale);
            const length = Math.max(0.001, shiftedMag) * scale;

            if (!isFinite(length) || length <= 0) return;

            const x1 = x0 + ux * length;
            const y1 = y0 + uy * length;

            arrowX.push(x0, x1, null);
            arrowY.push(y0, y1, null);

            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.sqrt(dx * dx + dy * dy);

            if (len > 0) {
                const dirx = dx / len;
                const diry = dy / len;
                const px = -diry;
                const py = dirx;
                const ah = Math.min(0.5, len * 0.2);

                const hx1 = x1 - dirx * ah + px * ah * 0.5;
                const hy1 = y1 - diry * ah + py * ah * 0.5;
                const hx2 = x1 - dirx * ah - px * ah * 0.5;
                const hy2 = y1 - diry * ah - py * ah * 0.5;

                headX.push(x1, hx1, null, x1, hx2, null);
                headY.push(y1, hy1, null, y1, hy2, null);
            }
        });

        traces.push({
            x: arrowX,
            y: arrowY,
            type: 'scatter',
            mode: 'lines',
            line: { color: arrowColor, width: 2 },
            name: `${vectorType.charAt(0).toUpperCase() + vectorType.slice(1)} Flow`,
            hoverinfo: 'skip',
            showlegend: true
        });

        if (headX.length > 0) {
            traces.push({
                x: headX,
                y: headY,
                type: 'scatter',
                mode: 'lines',
                line: { color: arrowColor, width: 2 },
                hoverinfo: 'skip',
                showlegend: false
            });
        }
    }

    const layout = {
        title: {
            text: `${getVariableLabel(selectedVariable)} at Time: ${currentTime.toFixed(5)} years`,
            font: { size: 18, color: currentTheme === 'dark' ? '#ffffff' : '#333333' }
        },
        xaxis: {
            title: 'X (km)',
            range: [xAxisRange.min, xAxisRange.max],
            gridcolor: currentTheme === 'dark' ? '#444' : 'lightgray',
            zeroline: false,
            color: currentTheme === 'dark' ? '#ffffff' : '#333333',
            tickfont: { color: currentTheme === 'dark' ? '#ffffff' : '#333333' }
        },
        yaxis: {
            title: 'Z (km)',
            range: [zAxisRange.min, zAxisRange.max],
            gridcolor: currentTheme === 'dark' ? '#444' : 'lightgray',
            zeroline: false,
            color: currentTheme === 'dark' ? '#ffffff' : '#333333',
            tickfont: { color: currentTheme === 'dark' ? '#ffffff' : '#333333' }
        },
        plot_bgcolor: currentTheme === 'dark' ? '#1a1a1a' : 'white',
        paper_bgcolor: currentTheme === 'dark' ? '#1a1a1a' : 'white',
        margin: { l: 60, r: 60, t: 80, b: 60 },
        height: 500,
        width: null,
        autosize: true
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d'],
        displaylogo: false,
        useResizeHandler: true
    };

    Plotly.newPlot('plotContainer', traces, layout, config);
    setupPlotClickSelection();

    updateRangeDisplay();
    updateXRangeDisplay();
    updateZRangeDisplay();
}

// Legacy createMeshGrid kept as a compatibility shim, but now O(N) using
// the parsedScalar coordinate index.
function createMeshGrid(data, variable) {
    if (parsedScalar) {
        const { nx, nz, xCoords, zCoords, xIndex, zIndex } = parsedScalar;
        const z = Array.from({ length: nz }, () => Array(nx).fill(NaN));
        for (const r of data) {
            const ix = xIndex.get(r.x);
            const iz = zIndex.get(r.z);
            if (ix !== undefined && iz !== undefined) {
                z[iz][ix] = r[variable];
            }
        }
        return { x: Array.from(xCoords), y: Array.from(zCoords), z };
    }
    // Fallback (no parsed grid available).
    const xCoords = [...new Set(data.map(row => row.x))].sort((a, b) => a - b);
    const zCoords = [...new Set(data.map(row => row.z))].sort((a, b) => a - b);
    const xIdx = new Map(xCoords.map((v, i) => [v, i]));
    const zIdx = new Map(zCoords.map((v, i) => [v, i]));
    const z = Array.from({ length: zCoords.length }, () => Array(xCoords.length).fill(NaN));
    for (const r of data) {
        z[zIdx.get(r.z)][xIdx.get(r.x)] = r[variable];
    }
    return { x: xCoords, y: zCoords, z };
}

function setupPlotClickSelection() {
    const plotDiv = document.getElementById('plotContainer');
    if (!plotDiv || typeof plotDiv.on !== 'function') return;

    plotDiv.on('plotly_click', function (eventData) {
        if (!eventData || !eventData.points || eventData.points.length === 0) return;

        // Only react to clicks on the heatmap layer — ignore arrow / marker clicks
        // so the recorded coordinates always come from the data grid.
        const heatmapPoint = eventData.points.find(p =>
            p && p.data && p.data.type === 'heatmap'
        );
        const clicked = heatmapPoint || eventData.points[0];
        const x = clicked.x;
        const z = clicked.y;

        if (!isFinite(x) || !isFinite(z)) return;

        let cellX = x, cellZ = z;
        if (parsedScalar) {
            const ix = nearestIndex(parsedScalar.xCoords, x);
            const iz = nearestIndex(parsedScalar.zCoords, z);
            cellX = parsedScalar.xCoords[ix];
            cellZ = parsedScalar.zCoords[iz];
        }

        const slot = nextPointSlot;
        document.getElementById(`xCoord${slot}`).value = cellX.toFixed(3);
        document.getElementById(`zCoord${slot}`).value = cellZ.toFixed(3);

        nextPointSlot = slot === 4 ? 1 : slot + 1;

        updatePlottedPointsFromInputs();
        plotData();
    });
}

// ============================================================
// Labels / formatting
// ============================================================

function getVariableLabel(variable) {
    const labels = {
        temperature: 'Temperature (°C)',
        pressure: 'Pressure (bar)',
        saturation: 'Saturation',
        phase: 'Phase Index',
        water_flux_mag: 'Water mass-flux magnitude (g/s/cm²)',
        steam_flux_mag: 'Steam mass-flux magnitude (g/s/cm²)',
        total_flux_mag: 'Total mass-flux magnitude (g/s/cm²)',
        heat_flux_density: 'Advective heat flux density (W/m²)',
        heat_per_cell: 'Net advective heat in/out per cell (MW)'
    };
    return labels[variable] || variable;
}

function formatValue(value, variable) {
    if (variable === 'pressure') {
        return `${value.toFixed(2)} bar`;
    } else if (variable === 'temperature') {
        return `${value.toFixed(1)} °C`;
    } else if (variable === 'heat_flux_density') {
        return `${value.toExponential(3)} W/m²`;
    } else if (variable === 'heat_per_cell') {
        return `${value.toExponential(3)} MW`;
    } else {
        return value.toFixed(3);
    }
}

function getRange(values) {
    return arrayMinMaxFinite(values);
}

// ============================================================
// Inline help: one-sentence definitions surfaced under selectors
// ============================================================
//
// Updates the help text under #variableSelect and #timeSeriesVariable
// whenever the choice changes, so a student doesn't have to know what
// "Phase" or "Saturation" mean ahead of time. Also toggles the model
// y-thickness input, which is only relevant for the per-cell heat field.

const VARIABLE_HELP = {
    temperature:
        'Temperature in degrees Celsius. Drives buoyancy and the water/steam phase split.',
    pressure:
        'Total fluid pressure in bar. In hydrothermal systems this is roughly hydrostatic plus any overpressure from boiling.',
    saturation:
        'Liquid-water saturation: fraction of pore space filled with liquid (0 = all steam, 1 = all liquid).',
    phase:
        'HYDROTHERM phase index. Integer code marking which phases are present in each cell (single-phase liquid, single-phase steam, two-phase, etc.).',
    water_flux_mag:
        'Magnitude of the liquid-water mass-flux vector at each cell, in g/s/cm². Direction is shown by the arrows when a vector file is loaded.',
    steam_flux_mag:
        'Magnitude of the steam mass-flux vector at each cell, in g/s/cm².',
    total_flux_mag:
        'Sum of water and steam mass-flux magnitudes (g/s/cm²). A simple "how much fluid is moving here" view.',
    heat_flux_density:
        'Advective heat flux carried by the fluid at each cell (W/m²). Computed as ρv·h(T) using saturation enthalpies for liquid water and steam.',
    heat_per_cell:
        'Net rate at which advective heat enters or leaves each grid cell (MW). Positive = inflow. Computed as the divergence of the heat flux vector × cell volume; needs the y-thickness below for 2D runs.'
};

function updateVariableHelp() {
    const sel = document.getElementById('variableSelect');
    const help = document.getElementById('variableHelp');
    const yRow = document.getElementById('yThicknessRow');
    if (!sel || !help) return;
    const v = sel.value;
    help.textContent = VARIABLE_HELP[v] || '';
    if (yRow) yRow.style.display = (v === 'heat_per_cell') ? 'block' : 'none';
}

function updateTimeSeriesVariableHelp() {
    const sel = document.getElementById('timeSeriesVariable');
    const help = document.getElementById('timeSeriesVariableHelp');
    if (!sel || !help) return;
    help.textContent = VARIABLE_HELP[sel.value] || '';
}

// ============================================================
// Utility / theme / loading
// ============================================================

function showLoading(show) {
    const loading = document.getElementById('loading');
    const plotContainer = document.getElementById('plotContainer');

    if (show) {
        loading.style.display = 'block';
        plotContainer.style.display = 'none';
    } else {
        loading.style.display = 'none';
        plotContainer.style.display = 'block';
    }
}

// ============================================================
// In-page error / info cards (replacement for window.alert)
// ============================================================
//
// alert() is hostile and gives the user no path forward. Every former
// alert() call site now goes through showErrorCard, which renders a
// dismissable card at the top of the page with an optional list of
// suggested fixes and a "What does this mean?" link.

function _ensureErrorContainer() {
    let el = document.getElementById('errorContainer');
    if (el) return el;
    // Insert at the very top of the main container so it's always visible.
    el = document.createElement('div');
    el.id = 'errorContainer';
    el.style.cssText = 'margin: 0 0 20px 0;';
    const main = document.querySelector('.main-container');
    if (main && main.firstChild) main.insertBefore(el, main.firstChild.nextSibling);
    else document.body.insertBefore(el, document.body.firstChild);
    return el;
}

// kind: 'error' | 'warning' | 'info' | 'success'
function showErrorCard({ title, body, kind = 'error', suggestions = [], actions = [] }) {
    const container = _ensureErrorContainer();
    const palette = {
        error:   { bg: '#fde7e9', border: '#e74c3c', icon: 'fa-circle-exclamation', fg: '#7d1f1f' },
        warning: { bg: '#fff4d6', border: '#f39c12', icon: 'fa-triangle-exclamation', fg: '#7a5500' },
        info:    { bg: '#e7f1fb', border: '#3498db', icon: 'fa-circle-info', fg: '#1a4d75' },
        success: { bg: '#e0f5e9', border: '#27ae60', icon: 'fa-circle-check', fg: '#1d6e3a' }
    }[kind] || {};

    const card = document.createElement('div');
    card.style.cssText = `
        background: ${palette.bg}; border-left: 4px solid ${palette.border};
        color: ${palette.fg}; padding: 14px 18px; border-radius: 8px;
        margin-bottom: 10px; position: relative; box-shadow: 0 2px 6px rgba(0,0,0,0.08);
    `;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.innerHTML = '×';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.style.cssText = `
        position: absolute; top: 6px; right: 10px; background: transparent;
        border: 0; font-size: 22px; line-height: 1; color: ${palette.fg};
        cursor: pointer; opacity: 0.75;
    `;
    dismiss.onclick = () => card.remove();
    card.appendChild(dismiss);

    if (title) {
        const h = document.createElement('div');
        h.style.cssText = 'font-weight: 600; margin-bottom: 6px;';
        h.innerHTML = `<i class="fas ${palette.icon}" style="margin-right:8px;"></i>${title}`;
        card.appendChild(h);
    }
    if (body) {
        const p = document.createElement('div');
        p.textContent = body;
        p.style.cssText = 'line-height: 1.4;';
        card.appendChild(p);
    }
    if (suggestions.length) {
        const ul = document.createElement('ul');
        ul.style.cssText = 'margin: 8px 0 0 18px; padding: 0;';
        for (const s of suggestions) {
            const li = document.createElement('li');
            li.textContent = s;
            li.style.cssText = 'margin-bottom: 2px;';
            ul.appendChild(li);
        }
        card.appendChild(ul);
    }
    if (actions.length) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top: 10px; display: flex; gap: 8px;';
        for (const a of actions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = a.label;
            btn.className = 'btn btn-sm btn-outline-dark';
            btn.onclick = () => { try { a.onClick(); } catch (e) { console.error(e); } card.remove(); };
            wrap.appendChild(btn);
        }
        card.appendChild(wrap);
    }

    // Replace any existing card so we don't stack identical messages.
    container.innerHTML = '';
    container.appendChild(card);

    // Auto-dismiss success/info after 6 s; keep errors / warnings until clicked.
    if (kind === 'info' || kind === 'success') {
        setTimeout(() => card.remove(), 6000);
    }
    // Scroll into view if off-screen.
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearErrorCard() {
    const c = document.getElementById('errorContainer');
    if (c) c.innerHTML = '';
}

function readFileAsText(file) {
    return file.text();
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    currentTheme = theme;
}

// ============================================================
// Time series
// ============================================================

function getPointsFromInputs() {
    const points = [];

    for (let i = 1; i <= 4; i++) {
        const xCoord = parseFloat(document.getElementById(`xCoord${i}`).value);
        const zCoord = parseFloat(document.getElementById(`zCoord${i}`).value);

        if (!isNaN(xCoord) && !isNaN(zCoord)) {
            points.push({
                id: i,
                x: xCoord,
                z: zCoord,
                color: POINT_COLORS[i - 1]
            });
        }
    }

    return points;
}

function updatePlottedPointsFromInputs() {
    plottedPoints = getPointsFromInputs();
}

// Walk every timestep on disk, reading just enough to extract the requested
// cell's value across all timesteps. Cached per (cell, variable). The first
// call for a (cell, variable) pair pays the I/O cost — bounded by file size,
// typically tens of seconds for a 1 GB file — and every subsequent call hits
// the cache and returns instantly.
async function gatherTimeSeries(variable, ix, iz, onProgress) {
    if (!parsedScalar) return [];
    const isDerived = isDerivedVectorField(variable);
    const nt = parsedScalar.timePoints.length;
    const out = new Array(nt);

    if (!isDerived) {
        const series = await getCellTimeSeries(parsedScalar, ix, iz, variable, onProgress);
        for (let ti = 0; ti < nt; ti++) {
            out[ti] = { time: parsedScalar.timePoints[ti], value: series[ti] };
        }
        return out;
    }

    if (!parsedVector) return [];

    // Map scalar (ix, iz) onto the vector grid by nearest cell — typically
    // they share a grid, but cold125-style files can differ slightly.
    const xv = parsedScalar.xCoords[ix];
    const zv = parsedScalar.zCoords[iz];
    const ixv = nearestIndex(parsedVector.xCoords, xv);
    const izv = nearestIndex(parsedVector.zCoords, zv);
    const ntV = parsedVector.timePoints.length;

    if (variable === 'heat_per_cell') {
        // Per-step grid-wise computation: load both slices, compute the
        // divergence at the requested cell, multiply by cell volume.
        const dyM = getYThicknessMeters();
        for (let ti = 0; ti < nt; ti++) {
            const tNow = parsedScalar.timePoints[ti];
            const tvIdx = (ntV === nt) ? ti : nearestIndex(parsedVector.timePoints, tNow);
            const scalarSlice = await ensureSlice(parsedScalar, ti);
            const vectorSlice = await ensureSlice(parsedVector, tvIdx);
            const perCellMW = computeHeatPerCellMW(
                parsedScalar, parsedVector, scalarSlice, vectorSlice, dyM
            );
            const v = perCellMW[izv * parsedVector.nx + ixv];
            out[ti] = { time: tNow, value: v };
            if (onProgress && (ti % 16 === 0 || ti === nt - 1)) {
                onProgress({ ti, total: nt });
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return out;
    }

    // Cell-local derived fields: pull each component series once (cached).
    const [xwS, ywS, zwS, xsS, ysS, zsS, tempS] = await Promise.all([
        getCellTimeSeries(parsedVector, ixv, izv, 'xw'),
        getCellTimeSeries(parsedVector, ixv, izv, 'yw'),
        getCellTimeSeries(parsedVector, ixv, izv, 'zw'),
        getCellTimeSeries(parsedVector, ixv, izv, 'xs'),
        getCellTimeSeries(parsedVector, ixv, izv, 'ys'),
        getCellTimeSeries(parsedVector, ixv, izv, 'zs'),
        getCellTimeSeries(parsedScalar, ix, iz, 'temperature', onProgress)
    ]);

    for (let ti = 0; ti < nt; ti++) {
        const tNow = parsedScalar.timePoints[ti];
        const tvIdx = (ntV === nt) ? ti : nearestIndex(parsedVector.timePoints, tNow);
        const xw = xwS[tvIdx], yw = ywS[tvIdx], zw = zwS[tvIdx];
        const xs = xsS[tvIdx], ys = ysS[tvIdx], zs = zsS[tvIdx];
        const wmag = mag3(xw, yw, zw);
        const smag = mag3(xs, ys, zs);

        let value;
        if (variable === 'water_flux_mag') value = wmag;
        else if (variable === 'steam_flux_mag') value = smag;
        else if (variable === 'total_flux_mag') value = wmag + smag;
        else if (variable === 'heat_flux_density') {
            const T = tempS[ti];
            const hW = getWaterEnthalpy(T) * 1000;
            const hS = getSteamEnthalpy(T) * 1000;
            const Fx = 10.0 * (xw * hW + xs * hS);
            const Fy = 10.0 * (yw * hW + ys * hS);
            const Fz = 10.0 * (zw * hW + zs * hS);
            value = Math.sqrt(Fx*Fx + Fy*Fy + Fz*Fz);
        } else {
            value = NaN;
        }
        out[ti] = { time: tNow, value };
    }
    return out;
}

async function plotTimeSeries() {
    if (!parsedScalar || timePoints.length === 0) {
        showErrorCard({
            title: 'No scalar file loaded',
            body: 'Load a Plot_scalar file first, then come back to plot a time series at a point.',
            kind: 'info'
        });
        return;
    }

    const selectedVariable = document.getElementById('timeSeriesVariable').value;
    const points = getPointsFromInputs();

    if (points.length === 0) {
        showErrorCard({
            title: 'No points selected',
            body: 'Type X and Z coordinates into one of the four point boxes, ' +
                'or click directly on the heatmap above to record a point.',
            kind: 'info'
        });
        return;
    }

    if (isDerivedVectorField(selectedVariable) && !parsedVector) {
        showErrorCard({
            title: 'Need a vector file for that field',
            body: `${getVariableLabel(selectedVariable)} is derived from mass-flux ` +
                'components. Load a Plot_vector file to compute it over time.',
            kind: 'info'
        });
        return;
    }

    plottedPoints = points;

    // Show progress for the (potentially long) initial gather. Subsequent
    // calls for the same cell are instant because gatherTimeSeries caches.
    showLoading(true);
    const allTraces = [];

    for (let pi = 0; pi < points.length; pi++) {
        const point = points[pi];
        const ix = nearestIndex(parsedScalar.xCoords, point.x);
        const iz = nearestIndex(parsedScalar.zCoords, point.z);
        if (ix < 0 || iz < 0) continue;

        const onProg = ({ ti, total }) => {
            _setLoadingMessage(
                `Computing time series — point ${pi + 1} / ${points.length}, ` +
                `step ${ti + 1} / ${total}`
            );
        };
        const series = (await gatherTimeSeries(selectedVariable, ix, iz, onProg))
            .filter(d => Number.isFinite(d.value));

        if (series.length === 0) continue;

        allTraces.push({
            x: series.map(d => d.time),
            y: series.map(d => d.value),
            type: 'scatter',
            mode: 'lines+markers',
            line: { color: point.color, width: 3 },
            marker: { size: 6, color: point.color },
            name: `Point ${point.id} (${point.x.toFixed(3)}, ${point.z.toFixed(3)})`
        });
    }

    if (allTraces.length === 0) {
        showLoading(false);
        showErrorCard({
            title: 'No data near the points you picked',
            body: 'The selected coordinates fall outside the model grid, or the ' +
                'value is undefined there at every timestep.',
            kind: 'warning',
            suggestions: [
                'Click directly on the heatmap to snap to the nearest valid cell.',
                `Valid X range: ${parsedScalar.xCoords[0]} – ${parsedScalar.xCoords[parsedScalar.xCoords.length - 1]} km.`,
                `Valid Z range: ${parsedScalar.zCoords[0]} – ${parsedScalar.zCoords[parsedScalar.zCoords.length - 1]} km.`
            ]
        });
        return;
    }

    showLoading(false);

    const layout = {
        title: {
            text: `${getVariableLabel(selectedVariable)} Time Series at Multiple Points`,
            font: { size: 16, color: currentTheme === 'dark' ? '#ffffff' : '#333333' }
        },
        xaxis: {
            title: 'Time (years)',
            gridcolor: currentTheme === 'dark' ? '#444' : 'lightgray',
            zeroline: false,
            color: currentTheme === 'dark' ? '#ffffff' : '#333333',
            tickfont: { color: currentTheme === 'dark' ? '#ffffff' : '#333333' }
        },
        yaxis: {
            title: getVariableLabel(selectedVariable),
            gridcolor: currentTheme === 'dark' ? '#444' : 'lightgray',
            zeroline: false,
            color: currentTheme === 'dark' ? '#ffffff' : '#333333',
            tickfont: { color: currentTheme === 'dark' ? '#ffffff' : '#333333' }
        },
        plot_bgcolor: currentTheme === 'dark' ? '#1a1a1a' : 'white',
        paper_bgcolor: currentTheme === 'dark' ? '#1a1a1a' : 'white',
        margin: { l: 60, r: 60, t: 80, b: 60 },
        height: 400,
        width: null,
        autosize: true,
        showlegend: true,
        legend: {
            x: 0.02,
            y: 0.98,
            bgcolor: currentTheme === 'dark' ? 'rgba(30,30,30,0.8)' : 'rgba(255,255,255,0.8)',
            bordercolor: currentTheme === 'dark' ? '#444' : 'lightgray',
            font: { color: currentTheme === 'dark' ? '#ffffff' : '#333333' }
        }
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d'],
        displaylogo: false,
        useResizeHandler: true
    };

    Plotly.newPlot('timeSeriesContainer', allTraces, layout, config);
    plotData();
}

function clearAllPoints() {
    for (let i = 1; i <= 4; i++) {
        document.getElementById(`xCoord${i}`).value = '';
        document.getElementById(`zCoord${i}`).value = '';
    }

    plottedPoints = [];
    nextPointSlot = 1;
    plotData();
}

function showTimeSeriesSection() {
    const timeSeriesSection = document.getElementById('timeSeriesSection');
    timeSeriesSection.style.display = 'block';

    if (parsedScalar && parsedScalar.xCoords.length > 0 && parsedScalar.zCoords.length > 0) {
        const xs = parsedScalar.xCoords;
        const zs = parsedScalar.zCoords;
        const samples = [
            { x: xs[Math.floor(xs.length * 0.25)], z: zs[Math.floor(zs.length * 0.25)] },
            { x: xs[Math.floor(xs.length * 0.50)], z: zs[Math.floor(zs.length * 0.50)] },
            { x: xs[Math.floor(xs.length * 0.75)], z: zs[Math.floor(zs.length * 0.50)] },
            { x: xs[Math.floor(xs.length * 0.50)], z: zs[Math.floor(zs.length * 0.75)] }
        ];
        for (let i = 0; i < samples.length; i++) {
            document.getElementById(`xCoord${i + 1}`).value = samples[i].x.toFixed(3);
            document.getElementById(`zCoord${i + 1}`).value = samples[i].z.toFixed(3);
        }
    }

    updatePlottedPointsFromInputs();
}

async function downloadTimeSeriesCSV() {
    if (!parsedScalar || timePoints.length === 0) {
        showErrorCard({
            title: 'No data loaded',
            body: 'Load a Plot_scalar file before downloading a CSV.',
            kind: 'info'
        });
        return;
    }

    const points = getPointsFromInputs();
    if (points.length === 0) {
        showErrorCard({
            title: 'No points selected',
            body: 'Pick at least one point (type coordinates or click the plot) before exporting.',
            kind: 'info'
        });
        return;
    }

    const selectedVariable = document.getElementById('timeSeriesVariable').value;

    if (isDerivedVectorField(selectedVariable) && !parsedVector) {
        showErrorCard({
            title: 'Need a vector file for that field',
            body: `${getVariableLabel(selectedVariable)} is derived from mass-flux components. ` +
                'Load a Plot_vector file before exporting.',
            kind: 'info'
        });
        return;
    }

    showLoading(true);
    const allSeries = [];
    for (let pi = 0; pi < points.length; pi++) {
        const p = points[pi];
        const ix = nearestIndex(parsedScalar.xCoords, p.x);
        const iz = nearestIndex(parsedScalar.zCoords, p.z);
        if (ix < 0 || iz < 0) { allSeries.push([]); continue; }
        const onProg = ({ ti, total }) => {
            _setLoadingMessage(
                `Building CSV — point ${pi + 1} / ${points.length}, ` +
                `step ${ti + 1} / ${total}`
            );
        };
        allSeries.push(await gatherTimeSeries(selectedVariable, ix, iz, onProg));
    }
    showLoading(false);

    let csv = 'time';
    for (let i = 0; i < points.length; i++) csv += `,point${i + 1}`;
    csv += '\n';

    const nt = parsedScalar.timePoints.length;
    for (let ti = 0; ti < nt; ti++) {
        csv += `${parsedScalar.timePoints[ti]}`;
        for (let i = 0; i < points.length; i++) {
            const s = allSeries[i][ti];
            csv += `,${(s && Number.isFinite(s.value)) ? s.value : ''}`;
        }
        csv += '\n';
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'time_series.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================================
// GIF export
// ============================================================
//
// Renders a real animated GIF in-browser using gif.js (already vendored in
// the repo as gif.js / gif.worker.js). gif.js is loaded on demand the first
// time the user clicks Export, so the page doesn't pay for it on every load.

let _gifLibPromise = null;

function ensureGifLibLoaded() {
    if (window.GIF) return Promise.resolve();
    if (_gifLibPromise) return _gifLibPromise;
    _gifLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'gif.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load gif.js'));
        document.head.appendChild(s);
    });
    return _gifLibPromise;
}

function _ensureGifProgressDiv(plotDiv) {
    let div = document.getElementById('gifExportProgress');
    if (!div) {
        div = document.createElement('div');
        div.id = 'gifExportProgress';
        div.style = 'color: #fff; background: #222; padding: 10px; border-radius: 8px; margin: 10px 0;';
        plotDiv.parentNode.insertBefore(div, plotDiv);
    }
    return div;
}

async function exportGifAnimation() {
    if (!parsedScalar || timePoints.length === 0) {
        showErrorCard({
            title: 'No data loaded',
            body: 'Load a Plot_scalar file first — the GIF export captures the heatmap frame by frame.',
            kind: 'info'
        });
        return;
    }

    const frameStep = Math.max(1, parseInt(document.getElementById('gifFrameStep').value, 10) || 1);
    const resString = document.getElementById('gifResolution').value || '900x600';
    const [width, height] = resString.split('x').map(Number);
    const plotDiv = document.getElementById('plotContainer');
    const nFrames = timePoints.length;
    const progress = _ensureGifProgressDiv(plotDiv);

    progress.textContent = 'Loading GIF encoder…';
    try {
        await ensureGifLibLoaded();
    } catch (e) {
        progress.textContent = 'Could not load gif.js. Make sure gif.js and gif.worker.js are served alongside index.html.';
        console.error(e);
        return;
    }

    const gif = new window.GIF({
        workers: 2,
        quality: 10,
        width,
        height,
        workerScript: 'gif.worker.js',
        repeat: 0,
        background: currentTheme === 'dark' ? '#1a1a1a' : '#ffffff'
    });

    gif.on('progress', p => {
        progress.textContent = `Encoding: ${(p * 100).toFixed(1)}%`;
    });

    let frameIndex = 0;
    const totalFrames = Math.ceil(nFrames / frameStep);

    for (let i = 0; i < nFrames; i += frameStep) {
        currentTimeIndex = i;
        await plotData();
        // Plotly renders synchronously to the DOM but its internal canvas
        // composition needs a tick before toImage gives a complete frame.
        await new Promise(r => requestAnimationFrame(() => r()));

        const pngUrl = await Plotly.toImage(plotDiv, { format: 'png', width, height });
        const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = pngUrl;
        });

        gif.addFrame(img, { delay: 50, copy: true });
        frameIndex++;
        progress.textContent = `Captured frame ${frameIndex} / ${totalFrames}`;
    }

    progress.textContent = 'Encoding GIF…';
    gif.on('finished', blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `hydrotherm_animation_${Date.now()}.gif`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        progress.textContent = `Done — ${(blob.size / 1024 / 1024).toFixed(2)} MB GIF downloaded.`;
        setTimeout(() => progress.remove(), 15000);
    });
    gif.render();
}

// ============================================================
// First-visit guided tour (Shepherd.js, loaded on demand)
// ============================================================
//
// Runs a 4-step walkthrough the first time someone opens the page. The
// "Take tour" button in the title bar replays it. Shepherd's CSS and JS
// are pulled from a CDN the first time they're needed; if loading fails
// the tour is silently skipped — the rest of the app still works.

const TOUR_LOCALSTORAGE_KEY = 'hydrotherm_viewer_tour_seen_v1';

let _shepherdLibPromise = null;
function ensureShepherdLoaded() {
    if (window.Shepherd) return Promise.resolve();
    if (_shepherdLibPromise) return _shepherdLibPromise;
    _shepherdLibPromise = new Promise((resolve, reject) => {
        // CSS
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://cdn.jsdelivr.net/npm/shepherd.js@11.2.0/dist/css/shepherd.css';
        document.head.appendChild(css);
        // JS
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/shepherd.js@11.2.0/dist/js/shepherd.min.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load Shepherd.js'));
        document.head.appendChild(s);
    });
    return _shepherdLibPromise;
}

async function startTour() {
    try {
        await ensureShepherdLoaded();
    } catch (e) {
        console.warn('Tour unavailable:', e);
        return;
    }
    if (!window.Shepherd) return;
    const tour = new window.Shepherd.Tour({
        useModalOverlay: true,
        defaultStepOptions: {
            cancelIcon: { enabled: true },
            scrollTo: { behavior: 'smooth', block: 'center' },
            classes: 'shepherd-theme-arrows'
        }
    });

    const btn = (text, action, classes) => ({ text, action, classes });
    const navButtons = (last) => [
        btn('Skip', () => tour.cancel(), 'shepherd-button-secondary'),
        last
            ? btn('Got it', () => tour.complete(), 'shepherd-button-primary')
            : btn('Next', () => tour.next(), 'shepherd-button-primary')
    ];

    tour.addStep({
        id: 'welcome',
        title: 'Welcome to the HYDROTHERM Postprocessor',
        text:
            'This tool lets you visualize HYDROTHERM simulation outputs entirely in your browser — no install, no coding. ' +
            'I’ll walk you through the four things you need to know.',
        buttons: navButtons(false)
    });
    tour.addStep({
        id: 'upload',
        attachTo: { element: '#fileInput', on: 'bottom' },
        title: 'Step 1 — Upload a scalar file',
        text:
            'Pick a Plot_scalar.* output file from your simulation. This is what HYDROTHERM writes to disk every PRINT 6 timestep.',
        buttons: navButtons(false)
    });
    tour.addStep({
        id: 'pick-field',
        attachTo: { element: '#variableSelect', on: 'bottom' },
        title: 'Step 2 — Pick what to plot',
        text:
            'Choose a field (temperature, pressure, saturation, …). The note underneath explains what each one means. ' +
            'Vector-derived fields like heat flux need a Plot_vector file too — that lives in the "Vector overlay" expander.',
        buttons: navButtons(false)
    });
    tour.addStep({
        id: 'load',
        attachTo: { element: 'button[onclick="loadAndProcessFile()"]', on: 'bottom' },
        title: 'Step 3 — Render',
        text:
            'Click Load &amp; Plot. The first read takes a few seconds (longer for big files); after that, ' +
            'sliding through time and switching fields is instant. Click any cell on the heatmap to drop a time-series point.',
        buttons: navButtons(true)
    });

    tour.on('complete', () => {
        try { localStorage.setItem(TOUR_LOCALSTORAGE_KEY, '1'); } catch (e) {}
    });
    tour.on('cancel', () => {
        try { localStorage.setItem(TOUR_LOCALSTORAGE_KEY, '1'); } catch (e) {}
    });

    tour.start();
}

function maybeAutoStartTour() {
    let seen = false;
    try { seen = !!localStorage.getItem(TOUR_LOCALSTORAGE_KEY); } catch (e) {}
    if (!seen) {
        // Defer briefly so layout settles before the tour points at things.
        setTimeout(startTour, 600);
    }
}

// ============================================================
// Events
// ============================================================

document.addEventListener('DOMContentLoaded', function () {
    const variableSelect = document.getElementById('variableSelect');
    const colormapSelect = document.getElementById('colormapSelect');
    const themeSelect = document.getElementById('themeSelect');
    const downloadTimeSeriesBtn = document.getElementById('downloadTimeSeriesBtn');

    variableSelect.addEventListener('change', function () {
        updateVariableHelp();
        if (parsedScalar) {
            customColorbarRange = null;
            customXRange = null;
            customZRange = null;
            $("#slider-range").slider("values", [0, 100]);
            $("#x-slider-range").slider("values", [0, 100]);
            $("#z-slider-range").slider("values", [0, 100]);
            plotData();
        }
    });

    const tsVarSelect = document.getElementById('timeSeriesVariable');
    if (tsVarSelect) tsVarSelect.addEventListener('change', updateTimeSeriesVariableHelp);

    const yThicknessInput = document.getElementById('yThicknessKm');
    if (yThicknessInput) {
        yThicknessInput.addEventListener('change', () => {
            if (parsedScalar && variableSelect.value === 'heat_per_cell') plotData();
        });
    }

    // Set initial help text based on whatever option is selected by default.
    updateVariableHelp();
    updateTimeSeriesVariableHelp();

    colormapSelect.addEventListener('change', function () {
        if (parsedScalar) plotData();
    });

    themeSelect.addEventListener('change', function () {
        currentTheme = this.value;
        applyTheme(currentTheme);
        if (parsedScalar) {
            plotData();
            if (document.getElementById('timeSeriesSection').style.display !== 'none') {
                plotTimeSeries();
            }
        }
    });

    if (downloadTimeSeriesBtn) {
        downloadTimeSeriesBtn.addEventListener('click', function () {
            downloadTimeSeriesCSV();
        });
    }

    applyTheme('dark');

    const arrowColorSelect = document.getElementById('arrowColorSelect');
    if (arrowColorSelect) {
        arrowColor = arrowColorSelect.value = '#ffffff';
    }

    const tourBtn = document.getElementById('takeTourBtn');
    if (tourBtn) tourBtn.addEventListener('click', startTour);
    maybeAutoStartTour();
});

document.addEventListener('keydown', function (e) {
    if (!parsedScalar) return;

    const timeRange = document.getElementById('timeRange');
    const currentValue = parseInt(timeRange.value, 10);

    if (e.key === 'ArrowLeft' && currentValue > 0) {
        timeRange.value = currentValue - 1;
        timeRange.dispatchEvent(new Event('input'));
    } else if (e.key === 'ArrowRight' && currentValue < timePoints.length - 1) {
        timeRange.value = currentValue + 1;
        timeRange.dispatchEvent(new Event('input'));
    }
});

window.addEventListener('resize', function () {
    if (parsedScalar && timePoints.length > 0) {
        clearTimeout(window.resizeTimeout);
        window.resizeTimeout = setTimeout(() => {
            plotData();
        }, 250);
    }
});
