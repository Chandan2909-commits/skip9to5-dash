// ═══════════════════════════════════════════════════════════════════
//  REJECTED PAYMENTS — Google Apps Script
//
//  Deploy as a Web App:
//    Execute as: Me
//    Who has access: Anyone
//
//  Paste the deployed URL into REJECTED_PAYMENTS_API_URL in script.js
// ═══════════════════════════════════════════════════════════════════

const SHEET_NAME = 'Rejected Payments';

function doGet(e) {
  e = e || { parameter: {} };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  // Create sheet with headers if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Transaction ID', 'Date', 'Full Name', 'Email', 'Phone', 'Service', 'Package', 'Amount', 'Rejected On']);
  }

  const action = e.parameter.action || '';

  // ── WRITE: reject a payment ──────────────────────────────────────
  if (action === 'reject') {
    sheet.appendRow([
      e.parameter.transactionId || '',
      e.parameter.date          || '',
      e.parameter.fullName      || '',
      e.parameter.email         || '',
      e.parameter.phone         || '',
      e.parameter.service       || '',
      e.parameter.package       || '',
      e.parameter.amount        || '',
      e.parameter.rejectedOn    || new Date().toLocaleString()
    ]);
    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── READ: return all rejected payments ───────────────────────────
  const rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, data: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const headers = rows[0];
  const data = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, data }))
    .setMimeType(ContentService.MimeType.JSON);
}
