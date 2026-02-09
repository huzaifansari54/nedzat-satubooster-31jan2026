const XLSX = require('xlsx');

/**
 * Converts an XLSX/XLS file into a tab-separated text string.
 * Limits sheets, rows, and columns to avoid bloating memory/AI context.
 * 
 * @param {string} absXlsx - Absolute path to the file
 * @param {number} maxSheets - Max number of sheets to process
 * @param {number} maxRows - Max number of rows per sheet
 * @param {number} maxCols - Max number of columns per row
 * @returns {string} Tab-separated text
 */
function xlsxToText(absXlsx, maxSheets = 3, maxRows = 60, maxCols = 20) {
    const wb = XLSX.readFile(absXlsx, { cellDates: true });
    const out = [];
    const sheetNames = (wb.SheetNames || []).slice(0, maxSheets);

    for (const sn of sheetNames) {
        const ws = wb.Sheets[sn];
        if (!ws) continue;
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
        out.push(`--- Sheet: ${sn} ---`);
        for (let r = 0; r < Math.min(rows.length, maxRows); r++) {
            const row = rows[r] || [];
            const cells = row.slice(0, maxCols).map(v => String(v ?? '').trim());
            if (cells.join('').length) out.push(cells.join('\t'));
        }
        out.push('');
    }
    return out.join('\n').trim();
}

module.exports = {
    xlsxToText
};
