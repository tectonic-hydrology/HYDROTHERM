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
let plottedPoints = [];
let vectorData = null;
let vectorFileText = null;
let vectorTimeIndex = {};
let vectorTimePoints = [];
let vectorType = 'water';
let arrowScale = -2.0;
let currentTheme = 'dark';
let arrowColor = '#ffffff';
let nextPointSlot = 1;

const DERIVED_VECTOR_FIELDS = [
    'water_flux_mag',
    'steam_flux_mag',
    'total_flux_mag',
    'heat_flux_proxy',
    'heat_flux_total'
];

const POINT_COLORS = ['#20bf6b', '#0fb9b1', '#26de81', '#45aaf2'];

///////////////////////////////////////////////////////////////
// ================= PRINT 6 CONVERTER =======================
///////////////////////////////////////////////////////////////

let convertedPrint6Text = null;
let convertedPrint6Filename = "converted_hydrotherm_input.txt";

function formatPrint6Line(tstep) {
    return `     ${tstep}     ${tstep}     6     0`;
}

function detectNewline(text) {
    return text.includes("\r\n") ? "\r\n" : "\n";
}

function convertPrint6Blocks(text, tstep) {
    const newline = detectNewline(text);
    const lines = text.split(/\r?\n/);
    let replacements = 0;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "# PRINT 6" && i + 2 < lines.length) {
            lines[i + 2] = formatPrint6Line(tstep);
            replacements += 1;
        }
    }

    return {
        text: lines.join(newline),
        replacements
    };
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
            if (!fileInput.files.length) {
                updateConverterStatus("Select a file first.");
                return;
            }

            const tstep = parseInt(tstepInput.value, 10);
            const file = fileInput.files[0];
            const text = await file.text();

            const result = convertPrint6Blocks(text, tstep);
            convertedPrint6Text = result.text;

            convertedPrint6Filename =
                file.name.replace(/\.[^/.]+$/, "") +
                `_tstep_${tstep}.txt`;

            downloadBtn.disabled = false;

            updateConverterStatus(
                `Converted ${result.replacements} PRINT 6 blocks.\nReady to download.`
            );

        } catch (err) {
            console.error(err);
            updateConverterStatus("Conversion failed.");
        }
    });

    downloadBtn.addEventListener("click", () => {
        if (!convertedPrint6Text) return;

        const blob = new Blob([convertedPrint6Text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = convertedPrint6Filename;
        a.click();

        URL.revokeObjectURL(url);
    });
}

///////////////////////////////////////////////////////////////
// ================= BASIC HELPERS ============================
///////////////////////////////////////////////////////////////

function mag3(a, b, c) {
    return Math.sqrt(a * a + b * b + c * c);
}

function isDerivedVectorField(variable) {
    return DERIVED_VECTOR_FIELDS.includes(variable);
}

///////////////////////////////////////////////////////////////
// ================= FILE LOADING =============================
///////////////////////////////////////////////////////////////

async function loadAndProcessFile() {
    const file = document.getElementById('fileInput').files[0];
    if (!file) return alert('Select file');

    fileText = await file.text();
    await buildTimeIndex(fileText);
    setupTimeSlider();
    plotData();
}

async function buildTimeIndex(text) {
    timeIndex = {};
    timePoints = [];

    const lines = text.split('\n');
    let currentTime = null;
    let start = 0;

    lines.forEach((line, i) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
            const t = parseFloat(parts[3]);
            if (!isNaN(t)) {
                if (currentTime === null) {
                    currentTime = t;
                    start = i;
                } else if (t !== currentTime) {
                    timeIndex[currentTime] = [start, i - 1];
                    timePoints.push(currentTime);
                    currentTime = t;
                    start = i;
                }
            }
        }
    });

    if (currentTime !== null) {
        timeIndex[currentTime] = [start, lines.length - 1];
        timePoints.push(currentTime);
    }
}

///////////////////////////////////////////////////////////////
// ================= PLOTTING ================================
///////////////////////////////////////////////////////////////

async function plotData() {
    if (!fileText) return;

    const variable = document.getElementById('variableSelect').value;
    const time = timePoints[currentTimeIndex];

    const data = parseTimeStepData(fileText, time);
    const mesh = createMeshGrid(data, variable);

    Plotly.newPlot('plotContainer', [{
        z: mesh.z,
        x: mesh.x,
        y: mesh.y,
        type: 'heatmap'
    }]);
}

function parseTimeStepData(text, time) {
    const [start, end] = timeIndex[time];
    const lines = text.split('\n').slice(start, end + 1);
    return lines.map(l => {
        const p = l.trim().split(/\s+/);
        return {
            x: +p[0],
            z: +p[2],
            temperature: +p[4]
        };
    });
}

function createMeshGrid(data) {
    const xs = [...new Set(data.map(d => d.x))];
    const zs = [...new Set(data.map(d => d.z))];

    const grid = zs.map(z =>
        xs.map(x => {
            const p = data.find(d => d.x === x && d.z === z);
            return p ? p.temperature : NaN;
        })
    );

    return { x: xs, y: zs, z: grid };
}

///////////////////////////////////////////////////////////////
// ================= UI INIT ================================
///////////////////////////////////////////////////////////////

document.addEventListener('DOMContentLoaded', () => {
    initializePrint6Converter();
});
