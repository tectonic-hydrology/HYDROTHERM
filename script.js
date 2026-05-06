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
    'heat_flux_proxy',
    'heat_flux_total'
];

const POINT_COLORS = ['#20bf6b', '#0fb9b1', '#26de81', '#45aaf2'];

// ============================================================
// Thermodynamic lookup tables for pure water / steam
// Cp in J kg^-1 K^-1 as a function of temperature (°C)
// ============================================================

const WATER_CP_TABLE = [
    { T: 0, cp: 4217 },
    { T: 25, cp: 4181 },
    { T: 50, cp: 4180 },
    { T: 100, cp: 4216 },
    { T: 150, cp: 4300 },
    { T: 200, cp: 4450 },
    { T: 250, cp: 4700 },
    { T: 300, cp: 5100 },
    { T: 350, cp: 6000 }
];

const STEAM_CP_TABLE = [
    { T: 100, cp: 2080 },
    { T: 150, cp: 2010 },
    { T: 200, cp: 1990 },
    { T: 250, cp: 2010 },
    { T: 300, cp: 2050 },
    { T: 350, cp: 2120 },
    { T: 400, cp: 2210 },
    { T: 500, cp: 2470 },
    { T: 600, cp: 2740 }
];

function interpolateCp(T, table) {
    if (T <= table[0].T) return table[0].cp;
    if (T >= table[table.length - 1].T) return table[table.length - 1].cp;

    for (let i = 0; i < table.length - 1; i++) {
        const a = table[i];
        const b = table[i + 1];
        if (T >= a.T && T <= b.T) {
            const f = (T - a.T) / (b.T - a.T);
            return a.cp + f * (b.cp - a.cp);
        }
    }
    return table[table.length - 1].cp;
}

function getWaterCp(tempC) {
    return interpolateCp(tempC, WATER_CP_TABLE);
}

function getSteamCp(tempC) {
    return interpolateCp(tempC, STEAM_CP_TABLE);
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

// FIXME (heat-flux formula): this computes ρv·Cp·T using ABSOLUTE Kelvin
// temperature, which is not physically heat flux density. Heat flux density
// requires either Cp·ΔT against a reference, or a specific-enthalpy lookup
// h(T,p). Values produced here are large because they scale with T_K rather
// than ΔT. Kept as-is to preserve existing UI behavior; flagged for a domain
// review before publishing the "heat transport proxy" output as physical.
function computeHeatFluxDensityWm2(waterMag, steamMag, tempC) {
    const waterFluxSI = waterMag * 10.0; // g/s/cm^2 -> kg/s/m^2
    const steamFluxSI = steamMag * 10.0;

    const cpWater = getWaterCp(tempC);
    const cpSteam = getSteamCp(tempC);
    const tempK = tempC + 273.15;

    return (waterFluxSI * cpWater * tempK) + (steamFluxSI * cpSteam * tempK);
}

function deriveVectorField(vectorRows, fieldName, tempLookup = null) {
    const cellAreaM2 = computeTypicalCellAreaM2FromVectorRows(vectorRows);

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
        } else if (fieldName === 'heat_flux_proxy' || fieldName === 'heat_flux_total') {
            const key = `${row.x}|${row.z}`;
            const tempC = tempLookup ? tempLookup.get(key) : undefined;

            if (tempC !== undefined && !isNaN(tempC)) {
                const heatFluxDensityWm2 = computeHeatFluxDensityWm2(waterMag, steamMag, tempC);

                if (fieldName === 'heat_flux_proxy') {
                    value = heatFluxDensityWm2 * 1000.0; // mW/m^2
                } else {
                    value = (heatFluxDensityWm2 * cellAreaM2) / 1.0e6; // MW
                }
            }
        }

        return {
            x: row.x,
            y: row.z,
            z: value
        };
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

function computeDerivedValueAtPoint(fieldName, vectorPoint, scalarPoint, cellAreaM2 = 1.0) {
    if (!vectorPoint) return NaN;

    const waterMag = mag3(vectorPoint.xw, vectorPoint.yw, vectorPoint.zw);
    const steamMag = mag3(vectorPoint.xs, vectorPoint.ys, vectorPoint.zs);
    const totalMag = waterMag + steamMag;

    if (fieldName === 'water_flux_mag') return waterMag;
    if (fieldName === 'steam_flux_mag') return steamMag;
    if (fieldName === 'total_flux_mag') return totalMag;

    if (fieldName === 'heat_flux_proxy' || fieldName === 'heat_flux_total') {
        if (!scalarPoint) return NaN;

        const tempC = scalarPoint.temperature;
        const heatFluxDensityWm2 = computeHeatFluxDensityWm2(waterMag, steamMag, tempC);

        if (fieldName === 'heat_flux_proxy') {
            return heatFluxDensityWm2 * 1000.0; // mW/m^2
        }

        return (heatFluxDensityWm2 * cellAreaM2) / 1.0e6; // MW
    }

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

// Materialize one timestep as the array-of-objects shape the rest of the
// app expects. ~nx*nz objects per call — fine for a per-render path
// (heatmap, click handler) but should NOT be called in a per-cell or
// per-timestep loop. Use direct typed-array reads in those cases.
function materializeScalarStep(p, ti) {
    if (!p || ti < 0 || ti >= p.timePoints.length) return [];
    const out = new Array(p.cellsPerStep);
    const time = p.timePoints[ti];
    let k = 0;
    for (let iz = 0; iz < p.nz; iz++) {
        for (let ix = 0; ix < p.nx; ix++) {
            const off = ti * p.cellsPerStep + iz * p.nx + ix;
            out[k++] = {
                x: p.xCoords[ix],
                y: 0,
                z: p.zCoords[iz],
                time,
                temperature: p.gridded.temperature[off],
                pressure: p.gridded.pressure[off],
                saturation: p.gridded.saturation[off],
                phase: p.gridded.phase[off],
                nusselt: p.gridded.nusselt[off]
            };
        }
    }
    return out;
}

function materializeVectorStep(p, ti) {
    if (!p || ti < 0 || ti >= p.timePoints.length) return [];
    const out = new Array(p.cellsPerStep);
    const time = p.timePoints[ti];
    let k = 0;
    for (let iz = 0; iz < p.nz; iz++) {
        for (let ix = 0; ix < p.nx; ix++) {
            const off = ti * p.cellsPerStep + iz * p.nx + ix;
            out[k++] = {
                x: p.xCoords[ix],
                y: 0,
                z: p.zCoords[iz],
                time,
                xw: p.gridded.xw[off],
                yw: p.gridded.yw[off],
                zw: p.gridded.zw[off],
                xs: p.gridded.xs[off],
                ys: p.gridded.ys[off],
                zs: p.gridded.zs[off]
            };
        }
    }
    return out;
}

// ============================================================
// File loading and validation
// ============================================================

async function loadAndProcessFile() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    if (!file) {
        alert('Please select a file first.');
        return;
    }

    if (!/plot[_ ]?scalar/i.test(file.name)) {
        console.warn('Filename does not match expected Plot_scalar pattern:', file.name);
    }

    showLoading(true);

    try {
        const rawText = await readFileAsText(file);

        console.log('file name:', file.name);
        console.log('fileText length:', rawText.length);
        console.log('fileText first 200 chars:', JSON.stringify(rawText.slice(0, 200)));

        const formatValidation = validateFileFormat(rawText);
        if (!formatValidation.isValid) {
            throw new Error(`Invalid file format: ${formatValidation.error}`);
        }

        const t0 = performance.now();
        parsedScalar = buildStructuredScalar(rawText);
        console.log(
            `parsed scalar in ${(performance.now() - t0).toFixed(0)} ms: ` +
            `nt=${parsedScalar.timePoints.length}, nx=${parsedScalar.nx}, nz=${parsedScalar.nz}`
        );

        // Free the raw text now that we have the structured arrays.
        // Keep `fileText` non-null as a "loaded" sentinel for legacy checks.
        fileText = '__loaded__';
        timePoints = parsedScalar.timePoints;
        currentTimeIndex = 0;

        if (timePoints.length > 0) {
            setupTimeSlider();
            await plotData();
            showTimeSeriesSection();
            showLoading(false);
        } else {
            throw new Error('No valid time-indexed data found in file.');
        }
    } catch (error) {
        console.error('Error processing file:', error);
        alert('Error processing file: ' + error.message);
        showLoading(false);
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
function parseTimeStepData(_unused, time) {
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
        alert('Please select a vector file first.');
        return;
    }

    if (!/plot[_ ]?vector/i.test(file.name)) {
        console.warn('Filename does not match expected Plot_vector pattern:', file.name);
    }

    try {
        const rawText = await readFileAsText(file);

        console.log('vector file name:', file.name);
        console.log('vector fileText length:', rawText.length);

        const formatValidation = validateVectorFileFormat(rawText);
        if (!formatValidation.isValid) {
            throw new Error(`Invalid vector file format: ${formatValidation.error}`);
        }

        const t0 = performance.now();
        parsedVector = buildStructuredVector(rawText);
        console.log(
            `parsed vector in ${(performance.now() - t0).toFixed(0)} ms: ` +
            `nt=${parsedVector.timePoints.length}, nx=${parsedVector.nx}, nz=${parsedVector.nz}`
        );

        vectorFileText = '__loaded__';
        vectorTimePoints = parsedVector.timePoints;

        const currentTime = timePoints[currentTimeIndex];
        const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
        const bestTi = bestVectorTime !== null
            ? vectorTimePoints.indexOf(bestVectorTime) : -1;
        vectorData = bestTi >= 0 ? materializeVectorStep(parsedVector, bestTi) : [];

        vectorType = vectorTypeSelect.value;
        arrowScale = parseFloat(arrowScaleSlider.value);

        plotData();
    } catch (error) {
        console.error('Error processing vector file:', error);
        alert('Error processing vector file: ' + error.message);
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
function parseVectorTimeStepData(_unused, time) {
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
    colorbarControls.style.display = 'block';
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
    axisControls.style.display = 'block';
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
            vectorData = bestTi >= 0 ? materializeVectorStep(parsedVector, bestTi) : [];
            plotData();
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

// Build the heatmap z-matrix directly from the gridded typed array — O(N).
function buildScalarMeshFast(p, variable, ti) {
    const arr = p.gridded[variable];
    if (!arr) return { x: [], y: [], z: [] };
    const { nx, nz, xCoords, zCoords, cellsPerStep } = p;
    const z = new Array(nz);
    for (let iz = 0; iz < nz; iz++) {
        const row = new Array(nx);
        const base = ti * cellsPerStep + iz * nx;
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
        vectorData = bestTi >= 0 ? materializeVectorStep(parsedVector, bestTi) : [];
    }

    let meshData;
    if (isDerivedVectorField(selectedVariable)) {
        if (!vectorData || vectorData.length === 0) {
            alert('Please load a vector file to plot vector-derived quantities.');
            return;
        }
        const timeData = materializeScalarStep(parsedScalar, currentTimeIndex);
        const tempLookup = buildTemperatureLookup(timeData);
        const derivedRows = deriveVectorField(vectorData, selectedVariable, tempLookup);
        meshData = createMeshGridFromXYZ(derivedRows);
    } else {
        meshData = buildScalarMeshFast(parsedScalar, selectedVariable, currentTimeIndex);
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
        heat_flux_proxy: 'Heat flux density (mW/m²)',
        heat_flux_total: 'Total heat transport (MW)'
    };
    return labels[variable] || variable;
}

function formatValue(value, variable) {
    if (variable === 'pressure') {
        return `${value.toFixed(2)} bar`;
    } else if (variable === 'temperature') {
        return `${value.toFixed(1)} °C`;
    } else if (variable === 'heat_flux_proxy') {
        return `${value.toExponential(3)} mW/m²`;
    } else if (variable === 'heat_flux_total') {
        return `${value.toExponential(3)} MW`;
    } else {
        return value.toFixed(3);
    }
}

function getRange(values) {
    return arrayMinMaxFinite(values);
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

// Walk the gridded typed arrays directly — no per-step text parsing, no
// per-step object allocation. For each requested point we resolve (ix, iz)
// once via binary search and then read nt values out of the variable buffer.
function gatherTimeSeries(variable, ix, iz) {
    if (!parsedScalar) return [];
    const isDerived = isDerivedVectorField(variable);
    const nt = parsedScalar.timePoints.length;
    const cps = parsedScalar.cellsPerStep;
    const nx = parsedScalar.nx;
    const out = new Array(nt);

    if (!isDerived) {
        const buf = parsedScalar.gridded[variable];
        for (let ti = 0; ti < nt; ti++) {
            const v = buf[ti * cps + iz * nx + ix];
            out[ti] = { time: parsedScalar.timePoints[ti], value: v };
        }
        return out;
    }

    if (!parsedVector) return [];
    // Map the scalar (ix, iz) onto the vector grid by nearest cell — typically
    // they share a grid, but cold125-style files can differ slightly.
    const xv = parsedScalar.xCoords[ix];
    const zv = parsedScalar.zCoords[iz];
    const ixv = nearestIndex(parsedVector.xCoords, xv);
    const izv = nearestIndex(parsedVector.zCoords, zv);
    const cpsV = parsedVector.cellsPerStep;
    const nxV = parsedVector.nx;
    const ntV = parsedVector.timePoints.length;

    const xw = parsedVector.gridded.xw;
    const yw = parsedVector.gridded.yw;
    const zw = parsedVector.gridded.zw;
    const xs = parsedVector.gridded.xs;
    const ys = parsedVector.gridded.ys;
    const zs = parsedVector.gridded.zs;

    let cellAreaM2 = 1.0;
    if (variable === 'heat_flux_total') {
        const xCoordsV = parsedVector.xCoords;
        const zCoordsV = parsedVector.zCoords;
        if (xCoordsV.length > 1 && zCoordsV.length > 1) {
            const dx = Math.abs(xCoordsV[1] - xCoordsV[0]) * 1000.0;
            const dz = Math.abs(zCoordsV[1] - zCoordsV[0]) * 1000.0;
            cellAreaM2 = dx * dz;
        }
    }

    const tempBuf = parsedScalar.gridded.temperature;

    for (let ti = 0; ti < nt; ti++) {
        const tNow = parsedScalar.timePoints[ti];
        const tvIdx = (ntV === nt) ? ti : nearestIndex(parsedVector.timePoints, tNow);
        const off = tvIdx * cpsV + izv * nxV + ixv;
        const wmag = mag3(xw[off], yw[off], zw[off]);
        const smag = mag3(xs[off], ys[off], zs[off]);

        let value;
        if (variable === 'water_flux_mag') value = wmag;
        else if (variable === 'steam_flux_mag') value = smag;
        else if (variable === 'total_flux_mag') value = wmag + smag;
        else {
            const tempC = tempBuf[ti * cps + iz * nx + ix];
            const q = computeHeatFluxDensityWm2(wmag, smag, tempC);
            value = (variable === 'heat_flux_proxy')
                ? q * 1000.0
                : (q * cellAreaM2) / 1.0e6;
        }
        out[ti] = { time: tNow, value };
    }
    return out;
}

function plotTimeSeries() {
    if (!parsedScalar || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }

    const selectedVariable = document.getElementById('timeSeriesVariable').value;
    const points = getPointsFromInputs();

    if (points.length === 0) {
        alert('Please enter valid coordinates for at least one point.');
        return;
    }

    if (isDerivedVectorField(selectedVariable) && !parsedVector) {
        alert('Please load a vector file first for vector-derived time series.');
        return;
    }

    plottedPoints = points;

    const allTraces = [];

    for (const point of points) {
        const ix = nearestIndex(parsedScalar.xCoords, point.x);
        const iz = nearestIndex(parsedScalar.zCoords, point.z);
        if (ix < 0 || iz < 0) continue;

        const series = gatherTimeSeries(selectedVariable, ix, iz)
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
        alert('No data found near the specified coordinates. Try different coordinates.');
        return;
    }

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

function downloadTimeSeriesCSV() {
    if (!parsedScalar || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }

    const points = getPointsFromInputs();
    if (points.length === 0) {
        alert('Please enter valid coordinates for at least one point.');
        return;
    }

    const selectedVariable = document.getElementById('timeSeriesVariable').value;

    if (isDerivedVectorField(selectedVariable) && !parsedVector) {
        alert('Please load a vector file first for vector-derived time series.');
        return;
    }

    const allSeries = points.map(p => {
        const ix = nearestIndex(parsedScalar.xCoords, p.x);
        const iz = nearestIndex(parsedScalar.zCoords, p.z);
        return (ix < 0 || iz < 0) ? [] : gatherTimeSeries(selectedVariable, ix, iz);
    });

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
        alert('Please load a data file first.');
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
// Events
// ============================================================

document.addEventListener('DOMContentLoaded', function () {
    const variableSelect = document.getElementById('variableSelect');
    const colormapSelect = document.getElementById('colormapSelect');
    const themeSelect = document.getElementById('themeSelect');
    const downloadTimeSeriesBtn = document.getElementById('downloadTimeSeriesBtn');

    variableSelect.addEventListener('change', function () {
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
