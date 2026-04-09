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

        return (heatFluxDensityWm2 * cellAreaM2) / 1.0e6; // MW
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
        return {
            isValid: false,
            error: 'File does not contain HYDROTHERM header information'
        };
    }

    if (dataLines === 0) {
        return {
            isValid: false,
            error: 'File does not contain any data lines'
        };
    }

    if (validDataLines === 0) {
        return {
            isValid: false,
            error: 'File contains data lines but none match the expected HYDROTHERM scalar format'
        };
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
        stats: {
            totalLines: lines.length,
            dataLines,
            validDataLines,
            validPercentage
        }
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
        return {
            isValid: false,
            error: 'File does not contain vector header information'
        };
    }

    if (dataLines === 0) {
        return {
            isValid: false,
            error: 'File does not contain any data lines'
        };
    }

    if (validDataLines === 0) {
        return {
            isValid: false,
            error: 'File contains data lines but none match the expected vector format'
        };
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
        stats: {
            totalLines: lines.length,
            dataLines,
            validDataLines,
            validPercentage
        }
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
            data.push({
                x, y, z, time: timeVal,
                xw, yw, zw,
                xs, ys, zs
            });
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
            const currentTime = timePoints[currentTimeIndex];
            const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
            vectorData = bestVectorTime !== null ? parseVectorTimeStepData(vectorFileText, bestVectorTime) : [];
            plotData();
        }
    });

    arrowColor = arrowColorSelect.value;
    arrowColorSelect.addEventListener('change', function () {
        arrowColor = this.value;
        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            plotData();
        }
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
    timeDisplay.textContent = `Time: ${currentTime.toFixed(5)} years`;
}

// ============================================================
// Plotting
// ============================================================

async function plotData() {
    if (!fileText || timePoints.length === 0) return;

    const variableSelect = document.getElementById('variableSelect');
    const colormapSelect = document.getElementById('colormapSelect');
    const selectedVariable = variableSelect.value;
    const selectedColormap = colormapSelect.value;
    const currentTime = timePoints[currentTimeIndex];

    const timeData = parseTimeStepData(fileText, currentTime);
    if (timeData.length === 0) return;

    if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
        const bestVectorTime = getClosestTimeValue(currentTime, vectorTimePoints);
        vectorData = bestVectorTime !== null ? parseVectorTimeStepData(vectorFileText, bestVectorTime) : [];
    }

    let meshData;
    if (isDerivedVectorField(selectedVariable)) {
        if (!vectorData || vectorData.length === 0) {
            alert('Please load a vector file to plot vector-derived quantities.');
            return;
        }

        const tempLookup = buildTemperatureLookup(timeData);
        const derivedRows = deriveVectorField(vectorData, selectedVariable, tempLookup);
        meshData = createMeshGridFromXYZ(derivedRows);
    } else {
        meshData = createMeshGrid(timeData, selectedVariable);
    }

    const allValues = meshData.z.flat().filter(val => !isNaN(val) && isFinite(val));
    if (allValues.length > 0) {
        currentDataRange = {
            min: Math.min(...allValues),
            max: Math.max(...allValues)
        };
    }

    if (meshData.x.length > 0 && meshData.y.length > 0) {
        currentXRange = {
            min: Math.min(...meshData.x),
            max: Math.max(...meshData.x)
        };
        currentZRange = {
            min: Math.min(...meshData.y),
            max: Math.max(...meshData.y)
        };
    }

    const colorbarRange = customColorbarRange || currentDataRange;
    const xAxisRange = customXRange || currentXRange;
    const zAxisRange = customZRange || currentZRange;

    const traces = [];

    const heatmapTrace = {
        z: meshData.z,
        x: meshData.x,
        y: meshData.y,
        type: 'heatmap',
        colorscale: selectedColormap,
        zmin: colorbarRange.min,
        zmax: colorbarRange.max,
        colorbar: {
            title: getVariableLabel(selectedVariable),
            titleside: 'right',
            tickfont: { color: currentTheme === 'dark' ? '#ffffff' : '#222222' },
            titlefont: { color: currentTheme === 'dark' ? '#ffffff' : '#222222' }
        },
        hoverongaps: false,
        hovertemplate:
            'X: %{x:.3f} km<br>' +
            'Z: %{y:.3f} km<br>' +
            `${getVariableLabel(selectedVariable)}: %{z:.3f}<br>` +
            '<extra></extra>'
    };
    traces.push(heatmapTrace);

    if (plottedPoints.length > 0) {
        for (let i = 0; i < plottedPoints.length; i++) {
            const point = plottedPoints[i];
            traces.push({
                x: [point.x],
                y: [point.z],
                type: 'scatter',
                mode: 'markers+text',
                marker: {
                    size: 12,
                    color: point.color,
                    line: {
                        color: 'white',
                        width: 2
                    },
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

function createMeshGrid(data, variable) {
    const xCoords = [...new Set(data.map(row => row.x))].sort((a, b) => a - b);
    const zCoords = [...new Set(data.map(row => row.z))].sort((a, b) => a - b);

    const zMatrix = [];

    for (let i = 0; i < zCoords.length; i++) {
        const row = [];
        for (let j = 0; j < xCoords.length; j++) {
            const point = data.find(d =>
                Math.abs(d.x - xCoords[j]) < 1e-10 &&
                Math.abs(d.z - zCoords[i]) < 1e-10
            );

            if (point) {
                row.push(point[variable]);
            } else {
                row.push(NaN);
            }
        }
        zMatrix.push(row);
    }

    return {
        x: xCoords,
        y: zCoords,
        z: zMatrix
    };
}

function setupPlotClickSelection() {
    const plotDiv = document.getElementById('plotContainer');
    if (!plotDiv) return;

    plotDiv.on('plotly_click', function (eventData) {
        if (!eventData || !eventData.points || eventData.points.length === 0) return;

        const clicked = eventData.points[0];
        const x = clicked.x;
        const z = clicked.y;

        if (!isFinite(x) || !isFinite(z)) return;

        const currentTime = timePoints[currentTimeIndex];
        const timeData = parseTimeStepData(fileText, currentTime);
        const { closestPoint } = findClosestScalarPoint(timeData, x, z);

        if (!closestPoint) return;

        const slot = nextPointSlot;
        document.getElementById(`xCoord${slot}`).value = closestPoint.x.toFixed(3);
        document.getElementById(`zCoord${slot}`).value = closestPoint.z.toFixed(3);

        nextPointSlot = slot === 4 ? 1 : slot + 1;

        updatePlottedPointsFromInputs();
        plotData();
    });
}

// ============================================================
// PRINT 6 TSTEP CONVERTER
// ============================================================

let convertedPrint6Text = null;
let convertedPrint6Filename = "converted_hydrotherm_input.txt";

function updateConverterStatus(message) {
    const el = document.getElementById("converterStatus");
    if (el) el.textContent = message;
}

function convertPrint6Blocks(text, tstep) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";

    const pattern =
        /# PRINT 6\r?\n# \.\. plotscalar_pr_intrv,plotvector_pr_intrv,plotfile_type\[I\],time_series_pr_intrv\r?\n[^\r\n]*\r?\n1\r?\n10 1 10(?=\r?\n# )/g;

    const replacement =
        `# PRINT 6${newline}` +
        `# .. plotscalar_pr_intrv,plotvector_pr_intrv,plotfile_type[I],time_series_pr_intrv${newline}` +
        `     ${tstep}     ${tstep}     6     0`;

    let replacements = 0;
    const converted = text.replace(pattern, () => {
        replacements += 1;
        return replacement;
    });

    return {
        text: converted,
        replacements
    };
}

function initializePrint6Converter() {
    const fileInput = document.getElementById("converterFile");
    const tstepInput = document.getElementById("tstepInput");
    const convertBtn = document.getElementById("convertPrint6Btn");
    const downloadBtn = document.getElementById("downloadConvertedBtn");

    if (!fileInput || !tstepInput || !convertBtn || !downloadBtn) return;

    convertBtn.addEventListener("click", async () => {
        try {
            if (!fileInput.files || fileInput.files.length === 0) {
                updateConverterStatus("Please choose a HYDROTHERM input file first.");
                return;
            }

            const tstep = parseInt(tstepInput.value, 10);
            if (!Number.isInteger(tstep) || tstep < 0) {
                updateConverterStatus("Please enter a valid non-negative integer for tstep.");
                return;
            }

            const file = fileInput.files[0];
            const originalText = await file.text();

            const result = convertPrint6Blocks(originalText, tstep);
            convertedPrint6Text = result.text;

            const dotIndex = file.name.lastIndexOf(".");
            if (dotIndex > 0) {
                convertedPrint6Filename =
                    file.name.slice(0, dotIndex) + `_print6_tstep_${tstep}` + file.name.slice(dotIndex);
            } else {
                convertedPrint6Filename = file.name + `_print6_tstep_${tstep}.txt`;
            }

            downloadBtn.disabled = false;

            updateConverterStatus(
                `Converted ${result.replacements} PRINT 6 block(s).\n` +
                `Inserted:\n` +
                `     ${tstep}     ${tstep}     6     0\n\n` +
                `Removed trailing lines "1" and "10 1 10" where present.\n\n` +
                `Ready to download: ${convertedPrint6Filename}`
            );
        } catch (err) {
            console.error(err);
            updateConverterStatus(`Conversion failed: ${err.message}`);
        }
    });

    downloadBtn.addEventListener("click", () => {
        if (!convertedPrint6Text) {
            updateConverterStatus("No converted file is available yet.");
            return;
        }

        const blob = new Blob([convertedPrint6Text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = convertedPrint6Filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(url);
    });
}

function updateConverterStatus(message) {
    const el = document.getElementById("converterStatus");
    if (el) el.textContent = message;
}

function initializePrint6Converter() {
    const fileInput = document.getElementById("converterFile");
    const tstepInput = document.getElementById("tstepInput");
    const convertBtn = document.getElementById("convertPrint6Btn");
    const downloadBtn = document.getElementById("downloadConvertedBtn");

    if (!fileInput || !tstepInput || !convertBtn || !downloadBtn) return;

    convertBtn.addEventListener("click", async () => {
        try {
            if (!fileInput.files || fileInput.files.length === 0) {
                updateConverterStatus("Please choose a HYDROTHERM input file first.");
                return;
            }

            const tstep = parseInt(tstepInput.value, 10);
            if (!Number.isInteger(tstep) || tstep < 0) {
                updateConverterStatus("Please enter a valid non-negative integer for tstep.");
                return;
            }

            const file = fileInput.files[0];
            const originalText = await file.text();

            const result = convertPrint6Blocks(originalText, tstep);
            convertedPrint6Text = result.text;

            const dotIndex = file.name.lastIndexOf(".");
            if (dotIndex > 0) {
                convertedPrint6Filename =
                    file.name.slice(0, dotIndex) + `_print6_tstep_${tstep}` + file.name.slice(dotIndex);
            } else {
                convertedPrint6Filename = file.name + `_print6_tstep_${tstep}.txt`;
            }

            downloadBtn.disabled = false;

            updateConverterStatus(
                `Converted ${result.replacements} PRINT 6 block(s).\n` +
                `Inserted line:\n${formatPrint6Line(tstep)}\n\n` +
                `Ready to download: ${convertedPrint6Filename}`
            );
        } catch (err) {
            console.error(err);
            updateConverterStatus(`Conversion failed: ${err.message}`);
        }
    });

    downloadBtn.addEventListener("click", () => {
        if (!convertedPrint6Text) {
            updateConverterStatus("No converted file is available yet.");
            return;
        }

        const blob = new Blob([convertedPrint6Text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = convertedPrint6Filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(url);
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
    const validValues = values.filter(v => !isNaN(v) && isFinite(v));
    return {
        min: Math.min(...validValues),
        max: Math.max(...validValues)
    };
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
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsText(file);
    });
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

function plotTimeSeries() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }

    const selectedVariable = document.getElementById('timeSeriesVariable').value;
    const points = getPointsFromInputs();

    if (points.length === 0) {
        alert('Please enter valid coordinates for at least one point.');
        return;
    }

    if (isDerivedVectorField(selectedVariable) && (!vectorFileText || vectorTimePoints.length === 0)) {
        alert('Please load a vector file first for vector-derived time series.');
        return;
    }

    plottedPoints = points;

    const allTraces = [];

    for (const point of points) {
        const timeSeriesData = [];
        const cellAreaM2 = vectorFileText ? computeTypicalCellAreaM2FromVectorRows(vectorData || []) : 1.0;

        for (const time of timePoints) {
            const scalarTimeData = parseTimeStepData(fileText, time);
            const scalarResult = findClosestScalarPoint(scalarTimeData, point.x, point.z);

            if (!scalarResult.closestPoint || scalarResult.minDistance >= 0.1) continue;

            let value = NaN;

            if (isDerivedVectorField(selectedVariable)) {
                const bestVectorTime = getClosestTimeValue(time, vectorTimePoints);
                if (bestVectorTime === null) continue;

                const vectorTimeData = parseVectorTimeStepData(vectorFileText, bestVectorTime);
                const vectorResult = findClosestVectorPoint(vectorTimeData, point.x, point.z);
                if (!vectorResult.closestPoint || vectorResult.minDistance >= 0.1) continue;

                const localCellAreaM2 = computeTypicalCellAreaM2FromVectorRows(vectorTimeData) || cellAreaM2;

                value = computeDerivedValueAtPoint(
                    selectedVariable,
                    vectorResult.closestPoint,
                    scalarResult.closestPoint,
                    localCellAreaM2
                );
            } else {
                value = scalarResult.closestPoint[selectedVariable];
            }

            if (isFinite(value)) {
                timeSeriesData.push({
                    time: time,
                    value: value
                });
            }
        }

        if (timeSeriesData.length > 0) {
            allTraces.push({
                x: timeSeriesData.map(d => d.time),
                y: timeSeriesData.map(d => d.value),
                type: 'scatter',
                mode: 'lines+markers',
                line: {
                    color: point.color,
                    width: 3
                },
                marker: {
                    size: 6,
                    color: point.color
                },
                name: `Point ${point.id} (${point.x.toFixed(3)}, ${point.z.toFixed(3)})`
            });
        }
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

    if (timePoints.length > 0) {
        const firstTimeData = parseTimeStepData(fileText, timePoints[0]);
        if (firstTimeData.length > 0) {
            const samplePoints = [];
            for (let i = 0; i < Math.min(4, firstTimeData.length); i++) {
                const index = Math.floor(i * firstTimeData.length / 4);
                samplePoints.push(firstTimeData[index]);
            }

            for (let i = 0; i < samplePoints.length; i++) {
                document.getElementById(`xCoord${i + 1}`).value = samplePoints[i].x.toFixed(3);
                document.getElementById(`zCoord${i + 1}`).value = samplePoints[i].z.toFixed(3);
            }
        }
    }

    updatePlottedPointsFromInputs();
}

function downloadTimeSeriesCSV() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }

    const points = getPointsFromInputs();
    if (points.length === 0) {
        alert('Please enter valid coordinates for at least one point.');
        return;
    }

    const selectedVariable = document.getElementById('timeSeriesVariable').value;

    if (isDerivedVectorField(selectedVariable) && (!vectorFileText || vectorTimePoints.length === 0)) {
        alert('Please load a vector file first for vector-derived time series.');
        return;
    }

    let csv = 'time';
    for (let i = 0; i < points.length; i++) {
        csv += `,point${i + 1}`;
    }
    csv += '\n';

    for (const time of timePoints) {
        const scalarTimeData = parseTimeStepData(fileText, time);
        const bestVectorTime = isDerivedVectorField(selectedVariable)
            ? getClosestTimeValue(time, vectorTimePoints)
            : null;
        const vectorTimeData = (isDerivedVectorField(selectedVariable) && bestVectorTime !== null)
            ? parseVectorTimeStepData(vectorFileText, bestVectorTime)
            : null;

        csv += `${time}`;

        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const scalarResult = findClosestScalarPoint(scalarTimeData, p.x, p.z);

            let value = '';

            if (scalarResult.closestPoint) {
                if (isDerivedVectorField(selectedVariable)) {
                    const vectorResult = vectorTimeData
                        ? findClosestVectorPoint(vectorTimeData, p.x, p.z)
                        : { closestPoint: null };

                    if (vectorResult.closestPoint) {
                        const localCellAreaM2 = vectorTimeData
                            ? computeTypicalCellAreaM2FromVectorRows(vectorTimeData)
                            : 1.0;

                        value = computeDerivedValueAtPoint(
                            selectedVariable,
                            vectorResult.closestPoint,
                            scalarResult.closestPoint,
                            localCellAreaM2
                        );
                    }
                } else {
                    value = scalarResult.closestPoint[selectedVariable];
                }
            }

            csv += `,${value}`;
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

async function exportGifAnimation() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }

    const frameStep = Math.max(1, parseInt(document.getElementById('gifFrameStep').value) || 1);
    const resString = document.getElementById('gifResolution').value || '900x600';
    const [width, height] = resString.split('x').map(Number);
    const plotDiv = document.getElementById('plotContainer');
    const nFrames = timePoints.length;
    const folderName = `plot_frames_${Date.now()}`;
    const zip = new JSZip();
    zip.folder(folderName);

    let progressDiv = document.getElementById('gifExportProgress');
    if (!progressDiv) {
        progressDiv = document.createElement('div');
        progressDiv.id = 'gifExportProgress';
        progressDiv.style = 'color: #fff; background: #222; padding: 10px; border-radius: 8px; margin: 10px 0;';
        plotDiv.parentNode.insertBefore(progressDiv, plotDiv);
    }

    let nExported = 0;
    for (let i = 0; i < nFrames; i += frameStep) {
        currentTimeIndex = i;
        await plotData();
        await new Promise(r => setTimeout(r, 100));

        const pngDataUrl = await Plotly.toImage(plotDiv, { format: 'png', width, height });
        const res = await fetch(pngDataUrl);
        const blob = await res.blob();

        const filename = `${folderName}/frame_${String(i).padStart(3, '0')}.png`;
        zip.file(filename, blob);

        nExported++;
        progressDiv.textContent = `Exported frame ${nExported} (step ${i + 1} of ${nFrames})`;
        await new Promise(r => setTimeout(r, 100));
    }

    progressDiv.textContent = `Zipping frames...`;
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    saveAs(zipBlob, `${folderName}.zip`);
    progressDiv.textContent = `Done! Unzip ${folderName}.zip, then run: convert -delay 5 *.png screens.gif`;
    setTimeout(() => progressDiv.remove(), 15000);
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
        if (fileText) {
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
        if (fileText) {
            plotData();
        }
    });

    themeSelect.addEventListener('change', function () {
        currentTheme = this.value;
        applyTheme(currentTheme);
        if (fileText) {
            plotData();
            plotTimeSeries();
        }
    });

    if (downloadTimeSeriesBtn) {
        downloadTimeSeriesBtn.addEventListener('click', function () {
            downloadTimeSeriesCSV();
        });
    }

    applyTheme('dark');
    initializePrint6Converter();

    const arrowColorSelect = document.getElementById('arrowColorSelect');
    if (arrowColorSelect) {
        arrowColor = arrowColorSelect.value = '#ffffff';
    }
});

document.addEventListener('keydown', function (e) {
    if (!fileText) return;

    const timeRange = document.getElementById('timeRange');
    const currentValue = parseInt(timeRange.value);

    if (e.key === 'ArrowLeft' && currentValue > 0) {
        timeRange.value = currentValue - 1;
        timeRange.dispatchEvent(new Event('input'));
    } else if (e.key === 'ArrowRight' && currentValue < timePoints.length - 1) {
        timeRange.value = currentValue + 1;
        timeRange.dispatchEvent(new Event('input'));
    }
});

window.addEventListener('resize', function () {
    if (fileText && timePoints.length > 0) {
        clearTimeout(window.resizeTimeout);
        window.resizeTimeout = setTimeout(() => {
            plotData();
        }, 250);
    }
});
