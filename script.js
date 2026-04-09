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
            // replace the numeric PRINT 6 line
            lines[i + 2] = formatPrint6Line(tstep);
            replacements += 1;

            // remove the next line if it is exactly "1"
            if (i + 3 < lines.length && lines[i + 3].trim() === "1") {
                lines.splice(i + 3, 1);
            }

            // after removing "1", the old "10 1 10" line shifts into i+3
            if (i + 3 < lines.length && lines[i + 3].trim() === "10 1 10") {
                lines.splice(i + 3, 1);
            }
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

document.addEventListener("DOMContentLoaded", initializePrint6Converter);
