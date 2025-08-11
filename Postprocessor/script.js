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
let plottedPoints = []; // Array to store plotted points for time series
let vectorData = null; // Store vector data
let vectorFileText = null; // Store vector file text
let vectorTimeIndex = {}; // Vector time index: { timeValue: [startLine, endLine] }
let vectorTimePoints = []; // Vector time points
let vectorType = 'water'; // Current vector type
let arrowScale = -2.0; // Current arrow scale (log scale: 10^-2 = 0.01x)
let currentTheme = 'dark';
let arrowColor = '#ffffff'; // Default arrow color is white

// File processing function (builds time index only)
async function loadAndProcessFile() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    if (!file) {
        alert('Please select a file first.');
        return;
    }
    // Filename validation for scalar file
    if (!file.name.startsWith('Plot_scalar.')) {
        alert('Invalid file name. Please select a file that begins with "Plot_scalar."');
        return;
    }
    showLoading(true);
    try {
        fileText = await readFileAsText(file);
        
        // Validate file format
        const formatValidation = validateFileFormat(fileText);
        if (!formatValidation.isValid) {
            throw new Error(`Invalid file format: ${formatValidation.error}`);
        }
        
        // Build time index
        await buildTimeIndex(fileText);
        if (timePoints.length > 0) {
            setupTimeSlider();
            await plotData(); // Plot first time step
            showTimeSeriesSection(); // Show time series section
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

// Validate if the file contains HYDROTHERM data format
function validateFileFormat(text) {
    const lines = text.split('\n');
    let dataLines = 0;
    let validDataLines = 0;
    let hasHeader = false;
    
    // Check for header information
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('x  y') || trimmed.includes('(km)') || 
            trimmed.includes('(yr)') || trimmed.includes('(Deg.C)') || 
            trimmed.includes('(dyne/cm^2)') || trimmed.includes('(-)')) {
            hasHeader = true;
            break;
        }
    }
    
    // Check for data lines
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('x  y') ||
            trimmed.includes('(km)') || trimmed.includes('(yr)') ||
            trimmed.includes('(Deg.C)') || trimmed.includes('(dyne/cm^2)') ||
            trimmed.includes('(-)') || trimmed.includes('No.')) {
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
    
    // Validation criteria
    if (!hasHeader) {
        return {
            isValid: false,
            error: 'File does not contain HYDROTHERM header information (missing column headers or units)'
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
            error: 'File contains data lines but none match the expected HYDROTHERM format (8 columns: x, y, z, time, temperature, pressure, saturation, phase)'
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
            dataLines: dataLines,
            validDataLines: validDataLines,
            validPercentage: validPercentage
        }
    };
}

// Build a time index: { timeValue: [startLine, endLine] }
async function buildTimeIndex(text) {
    timeIndex = {};
    timePoints = [];
    let currentTime = null;
    let startLine = 0;
    let lineNum = 0;
    const lines = text.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('x  y') ||
            trimmed.includes('(km)') || trimmed.includes('(yr)') ||
            trimmed.includes('(Deg.C)') || trimmed.includes('(dyne/cm^2)') ||
            trimmed.includes('(-)') || trimmed.includes('No.')) {
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
                    // Save previous time range
                    timeIndex[currentTime] = [startLine, lineNum-1];
                    timePoints.push(currentTime);
                    // Start new time
                    currentTime = time;
                    startLine = lineNum;
                }
            }
        }
        lineNum++;
    }
    // Save last time range
    if (currentTime !== null) {
        timeIndex[currentTime] = [startLine, lineNum-1];
        timePoints.push(currentTime);
    }
    timePoints = Array.from(new Set(timePoints)).sort((a, b) => a - b);
}

// Parse only the lines for the selected time step
function parseTimeStepData(text, time) {
    const [start, end] = timeIndex[time];
    const lines = text.split('\n').slice(start, end+1);
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

// Setup time slider and colorbar controls
function setupTimeSlider() {
    const timeSlider = document.getElementById('timeSlider');
    const timeRange = document.getElementById('timeRange');
    const timeDisplay = document.getElementById('timeDisplay');
    timeRange.max = timePoints.length - 1;
    timeRange.value = 0;
    timeRange.oninput = async function() {
        currentTimeIndex = parseInt(this.value);
        updateTimeDisplay();
        await plotData();
    };
    updateTimeDisplay();
    timeSlider.style.display = 'block';
    
    // Setup colorbar controls
    setupColorbarControls();
    
    // Setup axis controls
    setupAxisControls();
    
    // Setup vector controls
    setupVectorControls();
}

// Setup colorbar range slider
function setupColorbarControls() {
    const colorbarControls = document.getElementById('colorbarControls');
    
    // Initialize jQuery UI range slider
    $("#slider-range").slider({
        range: true,
        min: 0,
        max: 100,
        values: [0, 100],
        slide: function(event, ui) {
            const minPercent = ui.values[0];
            const maxPercent = ui.values[1];
            
            // Convert percentages to actual data values
            const dataRange = currentDataRange.max - currentDataRange.min;
            customColorbarRange = {
                min: currentDataRange.min + (dataRange * minPercent / 100),
                max: currentDataRange.min + (dataRange * maxPercent / 100)
            };
            
            updateRangeDisplay();
            plotData();
        }
    });
    
    // Initialize the display
    updateRangeDisplay();
    
    colorbarControls.style.display = 'block';
}

// Setup axis range sliders
function setupAxisControls() {
    const axisControls = document.getElementById('axisControls');
    
    // Initialize X-axis range slider
    $("#x-slider-range").slider({
        range: true,
        min: 0,
        max: 100,
        values: [0, 100],
        slide: function(event, ui) {
            const minPercent = ui.values[0];
            const maxPercent = ui.values[1];
            
            // Convert percentages to actual X values
            const xRange = currentXRange.max - currentXRange.min;
            customXRange = {
                min: currentXRange.min + (xRange * minPercent / 100),
                max: currentXRange.min + (xRange * maxPercent / 100)
            };
            
            updateXRangeDisplay();
            plotData();
        }
    });
    
    // Initialize Z-axis range slider
    $("#z-slider-range").slider({
        range: true,
        min: 0,
        max: 100,
        values: [0, 100],
        slide: function(event, ui) {
            const minPercent = ui.values[0];
            const maxPercent = ui.values[1];
            
            // Convert percentages to actual Z values
            const zRange = currentZRange.max - currentZRange.min;
            customZRange = {
                min: currentZRange.min + (zRange * minPercent / 100),
                max: currentZRange.min + (zRange * maxPercent / 100)
            };
            
            updateZRangeDisplay();
            plotData();
        }
    });
    
    // Initialize the displays
    updateXRangeDisplay();
    updateZRangeDisplay();
    
    axisControls.style.display = 'block';
}

// Update range display values
function updateRangeDisplay() {
    const amount = document.getElementById('amount');
    
    if (customColorbarRange) {
        amount.value = `${customColorbarRange.min.toFixed(3)} - ${customColorbarRange.max.toFixed(3)}`;
    } else {
        amount.value = `${currentDataRange.min.toFixed(3)} - ${currentDataRange.max.toFixed(3)}`;
    }
}

// Update X range display values
function updateXRangeDisplay() {
    const xRangeAmount = document.getElementById('xRangeAmount');
    
    if (customXRange) {
        xRangeAmount.value = `${customXRange.min.toFixed(3)} - ${customXRange.max.toFixed(3)} km`;
    } else {
        xRangeAmount.value = `${currentXRange.min.toFixed(3)} - ${currentXRange.max.toFixed(3)} km`;
    }
}

// Update Z range display values
function updateZRangeDisplay() {
    const zRangeAmount = document.getElementById('zRangeAmount');
    
    if (customZRange) {
        zRangeAmount.value = `${customZRange.min.toFixed(3)} - ${customZRange.max.toFixed(3)} km`;
    } else {
        zRangeAmount.value = `${currentZRange.min.toFixed(3)} - ${currentZRange.max.toFixed(3)} km`;
    }
}

// Reset colorbar to auto range
function resetColorbar() {
    customColorbarRange = null;
    $("#slider-range").slider("values", [0, 100]);
    updateRangeDisplay();
    plotData();
}

// Reset axes to auto range
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

// Plot data for the selected time step as a meshed heatmap
async function plotData() {
    if (!fileText || timePoints.length === 0) return;
    const variableSelect = document.getElementById('variableSelect');
    const colormapSelect = document.getElementById('colormapSelect');
    const selectedVariable = variableSelect.value;
    const selectedColormap = colormapSelect.value;
    const currentTime = timePoints[currentTimeIndex];
    
    console.log('Plotting with colormap:', selectedColormap);
    
    // Parse only the lines for this time step
    const timeData = parseTimeStepData(fileText, currentTime);
    if (timeData.length === 0) return;
    
    // Update vector data for current time step if vector file is loaded
    if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
        console.log(`Available vector time points: ${vectorTimePoints.join(', ')}`);
        console.log(`Current scalar time: ${currentTime}`);
        console.log(`Vector time index keys: ${Object.keys(vectorTimeIndex).join(', ')}`);
        
        // Check if the exact time exists in vector data
        if (vectorTimeIndex[currentTime]) {
            vectorData = parseVectorTimeStepData(vectorFileText, currentTime);
            console.log(`Updated vector data for time ${currentTime}: ${vectorData.length} vectors`);
        } else {
            // Try to find the closest time point
            const closestTime = vectorTimePoints.reduce((prev, curr) => 
                Math.abs(curr - currentTime) < Math.abs(prev - currentTime) ? curr : prev
            );
            console.log(`Exact time ${currentTime} not found in vector data, using closest: ${closestTime}`);
            vectorData = parseVectorTimeStepData(vectorFileText, closestTime);
            console.log(`Updated vector data for time ${closestTime}: ${vectorData.length} vectors`);
        }
    }
    
    // Create mesh grid (similar to np.meshgrid)
    const meshData = createMeshGrid(timeData, selectedVariable);
    
    // Calculate data ranges
    const allValues = meshData.z.flat().filter(val => !isNaN(val));
    if (allValues.length > 0) {
        currentDataRange = {
            min: Math.min(...allValues),
            max: Math.max(...allValues)
        };
    }
    
    // Calculate X and Z axis ranges
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
    
    // Use custom ranges if set, otherwise use data ranges
    const colorbarRange = customColorbarRange || currentDataRange;
    const xAxisRange = customXRange || currentXRange;
    const zAxisRange = customZRange || currentZRange;
    
    const traces = [];
    
    // Main heatmap trace
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
    
    // Add plotted points as scatter overlay if any exist
    if (plottedPoints.length > 0) {
        const colors = ['#20bf6b', '#0fb9b1', '#26de81', '#45aaf2'];
        
        for (let i = 0; i < plottedPoints.length; i++) {
            const point = plottedPoints[i];
            const scatterTrace = {
                x: [point.x],
                y: [point.z],
                type: 'scatter',
                mode: 'markers',
                marker: {
                    size: 12,
                    color: colors[i % colors.length],
                    line: {
                        color: 'white',
                        width: 2
                    },
                    symbol: 'circle'
                },
                name: `Point ${i + 1} (${point.x.toFixed(3)}, ${point.z.toFixed(3)})`,
                showlegend: false,
                hovertemplate: 
                    `Point ${i + 1}<br>` +
                    'X: %{x:.3f} km<br>' +
                    'Z: %{y:.3f} km<br>' +
                    '<extra></extra>'
            };
            traces.push(scatterTrace);
        }
    }
    
    // Add quiver plot if vector data is available
    if (vectorData && vectorData.length > 0) {
        console.log('Creating quiver plot with', vectorData.length, 'vectors');
        
        // Sample the vector data to avoid too many arrows
        const sampleStep = Math.max(1, Math.floor(vectorData.length / 1000)); // Increased to 1000 vectors
        const sampledData = vectorData.filter((_, index) => index % sampleStep === 0);
        console.log('Sampled', sampledData.length, 'vectors for plotting');
        
        const arrowScaleLocal = arrowScale;

        // Build arrays for all arrow lines and arrowheads
        let arrowX = [];
        let arrowY = [];
        let headX = [];
        let headY = [];

        sampledData.forEach(d => {
            // Arrow line: from (x, z) to (x+u*scale, z+v*scale)
            // For 2D x-z plot: u = x-component, v = z-component
            const x0 = d.x;
            const y0 = d.z;
            const u = d.u;
            const v = d.v;
            const mag = Math.sqrt(u*u + v*v);
            const logMag = Math.log10(mag + 1e-12); // Add epsilon to avoid log(0)
            // Direction
            let ux = 0, uy = 0;
            if (mag > 0) {
                ux = u / mag;
                uy = v / mag;
            }
            // Use log-magnitude for length, scaled by user scale
            const scale = Math.pow(10, arrowScaleLocal);
            const length = logMag * scale;
            const x1 = x0 + ux * length;
            const y1 = y0 + uy * length;
            arrowX.push(x0, x1, null);
            arrowY.push(y0, y1, null);

            // Arrowhead: short "V" at the tip
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.sqrt(dx*dx + dy*dy);
            if (len > 0) {
                const dirx = dx / len;
                const diry = dy / len;
                // Perpendicular vector
                const px = -diry;
                const py = dirx;
                // Arrowhead size - scale with the arrow
                const ah = Math.min(0.5, len * 0.2); // 20% of arrow length, max 0.5 km
                // Two points for the "V"
                const hx1 = x1 - dirx * ah + px * ah * 0.5;
                const hy1 = y1 - diry * ah + py * ah * 0.5;
                const hx2 = x1 - dirx * ah - px * ah * 0.5;
                const hy2 = y1 - diry * ah - py * ah * 0.5;
                headX.push(x1, hx1, null, x1, hx2, null);
                headY.push(y1, hy1, null, y1, hy2, null);
            }
        });

        console.log('Arrow arrays created - arrowX length:', arrowX.length, 'arrowY length:', arrowY.length);
        console.log('Sample arrow coordinates:', arrowX.slice(0, 6), arrowY.slice(0, 6));
        console.log('Sample vector data (first 3):', sampledData.slice(0, 3));
        console.log('Arrow scale being used:', arrowScaleLocal);
        
        // Debug: Check vector component ranges
        const uValues = sampledData.map(d => d.u);
        const vValues = sampledData.map(d => d.v);
        console.log('U component range:', Math.min(...uValues), 'to', Math.max(...uValues));
        console.log('V component range:', Math.min(...vValues), 'to', Math.max(...vValues));
        console.log('Sample U values:', uValues.slice(0, 5));
        console.log('Sample V values:', vValues.slice(0, 5));

        // Main arrow lines
        const arrowTrace = {
            x: arrowX,
            y: arrowY,
            type: 'scatter',
            mode: 'lines',
            line: { color: arrowColor, width: 2 },
            name: `${vectorType.charAt(0).toUpperCase() + vectorType.slice(1)} Flow`,
            hoverinfo: 'skip',
            showlegend: true
        };
        
        traces.push(arrowTrace);
        console.log('Added arrow trace to traces array. Total traces:', traces.length);
        
        // Arrowheads
        if (headX.length > 0) {
            const headTrace = {
                x: headX,
                y: headY,
                type: 'scatter',
                mode: 'lines',
                line: { color: arrowColor, width: 2 },
                hoverinfo: 'skip',
                showlegend: false
            };
            traces.push(headTrace);
            console.log('Added arrowhead trace. Total traces:', traces.length);
        }
    } else {
        console.log('No vector data available for quiver plot');
        console.log('vectorData:', vectorData);
        console.log('vectorFileText exists:', !!vectorFileText);
        console.log('vectorTimeIndex keys:', Object.keys(vectorTimeIndex));
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
        width: null, // Let Plotly auto-size the width
        autosize: true
    };
    
    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d'],
        displaylogo: false,
        useResizeHandler: true
    };
    
    console.log('About to plot with', traces.length, 'traces');
    console.log('Trace types:', traces.map(t => t.type));
    
    Plotly.newPlot('plotContainer', traces, layout, config);
    
    // Update range displays after plotting
    updateRangeDisplay();
    updateXRangeDisplay();
    updateZRangeDisplay();
}

// Create mesh grid from scattered data (similar to np.meshgrid + reshape)
function createMeshGrid(data, variable) {
    // Extract unique x and z coordinates
    const xCoords = [...new Set(data.map(row => row.x))].sort((a, b) => a - b);
    const zCoords = [...new Set(data.map(row => row.z))].sort((a, b) => a - b);
    
    // Create 2D array for the variable values
    const zMatrix = [];
    
    for (let i = 0; i < zCoords.length; i++) {
        const row = [];
        for (let j = 0; j < xCoords.length; j++) {
            // Find the data point at this x,z coordinate
            const point = data.find(d => 
                Math.abs(d.x - xCoords[j]) < 1e-10 && 
                Math.abs(d.z - zCoords[i]) < 1e-10
            );
            
            if (point) {
                row.push(point[variable]);
            } else {
                // If no data point found, use NaN or interpolate
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

// Get variable label for display
function getVariableLabel(variable) {
    const labels = {
        temperature: 'Temperature (°C)',
        pressure: 'Pressure (Pa)',
        saturation: 'Saturation',
        phase: 'Phase'
    };
    return labels[variable] || variable;
}

// Format value for display
function formatValue(value, variable) {
    if (variable === 'pressure') {
        return `${(value/1e8).toFixed(2)} ×10⁸ Pa`;
    } else if (variable === 'temperature') {
        return `${value.toFixed(1)} °C`;
    } else {
        return value.toFixed(3);
    }
}

// Get range of values
function getRange(values) {
    const validValues = values.filter(v => !isNaN(v) && isFinite(v));
    return {
        min: Math.min(...validValues),
        max: Math.max(...validValues)
    };
}



// Show/hide loading indicator
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

// Utility: Read file as text
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(new Error('Failed to read file'));
        reader.readAsText(file);
    });
}


// Event listeners for real-time updates
document.addEventListener('DOMContentLoaded', function() {
    const variableSelect = document.getElementById('variableSelect');
    const colormapSelect = document.getElementById('colormapSelect');
    const themeSelect = document.getElementById('themeSelect');
    const downloadTimeSeriesBtn = document.getElementById('downloadTimeSeriesBtn');
    
    variableSelect.addEventListener('change', function() {
        if (fileText) { // Only plot if fileText is loaded
            // Reset colorbar and axes when variable changes
            customColorbarRange = null;
            customXRange = null;
            customZRange = null;
            $("#slider-range").slider("values", [0, 100]);
            $("#x-slider-range").slider("values", [0, 100]);
            $("#z-slider-range").slider("values", [0, 100]);
            plotData();
        }
    });
    
    colormapSelect.addEventListener('change', function() {
        if (fileText) { // Only plot if fileText is loaded
            console.log('Colormap changed to:', this.value);
            plotData();
        }
    });
    
    themeSelect.addEventListener('change', function() {
        currentTheme = this.value;
        applyTheme(currentTheme);
        if (fileText) {
            plotData();
            plotTimeSeries();
        }
    });

    if (downloadTimeSeriesBtn) {
        downloadTimeSeriesBtn.addEventListener('click', function() {
            downloadTimeSeriesCSV();
        });
    }

    // Set default theme and arrow color on load
    applyTheme('dark');
    const arrowColorSelect = document.getElementById('arrowColorSelect');
    if (arrowColorSelect) {
        arrowColor = arrowColorSelect.value = '#ffffff';
    }
});

// Add keyboard navigation for time slider
document.addEventListener('keydown', function(e) {
    if (!fileText) return; // Only navigate if fileText is loaded
    
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

// Handle window resize to maintain plot sizing
window.addEventListener('resize', function() {
    if (fileText && timePoints.length > 0) {
        // Debounce resize events
        clearTimeout(window.resizeTimeout);
        window.resizeTimeout = setTimeout(() => {
            plotData();
        }, 250);
    }
});

// Plot time series for multiple spatial points
function plotTimeSeries() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }
    
    const selectedVariable = document.getElementById('timeSeriesVariable').value;
    
    // Collect all valid points
    const points = [];
    const colors = ['#20bf6b', '#0fb9b1', '#26de81', '#45aaf2'];
    
    for (let i = 1; i <= 4; i++) {
        const xCoord = parseFloat(document.getElementById(`xCoord${i}`).value);
        const zCoord = parseFloat(document.getElementById(`zCoord${i}`).value);
        
        if (!isNaN(xCoord) && !isNaN(zCoord)) {
            points.push({
                id: i,
                x: xCoord,
                z: zCoord,
                color: colors[i-1]
            });
        }
    }
    
    if (points.length === 0) {
        alert('Please enter valid coordinates for at least one point.');
        return;
    }
    
    // Store the plotted points for display on the main plot
    plottedPoints = points;
    
    // Collect time series data for all points
    const allTraces = [];
    
    for (const point of points) {
        const timeSeriesData = [];
        
        for (const time of timePoints) {
            const timeData = parseTimeStepData(fileText, time);
            
            // Find the closest point to the specified coordinates
            let closestPoint = null;
            let minDistance = Infinity;
            
            for (const dataPoint of timeData) {
                const distance = Math.sqrt(
                    Math.pow(dataPoint.x - point.x, 2) + 
                    Math.pow(dataPoint.z - point.z, 2)
                );
                
                if (distance < minDistance) {
                    minDistance = distance;
                    closestPoint = dataPoint;
                }
            }
            
            if (closestPoint && minDistance < 0.1) { // Within 0.1 km
                timeSeriesData.push({
                    time: time,
                    value: closestPoint[selectedVariable]
                });
            }
        }
        
        if (timeSeriesData.length > 0) {
            const trace = {
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
            };
            
            allTraces.push(trace);
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
    
    // Update the main plot to show the plotted points
    plotData();
}

// Load vector file
async function loadVectorFile() {
    const vectorFileInput = document.getElementById('vectorFileInput');
    const vectorTypeSelect = document.getElementById('vectorTypeSelect');
    const arrowScaleSlider = document.getElementById('arrowScaleSlider');
    
    const file = vectorFileInput.files[0];
    if (!file) {
        alert('Please select a vector file first.');
        return;
    }
    // Filename validation for vector file
    if (!file.name.startsWith('Plot_vector.')) {
        alert('Invalid file name. Please select a file that begins with "Plot_vector."');
        return;
    }
    
    try {
        console.log('Loading vector file:', file.name);
        vectorFileText = await readFileAsText(file);
        console.log('Vector file loaded, size:', vectorFileText.length);
        
        // Validate vector file format
        const formatValidation = validateVectorFileFormat(vectorFileText);
        if (!formatValidation.isValid) {
            throw new Error(`Invalid vector file format: ${formatValidation.error}`);
        }
        console.log('Vector file validation passed:', formatValidation.stats);
        
        // Build vector time index
        await buildVectorTimeIndex(vectorFileText);
        console.log('Vector time index built:', Object.keys(vectorTimeIndex));
        console.log('Vector time points:', vectorTimePoints);
        
        // Parse vector data for current time step
        const currentTime = timePoints[currentTimeIndex];
        console.log('Current time for vector loading:', currentTime);
        vectorData = parseVectorTimeStepData(vectorFileText, currentTime);
        console.log('Vector data loaded for time', currentTime, ':', vectorData.length, 'vectors');
        
        vectorType = vectorTypeSelect.value;
        arrowScale = parseFloat(arrowScaleSlider.value);
        
        // Update the main plot with vectors
        plotData();
        
    } catch (error) {
        console.error('Error processing vector file:', error);
        alert('Error processing vector file: ' + error.message);
    }
}

// Validate vector file format
function validateVectorFileFormat(text) {
    const lines = text.split('\n');
    let dataLines = 0;
    let validDataLines = 0;
    let hasHeader = false;
    
    // Check for header information
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('x  y') || trimmed.includes('(km)') || 
            trimmed.includes('(yr)') || trimmed.includes('(m/s)') || 
            trimmed.includes('(-)')) {
            hasHeader = true;
            break;
        }
    }
    
    // Check for data lines
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('x  y') ||
            trimmed.includes('(km)') || trimmed.includes('(yr)') ||
            trimmed.includes('(m/s)') || trimmed.includes('(-)') || trimmed.includes('No.')) {
            continue;
        }
        
        dataLines++;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 10) {
            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            const z = parseFloat(parts[2]);
            const time = parseFloat(parts[3]);
            
            // Check both water and steam components
            const waterU = parseFloat(parts[4]); // Column 5
            const waterV = parseFloat(parts[6]); // Column 7
            const steamU = parseFloat(parts[7]); // Column 8
            const steamV = parseFloat(parts[9]); // Column 10
            
            if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(time) &&
                (!isNaN(waterU) || !isNaN(steamU))) {
                validDataLines++;
            }
        }
    }
    
    // Validation criteria
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
                error: 'File contains data lines but none match the expected vector format (10+ columns: x, y, z, time, water_u, water_v, steam_u, steam_v)'
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
            dataLines: dataLines,
            validDataLines: validDataLines,
            validPercentage: validPercentage
        }
    };
}

// Build vector time index: { timeValue: [startLine, endLine] }
async function buildVectorTimeIndex(text) {
    vectorTimeIndex = {};
    vectorTimePoints = [];
    let currentTime = null;
    let startLine = 0;
    let lineNum = 0;
    const lines = text.split('\n');
    
    console.log('Building vector time index from', lines.length, 'lines');
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('.') || trimmed.includes('x  y') ||
            trimmed.includes('(km)') || trimmed.includes('(yr)') ||
            trimmed.includes('(m/s)') || trimmed.includes('(-)') || trimmed.includes('No.')) {
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
                    console.log('First vector time found:', time, 'at line', lineNum);
                } else if (time !== currentTime) {
                    // Save previous time range
                    vectorTimeIndex[currentTime] = [startLine, lineNum-1];
                    vectorTimePoints.push(currentTime);
                    console.log('Vector time range saved:', currentTime, 'lines', startLine, 'to', lineNum-1);
                    // Start new time
                    currentTime = time;
                    startLine = lineNum;
                }
            }
        }
        lineNum++;
    }
    // Save last time range
    if (currentTime !== null) {
        vectorTimeIndex[currentTime] = [startLine, lineNum-1];
        vectorTimePoints.push(currentTime);
        console.log('Last vector time range saved:', currentTime, 'lines', startLine, 'to', lineNum-1);
    }
    vectorTimePoints = Array.from(new Set(vectorTimePoints)).sort((a, b) => a - b);
    console.log('Final vector time points:', vectorTimePoints);
}

// Parse only the vector lines for the selected time step
function parseVectorTimeStepData(text, time) {
    console.log('Parsing vector data for time:', time);
    console.log('Vector time index for this time:', vectorTimeIndex[time]);
    
    if (!vectorTimeIndex[time]) {
        console.log('No vector time index found for time:', time);
        return [];
    }
    
    const [start, end] = vectorTimeIndex[time];
    console.log('Parsing vector lines from', start, 'to', end);
    const lines = text.split('\n').slice(start, end+1);
    console.log('Number of lines to parse:', lines.length);
    
    const data = [];
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 10) {
            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            const z = parseFloat(parts[2]);
            const timeVal = parseFloat(parts[3]);
            
            // Select columns based on vector type
            let u, v;
            if (vectorType === 'water') {
                u = parseFloat(parts[4]); // Column 5 (index 4)
                v = parseFloat(parts[6]); // Column 7 (index 6)
            } else if (vectorType === 'steam') {
                u = parseFloat(parts[7]); // Column 8 (index 7)
                v = parseFloat(parts[9]); // Column 10 (index 9)
            } else {
                // Default to water
                u = parseFloat(parts[4]);
                v = parseFloat(parts[6]);
            }
            
            if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(timeVal) &&
                !isNaN(u) && !isNaN(v)) {
                data.push({ x, y, z, time: timeVal, u, v });
            }
        }
        
        // Debug: Show first few lines with all columns
        if (data.length <= 3) {
            console.log('Raw line:', line);
            console.log('Parts:', parts);
            console.log('All columns:', parts.map((p, i) => `col${i}: ${p}`));
        }
    }
    
    console.log('Parsed', data.length, 'vector data points');
    if (data.length > 0) {
        console.log('Sample vector data:', data[0]);
    }
    
    return data;
}

// Clear vector data
function clearVectors() {
    vectorData = null;
    vectorFileText = null;
    vectorTimeIndex = {};
    vectorTimePoints = [];
    plotData();
}

// Setup vector controls
function setupVectorControls() {
    // Setup arrow scale slider
    const arrowScaleSlider = document.getElementById('arrowScaleSlider');
    const arrowScaleDisplay = document.getElementById('arrowScaleDisplay');
    
    // Set slider to default value if not already set
    arrowScaleSlider.value = -2.0;
    
    arrowScaleSlider.oninput = function() {
        arrowScale = parseFloat(this.value);
        const actualScale = Math.pow(10, arrowScale);
        // Format large numbers nicely
        let displayText;
        if (actualScale >= 1000000) {
            displayText = `Scale: ${(actualScale/1000000).toFixed(1)}Mx`;
        } else if (actualScale >= 1000) {
            displayText = `Scale: ${(actualScale/1000).toFixed(1)}Kx`;
        } else if (actualScale < 1) {
            displayText = `Scale: ${actualScale.toExponential(1)}x`;
        } else {
            displayText = `Scale: ${actualScale.toFixed(1)}x`;
        }
        arrowScaleDisplay.textContent = displayText;
        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            plotData();
        }
    };
    
    // Initialize the display
    const actualScale = Math.pow(10, arrowScale);
    let displayText;
    if (actualScale >= 1000000) {
        displayText = `Scale: ${(actualScale/1000000).toFixed(1)}Mx`;
    } else if (actualScale >= 1000) {
        displayText = `Scale: ${(actualScale/1000).toFixed(1)}Kx`;
    } else if (actualScale < 1) {
        displayText = `Scale: ${actualScale.toExponential(1)}x`;
    } else {
        displayText = `Scale: ${actualScale.toFixed(1)}x`;
    }
    arrowScaleDisplay.textContent = displayText;
    
    // Setup vector type change
    const vectorTypeSelect = document.getElementById('vectorTypeSelect');
    vectorTypeSelect.addEventListener('change', function() {
        vectorType = this.value;
        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            // Re-parse vector data with new type
            const currentTime = timePoints[currentTimeIndex];
            vectorData = parseVectorTimeStepData(vectorFileText, currentTime);
            plotData();
        }
    });

    // Setup arrow color dropdown
    const arrowColorSelect = document.getElementById('arrowColorSelect');
    arrowColor = arrowColorSelect.value;
    arrowColorSelect.addEventListener('change', function() {
        arrowColor = this.value;
        if (vectorFileText && Object.keys(vectorTimeIndex).length > 0) {
            plotData();
        }
    });
}

// Clear all point inputs
function clearAllPoints() {
    for (let i = 1; i <= 4; i++) {
        document.getElementById(`xCoord${i}`).value = '';
        document.getElementById(`zCoord${i}`).value = '';
    }
    
    // Clear plotted points from the main plot
    plottedPoints = [];
    plotData();
}

// Apply theme to the application
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    currentTheme = theme;
}

// Show time series section when data is loaded
function showTimeSeriesSection() {
    const timeSeriesSection = document.getElementById('timeSeriesSection');
    timeSeriesSection.style.display = 'block';
    
    // Auto-fill with valid coordinates from the first time step
    if (timePoints.length > 0) {
        const firstTimeData = parseTimeStepData(fileText, timePoints[0]);
        if (firstTimeData.length > 0) {
            // Get 4 different sample points
            const samplePoints = [];
            for (let i = 0; i < Math.min(4, firstTimeData.length); i++) {
                const index = Math.floor(i * firstTimeData.length / 4);
                samplePoints.push(firstTimeData[index]);
            }
            
            // Fill the coordinate inputs
            for (let i = 0; i < samplePoints.length; i++) {
                document.getElementById(`xCoord${i+1}`).value = samplePoints[i].x.toFixed(3);
                document.getElementById(`zCoord${i+1}`).value = samplePoints[i].z.toFixed(3);
            }
        }
    }
} 

function downloadTimeSeriesCSV() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }
    // Collect all valid points
    const points = [];
    for (let i = 1; i <= 4; i++) {
        const xCoord = parseFloat(document.getElementById(`xCoord${i}`).value);
        const zCoord = parseFloat(document.getElementById(`zCoord${i}`).value);
        if (!isNaN(xCoord) && !isNaN(zCoord)) {
            points.push({ x: xCoord, z: zCoord });
        }
    }
    if (points.length === 0) {
        alert('Please enter valid coordinates for at least one point.');
        return;
    }
    // Get selected variable
    const selectedVariable = document.getElementById('timeSeriesVariable').value;
    // Build CSV header
    let csv = 'time';
    for (let i = 0; i < points.length; i++) {
        csv += `,point${i+1}`;
    }
    csv += '\n';
    // For each time step, get value at each point
    for (let t = 0; t < timePoints.length; t++) {
        const time = timePoints[t];
        const timeData = parseTimeStepData(fileText, time);
        csv += `${time}`;
        for (let i = 0; i < points.length; i++) {
            // Find closest data point to (x, z)
            let minDist = Infinity;
            let value = '';
            for (const d of timeData) {
                const dist = Math.abs(d.x - points[i].x) + Math.abs(d.z - points[i].z);
                if (dist < minDist) {
                    minDist = dist;
                    value = d[selectedVariable];
                }
            }
            csv += `,${value}`;
        }
        csv += '\n';
    }
    // Download CSV
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

// Export GIF Animation of the main plot (one frame per time step)
async function exportGifAnimation() {
    if (!fileText || timePoints.length === 0) {
        alert('Please load a data file first.');
        return;
    }
    // Get user options
    const frameStep = Math.max(1, parseInt(document.getElementById('gifFrameStep').value) || 1);
    const resString = document.getElementById('gifResolution').value || '900x600';
    const [width, height] = resString.split('x').map(Number);
    const plotDiv = document.getElementById('plotContainer');
    const nFrames = timePoints.length;
    const folderName = `plot_frames_${Date.now()}`;
    const zip = new JSZip();
    zip.folder(folderName);
    // Show progress
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
        await new Promise(r => setTimeout(r, 100)); // Let plot render
        const pngDataUrl = await Plotly.toImage(plotDiv, {format: 'png', width, height});
        // Convert data URL to blob
        const res = await fetch(pngDataUrl);
        const blob = await res.blob();
        const filename = `${folderName}/frame_${String(i).padStart(3, '0')}.png`;
        zip.file(filename, blob);
        nExported++;
        progressDiv.textContent = `Exported frame ${nExported} (step ${i+1} of ${nFrames})`;
        await new Promise(r => setTimeout(r, 100)); // Throttle
    }
    progressDiv.textContent = `Zipping frames...`;
    const zipBlob = await zip.generateAsync({type: 'blob'});
    saveAs(zipBlob, `${folderName}.zip`);
    progressDiv.textContent = `Done! Unzip ${folderName}.zip, then run: convert -delay 5 *.png screens.gif`;
    setTimeout(() => progressDiv.remove(), 15000);
} 