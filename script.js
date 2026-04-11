// --- GLOBALS ---
let fileText = null;
let timeIndex = {};
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

        return (heatFluxDensityWm2 * cellAreaM2) / 1.0e6; // MW;
    }

    return NaN;
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

    if (!file.name.startsWith('Plot_scalar.')) {
        alert('Invalid file name. Please select a file that begins with "Plot_scalar."');
        return;
    }

    showLoading(true);

    try {
        fileText = await readFileAsText(file);

        const formatValidation = validateFileFormat(fileText);
        if (!formatValidation.isValid) {
            throw new Error(`Invalid file format: ${formatValidation.error}`);
        }

        await buildTimeIndex(fileText);

        if (timePoints.length > 0) {
            setupTimeSlider();
            await plotData();
            showTimeSeriesSection();
            showLoading(false);
        } else {
            throw new Error('No valid data found in file. Please ensure the file contains HYDROTHERM data with the expected format.');
        }
    } catch (error) {
        console.error('Error processing file:', error);
        alert('Error processing file: ' + error.message);
        showLoading(false);
    }
}

function validateFileFormat(text) {
    const lines = text.split('\n');
    let dataLines = 0;
    let validDataLines = 0;
    let hasHeader = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('x') || trimmed.includes('(km)') ||
            trimmed.includes('(yr)') || trimmed.includes('(Deg.C)') ||
            trimmed.includes('(bar)') || trimmed.includes('(-)')) {
            hasHeader = true;
            break;
        }
    }

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('(km)') ||
            trimmed.includes('(yr)') || trimmed.includes('(Deg.C)') ||
            trimmed.includes('(bar)') || trimmed.includes('(-)') || trimmed.includes('No.')) {
            continue;
        }

        dataLines++;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 8) {
            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            const z = parseFloat(parts[2]);
            const time = parseFloat(parts[3]);
            const temp = parseFloat(parts[4]);
            const pressure = parseFloat(parts[5]);
            const saturation = parseFloat(parts[6]);
            const phase = parseFloat(parts[7]);

            if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(time) &&
                !isNaN(temp) && !isNaN(pressure) && !isNaN(saturation) && !isNaN(phase)) {
                validDataLines++;
            }
        }
    }

    if (!hasHeader) {
        return { isValid: false, error: 'File does not contain HYDROTHERM header information' };
    }

    if (dataLines === 0) {
        return { isValid: false, error: 'File does not contain any data lines' };
    }

    if (validDataLines === 0) {
        return { isValid: false, error: 'File contains data lines but none match the expected HYDROTHERM scalar format' };
    }

    const validPercentage = (validDataLines / dataLines) * 100;
    if (validPercentage < 50) {
        return {
            isValid: false,
            error: `File format appears incorrect. Only ${validPercentage.toFixed(1)}% of data lines match the expected HYDROTHERM format`
        };
    }

    return {
        isValid: true,
        error: null,
        stats: { totalLines: lines.length, dataLines, validDataLines, validPercentage }
    };
}

async function buildTimeIndex(text) {
    timeIndex = {};
