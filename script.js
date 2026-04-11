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
    timePoints = [];
    let currentTime = null;
    let startLine = 0;
    let lineNum = 0;
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('(km)') ||
            trimmed.includes('(yr)') || trimmed.includes('(Deg.C)') ||
            trimmed.includes('(bar)') || trimmed.includes('(-)') || trimmed.includes('No.')) {
            lineNum++;
            continue;
        }

        const parts = trimmed.split(/\s+/);
        if (parts.length >= 8) {
            const time = parseFloat(parts[3]);
            if (!isNaN(time)) {
                if (currentTime === null) {
                    currentTime = time;
                    startLine = lineNum;
                } else if (time !== currentTime) {
                    timeIndex[currentTime] = [startLine, lineNum - 1];
                    timePoints.push(currentTime);
                    currentTime = time;
                    startLine = lineNum;
                }
            }
        }
        lineNum++;
    }

    if (currentTime !== null) {
        timeIndex[currentTime] = [startLine, lineNum - 1];
        timePoints.push(currentTime);
    }

    timePoints = Array.from(new Set(timePoints)).sort((a, b) => a - b);
}

function parseTimeStepData(text, time) {
    const range = timeIndex[time];
    if (!range) return [];

    const [start, end] = range;
    const lines = text.split('\n').slice(start, end + 1);
    const data = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length >= 8) {
            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            const z = parseFloat(parts[2]);
            const timeVal = parseFloat(parts[3]);
            const temperature = parseFloat(parts[4]);
            const pressure = parseFloat(parts[5]);
            const saturation = parseFloat(parts[6]);
            const phase = parseFloat(parts[7]);

            if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(timeVal) &&
                !isNaN(temperature) && !isNaN(pressure) &&
                !isNaN(saturation) && !isNaN(phase)) {
                data.push({ x, y, z, time: timeVal, temperature, pressure, saturation, phase });
            }
        }
    }

    return data;
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

    if (!file.name.startsWith('Plot_vector.')) {
        alert('Invalid file name. Please select a file that begins with "Plot_vector."');
        return;
    }

    try {
        vectorFileText = await readFileAsText(file);

        const formatValidation = validateVectorFileFormat(vectorFileText);
        if (!formatValidation.isValid) {
            throw new Error(`Invalid vector file format: ${formatValidation.error}`);
        }

        await buildVectorTimeIndex(vectorFileText);

        const currentTime = timePoints[currentTimeIndex];
        const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
        vectorData = bestVectorTime !== null ? parseVectorTimeStepData(vectorFileText, bestVectorTime) : [];

        vectorType = vectorTypeSelect.value;
        arrowScale = parseFloat(arrowScaleSlider.value);

        plotData();
    } catch (error) {
        console.error('Error processing vector file:', error);
        alert('Error processing vector file: ' + error.message);
    }
}

function validateVectorFileFormat(text) {
    const lines = text.split('\n');
    let dataLines = 0;
    let validDataLines = 0;
    let hasHeader = false;

    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        if (trimmed.includes('(km)') || trimmed.includes('(yr)') ||
            trimmed.includes('mass flux') || trimmed.includes('(g/s-cm^2)') ||
            trimmed.includes('x steam') || trimmed.includes('x water')) {
            hasHeader = true;
            break;
        }
    }

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('(km)') ||
            trimmed.includes('(yr)') || trimmed.includes('(g/s-cm^2)') ||
            trimmed.includes('No.')) {
            continue;
        }

        dataLines++;
        const parts = trimmed.split(/\s+/);

        if (parts.length >= 10) {
            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            const z = parseFloat(parts[2]);
            const time = parseFloat(parts[3]);

            const xw = parseFloat(parts[4]);
            const yw = parseFloat(parts[5]);
            const zw = parseFloat(parts[6]);
            const xs = parseFloat(parts[7]);
            const ys = parseFloat(parts[8]);
            const zs = parseFloat(parts[9]);

            if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(time) &&
                !isNaN(xw) && !isNaN(yw) && !isNaN(zw) &&
                !isNaN(xs) && !isNaN(ys) && !isNaN(zs)) {
                validDataLines++;
            }
        }
    }

    if (!hasHeader) {
        return { isValid: false, error: 'File does not contain vector header information' };
    }

    if (dataLines === 0) {
        return { isValid: false, error: 'File does not contain any data lines' };
    }

    if (validDataLines === 0) {
        return { isValid: false, error: 'File contains data lines but none match the expected vector format' };
    }

    const validPercentage = (validDataLines / dataLines) * 100;
    if (validPercentage < 50) {
        return {
            isValid: false,
            error: `File format appears incorrect. Only ${validPercentage.toFixed(1)}% of data lines match the expected vector format`
        };
    }

    return {
        isValid: true,
        error: null,
        stats: { totalLines: lines.length, dataLines, validDataLines, validPercentage }
    };
}

async function buildVectorTimeIndex(text) {
    vectorTimeIndex = {};
    vectorTimePoints = [];
    let currentTime = null;
    let startLine = 0;
    let lineNum = 0;
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('(km)') ||
            trimmed.includes('(yr)') || trimmed.includes('(g/s-cm^2)') ||
            trimmed.includes('No.')) {
            lineNum++;
            continue;
        }

        const parts = trimmed.split(/\s+/);
        if (parts.length >= 10) {
            const time = parseFloat(parts[3]);
            if (!isNaN(time)) {
                if (currentTime === null) {
                    currentTime = time;
                    startLine = lineNum;
                } else if (time !== currentTime) {
                    vectorTimeIndex[currentTime] = [startLine, lineNum - 1];
                    vectorTimePoints.push(currentTime);
                    currentTime = time;
                    startLine = lineNum;
                }
            }
        }
        lineNum++;
    }

    if (currentTime !== null) {
        vectorTimeIndex[currentTime] = [startLine, lineNum - 1];
        vectorTimePoints.push(currentTime);
    }

    vectorTimePoints = Array.from(new Set(vectorTimePoints)).sort((a, b) => a - b);
}

function parseVectorTimeStepData(text, time) {
    if (!vectorTimeIndex[time]) return [];

    const [start, end] = vectorTimeIndex[time];
    const lines = text.split('\n').slice(start, end + 1);
    const data = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 10) continue;

        const x = parseFloat(parts[0]);
        const y = parseFloat(parts[1]);
        const z = parseFloat(parts[2]);
        const timeVal = parseFloat(parts[3]);
        const xw = parseFloat(parts[4]);
        const yw = parseFloat(parts[5]);
        const zw = parseFloat(parts[6]);
        const xs = parseFloat(parts[7]);
        const ys = parseFloat(parts[8]);
        const zs = parseFloat(parts[9]);

        if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(timeVal) &&
            !isNaN(xw) && !isNaN(yw) && !isNaN(zw) &&
            !isNaN(xs) && !isNaN(ys) && !isNaN(zs)) {
            data.push({ x, y, z, time: timeVal, xw, yw, zw, xs, ys, zs });
        }
    }

    return data;
}

function clearVectors() {
    vectorData = null;
    vectorFileText = null;
    vectorTimeIndex = {};
    vectorTimePoints = [];
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
        currentTimeIndex = parseInt(this.value);
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
        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            plotData();
        }
    };

    updateArrowScaleDisplay(arrowScaleDisplay);

    vectorTypeSelect.addEventListener('change', function () {
        vectorType = this.value;
        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            plotData();
        }
    });

    arrowColorSelect.addEventListener('change', function () {
        arrowColor = this.value;
        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            plotData();
        }
    });
}

function updateTimeDisplay() {
    const timeDisplay = document.getElementById('timeDisplay');
    if (timePoints.length > 0) {
        timeDisplay.textContent = `Time: ${timePoints[currentTimeIndex].toExponential(3)} years (${currentTimeIndex + 1}/${timePoints.length})`;
    }
}

function updateRangeDisplay() {
    const rangeDisplay = document.getElementById('rangeDisplay');
    if (customColorbarRange) {
        rangeDisplay.textContent = `Color range: ${customColorbarRange.min.toFixed(3)} to ${customColorbarRange.max.toFixed(3)}`;
    } else {
        rangeDisplay.textContent = `Color range: ${currentDataRange.min.toFixed(3)} to ${currentDataRange.max.toFixed(3)}`;
    }
}

function updateXRangeDisplay() {
    const xRangeDisplay = document.getElementById('xRangeDisplay');
    if (customXRange) {
        xRangeDisplay.textContent = `X range: ${customXRange.min.toFixed(3)} to ${customXRange.max.toFixed(3)} km`;
    } else {
        xRangeDisplay.textContent = `X range: ${currentXRange.min.toFixed(3)} to ${currentXRange.max.toFixed(3)} km`;
    }
}

function updateZRangeDisplay() {
    const zRangeDisplay = document.getElementById('zRangeDisplay');
    if (customZRange) {
        zRangeDisplay.textContent = `Z range: ${customZRange.min.toFixed(3)} to ${customZRange.max.toFixed(3)} km`;
    } else {
        zRangeDisplay.textContent = `Z range: ${currentZRange.min.toFixed(3)} to ${currentZRange.max.toFixed(3)} km`;
    }
}

function updateArrowScaleDisplay(displayElement) {
    if (displayElement) {
        displayElement.textContent = `Arrow Scale: 10^${arrowScale.toFixed(1)}`;
    }
}

function showTimeSeriesSection() {
    const section = document.getElementById('timeSeriesSection');
    if (section) section.style.display = 'block';
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    const plotDiv = document.getElementById('plotDiv');

    if (loading) loading.style.display = show ? 'block' : 'none';
    if (plotDiv) plotDiv.style.display = show ? 'none' : 'block';
}

// ============================================================
// Plotting
// ============================================================

async function plotData() {
    if (!fileText || timePoints.length === 0) return;

    const variableSelect = document.getElementById('variableSelect');
    const colormapSelect = document.getElementById('colormapSelect');
    const variable = variableSelect.value;
    const colorscale = colormapSelect.value;
    const currentTime = timePoints[currentTimeIndex];

    const timeData = parseTimeStepData(fileText, currentTime);
    if (timeData.length === 0) return;

    let plotRows = [];
    let zTitle = '';

    if (isDerivedVectorField(variable)) {
        if (!vectorFileText || Object.keys(vectorTimeIndex).length === 0) {
            alert('This field requires a Plot_vector file. Please load a vector file.');
            return;
        }

        const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
        const vectorRows = bestVectorTime !== null ? parseVectorTimeStepData(vectorFileText, bestVectorTime) : [];
        const tempLookup = buildTemperatureLookup(timeData);
        plotRows = deriveVectorField(vectorRows, variable, tempLookup);

        if (variable === 'water_flux_mag') zTitle = 'Water mass-flux magnitude (g/s-cm²)';
        if (variable === 'steam_flux_mag') zTitle = 'Steam mass-flux magnitude (g/s-cm²)';
        if (variable === 'total_flux_mag') zTitle = 'Total mass-flux magnitude (g/s-cm²)';
        if (variable === 'heat_flux_proxy') zTitle = 'Heat transport proxy (mW/m²)';
        if (variable === 'heat_flux_total') zTitle = 'Total heat transport (MW)';

        vectorData = vectorRows;
    } else {
        plotRows = timeData.map(row => ({
            x: row.x,
            y: row.z,
            z: row[variable]
        }));

        if (variable === 'temperature') zTitle = 'Temperature (°C)';
        if (variable === 'pressure') zTitle = 'Pressure (bar)';
        if (variable === 'saturation') zTitle = 'Saturation (-)';
        if (variable === 'phase') zTitle = 'Phase';

        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
            vectorData = bestVectorTime !== null ? parseVectorTimeStepData(vectorFileText, bestVectorTime) : [];
        }
    }

    const finiteValues = plotRows.map(r => r.z).filter(v => Number.isFinite(v));
    if (finiteValues.length === 0) {
        alert('No plottable numeric values were found for this timestep/field.');
        return;
    }

    currentDataRange = {
        min: Math.min(...finiteValues),
        max: Math.max(...finiteValues)
    };

    currentXRange = {
        min: Math.min(...plotRows.map(r => r.x)),
        max: Math.max(...plotRows.map(r => r.x))
    };

    currentZRange = {
        min: Math.min(...plotRows.map(r => r.y)),
        max: Math.max(...plotRows.map(r => r.y))
    };

    updateRangeDisplay();
    updateXRangeDisplay();
    updateZRangeDisplay();

    const mesh = createMeshGridFromXYZ(plotRows);

    const data = [{
        type: 'heatmap',
        x: mesh.x,
        y: mesh.y,
        z: mesh.z,
        colorscale: colorscale,
        colorbar: { title: zTitle },
        zmin: customColorbarRange ? customColorbarRange.min : currentDataRange.min,
        zmax: customColorbarRange ? customColorbarRange.max : currentDataRange.max,
        hovertemplate: 'x: %{x:.3f} km<br>z: %{y:.3f} km<br>value: %{z:.5g}<extra></extra>'
    }];

    if (vectorData && vectorData.length > 0) {
        const vectorTrace = createVectorTrace(vectorData, vectorType);
        if (vectorTrace) data.push(vectorTrace);
    }

    const pointTraces = createPointTraces();
    data.push(...pointTraces);

    const layout = {
        title: `HYDROTHERM ${variable.replaceAll('_', ' ')} at t = ${currentTime.toExponential(3)} yr`,
        xaxis: {
            title: 'X (km)',
            range: customXRange ? [customXRange.min, customXRange.max] : [currentXRange.min, currentXRange.max],
            gridcolor: getComputedStyle(document.documentElement).getPropertyValue('--grid-color').trim(),
            color: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim()
        },
        yaxis: {
            title: 'Z (km)',
            range: customZRange ? [customZRange.min, customZRange.max] : [currentZRange.min, currentZRange.max],
            scaleanchor: 'x',
            scaleratio: 1,
            gridcolor: getComputedStyle(document.documentElement).getPropertyValue('--grid-color').trim(),
            color: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim()
        },
        plot_bgcolor: getComputedStyle(document.documentElement).getPropertyValue('--plot-bg').trim(),
        paper_bgcolor: getComputedStyle(document.documentElement).getPropertyValue('--plot-paper-bg').trim(),
        font: {
            color: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim()
        },
        margin: { l: 70, r: 40, t: 60, b: 60 },
        showlegend: false
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        scrollZoom: true
    };

    await Plotly.newPlot('plotDiv', data, layout, config);

    const plotDiv = document.getElementById('plotDiv');
    plotDiv.on('plotly_click', handlePlotClick);
}

function createVectorTrace(vectorRows, type) {
    if (!vectorRows || vectorRows.length === 0) return null;

    const x = [];
    const y = [];
    const dxScale = Math.pow(10, arrowScale);

    for (const row of vectorRows) {
        const comp = getVectorComponentsForPlot(row, type);
        const x0 = row.x;
        const y0 = row.z;
        const x1 = x0 + comp.u * dxScale;
        const y1 = y0 + comp.w * dxScale;

        x.push(x0, x1, null);
        y.push(y0, y1, null);
    }

    return {
        type: 'scatter',
        mode: 'lines',
        x,
        y,
        line: { color: arrowColor, width: 1 },
        hoverinfo: 'skip'
    };
}

function createPointTraces() {
    return plottedPoints.map(point => ({
        type: 'scatter',
        mode: 'markers+text',
        x: [point.x],
        y: [point.z],
        marker: {
            color: point.color,
            size: 10,
            symbol: 'circle'
        },
        text: [point.id],
        textposition: 'top center',
        textfont: { color: point.color, size: 12 },
        hovertemplate: `${point.id}<br>x: %{x:.3f} km<br>z: %{y:.3f} km<extra></extra>`
    }));
}

function handlePlotClick(eventData) {
    if (!eventData || !eventData.points || eventData.points.length === 0) return;

    const pt = eventData.points[0];
    const x = pt.x;
    const z = pt.y;

    const existing = plottedPoints.findIndex(p => p.id === `P${nextPointSlot}`);
    const newPoint = {
        id: `P${nextPointSlot}`,
        x,
        z,
        color: POINT_COLORS[(nextPointSlot - 1) % POINT_COLORS.length]
    };

    if (existing >= 0) plottedPoints[existing] = newPoint;
    else plottedPoints.push(newPoint);

    nextPointSlot = nextPointSlot === 4 ? 1 : nextPointSlot + 1;
    plotData();
    updatePointTable();
}

function updatePointTable() {
    const container = document.getElementById('selectedPointsList');
    if (!container) return;

    if (plottedPoints.length === 0) {
        container.innerHTML = '<div class="helper-note">Click the plot to place up to four tracked points.</div>';
        return;
    }

    container.innerHTML = plottedPoints.map(p => `
        <div class="point-input-group">
            <label>${p.id}</label>
            <div>x = ${p.x.toFixed(3)} km, z = ${p.z.toFixed(3)} km</div>
        </div>
    `).join('');
}

// ============================================================
// Time series extraction
// ============================================================

function extractTimeSeriesAtTrackedPoints() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load a scalar file first.');
        return;
    }

    if (plottedPoints.length === 0) {
        alert('Please click at least one point on the plot first.');
        return;
    }

    const variable = document.getElementById('variableSelect').value;
    const traces = [];

    let cellAreaM2 = 1.0;
    if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
        const firstVectorTime = vectorTimePoints[0];
        const firstVectorRows = parseVectorTimeStepData(vectorFileText, firstVectorTime);
        cellAreaM2 = computeTypicalCellAreaM2FromVectorRows(firstVectorRows);
    }

    for (const point of plottedPoints) {
        const yValues = [];
        const xValues = [];

        for (const t of timePoints) {
            const scalarRows = parseTimeStepData(fileText, t);
            const scalarMatch = findClosestScalarPoint(scalarRows, point.x, point.z).closestPoint;

            let val = NaN;

            if (isDerivedVectorField(variable)) {
                if (!vectorFileText || Object.keys(vectorTimeIndex).length === 0) {
                    val = NaN;
                } else {
                    const bestVectorTime = getClosestTimeValue(t, vectorTimePoints);
                    const vectorRows = bestVectorTime !== null ? parseVectorTimeStepData(vectorFileText, bestVectorTime) : [];
                    const vectorMatch = findClosestVectorPoint(vectorRows, point.x, point.z).closestPoint;
                    val = computeDerivedValueAtPoint(variable, vectorMatch, scalarMatch, cellAreaM2);
                }
            } else if (scalarMatch) {
                val = scalarMatch[variable];
            }

            xValues.push(t);
            yValues.push(val);
        }

        traces.push({
            type: 'scatter',
            mode: 'lines+markers',
            name: point.id,
            x: xValues,
            y: yValues,
            line: { color: point.color, width: 2 },
            marker: { color: point.color, size: 6 }
        });
    }

    let yTitle = variable;
    if (variable === 'temperature') yTitle = 'Temperature (°C)';
    if (variable === 'pressure') yTitle = 'Pressure (bar)';
    if (variable === 'saturation') yTitle = 'Saturation (-)';
    if (variable === 'phase') yTitle = 'Phase';
    if (variable === 'water_flux_mag') yTitle = 'Water mass-flux magnitude (g/s-cm²)';
    if (variable === 'steam_flux_mag') yTitle = 'Steam mass-flux magnitude (g/s-cm²)';
    if (variable === 'total_flux_mag') yTitle = 'Total mass-flux magnitude (g/s-cm²)';
    if (variable === 'heat_flux_proxy') yTitle = 'Heat transport proxy (mW/m²)';
    if (variable === 'heat_flux_total') yTitle = 'Total heat transport (MW)';

    const layout = {
        title: `Time series of ${variable.replaceAll('_', ' ')}`,
        xaxis: {
            title: 'Time (years)',
            type: 'log',
            gridcolor: getComputedStyle(document.documentElement).getPropertyValue('--grid-color').trim(),
            color: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim()
        },
        yaxis: {
            title: yTitle,
            gridcolor: getComputedStyle(document.documentElement).getPropertyValue('--grid-color').trim(),
            color: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim()
        },
        plot_bgcolor: getComputedStyle(document.documentElement).getPropertyValue('--plot-bg').trim(),
        paper_bgcolor: getComputedStyle(document.documentElement).getPropertyValue('--plot-paper-bg').trim(),
        font: {
            color: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim()
        },
        margin: { l: 70, r: 20, t: 60, b: 60 },
        showlegend: true
    };

    Plotly.newPlot('timeSeriesPlot', traces, layout, { responsive: true });
}

function clearTrackedPoints() {
    plottedPoints = [];
    nextPointSlot = 1;
    updatePointTable();
    plotData();

    const tsDiv = document.getElementById('timeSeriesPlot');
    if (tsDiv) {
        Plotly.purge(tsDiv);
    }
}

// ============================================================
// GIF export
// ============================================================

async function exportGifAnimation() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load and plot a scalar file first.');
        return;
    }

    alert('GIF export in this version saves an HTML animation bundle instead of a true GIF. Use the downloaded HTML for interactive playback.');
    exportAnimationHTML();
}

function exportAnimationHTML() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load and plot a scalar file first.');
        return;
    }

    const variable = document.getElementById('variableSelect').value;
    const colorscale = document.getElementById('colormapSelect').value;
    const frameStep = Math.max(1, parseInt(document.getElementById('gifFrameStep').value || '1'));
    const selectedTimes = timePoints.filter((_, i) => i % frameStep === 0);

    const frames = [];
    let zTitle = variable;

    for (const t of selectedTimes) {
        const timeData = parseTimeStepData(fileText, t);
        let plotRows = [];

        if (isDerivedVectorField(variable)) {
            if (!vectorFileText || Object.keys(vectorTimeIndex).length === 0) continue;
            const bestVectorTime = getClosestTimeValue(t, vectorTimePoints);
            const vectorRows = bestVectorTime !== null ? parseVectorTimeStepData(vectorFileText, bestVectorTime) : [];
            const tempLookup = buildTemperatureLookup(timeData);
            plotRows = deriveVectorField(vectorRows, variable, tempLookup);
        } else {
            plotRows = timeData.map(row => ({ x: row.x, y: row.z, z: row[variable] }));
        }

        const mesh = createMeshGridFromXYZ(plotRows);
        frames.push({
            name: `t_${t}`,
            data: [{
                type: 'heatmap',
                x: mesh.x,
                y: mesh.y,
                z: mesh.z,
                colorscale: colorscale,
                zmin: customColorbarRange ? customColorbarRange.min : currentDataRange.min,
                zmax: customColorbarRange ? customColorbarRange.max : currentDataRange.max
            }]
        });
    }

    if (variable === 'temperature') zTitle = 'Temperature (°C)';
    if (variable === 'pressure') zTitle = 'Pressure (bar)';
    if (variable === 'saturation') zTitle = 'Saturation (-)';
    if (variable === 'phase') zTitle = 'Phase';
    if (variable === 'water_flux_mag') zTitle = 'Water mass-flux magnitude (g/s-cm²)';
    if (variable === 'steam_flux_mag') zTitle = 'Steam mass-flux magnitude (g/s-cm²)';
    if (variable === 'total_flux_mag') zTitle = 'Total mass-flux magnitude (g/s-cm²)';
    if (variable === 'heat_flux_proxy') zTitle = 'Heat transport proxy (mW/m²)';
    if (variable === 'heat_flux_total') zTitle = 'Total heat transport (MW)';

    const firstFrame = frames[0];
    if (!firstFrame) {
        alert('No frames available for export.');
        return;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>HYDROTHERM Animation</title>
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
<style>body{margin:0;background:#111;color:#fff;font-family:Arial,sans-serif;}#plot{width:100vw;height:100vh;}</style>
</head>
<body>
<div id="plot"></div>
<script>
const frames = ${JSON.stringify(frames)};
const layout = {
  title: 'HYDROTHERM animation',
  xaxis: {title: 'X (km)'},
  yaxis: {title: 'Z (km)', scaleanchor: 'x', scaleratio: 1},
  paper_bgcolor: '#111', plot_bgcolor: '#111', font: {color: '#fff'}
};
Plotly.newPlot('plot', firstFrame.data, layout).then(() => {
  Plotly.addFrames('plot', frames);
  Plotly.animate('plot', null, {
    frame: {duration: 50, redraw: true},
    transition: {duration: 0},
    mode: 'immediate'
  });
});
</script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    saveAs(blob, 'hydrotherm_animation.html');
}

// ============================================================
// Input-file converter for PRINT 6 blocks
// ============================================================

let convertedPrint6Text = null;

function detectNewline(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePrint6Value(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return '1';
    return value;
}

function buildPrint6Replacement(tstep, newline) {
    return [
        '# PRINT 6',
        '# .. plotscalar_pr_intrv,plotvector_pr_intrv,plotfile_type[I],time_series_pr_intrv',
        `     ${tstep}     ${tstep}     6     0`
    ].join(newline);
}

function convertPrint6Blocks(text, tstep) {
    const newline = detectNewline(text);
    const replacementBase = buildPrint6Replacement(tstep, newline);

    const lines = text.split(/\r?\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed === '# PRINT 6') {
            out.push('# PRINT 6');
            out.push('# .. plotscalar_pr_intrv,plotvector_pr_intrv,plotfile_type[I],time_series_pr_intrv');
            out.push(`     ${tstep}     ${tstep}     6     0`);

            i += 1;

            while (i < lines.length) {
                const look = lines[i].trim();

                if (look === '# SLICE number') {
                    out.push('# SLICE number');
                    i += 1;
                    break;
                }

                if (look.startsWith('#---') || look.startsWith('# ---')) {
                    out.push(lines[i]);
                    i += 1;
                    break;
                }

                if (
                    look.startsWith('# TEMP0') ||
                    look.startsWith('# PRES0') ||
                    look.startsWith('# XPERM') ||
                    look.startsWith('# IPLOT') ||
                    look.startsWith('# LAYER') ||
                    look.startsWith('# ROCK') ||
                    look.startsWith('# SOURCE') ||
                    look.startsWith('# BOUND') ||
                    (look.startsWith('#') && look !== '# .. plotscalar_pr_intrv,plotvector_pr_intrv,plotfile_type[I],time_series_pr_intrv')
                ) {
                    out.push(lines[i]);
                    i += 1;
                    break;
                }

                i += 1;
            }

            continue;
        }

        out.push(line);
        i += 1;
    }

    return out.join(newline);
}

async function convertInputFile() {
    const fileInput = document.getElementById('converterFileInput');
    const tstepInput = document.getElementById('converterTstepInput');
    const status = document.getElementById('converterStatus');

    const file = fileInput?.files?.[0];
    if (!file) {
        if (status) status.textContent = 'Please choose a HYDROTHERM input file.';
        return;
    }

    const tstep = normalizePrint6Value(tstepInput?.value);

    try {
        const text = await readFileAsText(file);
        const converted = convertPrint6Blocks(text, tstep);
        convertedPrint6Text = converted;

        const changed = converted !== text;
        if (status) {
            status.textContent = changed
                ? `Converted PRINT 6 blocks successfully using tstep = ${tstep}.`
                : 'No PRINT 6 block was found. File left unchanged.';
        }
    } catch (err) {
        console.error(err);
        if (status) status.textContent = `Conversion failed: ${err.message}`;
    }
}

function downloadConvertedInputFile() {
    const fileInput = document.getElementById('converterFileInput');
    const status = document.getElementById('converterStatus');

    if (!convertedPrint6Text) {
        if (status) status.textContent = 'Nothing to download yet. Convert a file first.';
        return;
    }

    const originalName = fileInput?.files?.[0]?.name || 'hydrotherm_input.txt';
    const dot = originalName.lastIndexOf('.');
    const outName = dot > 0
        ? `${originalName.slice(0, dot)}_print6_fixed${originalName.slice(dot)}`
        : `${originalName}_print6_fixed.txt`;

    const blob = new Blob([convertedPrint6Text], { type: 'text/plain;charset=utf-8' });
    saveAs(blob, outName);

    if (status) status.textContent = `Downloaded ${outName}`;
}

// ============================================================
// Utilities
// ============================================================

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = e => reject(new Error('Failed to read file.'));
        reader.readAsText(file);
    });
}

function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    currentTheme = theme;
    if (fileText && timePoints.length > 0) {
        plotData();
    }

    const tsDiv = document.getElementById('timeSeriesPlot');
    if (tsDiv && tsDiv.data && tsDiv.data.length > 0) {
        extractTimeSeriesAtTrackedPoints();
    }
}

// ============================================================
// Event wiring
// ============================================================

document.addEventListener('DOMContentLoaded', function () {
    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
        themeSelect.addEventListener('change', function () {
            applyTheme(this.value);
        });
    }

    const vectorFileInput = document.getElementById('vectorFileInput');
    if (vectorFileInput) {
        vectorFileInput.addEventListener('change', loadVectorFile);
    }

    const clearVectorsBtn = document.getElementById('clearVectorsBtn');
    if (clearVectorsBtn) {
        clearVectorsBtn.addEventListener('click', clearVectors);
    }

    const extractTsBtn = document.getElementById('extractTimeSeriesBtn');
    if (extractTsBtn) {
        extractTsBtn.addEventListener('click', extractTimeSeriesAtTrackedPoints);
    }

    const clearPointsBtn = document.getElementById('clearPointsBtn');
    if (clearPointsBtn) {
        clearPointsBtn.addEventListener('click', clearTrackedPoints);
    }

    const variableSelect = document.getElementById('variableSelect');
    if (variableSelect) {
        variableSelect.addEventListener('change', function () {
            if (fileText && timePoints.length > 0) plotData();
        });
    }

    const colormapSelect = document.getElementById('colormapSelect');
    if (colormapSelect) {
        colormapSelect.addEventListener('change', function () {
            if (fileText && timePoints.length > 0) plotData();
        });
    }

    const convertBtn = document.getElementById('convertInputBtn');
    if (convertBtn) {
        convertBtn.addEventListener('click', convertInputFile);
    }

    const downloadBtn = document.getElementById('downloadConvertedBtn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', downloadConvertedInputFile);
    }

    updatePointTable();
    applyTheme(currentTheme);
});
