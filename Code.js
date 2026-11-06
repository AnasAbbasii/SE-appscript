/*********************************************************************
 * SE Foundation — Donation & Expense Database   (Code.gs  v3.1)
 * Six sheets only. Donation Records is the source of truth.
 * No test data is ever written. Setup/repair are idempotent.
 *********************************************************************/

/* ============================ CONSTANTS ============================ */
const APP = Object.freeze({
  VERSION: '3.1', HEADER_ROW: 3, DATA_START_ROW: 4,
  SHEETS: Object.freeze({
    DONATIONS: 'Donation Records', STUDENTS: 'Student Members', OUTSIDERS: 'Outsider Members',
    EXPENSES: 'Expenses', CONFIG: 'Configuration', PUBLIC: 'Public Data'
  }),
  PREFIXES: Object.freeze({ DONOR: 'DON-', EXPENSE: 'EXP-', RECORD: 'REC-' }),
  STATUS: Object.freeze({ PENDING: 'Pending', VERIFIED: 'Verified', REJECTED: 'Rejected' }),
  MONTH: Object.freeze({ PAID: 'Paid', UNPAID: 'Unpaid' })
});
const STATUS_LIST = [APP.STATUS.PENDING, APP.STATUS.VERIFIED, APP.STATUS.REJECTED];

const D = Object.freeze({ NAME: 1, DONOR_ID: 2, DATE: 3, AMOUNT: 4, UNIVERSITY: 5, DEPARTMENT: 6, CLASS: 7,
  WHATSAPP: 8, ROLL: 9, STATUS: 10, RECEIPT: 11, RECORD_ID: 12, CREATED_AT: 13, UPDATED_AT: 14 });
const S = Object.freeze({ NAME: 1, DONOR_ID: 2, COUNT: 3, TOTAL: 4, UNIVERSITY: 5, DEPARTMENT: 6, CLASS: 7,
  WHATSAPP: 8, EMAIL: 9, ROLL: 10, MONTH_STATUS: 11, LAST_DONATION: 12 });
const O = Object.freeze({ NAME: 1, CONTACT: 2, EMAIL: 3, DONOR_ID: 4, COUNT: 5, TOTAL: 6, STATUS: 7,
  RECEIPT: 8, RECORD_ID: 9, CREATED_AT: 10, UPDATED_AT: 11, MONTH_STATUS: 12 });
const E = Object.freeze({ ID: 1, DATE: 2, AMOUNT: 3, CATEGORY: 4, RECEIPT: 5, PERSONAL_DESCRIPTION: 6,
  DONATION_DESCRIPTION: 7, CONTRIBUTION: 8 });

const CFG = Object.freeze({
  ROWS: Object.freeze({ STATUS: 4, DONOR: 5, EXPENSE: 6, RECORD: 7, FOLDER: 8 }),
  LABELS: ['Valid Donation Status', 'Donor ID Prefix', 'Expense ID Prefix', 'Donation Record ID Prefix', 'Report Folder ID'],
  NOTES: ['Only donations with this status are counted (Pending / Verified / Rejected).',
    'Prefix for new Donor IDs.', 'Prefix for new Expense IDs.', 'Prefix for new donation Record IDs.',
    'Google Drive folder ID where reports are saved (leave blank until needed).'],
  CAT_COL: 5
});

/* sheet spec: title, subtitle, headers, [minWidth,maxWidth] per column, number formats */
const SPEC = Object.freeze({
  DONATIONS: { name: APP.SHEETS.DONATIONS, title: 'Donation Records', sub: 'Source of truth for all donations. Dates: yyyy-mm-dd.',
    headers: ['Name', 'Donor ID', 'Date', 'Donation Amount', 'University', 'Department', 'Class', 'WhatsApp Number', 'Roll Number', 'Verification Status', 'Receipt', 'Record ID', 'Created At', 'Updated At'],
    widths: [[110, 160], [80, 90], [80, 90], [90, 100], [100, 140], [90, 120], [55, 80], [100, 115], [75, 95], [95, 105], [70, 120], [80, 90], [105, 125], [105, 125]],
    fmt: { 3: 'yyyy-mm-dd', 4: '#,##0.00', 8: '@', 9: '@', 13: 'yyyy-mm-dd hh:mm', 14: 'yyyy-mm-dd hh:mm' } },
  STUDENTS: { name: APP.SHEETS.STUDENTS, title: 'Student Members', sub: 'Derived from Donation Records. Edit donors via the SE Foundation menu.',
    headers: ['Name', 'Donor ID', 'Total Donation Count', 'Total Donation Amount', 'University', 'Department', 'Class', 'WhatsApp Number', 'Email', 'Roll Number', 'Current Month Donation Status', 'Last Donation Date'],
    widths: [[110, 160], [80, 90], [75, 90], [95, 110], [100, 140], [90, 120], [55, 80], [100, 115], [130, 190], [75, 95], [100, 120], [90, 100]],
    fmt: { 3: '0', 4: '#,##0.00', 8: '@', 10: '@', 12: 'yyyy-mm-dd' } },
  OUTSIDERS: { name: APP.SHEETS.OUTSIDERS, title: 'Outsider Members', sub: 'Derived from Donation Records. Edit donors via the SE Foundation menu.',
    headers: ['Name', 'Contact (WhatsApp Number)', 'Email', 'Donor ID', 'Total Donation Count', 'Total Donation Amount', 'Verification Status', 'Receipt', 'Record ID', 'Created At', 'Updated At', 'Current Month Status'],
    widths: [[110, 160], [105, 120], [130, 190], [80, 90], [75, 90], [95, 110], [95, 105], [70, 120], [80, 90], [105, 125], [105, 125], [100, 120]],
    fmt: { 2: '@', 5: '0', 6: '#,##0.00', 10: 'yyyy-mm-dd hh:mm', 11: 'yyyy-mm-dd hh:mm', 12: '@' } },
  EXPENSES: { name: APP.SHEETS.EXPENSES, title: 'Expenses', sub: 'All expenses. Dates: yyyy-mm-dd.',
    headers: ['Expense ID', 'Date', 'Amount Spent', 'Expense Type / Category', 'Receipt', 'Personal Description', 'Donation Description', 'Contribution to Society'],
    widths: [[80, 90], [80, 90], [90, 100], [110, 150], [70, 120], [140, 220], [140, 220], [140, 220]],
    fmt: { 2: 'yyyy-mm-dd', 3: '#,##0.00' } }
});

/* ============================ ERRORS / LOCK ============================ */
let LOCK_HELD_ = false, CFG_CACHE_ = null, TZ_ = null;
function userError_(msg) { const e = new Error(msg); e.isUser = true; return e; }
function resetCache_() { CFG_CACHE_ = null; }

/** Public entry points take the lock ONCE; internal workers never lock. */
function withLock_(fn) {
  if (LOCK_HELD_) return fn(); // defensive: never nest
  const lock = LockService.getScriptLock();
  let got = false;
  for (let i = 0; i < 3 && !got; i++) { got = lock.tryLock(4000); if (!got) Utilities.sleep(350); }
  if (!got) throw userError_('The system is busy. Please try again in a moment.');
  LOCK_HELD_ = true;
  try { resetCache_(); return fn(); } finally { LOCK_HELD_ = false; lock.releaseLock(); }
}

/** Wrapper for server functions called from HTML: never returns raw stack traces. */
function api_(fn) {
  try { return Object.assign({ ok: true }, fn() || {}); }
  catch (e) {
    if (!e.isUser) console.error(e && e.stack ? e.stack : e);
    return { ok: false, error: e.isUser ? e.message : 'Something went wrong and the operation was not completed. Please try again, or run Repair Database.' };
  }
}
function alert_(msg, title) { try { SpreadsheetApp.getUi().alert(title || 'SE Foundation', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { console.log(msg); } }
function menuRun_(fn, okTitle) {
  try { const r = fn(); if (r && r.message) alert_(r.message, okTitle); }
  catch (e) { if (!e.isUser) console.error(e.stack || e); alert_(e.isUser ? e.message : 'Operation failed. Please try again or run Repair Database.', 'SE Foundation'); }
}

/* ============================ UTILITIES ============================ */
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function pad_(n, w) { let s = String(n); while (s.length < w) s = '0' + s; return s; }
function tz_() { return TZ_ || (TZ_ = SpreadsheetApp.getActive().getSpreadsheetTimeZone()); }
function fmtDate_(d) { return d instanceof Date && !isNaN(d) ? Utilities.formatDate(d, tz_(), 'yyyy-MM-dd') : ''; }
function monthKey_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM'); }
/** Parses YYYY-MM-DD in LOCAL time (never via UTC). Returns Date or null. */
function normalizeDate_(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = str_(v); if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null;
}
function toAmount_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  const s = str_(v).replace(/,/g, ''); if (!s || !/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}
function normText_(s) { return str_(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function normPhone_(s) { const d = str_(s).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; }
function normEmail_(s) { return str_(s).toLowerCase(); }
function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isDonationBlank_(r) { return !str_(r[D.NAME - 1]) && !str_(r[D.DONOR_ID - 1]) && !str_(r[D.AMOUNT - 1]) && !str_(r[D.DATE - 1]) && !str_(r[D.RECORD_ID - 1]); }
function isBlankRow_(r) { return r.every(function (c) { return str_(c) === ''; }); }
function isStudentRow_(r) { return !!(str_(r[D.UNIVERSITY - 1]) || str_(r[D.DEPARTMENT - 1]) || str_(r[D.CLASS - 1]) || str_(r[D.ROLL - 1])); }
function dice_(a, b) {
  a = normText_(a); b = normText_(b); if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const g = function (s) { const m = {}; for (let i = 0; i < s.length - 1; i++) { const k = s.substr(i, 2); m[k] = (m[k] || 0) + 1; } return m; };
  const x = g(a), y = g(b); let hit = 0;
  Object.keys(x).forEach(function (k) { if (y[k]) hit += Math.min(x[k], y[k]); });
  return (2 * hit) / (a.length + b.length - 2);
}
function normalizeReceipt_(v) {
  const s = str_(v); if (!s) return '';
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^[\w-]{20,}$/.test(s)) return 'https://drive.google.com/file/d/' + s + '/view';
  throw userError_('Receipt must be a Google Drive link or file ID.');
}
function normalizePhone_(v, required) {
  const s = str_(v); if (!s) { if (required) throw userError_('Please enter a WhatsApp number.'); return ''; }
  if (!/^\+?[\d\s\-()]{10,20}$/.test(s) || s.replace(/\D/g, '').length < 10 || s.replace(/\D/g, '').length > 15) throw userError_('Please enter a valid WhatsApp number (10–15 digits).');
  return s.replace(/[\s\-()]/g, '');
}

/* ============================ SHEET ACCESS ============================ */
function getSheet_(name, optional) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh && !optional) throw userError_('Sheet "' + name + '" is missing. Run SE Foundation → Repair Database.');
  return sh;
}
function readRows_(sh, ncols) {
  if (!sh) return [];
  const last = sh.getLastRow(); if (last < APP.DATA_START_ROW) return [];
  return sh.getRange(APP.DATA_START_ROW, 1, last - APP.DATA_START_ROW + 1, ncols).getValues();
}
function ensureRows_(sh, rowNeeded) { const max = sh.getMaxRows(); if (rowNeeded > max) sh.insertRowsAfter(max, Math.max(rowNeeded - max, 500)); }
function appendRow_(sh, values) {
  const row = Math.max(sh.getLastRow() + 1, APP.DATA_START_ROW);
  ensureRows_(sh, row); sh.getRange(row, 1, 1, values.length).setValues([values]); return row;
}
function findRowById_(sh, col, id) {
  const last = sh.getLastRow(); if (last < APP.DATA_START_ROW || !id) return 0;
  const vals = sh.getRange(APP.DATA_START_ROW, col, last - APP.DATA_START_ROW + 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (str_(vals[i][0]) === id) return i + APP.DATA_START_ROW;
  return 0;
}

/* ============================ CONFIGURATION ============================ */
function getConfig_() {

  if (CFG_CACHE_) return CFG_CACHE_;

  const sh = getSheet_(APP.SHEETS.CONFIG, true);

  let validStatus = '';
  let donorPrefix = '';
  let expensePrefix = '';
  let recordPrefix = '';
  let folderId = '';
  let cats = [];

  if (sh) {

    /*
     * Read configuration by label.
     *
     * Expected configuration labels:
     * Valid Donation Status
     * Donor ID Prefix
     * Expense ID Prefix
     * Donation Record ID Prefix
     * Report Folder ID
     */

    const lastRow = sh.getLastRow();

    if (lastRow > 0) {

      const values = sh.getRange(1, 1, lastRow, 2).getDisplayValues();

      values.forEach(function (row) {

        const label = str_(row[0]).trim().toLowerCase();
        const value = str_(row[1]).trim();

        if (!label) return;

        switch (label) {

          case 'valid donation status':
            validStatus = value;
            break;

          case 'donor id prefix':
            donorPrefix = value;
            break;

          case 'expense id prefix':
            expensePrefix = value;
            break;

          case 'donation record id prefix':
            recordPrefix = value;
            break;

          case 'report folder id':
            folderId = value;
            break;
        }
      });
    }

    /*
     * Read expense categories from the category column.
     */
    if (lastRow >= APP.DATA_START_ROW) {

      const seen = {};

      sh
        .getRange(
          APP.DATA_START_ROW,
          CFG.CAT_COL,
          lastRow - APP.DATA_START_ROW + 1,
          1
        )
        .getDisplayValues()
        .forEach(function (row) {

          const category = str_(row[0]).trim();

          if (
            category &&
            !seen[category.toLowerCase()]
          ) {
            seen[category.toLowerCase()] = 1;
            cats.push(category);
          }

        });
    }
  }

  CFG_CACHE_ = {

    validStatus:
      STATUS_LIST.indexOf(validStatus) >= 0
        ? validStatus
        : APP.STATUS.VERIFIED,

    donorPrefix:
      donorPrefix || APP.PREFIXES.DONOR,

    expensePrefix:
      expensePrefix || APP.PREFIXES.EXPENSE,

    recordPrefix:
      recordPrefix || APP.PREFIXES.RECORD,

    folderId:
      folderId || '',

    categories:
      cats
  };

  return CFG_CACHE_;
}


function prefixFor_(kind) {

  const c = getConfig_();

  return kind === 'DONOR'
    ? c.donorPrefix
    : kind === 'EXPENSE'
      ? c.expensePrefix
      : c.recordPrefix;
}

/* ============================ ID GENERATION ============================ */
/** Sequence = max(stored counter, highest number found in existing IDs) + 1. Call under lock. */
function idAllocator_(kind, existingIds) {
  const prefix = prefixFor_(kind), props = PropertiesService.getScriptProperties(), key = 'SEQ_' + kind;
  let max = parseInt(props.getProperty(key) || '0', 10) || 0;
  (existingIds || []).forEach(function (id) { const m = /(\d+)\s*$/.exec(str_(id)); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return { next: function () { max++; props.setProperty(key, String(max)); return prefix + pad_(max, 6); } };
}
function allDonorIds_() {
  const ids = [];
  readRows_(getSheet_(APP.SHEETS.DONATIONS), 14).forEach(function (r) { ids.push(r[D.DONOR_ID - 1]); });
  readRows_(getSheet_(APP.SHEETS.STUDENTS), 12).forEach(function (r) { ids.push(r[S.DONOR_ID - 1]); });
  readRows_(getSheet_(APP.SHEETS.OUTSIDERS), 12).forEach(function (r) { ids.push(r[O.DONOR_ID - 1]); });
  return ids;
}
function allRecordIds_() { return readRows_(getSheet_(APP.SHEETS.DONATIONS), 14).map(function (r) { return r[D.RECORD_ID - 1]; }); }
function allExpenseIds_() { return readRows_(getSheet_(APP.SHEETS.EXPENSES), 8).map(function (r) { return r[E.ID - 1]; }); }
function idPattern_(kind) { return new RegExp('^' + prefixFor_(kind).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d+$'); }

/* ============================ SETUP / FORMATTING ============================ */
/** Safe + idempotent. Creates missing sheets, headers (only if blank), formatting, validation, formulas, charts, triggers. */
function setupDatabase() {
  return withLock_(function () {
    ensureStructure_(); installTriggers_();
    return { message: 'Setup complete. The database is ready for real data.\nNext: enter your Report Folder ID in Configuration (optional).' };
  });
}
function ensureStructure_() {
  const ss = SpreadsheetApp.getActive();
  const scriptTz = Session.getScriptTimeZone();
  if (ss.getSpreadsheetTimeZone() !== scriptTz) ss.setSpreadsheetTimeZone(scriptTz); // keeps dates from shifting
  TZ_ = null;
  const order = [APP.SHEETS.DONATIONS, APP.SHEETS.STUDENTS, APP.SHEETS.OUTSIDERS, APP.SHEETS.EXPENSES, APP.SHEETS.CONFIG, APP.SHEETS.PUBLIC];
  order.forEach(function (n) { if (!ss.getSheetByName(n)) ss.insertSheet(n); });
  ss.getSheets().forEach(function (sh) { // remove only the untouched default sheet
    if (order.indexOf(sh.getName()) < 0 && /^Sheet ?1$/i.test(sh.getName()) && sh.getDataRange().isBlank() && ss.getSheets().length > order.length) ss.deleteSheet(sh);
  });
  ['DONATIONS', 'STUDENTS', 'OUTSIDERS', 'EXPENSES'].forEach(function (k) { formatDataSheet_(ss.getSheetByName(SPEC[k].name), SPEC[k]); });
  ensureConfigSheet_(ss.getSheetByName(APP.SHEETS.CONFIG));
  resetCache_();
  applyValidationAndRules_();
  ensurePublicData_(ss.getSheetByName(APP.SHEETS.PUBLIC));
  SpreadsheetApp.flush();
}
function titleRows_(sh, title, sub, ncols) {
  sh.getRange(1, 1).setValue(title).setFontSize(14).setFontWeight('bold').setFontColor('#1F3A5F');
  sh.getRange(2, 1).setValue(sub).setFontSize(9).setFontColor('#666666').setFontStyle('italic');
  sh.setRowHeight(1, 28);
}
function formatDataSheet_(sh, spec) {
  const n = spec.headers.length, max = sh.getMaxRows();
  titleRows_(sh, spec.title, spec.sub, n);
  const hdr = sh.getRange(APP.HEADER_ROW, 1, 1, n);
  const cur = hdr.getValues()[0];
  if (cur.every(function (c) { return str_(c) === ''; })) hdr.setValues([spec.headers]); // never overwrite existing headers
  hdr.setBackground('#1F3A5F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  sh.setRowHeight(APP.HEADER_ROW, 34);
  const body = sh.getRange(APP.DATA_START_ROW, 1, Math.max(max - APP.HEADER_ROW, 1), n);
  body.setFontSize(10).setVerticalAlignment('middle').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP)
    .setBorder(null, null, null, null, false, true, '#E3E8EF', SpreadsheetApp.BorderStyle.SOLID);
  Object.keys(spec.fmt).forEach(function (c) { sh.getRange(APP.DATA_START_ROW, +c, Math.max(max - APP.HEADER_ROW, 1), 1).setNumberFormat(spec.fmt[c]); });
  sh.setFrozenRows(APP.HEADER_ROW);
  if (!sh.getFilter()) sh.getRange(APP.HEADER_ROW, 1, Math.max(max - APP.HEADER_ROW + 1, 2), n).createFilter();
  autoFitSheetColumns_(sh, spec.widths);
}
/** Auto-fit, then clamp every column to [min,max] so long URLs/descriptions can't blow up the width. */
function autoFitSheetColumns_(sh, widths) {
  const n = widths.length;
  sh.autoResizeColumns(1, n);
  for (let c = 1; c <= n; c++) {
    const w = Math.min(Math.max(sh.getColumnWidth(c), widths[c - 1][0]), widths[c - 1][1]);
    setWidth_(sh, c, w);
  }
}
function setWidth_(sh, col, w) {
  if (!Number.isInteger(col) || col < 1 || !isFinite(w)) throw new Error('Invalid column width call: ' + col + ',' + w);
  sh.setColumnWidth(col, Math.round(w));
}
function ensureConfigSheet_(sh) {
  titleRows_(sh, 'Configuration', 'Central settings. Values are read live by the system.', 5);
  const hdr = sh.getRange(APP.HEADER_ROW, 1, 1, 5);
  if (str_(sh.getRange(APP.HEADER_ROW, 1).getValue()) === '') sh.getRange(APP.HEADER_ROW, 1, 1, 3).setValues([['Setting', 'Value', 'Notes']]);
  if (str_(sh.getRange(APP.HEADER_ROW, CFG.CAT_COL).getValue()) === '') sh.getRange(APP.HEADER_ROW, CFG.CAT_COL).setValue('Expense Categories');
  hdr.setBackground('#1F3A5F').setFontColor('#FFFFFF').setFontWeight('bold');
  const defaults = [APP.STATUS.VERIFIED, APP.PREFIXES.DONOR, APP.PREFIXES.EXPENSE, APP.PREFIXES.RECORD, ''];
  for (let i = 0; i < 5; i++) {
    const r = CFG.ROWS.STATUS + i;
    sh.getRange(r, 1).setValue(CFG.LABELS[i]).setFontWeight('bold');
    sh.getRange(r, 3).setValue(CFG.NOTES[i]).setFontColor('#666666').setFontSize(9);
    const v = sh.getRange(r, 2); if (str_(v.getValue()) === '' && defaults[i] !== '') v.setValue(defaults[i]);
    v.setNumberFormat('@').setBackground('#FFF8E1');
  }
  sh.getRange(CFG.ROWS.STATUS, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUS_LIST, true).setAllowInvalid(false).build());
  sh.getRange(APP.DATA_START_ROW, CFG.CAT_COL).setNote('List your expense categories in this column, one per row. The Expenses dropdown follows this list. Leave empty for free-text categories.');
  sh.setFrozenRows(APP.HEADER_ROW);
  setWidth_(sh, 1, 170); setWidth_(sh, 2, 140); setWidth_(sh, 3, 330); setWidth_(sh, 4, 20); setWidth_(sh, 5, 160);
}
function applyValidationAndRules_() {
  const ss = SpreadsheetApp.getActive(), R0 = APP.DATA_START_ROW;
  const rowsOf = function (sh) { return Math.max(sh.getMaxRows() - APP.HEADER_ROW, 1); };
  const list = function (vals) { return SpreadsheetApp.newDataValidation().requireValueInList(vals, true).setAllowInvalid(false).build(); };
  const don = ss.getSheetByName(APP.SHEETS.DONATIONS), stu = ss.getSheetByName(APP.SHEETS.STUDENTS), out = ss.getSheetByName(APP.SHEETS.OUTSIDERS);
  [[don, D.STATUS], [don, D.DATE], [don, D.AMOUNT], [stu, S.MONTH_STATUS], [out, O.STATUS], [out, O.MONTH_STATUS]].forEach(function (p) {
    p[0].getRange(R0, p[1], rowsOf(p[0]), 1).clearDataValidations();
  });
  don.getRange(R0, D.STATUS, rowsOf(don), 1).setDataValidation(list(STATUS_LIST));
  don.getRange(R0, D.DATE, rowsOf(don), 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).setHelpText('Enter a valid date (yyyy-mm-dd).').build());
  don.getRange(R0, D.AMOUNT, rowsOf(don), 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false).setHelpText('Amount must be greater than 0.').build());
  stu.getRange(R0, S.MONTH_STATUS, rowsOf(stu), 1).setDataValidation(list([APP.MONTH.PAID, APP.MONTH.UNPAID]));
  out.getRange(R0, O.MONTH_STATUS, rowsOf(out), 1).setDataValidation(list([APP.MONTH.PAID, APP.MONTH.UNPAID]));
  applyExpenseValidation_();
  const col = function (sh, c, text, bg) { return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg).setRanges([sh.getRange(R0, c, rowsOf(sh), 1)]).build(); };
  don.setConditionalFormatRules([col(don, D.STATUS, 'Verified', '#E6F4EA'), col(don, D.STATUS, 'Pending', '#FEF7E0'), col(don, D.STATUS, 'Rejected', '#FCE8E6')]);
  stu.setConditionalFormatRules([col(stu, S.MONTH_STATUS, 'Paid', '#E6F4EA'), col(stu, S.MONTH_STATUS, 'Unpaid', '#FCE8E6')]);
  out.setConditionalFormatRules([
    col(out, O.STATUS, 'Verified', '#E6F4EA'), col(out, O.STATUS, 'Pending', '#FEF7E0'), col(out, O.STATUS, 'Rejected', '#FCE8E6'),
    col(out, O.MONTH_STATUS, 'Paid', '#E6F4EA'), col(out, O.MONTH_STATUS, 'Unpaid', '#FCE8E6')
  ]);
}
/** Clears stale rules first, then rebuilds from Configuration. */
function applyExpenseValidation_() {
  const sh = getSheet_(APP.SHEETS.EXPENSES), rows = Math.max(sh.getMaxRows() - APP.HEADER_ROW, 1);
  const cats = getConfig_().categories;
  sh.getRange(APP.DATA_START_ROW, E.CATEGORY, rows, 1).clearDataValidations();
  sh.getRange(APP.DATA_START_ROW, E.DATE, rows, 1).clearDataValidations();
  sh.getRange(APP.DATA_START_ROW, E.AMOUNT, rows, 1).clearDataValidations();
  if (cats.length) sh.getRange(APP.DATA_START_ROW, E.CATEGORY, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(cats, true).setAllowInvalid(false).build());
  sh.getRange(APP.DATA_START_ROW, E.DATE, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  sh.getRange(APP.DATA_START_ROW, E.AMOUNT, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false).build());
}

/* ============================ PUBLIC DATA ============================ */
function ensurePublicData_(sh) {
  sh.clear(); sh.setFrozenRows(0);
  const V = "Configuration!$B$" + CFG.ROWS.STATUS, DR = "'Donation Records'!", ER = 'Expenses!';
  const start = 'DATE(YEAR(TODAY()),MONTH(TODAY()),1)';
  sh.getRange('A1').setValue('SE Foundation — Public Financial Summary').setFontSize(14).setFontWeight('bold').setFontColor('#1F3A5F');
  sh.getRange('A2').setValue('Aggregate figures only. No donor information is shown here.').setFontSize(9).setFontColor('#666666').setFontStyle('italic');
  sh.getRange('A3:B3').setValues([['Metric', 'Value']]);
  sh.getRange('A4:A9').setValues([['Total Number of Donations'], ['Total Donation Collected'], ['Total Expense'], ['Current Account Balance'], ['Current Month Donations'], ['Current Month Expenses']]);
  sh.getRange('B4:B9').setFormulas([
    ['=COUNTIFS(' + DR + '$J$4:$J,' + V + ')'],
    ['=SUMIFS(' + DR + '$D$4:$D,' + DR + '$J$4:$J,' + V + ')'],
    ['=SUM(' + ER + '$C$4:$C)'],
    ['=B5-B6'],
    ['=SUMIFS(' + DR + '$D$4:$D,' + DR + '$J$4:$J,' + V + ',' + DR + '$C$4:$C,">="&' + start + ',' + DR + '$C$4:$C,"<"&EDATE(' + start + ',1))'],
    ['=SUMIFS(' + ER + '$C$4:$C,' + ER + '$B$4:$B,">="&' + start + ',' + ER + '$B$4:$B,"<"&EDATE(' + start + ',1))']
  ]);
  sh.getRange('D3:F3').setValues([['Month', 'Donations', 'Expenses']]);
  const f = [];
  for (let i = 0; i < 12; i++) {
    const r = 4 + i, d = 'D' + r;
    f.push([i === 0 ? '=EDATE(' + start + ',-11)' : '=EDATE(D' + (r - 1) + ',1)',
      '=SUMIFS(' + DR + '$D$4:$D,' + DR + '$J$4:$J,' + V + ',' + DR + '$C$4:$C,">="&' + d + ',' + DR + '$C$4:$C,"<"&EDATE(' + d + ',1))',
      '=SUMIFS(' + ER + '$C$4:$C,' + ER + '$B$4:$B,">="&' + d + ',' + ER + '$B$4:$B,"<"&EDATE(' + d + ',1))']);
  }
  sh.getRange('D4:F15').setFormulas(f);
  ['A3:B3', 'D3:F3'].forEach(function (a) { sh.getRange(a).setBackground('#1F3A5F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center'); });
  sh.getRange('A4:B9').setBorder(true, true, true, true, true, true, '#E3E8EF', SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('D4:F15').setBorder(true, true, true, true, true, true, '#E3E8EF', SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('B4').setNumberFormat('0'); sh.getRange('B5:B9').setNumberFormat('#,##0.00'); sh.getRange('B4:B9').setFontWeight('bold');
  sh.getRange('D4:D15').setNumberFormat('mmm yyyy'); sh.getRange('E4:F15').setNumberFormat('#,##0.00');
  [190, 110, 20, 80, 100, 100].forEach(function (w, i) { setWidth_(sh, i + 1, w); });
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.COLUMN).addRange(sh.getRange('A5:B7')).setNumHeaders(0)
    .setPosition(17, 1, 0, 0).setOption('title', 'Collected vs Expense vs Balance').setOption('legend', { position: 'none' })
    .setOption('colors', ['#1F3A5F']).setOption('width', 440).setOption('height', 260).build());
  sh.insertChart(sh.newChart().setChartType(Charts.ChartType.COLUMN).addRange(sh.getRange('D3:F15')).setNumHeaders(1)
    .setPosition(31, 1, 0, 0).setOption('title', 'Monthly Donations vs Expenses (last 12 months)').setOption('legend', { position: 'bottom' })
    .setOption('colors', ['#2E7D32', '#C62828']).setOption('width', 600).setOption('height', 280).build());
}

/* ============================ TRIGGERS ============================ */
function installTriggers_() {
  const ss = SpreadsheetApp.getActive(), all = ScriptApp.getProjectTriggers(), seen = {};
  all.forEach(function (t) { // remove duplicates, keep one per handler
    const h = t.getHandlerFunction();
    if (seen[h]) ScriptApp.deleteTrigger(t); else seen[h] = true;
  });
  if (!seen.handleEdit) ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
  if (!seen.handleChange) ScriptApp.newTrigger('handleChange').forSpreadsheet(ss).onChange().create();
  if (!seen.handleMonthlyResetTrigger) ScriptApp.newTrigger('handleMonthlyResetTrigger').timeBased().everyDays(1).atHour(1).create();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('SE Foundation')
    .addItem('Donation Form', 'showDonationForm')
    .addItem('Search & Manage Donors', 'searchDonor')
    .addItem('Expense Form', 'showExpenseForm')
    .addItem('Admin Panel', 'showAdminPanel')
    .addSeparator()
    .addItem('Synchronize Database', 'menuSynchronize')
    .addItem('Repair Database', 'menuRepair')
    .addItem('Reset Monthly Status', 'menuReset')
    .addItem('Generate Report', 'menuReport')
    .addToUi();
}

/** Installable onEdit. Takes the lock once, processes, synchronizes once. */
function handleEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet(), name = sh.getName(), r1 = e.range.getRow(), r2 = e.range.getLastRow(), c1 = e.range.getColumn();
    if (r2 < APP.DATA_START_ROW) return;
    const first = Math.max(r1, APP.DATA_START_ROW);
    if (name === APP.SHEETS.DONATIONS) {
      withLock_(function () { ensureDonationRows_(c1 <= D.RECEIPT ? first : 0, r2); syncMembers_(); });
    } else if (name === APP.SHEETS.EXPENSES) {
      withLock_(function () { ensureExpenseRows_(); });
    } else if (name === APP.SHEETS.STUDENTS || name === APP.SHEETS.OUTSIDERS) {
      withLock_(function () { syncMembers_(); });
    } else if (name === APP.SHEETS.CONFIG) {
      withLock_(function () {
        if (e.range.getColumn() === 2 && first <= CFG.ROWS.STATUS && r2 >= CFG.ROWS.STATUS && STATUS_LIST.indexOf(str_(sh.getRange(CFG.ROWS.STATUS, 2).getValue())) < 0) {
          sh.getRange(CFG.ROWS.STATUS, 2).setValue(e.oldValue && STATUS_LIST.indexOf(e.oldValue) >= 0 ? e.oldValue : APP.STATUS.VERIFIED);
          SpreadsheetApp.getActive().toast('Valid Donation Status must be Pending, Verified or Rejected.', 'SE Foundation', 6);
        }
        resetCache_();
        if (c1 <= CFG.CAT_COL && e.range.getLastColumn() >= CFG.CAT_COL) applyExpenseValidation_();
        syncMembers_();
      });
    }
  } catch (err) { console.error('handleEdit: ' + (err && err.message)); }
}
function handleChange(e) {
  try { if (e && (e.changeType === 'REMOVE_ROW' || e.changeType === 'REMOVE_COLUMN')) withLock_(function () { syncMembers_(); }); }
  catch (err) { console.error('handleChange: ' + (err && err.message)); }
}
/** Daily trigger; acts only on the 1st. Safe to run repeatedly. Never touches donation history. */
function handleMonthlyResetTrigger() {
  const today = new Date();
  if (today.getDate() !== 1) return;
  return resetMonthlyDonationStatus();
}
function resetMonthlyDonationStatus() {
  return withLock_(function () { const n = syncMembers_(); return { message: 'Monthly status recalculated for ' + n.students + ' student donor(s) and ' + n.outsiders + ' outsider donor(s).' }; });
}

/* ============================ DONATION ROW PROCESSING ============================ */
/** Assigns missing/duplicate IDs, normalizes dates/status, stamps timestamps. No sync here. Caller holds lock. */
function ensureDonationRows_(stampFrom, stampTo) {
  const sh = getSheet_(APP.SHEETS.DONATIONS), last = sh.getLastRow();
  if (last < APP.DATA_START_ROW) return 0;
  const rng = sh.getRange(APP.DATA_START_ROW, 1, last - APP.DATA_START_ROW + 1, 14), rows = rng.getValues();
  const recAlloc = idAllocator_('RECORD', allRecordIds_()), donAlloc = idAllocator_('DONOR', allDonorIds_());
  const index = buildDonorIndex_(rows), seenRec = {}; let changed = 0; const now = new Date();
  rows.forEach(function (r, i) {
    if (isDonationBlank_(r)) return;
    const sheetRow = i + APP.DATA_START_ROW; let ch = false;
    const dt = normalizeDate_(r[D.DATE - 1]);
    if (dt && !(r[D.DATE - 1] instanceof Date)) { r[D.DATE - 1] = dt; ch = true; }
    if (!str_(r[D.STATUS - 1])) { r[D.STATUS - 1] = APP.STATUS.PENDING; ch = true; }
    let rid = str_(r[D.RECORD_ID - 1]);
    if (!rid || seenRec[rid]) { rid = recAlloc.next(); r[D.RECORD_ID - 1] = rid; ch = true; }
    seenRec[rid] = true;
    if (!str_(r[D.DONOR_ID - 1])) {
      const hit = matchIndexStrict_(index, r);
      const id = hit || donAlloc.next();
      r[D.DONOR_ID - 1] = id; ch = true;
      index.push({ id: id, wa: normPhone_(r[D.WHATSAPP - 1]), roll: normText_(r[D.ROLL - 1]), uni: normText_(r[D.UNIVERSITY - 1]), name: normText_(r[D.NAME - 1]) });
    }
    if (!r[D.CREATED_AT - 1]) { r[D.CREATED_AT - 1] = now; ch = true; }
    if ((stampFrom && sheetRow >= stampFrom && sheetRow <= stampTo) || !r[D.UPDATED_AT - 1]) { r[D.UPDATED_AT - 1] = now; ch = true; }
    if (ch) changed++;
  });
  if (changed) rng.setValues(rows);
  return changed;
}
function buildDonorIndex_(donationRows) {
  const idx = [];
  readRows_(getSheet_(APP.SHEETS.STUDENTS), 12).forEach(function (r) {
    if (str_(r[S.DONOR_ID - 1])) idx.push({ id: str_(r[S.DONOR_ID - 1]), wa: normPhone_(r[S.WHATSAPP - 1]), roll: normText_(r[S.ROLL - 1]), uni: normText_(r[S.UNIVERSITY - 1]), name: normText_(r[S.NAME - 1]), email: normEmail_(r[S.EMAIL - 1]) });
  });
  readRows_(getSheet_(APP.SHEETS.OUTSIDERS), 12).forEach(function (r) {
    if (str_(r[O.DONOR_ID - 1])) idx.push({ id: str_(r[O.DONOR_ID - 1]), wa: normPhone_(r[O.CONTACT - 1]), roll: '', uni: '', name: normText_(r[O.NAME - 1]), email: normEmail_(r[O.EMAIL - 1]) });
  });
  (donationRows || []).forEach(function (r) {
    if (str_(r[D.DONOR_ID - 1])) idx.push({ id: str_(r[D.DONOR_ID - 1]), wa: normPhone_(r[D.WHATSAPP - 1]), roll: normText_(r[D.ROLL - 1]), uni: normText_(r[D.UNIVERSITY - 1]), name: normText_(r[D.NAME - 1]) });
  });
  return idx;
}
/** Strict auto-match for manual sheet rows: same roll+university, or same phone AND same name. Never name alone. */
function matchIndexStrict_(index, r) {
  const roll = normText_(r[D.ROLL - 1]), uni = normText_(r[D.UNIVERSITY - 1]), wa = normPhone_(r[D.WHATSAPP - 1]), nm = normText_(r[D.NAME - 1]);
  for (let i = 0; i < index.length; i++) {
    const x = index[i];
    if (roll && x.roll === roll && x.uni === uni) return x.id;
    if (wa && x.wa === wa && nm && x.name === nm) return x.id;
  }
  return '';
}
function ensureExpenseRows_() {
  const sh = getSheet_(APP.SHEETS.EXPENSES), last = sh.getLastRow();
  if (last < APP.DATA_START_ROW) return 0;
  const rng = sh.getRange(APP.DATA_START_ROW, 1, last - APP.DATA_START_ROW + 1, 8), rows = rng.getValues();
  const alloc = idAllocator_('EXPENSE', allExpenseIds_()), seen = {}; let changed = 0;
  rows.forEach(function (r) {
    if (isBlankRow_(r)) return; let ch = false;
    let id = str_(r[E.ID - 1]);
    if (!id || seen[id]) { id = alloc.next(); r[E.ID - 1] = id; ch = true; }
    seen[id] = true;
    const dt = normalizeDate_(r[E.DATE - 1]); if (dt && !(r[E.DATE - 1] instanceof Date)) { r[E.DATE - 1] = dt; ch = true; }
    if (ch) changed++;
  });
  if (changed) rng.setValues(rows);
  return changed;
}

/* ============================ MEMBER SYNCHRONIZATION ============================ */
/** Rebuilds derived member columns from Donation Records. Existing profile/email/created values are preserved. Caller holds lock. */
function syncMembers_() {
  const res = computeMembers_(true);
  writeMemberRows_(getSheet_(APP.SHEETS.STUDENTS), res.students, 12);
  writeMemberRows_(getSheet_(APP.SHEETS.OUTSIDERS), res.outsiders, 12);
  return { students: res.students.length, outsiders: res.outsiders.length };
}
function writeMemberRows_(sh, rows, n) {
  const last = sh.getLastRow();
  if (last >= APP.DATA_START_ROW) sh.getRange(APP.DATA_START_ROW, 1, last - APP.DATA_START_ROW + 1, n).clearContent();
  if (rows.length) { ensureRows_(sh, APP.HEADER_ROW + rows.length); sh.getRange(APP.DATA_START_ROW, 1, rows.length, n).setValues(rows); }
}
function computeMembers_(allocate) {
  const cfg = getConfig_(), now = new Date(), mk = monthKey_(now);
  const dRows = readRows_(getSheet_(APP.SHEETS.DONATIONS), 14);
  const sRows = readRows_(getSheet_(APP.SHEETS.STUDENTS), 12), oRows = readRows_(getSheet_(APP.SHEETS.OUTSIDERS), 12);
  const agg = {}, aggOrder = [];
  dRows.forEach(function (r) {
    const id = str_(r[D.DONOR_ID - 1]); if (!id) return;
    let a = agg[id]; if (!a) { a = agg[id] = { count: 0, total: 0, last: null, paid: false, latest: null, latestT: -1 }; aggOrder.push(id); }
    const date = normalizeDate_(r[D.DATE - 1]), amt = toAmount_(r[D.AMOUNT - 1]);
    if (str_(r[D.STATUS - 1]) === cfg.validStatus && isFinite(amt)) {
      a.count++; a.total += amt;
      if (date) { if (!a.last || date > a.last) a.last = date; if (monthKey_(date) === mk) a.paid = true; }
    }
    const t = date ? date.getTime() : 0;
    if (!a.latest || t >= a.latestT) { a.latest = r; a.latestT = t; }
  });
  const alloc = allocate ? idAllocator_('DONOR', allDonorIds_()) : null;
  const sEnt = [], oEnt = [], sMap = {}, oMap = {};
  sRows.forEach(function (r) {
    if (isBlankRow_(r)) return; let id = str_(r[S.DONOR_ID - 1]);
    if (!id && alloc) id = alloc.next();
    const ent = { r: r.slice(), id: id, dup: !id || !!sMap[id] }; r[S.DONOR_ID - 1] = id; ent.r[S.DONOR_ID - 1] = id;
    if (id && !sMap[id]) sMap[id] = ent; sEnt.push(ent);
  });
  oRows.forEach(function (r) {
    if (isBlankRow_(r)) return; let id = str_(r[O.DONOR_ID - 1]);
    if (!id && alloc) id = alloc.next();
    const ent = { r: r.slice(), id: id, dup: !id || !!oMap[id] || !!sMap[id] }; ent.r[O.DONOR_ID - 1] = id;
    if (id && !oMap[id]) oMap[id] = ent; oEnt.push(ent);
  });
  aggOrder.forEach(function (id) { // donors that only exist in donations
    if (sMap[id] || oMap[id]) return;
    const l = agg[id].latest;
    if (isStudentRow_(l)) { const e = { r: new Array(12).fill(''), id: id, dup: false, fresh: true }; e.r[S.DONOR_ID - 1] = id; sMap[id] = e; sEnt.push(e); }
    else { const e = { r: new Array(12).fill(''), id: id, dup: false, fresh: true }; e.r[O.DONOR_ID - 1] = id; oMap[id] = e; oEnt.push(e); }
  });
  const fill = function (r, i, v) { if (str_(r[i]) === '' && str_(v) !== '') r[i] = v; };
  const students = sEnt.map(function (ent) {
    if (ent.dup) return ent.r;
    const r = ent.r, a = agg[ent.id];
    if (a) {
      const l = a.latest;
      fill(r, S.NAME - 1, l[D.NAME - 1]); fill(r, S.UNIVERSITY - 1, l[D.UNIVERSITY - 1]); fill(r, S.DEPARTMENT - 1, l[D.DEPARTMENT - 1]);
      fill(r, S.CLASS - 1, l[D.CLASS - 1]); fill(r, S.WHATSAPP - 1, l[D.WHATSAPP - 1]); fill(r, S.ROLL - 1, l[D.ROLL - 1]);
    }
    r[S.COUNT - 1] = a ? a.count : 0; r[S.TOTAL - 1] = a ? a.total : 0;
    r[S.MONTH_STATUS - 1] = a && a.paid ? APP.MONTH.PAID : APP.MONTH.UNPAID; r[S.LAST_DONATION - 1] = a && a.last ? a.last : '';
    return r;
  });
  const outsiders = oEnt.map(function (ent) {
    if (ent.dup) return ent.r;
    const r = ent.r, a = agg[ent.id], before = JSON.stringify([r[O.COUNT - 1], r[O.TOTAL - 1], r[O.STATUS - 1], r[O.RECEIPT - 1], r[O.RECORD_ID - 1], r[O.NAME - 1], r[O.CONTACT - 1], r[O.EMAIL - 1], r[O.MONTH_STATUS - 1]]);
    if (a) {
      const l = a.latest;
      fill(r, O.NAME - 1, l[D.NAME - 1]); fill(r, O.CONTACT - 1, l[D.WHATSAPP - 1]);
      r[O.STATUS - 1] = l[D.STATUS - 1]; r[O.RECEIPT - 1] = l[D.RECEIPT - 1]; r[O.RECORD_ID - 1] = l[D.RECORD_ID - 1];
    }
    r[O.COUNT - 1] = a ? a.count : 0; r[O.TOTAL - 1] = a ? a.total : 0;
    r[O.MONTH_STATUS - 1] = a && a.paid ? APP.MONTH.PAID : APP.MONTH.UNPAID;
    if (!r[O.CREATED_AT - 1]) r[O.CREATED_AT - 1] = now;
    const after = JSON.stringify([r[O.COUNT - 1], r[O.TOTAL - 1], r[O.STATUS - 1], r[O.RECEIPT - 1], r[O.RECORD_ID - 1], r[O.NAME - 1], r[O.CONTACT - 1], r[O.EMAIL - 1], r[O.MONTH_STATUS - 1]]);
    if (before !== after || !r[O.UPDATED_AT - 1]) r[O.UPDATED_AT - 1] = now;
    return r;
  });
  return { students: students, outsiders: outsiders };
}
function synchronizeDatabase() {
  return withLock_(function () { ensureDonationRows_(0, 0); ensureExpenseRows_(); const n = syncMembers_(); return { message: 'Database synchronized.\nStudents: ' + n.students + '   Outsiders: ' + n.outsiders }; });
}

/* ============================ DONOR PROFILES / SEARCH ============================ */
function profileFromStudent_(r) {
  return { type: 'Student', donorId: str_(r[S.DONOR_ID - 1]), name: str_(r[S.NAME - 1]), whatsapp: str_(r[S.WHATSAPP - 1]), email: str_(r[S.EMAIL - 1]),
    university: str_(r[S.UNIVERSITY - 1]), department: str_(r[S.DEPARTMENT - 1]), className: str_(r[S.CLASS - 1]), roll: str_(r[S.ROLL - 1]),
    count: Number(r[S.COUNT - 1]) || 0, total: Number(r[S.TOTAL - 1]) || 0, monthStatus: str_(r[S.MONTH_STATUS - 1]), lastDonation: fmtDate_(r[S.LAST_DONATION - 1]) };
}
function profileFromOutsider_(r) {
  return { type: 'Outsider', donorId: str_(r[O.DONOR_ID - 1]), name: str_(r[O.NAME - 1]), whatsapp: str_(r[O.CONTACT - 1]), email: str_(r[O.EMAIL - 1]),
    university: '', department: '', className: '', roll: '', count: Number(r[O.COUNT - 1]) || 0, total: Number(r[O.TOTAL - 1]) || 0, monthStatus: str_(r[O.MONTH_STATUS - 1]), lastDonation: '' };
}
function allProfiles_() {
  return readRows_(getSheet_(APP.SHEETS.STUDENTS), 12).filter(function (r) { return str_(r[S.DONOR_ID - 1]); }).map(profileFromStudent_)
    .concat(readRows_(getSheet_(APP.SHEETS.OUTSIDERS), 12).filter(function (r) { return str_(r[O.DONOR_ID - 1]); }).map(profileFromOutsider_));
}
function findProfile_(donorId) {
  const id = str_(donorId); let row = findRowById_(getSheet_(APP.SHEETS.STUDENTS), S.DONOR_ID, id);
  if (row) return { type: 'Student', sheet: getSheet_(APP.SHEETS.STUDENTS), row: row, n: 12 };
  row = findRowById_(getSheet_(APP.SHEETS.OUTSIDERS), O.DONOR_ID, id);
  if (row) return { type: 'Outsider', sheet: getSheet_(APP.SHEETS.OUTSIDERS), row: row, n: 12 };
  return null;
}
function loadProfile_(donorId) {
  const loc = findProfile_(donorId); if (!loc) throw userError_('No matching donor found.');
  const r = loc.sheet.getRange(loc.row, 1, 1, loc.n).getValues()[0];
  const p = loc.type === 'Student' ? profileFromStudent_(r) : profileFromOutsider_(r); p._loc = loc; return p;
}
/** Warn-only duplicate detection using strong identifiers (never name alone). */
function findDuplicates_(p, excludeId) {
  const wa = normPhone_(p.whatsapp), em = normEmail_(p.email), roll = normText_(p.roll), uni = normText_(p.university), out = [];
  allProfiles_().forEach(function (x) {
    if (x.donorId === excludeId) return; const why = [];
    if (wa && normPhone_(x.whatsapp) === wa) why.push('same WhatsApp');
    if (em && normEmail_(x.email) === em) why.push('same email');
    if (roll && normText_(x.roll) === roll && (!uni || !normText_(x.university) || normText_(x.university) === uni)) why.push('same roll number');
    if (why.length) out.push({ donorId: x.donorId, name: x.name, type: x.type, whatsapp: x.whatsapp, email: x.email, roll: x.roll, reason: why.join(', ') });
  });
  return out.slice(0, 5);
}
/** Read-only, lock-free search. */
function searchDonorRecords(query) {
  return api_(function () {
    const q = normText_(query), qd = str_(query).replace(/\D/g, ''); if (q.length < 1) return { results: [] };
    const tokens = str_(query).toLowerCase().split(/[\s,]+/).map(normText_).filter(Boolean);
    const scored = [];
    allProfiles_().forEach(function (p) {
      const fields = [normText_(p.name), normText_(p.donorId), normText_(p.email), normText_(p.roll)];
      const ph = normPhone_(p.whatsapp), hay = [p.name, p.donorId, p.whatsapp, p.email, p.roll, p.university, p.department, p.className].map(normText_).join(' ');
      let s = 0;
      fields.forEach(function (f) { if (!f) return; if (f === q) s = Math.max(s, 100); else if (f.indexOf(q) === 0) s = Math.max(s, 80); else if (f.indexOf(q) >= 0) s = Math.max(s, 60); });
      if (qd.length >= 4 && ph) { const pl = qd.slice(-10); if (ph === pl) s = Math.max(s, 100); else if (ph.indexOf(qd) >= 0 || ph.slice(-qd.length) === qd) s = Math.max(s, 65); }
      if (!s && tokens.length > 1 && tokens.every(function (t) { return hay.indexOf(t) >= 0; })) s = 50;
      if (!s && q.length >= 3) { const d = dice_(p.name, query); if (d >= 0.6) s = 30 + Math.round(d * 10); }
      if (s) scored.push({ s: s, p: p });
    });
    scored.sort(function (a, b) { return b.s - a.s || a.p.name.localeCompare(b.p.name); });
    return { results: scored.slice(0, 30).map(function (x) { return x.p; }) };
  });
}

/* ============================ DONOR / DONATION SERVICES ============================ */
function cleanProfile_(p, isOutsider) {
  const o = { name: str_(p.name), email: str_(p.email), whatsapp: normalizePhone_(p.whatsapp, true) };
  if (!o.name) throw userError_('Please enter the donor name.');
  if (o.email && !isEmail_(o.email)) throw userError_('Please enter a valid email address.');
  if (isOutsider) { o.university = o.department = o.className = o.roll = ''; return o; } // server-side enforcement
  o.university = str_(p.university); o.department = str_(p.department); o.className = str_(p.className); o.roll = str_(p.roll);
  if (!o.university || !o.department || !o.className || !o.roll) throw userError_('Students must provide university, department, class and roll number. Tick "I am an outsider" if this donor is not a student.');
  return o;
}
function claimToken_(token) {
  if (!token) return; const c = CacheService.getScriptCache();
  if (c.get('tok_' + token)) throw userError_('This form was already submitted. Please start a new entry.');
  c.put('tok_' + token, '1', 600);
}
function releaseToken_(token) { if (token) CacheService.getScriptCache().remove('tok_' + token); }

function saveDonation(payload) {
  return api_(function () {
    return withLock_(function () {
      const p = payload || {}; claimToken_(p.token);
      try {
        const isOutsider = p.isOutsider === true || p.isOutsider === 'true';
        const date = normalizeDate_(p.date); if (!date) throw userError_('Please enter a valid donation date.');
        const amount = toAmount_(p.amount); if (!isFinite(amount) || amount <= 0) throw userError_('Please enter a valid donation amount.');
        const status = str_(p.status) || APP.STATUS.PENDING; if (STATUS_LIST.indexOf(status) < 0) throw userError_('Please choose a valid verification status.');
        const receipt = normalizeReceipt_(p.receipt), now = new Date();
        let donorId = str_(p.donorId), prof, shell = false;
        if (donorId) { const lp = loadProfile_(donorId); prof = { name: lp.name, whatsapp: lp.whatsapp, university: lp.university, department: lp.department, className: lp.className, roll: lp.roll, email: lp.email }; 
          const em = str_(p.email); if (em && !lp.email) { if (!isEmail_(em)) throw userError_('Please enter a valid email address.'); lp._loc.sheet.getRange(lp._loc.row, lp.type === 'Student' ? S.EMAIL : O.EMAIL).setValue(em); } }
        else {
          prof = cleanProfile_(p, isOutsider);
          const dups = findDuplicates_(prof, '');
          if (dups.length && !(p.confirmNew === true || p.confirmNew === 'true')) { releaseToken_(p.token); return { duplicate: true, matches: dups, message: 'Possible duplicate donor detected. Please review before continuing.' }; }
          donorId = idAllocator_('DONOR', allDonorIds_()).next(); shell = true;
        }
        const recordId = idAllocator_('RECORD', allRecordIds_()).next();
        if (shell) {
          if (isOutsider) appendRow_(getSheet_(APP.SHEETS.OUTSIDERS), [prof.name, prof.whatsapp, prof.email, donorId, 0, 0, status, receipt, recordId, now, now, APP.MONTH.UNPAID]);
          else appendRow_(getSheet_(APP.SHEETS.STUDENTS), [prof.name, donorId, 0, 0, prof.university, prof.department, prof.className, prof.whatsapp, prof.email, prof.roll, APP.MONTH.UNPAID, '']);
        }
        const row = []; row[D.NAME - 1] = prof.name; row[D.DONOR_ID - 1] = donorId; row[D.DATE - 1] = date; row[D.AMOUNT - 1] = amount;
        row[D.UNIVERSITY - 1] = prof.university; row[D.DEPARTMENT - 1] = prof.department; row[D.CLASS - 1] = prof.className;
        row[D.WHATSAPP - 1] = prof.whatsapp; row[D.ROLL - 1] = prof.roll; row[D.STATUS - 1] = status; row[D.RECEIPT - 1] = receipt;
        row[D.RECORD_ID - 1] = recordId; row[D.CREATED_AT - 1] = now; row[D.UPDATED_AT - 1] = now;
        appendRow_(getSheet_(APP.SHEETS.DONATIONS), row);
        syncMembers_();
        return { message: 'Donation saved successfully.', donorId: donorId, recordId: recordId };
      } catch (e) { releaseToken_(p.token); throw e; }
    });
  });
}
function getDonation(recordId) {
  return api_(function () {
    const sh = getSheet_(APP.SHEETS.DONATIONS), row = findRowById_(sh, D.RECORD_ID, str_(recordId));
    if (!row) throw userError_('Donation record not found.');
    const r = sh.getRange(row, 1, 1, 14).getValues()[0];
    return { donation: { recordId: str_(r[D.RECORD_ID - 1]), donorId: str_(r[D.DONOR_ID - 1]), name: str_(r[D.NAME - 1]), date: fmtDate_(r[D.DATE - 1]), amount: r[D.AMOUNT - 1], status: str_(r[D.STATUS - 1]), receipt: str_(r[D.RECEIPT - 1]) }, statuses: STATUS_LIST };
  });
}
function updateDonation(payload) {
  return api_(function () {
    return withLock_(function () {
      const p = payload || {}, sh = getSheet_(APP.SHEETS.DONATIONS), row = findRowById_(sh, D.RECORD_ID, str_(p.recordId));
      if (!row) throw userError_('Donation record not found.');
      const date = normalizeDate_(p.date); if (!date) throw userError_('Please enter a valid donation date.');
      const amount = toAmount_(p.amount); if (!isFinite(amount) || amount <= 0) throw userError_('Please enter a valid donation amount.');
      const status = str_(p.status); if (STATUS_LIST.indexOf(status) < 0) throw userError_('Please choose a valid verification status.');
      const receipt = normalizeReceipt_(p.receipt);
      sh.getRange(row, D.DATE).setValue(date); sh.getRange(row, D.AMOUNT).setValue(amount); sh.getRange(row, D.STATUS).setValue(status);
      sh.getRange(row, D.RECEIPT).setValue(receipt); sh.getRange(row, D.UPDATED_AT).setValue(new Date());
      syncMembers_();
      return { message: 'Donation updated successfully.' };
    });
  });
}
function getDonorForEdit(donorId) {
  return api_(function () {
    const p = loadProfile_(donorId); delete p._loc;
    const rows = readRows_(getSheet_(APP.SHEETS.DONATIONS), 14).filter(function (r) { return str_(r[D.DONOR_ID - 1]) === p.donorId; });
    p.donations = rows.map(function (r) { return { recordId: str_(r[D.RECORD_ID - 1]), date: fmtDate_(r[D.DATE - 1]), amount: r[D.AMOUNT - 1], status: str_(r[D.STATUS - 1]) }; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return { donor: p };
  });
}
function saveDonor(payload) {
  return api_(function () {
    return withLock_(function () {
      const p = payload || {}, lp = loadProfile_(p.donorId), isOut = lp.type === 'Outsider', c = cleanProfile_(p, isOut);
      const dups = findDuplicates_(c, lp.donorId);
      if (dups.length && !(p.confirmNew === true || p.confirmNew === 'true')) return { duplicate: true, matches: dups, message: 'Possible duplicate donor detected. Please review before continuing.' };
      const loc = lp._loc, rng = loc.sheet.getRange(loc.row, 1, 1, loc.n), r = rng.getValues()[0], now = new Date();
      if (isOut) { r[O.NAME - 1] = c.name; r[O.CONTACT - 1] = c.whatsapp; r[O.EMAIL - 1] = c.email; r[O.UPDATED_AT - 1] = now; }
      else { r[S.NAME - 1] = c.name; r[S.UNIVERSITY - 1] = c.university; r[S.DEPARTMENT - 1] = c.department; r[S.CLASS - 1] = c.className; r[S.WHATSAPP - 1] = c.whatsapp; r[S.EMAIL - 1] = c.email; r[S.ROLL - 1] = c.roll; }
      rng.setValues([r]);
      const dsh = getSheet_(APP.SHEETS.DONATIONS), last = dsh.getLastRow();
      if (last >= APP.DATA_START_ROW) {
        const dr = dsh.getRange(APP.DATA_START_ROW, 1, last - APP.DATA_START_ROW + 1, 14), rows = dr.getValues(); let ch = false;
        rows.forEach(function (x) {
          if (str_(x[D.DONOR_ID - 1]) !== lp.donorId) return;
          x[D.NAME - 1] = c.name; x[D.WHATSAPP - 1] = c.whatsapp; x[D.UNIVERSITY - 1] = c.university; x[D.DEPARTMENT - 1] = c.department;
          x[D.CLASS - 1] = c.className; x[D.ROLL - 1] = c.roll; x[D.UPDATED_AT - 1] = now; ch = true;
        });
        if (ch) dr.setValues(rows);
      }
      syncMembers_();
      return { message: 'Donor updated successfully.' };
    });
  });
}

/* ============================ EXPENSE SERVICES ============================ */
function getExpense(expenseId) {
  return api_(function () {
    const sh = getSheet_(APP.SHEETS.EXPENSES), row = findRowById_(sh, E.ID, str_(expenseId));
    if (!row) throw userError_('No matching expense found.');
    const r = sh.getRange(row, 1, 1, 8).getValues()[0];
    return { expense: { expenseId: str_(r[E.ID - 1]), date: fmtDate_(r[E.DATE - 1]), amount: r[E.AMOUNT - 1], category: str_(r[E.CATEGORY - 1]), receipt: str_(r[E.RECEIPT - 1]),
      personal: str_(r[E.PERSONAL_DESCRIPTION - 1]), donation: str_(r[E.DONATION_DESCRIPTION - 1]), contribution: str_(r[E.CONTRIBUTION - 1]) } };
  });
}
function saveExpense(payload) {
  return api_(function () {
    return withLock_(function () {
      const p = payload || {}; claimToken_(p.token);
      try {
        const date = normalizeDate_(p.date); if (!date) throw userError_('Please enter a valid expense date.');
        const amount = toAmount_(p.amount); if (!isFinite(amount) || amount <= 0) throw userError_('Please enter a valid expense amount.');
        const cat = str_(p.category); if (!cat) throw userError_('Please choose an expense category.');
        const cats = getConfig_().categories;
        if (cats.length && cats.indexOf(cat) < 0) throw userError_('Category is not in the Configuration list.');
        const receipt = normalizeReceipt_(p.receipt), sh = getSheet_(APP.SHEETS.EXPENSES);
        const vals = []; vals[E.DATE - 1] = date; vals[E.AMOUNT - 1] = amount; vals[E.CATEGORY - 1] = cat; vals[E.RECEIPT - 1] = receipt;
        vals[E.PERSONAL_DESCRIPTION - 1] = str_(p.personal); vals[E.DONATION_DESCRIPTION - 1] = str_(p.donation); vals[E.CONTRIBUTION - 1] = str_(p.contribution);
        let id = str_(p.expenseId);
        if (id) {
          const row = findRowById_(sh, E.ID, id); if (!row) throw userError_('No matching expense found.');
          vals[E.ID - 1] = id; sh.getRange(row, 1, 1, 8).setValues([vals]);
          return { message: 'Expense updated successfully.', expenseId: id };
        }
        id = idAllocator_('EXPENSE', allExpenseIds_()).next(); vals[E.ID - 1] = id; appendRow_(sh, vals);
        return { message: 'Expense saved successfully.', expenseId: id };
      } catch (e) { releaseToken_(p.token); throw e; }
    });
  });
}

/* ============================ VALIDATION / REPAIR ============================ */
function validateDatabase_() {
  const issues = [], add = function (lvl, sheet, row, msg) { issues.push({ level: lvl, sheet: sheet, row: row || '', message: msg }); };
  const ss = SpreadsheetApp.getActive(); let ok = true;
  Object.keys(APP.SHEETS).forEach(function (k) { if (!ss.getSheetByName(APP.SHEETS[k])) { add('ERROR', APP.SHEETS[k], '', 'Sheet is missing.'); ok = false; } });
  if (!ok) return issues;
  ['DONATIONS', 'STUDENTS', 'OUTSIDERS', 'EXPENSES'].forEach(function (k) {
    const sp = SPEC[k], cur = ss.getSheetByName(sp.name).getRange(APP.HEADER_ROW, 1, 1, sp.headers.length).getValues()[0];
    sp.headers.forEach(function (h, i) { if (str_(cur[i]) !== h) add('ERROR', sp.name, APP.HEADER_ROW, 'Column ' + (i + 1) + ' header is "' + str_(cur[i]) + '", expected "' + h + '". Fix manually (not auto-changed to protect data).'); });
  });
  if (issues.length) return issues;
  const cfg = getConfig_(), cs = ss.getSheetByName(APP.SHEETS.CONFIG);
  if (STATUS_LIST.indexOf(str_(cs.getRange(CFG.ROWS.STATUS, 2).getValue())) < 0) add('ERROR', APP.SHEETS.CONFIG, CFG.ROWS.STATUS, 'Valid Donation Status must be Pending, Verified or Rejected.');
  if (cfg.folderId === '') add('INFO', APP.SHEETS.CONFIG, CFG.ROWS.FOLDER, 'Report Folder ID is blank (reports disabled until set).');
  const dRows = readRows_(ss.getSheetByName(APP.SHEETS.DONATIONS), 14), recSeen = {}, recRe = idPattern_('RECORD'), donRe = idPattern_('DONOR'), expRe = idPattern_('EXPENSE');
  dRows.forEach(function (r, i) {
    if (isDonationBlank_(r)) return; const row = i + APP.DATA_START_ROW, S_ = APP.SHEETS.DONATIONS;
    if (!str_(r[D.DONOR_ID - 1])) add('ERROR', S_, row, 'Missing Donor ID.'); else if (!donRe.test(str_(r[D.DONOR_ID - 1]))) add('WARN', S_, row, 'Donor ID does not match the configured prefix.');
    const rid = str_(r[D.RECORD_ID - 1]);
    if (!rid) add('ERROR', S_, row, 'Missing Record ID.'); else { if (recSeen[rid]) add('ERROR', S_, row, 'Duplicate Record ID ' + rid + '.'); recSeen[rid] = 1; if (!recRe.test(rid)) add('WARN', S_, row, 'Record ID does not match the configured prefix.'); }
    if (STATUS_LIST.indexOf(str_(r[D.STATUS - 1])) < 0) add('ERROR', S_, row, 'Invalid verification status.');
    if (!isFinite(toAmount_(r[D.AMOUNT - 1])) || toAmount_(r[D.AMOUNT - 1]) <= 0) add('ERROR', S_, row, 'Invalid donation amount.');
    if (!normalizeDate_(r[D.DATE - 1])) add('ERROR', S_, row, 'Invalid date.');
  });
  const donorSeen = {};
  readRows_(ss.getSheetByName(APP.SHEETS.STUDENTS), 12).forEach(function (r, i) {
    if (isBlankRow_(r)) return; const row = i + APP.DATA_START_ROW, id = str_(r[S.DONOR_ID - 1]);
    if (!id) add('ERROR', APP.SHEETS.STUDENTS, row, 'Missing Donor ID.'); else { if (donorSeen[id]) add('ERROR', APP.SHEETS.STUDENTS, row, 'Duplicate Donor ID ' + id + '.'); donorSeen[id] = 1; }
    if ([APP.MONTH.PAID, APP.MONTH.UNPAID].indexOf(str_(r[S.MONTH_STATUS - 1])) < 0) add('ERROR', APP.SHEETS.STUDENTS, row, 'Invalid month status.');
  });
  readRows_(ss.getSheetByName(APP.SHEETS.OUTSIDERS), 12).forEach(function (r, i) {
    if (isBlankRow_(r)) return; const row = i + APP.DATA_START_ROW, id = str_(r[O.DONOR_ID - 1]);
    if (!id) add('ERROR', APP.SHEETS.OUTSIDERS, row, 'Missing Donor ID.'); else { if (donorSeen[id]) add('ERROR', APP.SHEETS.OUTSIDERS, row, 'Duplicate Donor ID ' + id + ' (also in another member sheet).'); donorSeen[id] = 1; }
    if ([APP.MONTH.PAID, APP.MONTH.UNPAID].indexOf(str_(r[O.MONTH_STATUS - 1])) < 0) add('ERROR', APP.SHEETS.OUTSIDERS, row, 'Invalid month status.');
  });
  const expSeen = {};
  readRows_(ss.getSheetByName(APP.SHEETS.EXPENSES), 8).forEach(function (r, i) {
    if (isBlankRow_(r)) return; const row = i + APP.DATA_START_ROW, id = str_(r[E.ID - 1]), S_ = APP.SHEETS.EXPENSES;
    if (!id) add('ERROR', S_, row, 'Missing Expense ID.'); else { if (expSeen[id]) add('ERROR', S_, row, 'Duplicate Expense ID ' + id + '.'); expSeen[id] = 1; if (!expRe.test(id)) add('WARN', S_, row, 'Expense ID does not match the configured prefix.'); }
    if (!isFinite(toAmount_(r[E.AMOUNT - 1])) || toAmount_(r[E.AMOUNT - 1]) <= 0) add('ERROR', S_, row, 'Invalid amount.');
    if (!normalizeDate_(r[E.DATE - 1])) add('ERROR', S_, row, 'Invalid date.');
    if (cfg.categories.length && cfg.categories.indexOf(str_(r[E.CATEGORY - 1])) < 0) add('WARN', S_, row, 'Category is not in the Configuration list.');
  });
  // stale member totals
  const calc = computeMembers_(false), sIdx = {}, oIdx = {}, now = [];
  readRows_(ss.getSheetByName(APP.SHEETS.STUDENTS), 12).forEach(function (r) { sIdx[str_(r[S.DONOR_ID - 1])] = r; });
  readRows_(ss.getSheetByName(APP.SHEETS.OUTSIDERS), 12).forEach(function (r) { oIdx[str_(r[O.DONOR_ID - 1])] = r; });
  let stale = 0;
  calc.students.forEach(function (r) { const x = sIdx[str_(r[S.DONOR_ID - 1])]; if (!x || x[S.COUNT - 1] !== r[S.COUNT - 1] || Math.abs(Number(x[S.TOTAL - 1]) - Number(r[S.TOTAL - 1])) > 0.005 || x[S.MONTH_STATUS - 1] !== r[S.MONTH_STATUS - 1]) stale++; });
  calc.outsiders.forEach(function (r) { const x = oIdx[str_(r[O.DONOR_ID - 1])]; if (!x || x[O.COUNT - 1] !== r[O.COUNT - 1] || Math.abs(Number(x[O.TOTAL - 1]) - Number(r[O.TOTAL - 1])) > 0.005 || x[O.MONTH_STATUS - 1] !== r[O.MONTH_STATUS - 1]) stale++; });
  if (stale) add('WARN', 'Members', '', stale + ' member row(s) have stale totals. Run Synchronize Database.');
  // public data formulas / stale validation
  const pub = ss.getSheetByName(APP.SHEETS.PUBLIC), pf = pub.getRange('B4:B9').getFormulas(), pv = pub.getRange('B4:B9').getDisplayValues();
  pf.forEach(function (f, i) { if (!f[0]) add('ERROR', APP.SHEETS.PUBLIC, 4 + i, 'Formula missing. Run Repair Database.'); else if (/^#/.test(pv[i][0])) add('ERROR', APP.SHEETS.PUBLIC, 4 + i, 'Formula shows an error: ' + pv[i][0]); });
  const dv = ss.getSheetByName(APP.SHEETS.EXPENSES).getRange(APP.DATA_START_ROW, E.CATEGORY).getDataValidation();
  const have = dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST ? dv.getCriteriaValues()[0] : [];
  if (JSON.stringify(have || []) !== JSON.stringify(cfg.categories)) add('WARN', APP.SHEETS.EXPENSES, '', 'Category dropdown is out of date. Run Repair Database.');
  return issues;
}
/** Conservative: never deletes records or overwrites existing headers. */
function repairDatabase() {
  return withLock_(function () {
    ensureStructure_(); installTriggers_();
    const ids = ensureDonationRows_(0, 0), ex = ensureExpenseRows_(); syncMembers_();
    const issues = validateDatabase_(), bad = issues.filter(function (i) { return i.level !== 'INFO'; });
    return { issues: issues, message: 'Repair complete. IDs repaired: ' + (ids + ex) + '.\n' + (bad.length ? bad.length + ' item(s) need attention:\n' + bad.slice(0, 12).map(function (i) { return '• ' + i.sheet + (i.row ? ' r' + i.row : '') + ': ' + i.message; }).join('\n') : 'No problems found.') };
  });
}
/* ============================ REPORTS ============================ */

function generateReport() {

  return withLock_(function () {

    CFG_CACHE_ = null;

    const cfg = getConfig_();

    if (!cfg.folderId) {
      throw userError_(
        'Report Folder ID is not set. Enter the folder ID in Configuration.'
      );
    }

    const folderId = extractDriveFolderId_(cfg.folderId);

    if (!folderId) {
      throw userError_(
        'The Report Folder ID is invalid.'
      );
    }

    let folder;

    try {

      folder = DriveApp.getFolderById(folderId);

    } catch (e) {

      console.error('Folder ID: ' + folderId);
      console.error(
        'Drive error: ' +
        (e && e.message ? e.message : e)
      );

      throw userError_(
        'The Report Folder could not be opened.\n\n' +
        'Please check that the folder exists and that you have access to it.'
      );
    }

    SpreadsheetApp.flush();

    const pub = getSheet_(APP.SHEETS.PUBLIC);

    if (!pub) {
      throw userError_(
        'The Public Data sheet could not be found.'
      );
    }

    /*
     * ============================
     * READ REPORT DATA
     * ============================
     */

    const summary =
      pub.getRange('A3:B9').getDisplayValues();

    const monthly =
      pub.getRange('D3:F15').getDisplayValues();

    const stamp =
      fmtDate_(new Date());

    const reportName =
      'SE Foundation Financial Report ' + stamp;

    let tempSpreadsheet = null;

    try {

      /*
       * ============================
       * CREATE TEMPORARY SPREADSHEET
       * ============================
       */

      tempSpreadsheet =
        SpreadsheetApp.create(reportName);

      const sheet =
        tempSpreadsheet.getSheets()[0];

      sheet.setName('Financial Report');

      /*
       * ============================
       * COLORS
       * ============================
       */

      const DARK_GREEN = '#214C39';
      const GREEN = '#2F6B4F';
      const LIGHT_GREEN = '#EAF2ED';
      const VERY_LIGHT_GREEN = '#F6F9F7';

      const WHITE = '#FFFFFF';
      const DARK = '#263238';
      const GREY = '#6B7280';
      const BORDER = '#D9E2DC';

      const RED = '#B42318';
      const LIGHT_RED = '#FCEBE8';

      /*
       * ============================
       * GENERAL SHEET SETTINGS
       * ============================
       */

      sheet.setHiddenGridlines(true);

      sheet.setColumnWidth(1, 150);
      sheet.setColumnWidth(2, 125);
      sheet.setColumnWidth(3, 150);
      sheet.setColumnWidth(4, 125);
      sheet.setColumnWidth(5, 150);
      sheet.setColumnWidth(6, 125);
      sheet.setColumnWidth(7, 150);
      sheet.setColumnWidth(8, 125);

      /*
       * ============================
       * HEADER
       * ============================
       */

      sheet.getRange('A1:H1').merge();

      sheet.getRange('A1')
        .setValue('SE FOUNDATION')
        .setFontFamily('Arial')
        .setFontSize(22)
        .setFontWeight('bold')
        .setFontColor(WHITE)
        .setBackground(DARK_GREEN)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');

      sheet.setRowHeight(1, 42);

      /*
       * ============================
       * SUBTITLE
       * ============================
       */

      sheet.getRange('A2:H2').merge();

      sheet.getRange('A2')
        .setValue('FINANCIAL REPORT')
        .setFontFamily('Arial')
        .setFontSize(12)
        .setFontWeight('bold')
        .setFontColor(WHITE)
        .setBackground(GREEN)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');

      sheet.setRowHeight(2, 28);

      /*
       * ============================
       * REPORT DATE
       * ============================
       */

      sheet.getRange('A3:H3').merge();

      sheet.getRange('A3')
        .setValue('Report Date: ' + stamp)
        .setFontFamily('Arial')
        .setFontSize(9)
        .setFontColor(GREY)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');

      sheet.setRowHeight(3, 24);

      /*
       * ============================
       * FINANCIAL OVERVIEW
       * ============================
       */

      sheet.getRange('A5:H5').merge();

      sheet.getRange('A5')
        .setValue('FINANCIAL OVERVIEW')
        .setFontFamily('Arial')
        .setFontSize(12)
        .setFontWeight('bold')
        .setFontColor(DARK_GREEN)
        .setBackground(LIGHT_GREEN)
        .setHorizontalAlignment('left')
        .setVerticalAlignment('middle');

      sheet.setRowHeight(5, 28);

      /*
       * ============================
       * EXTRACT SUMMARY VALUES
       * ============================
       */

      const metrics = {};

      for (let i = 0; i < summary.length; i++) {

        const label =
          String(summary[i][0] || '')
            .trim()
            .toLowerCase();

        const value =
          summary[i][1];

        if (label) {
          metrics[label] = value;
        }
      }

      /*
       * ============================
       * KPI CARD FUNCTION
       * ============================
       */

      function makeCard(
        range,
        label,
        value,
        valueColor,
        background
      ) {

        const cardRange =
          sheet.getRange(range);

        cardRange
          .setBackground(background || WHITE)
          .setBorder(
            true,
            true,
            true,
            true,
            false,
            false,
            BORDER,
            SpreadsheetApp.BorderStyle.SOLID
          );

        const row =
          cardRange.getRow();

        const col =
          cardRange.getColumn();

        const columns =
          cardRange.getNumColumns();

        /*
         * Label
         */

        sheet
          .getRange(
            row,
            col,
            1,
            columns
          )
          .merge();

        sheet
          .getRange(row, col)
          .setValue(label)
          .setFontFamily('Arial')
          .setFontSize(8)
          .setFontWeight('bold')
          .setFontColor(GREY)
          .setHorizontalAlignment('center')
          .setVerticalAlignment('middle');

        /*
         * Value
         */

        sheet
          .getRange(
            row + 1,
            col,
            2,
            columns
          )
          .merge();

        sheet
          .getRange(row + 1, col)
          .setValue(value || '0')
          .setFontFamily('Arial')
          .setFontSize(17)
          .setFontWeight('bold')
          .setFontColor(valueColor || DARK_GREEN)
          .setHorizontalAlignment('center')
          .setVerticalAlignment('middle');

        sheet.setRowHeight(row, 22);
        sheet.setRowHeight(row + 1, 24);
        sheet.setRowHeight(row + 2, 24);
      }

      /*
       * ============================
       * KPI CARDS
       * ============================
       */

      makeCard(
        'A7:B9',
        'TOTAL DONATIONS',
        metrics['total number of donations'],
        DARK_GREEN,
        WHITE
      );

      makeCard(
        'C7:D9',
        'TOTAL DONATION COLLECTED',
        metrics['total donation collected'],
        DARK_GREEN,
        WHITE
      );

      makeCard(
        'E7:F9',
        'TOTAL EXPENSES',
        metrics['total expense'],
        RED,
        LIGHT_RED
      );

      makeCard(
        'G7:H9',
        'CURRENT ACCOUNT BALANCE',
        metrics['current account balance'],
        DARK_GREEN,
        LIGHT_GREEN
      );

      makeCard(
        'A11:B13',
        'CURRENT MONTH DONATIONS',
        metrics['current month donations'],
        DARK_GREEN,
        WHITE
      );

      makeCard(
        'C11:D13',
        'CURRENT MONTH EXPENSES',
        metrics['current month expenses'],
        RED,
        LIGHT_RED
      );

      /*
       * Information card
       */

      sheet
        .getRange('E11:H13')
        .merge();

      sheet
        .getRange('E11')
        .setValue(
          'SE Foundation\nFinancial Management Report'
        )
        .setFontFamily('Arial')
        .setFontSize(12)
        .setFontWeight('bold')
        .setFontColor(DARK_GREEN)
        .setBackground(LIGHT_GREEN)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle')
        .setWrap(true);

      /*
       * ============================
       * MONTHLY FINANCIAL ACTIVITY
       * ============================
       */

      sheet.getRange('A15:H15').merge();

      sheet.getRange('A15')
        .setValue('MONTHLY FINANCIAL ACTIVITY')
        .setFontFamily('Arial')
        .setFontSize(12)
        .setFontWeight('bold')
        .setFontColor(DARK_GREEN)
        .setBackground(LIGHT_GREEN)
        .setHorizontalAlignment('left')
        .setVerticalAlignment('middle');

      sheet.setRowHeight(15, 28);

      /*
       * ============================
       * MONTHLY TABLE
       * ============================
       */

      const monthlyStartRow = 17;

      if (monthly.length > 0) {

        sheet
          .getRange(
            monthlyStartRow,
            1,
            monthly.length,
            3
          )
          .setValues(monthly);

        /*
         * Header
         */

        sheet
          .getRange(
            monthlyStartRow,
            1,
            1,
            3
          )
          .setBackground(DARK_GREEN)
          .setFontFamily('Arial')
          .setFontSize(9)
          .setFontWeight('bold')
          .setFontColor(WHITE)
          .setHorizontalAlignment('center')
          .setVerticalAlignment('middle');

        /*
         * Body
         */

        if (monthly.length > 1) {

          const body =
            sheet.getRange(
              monthlyStartRow + 1,
              1,
              monthly.length - 1,
              3
            );

          body
            .setFontFamily('Arial')
            .setFontSize(9)
            .setFontColor(DARK)
            .setVerticalAlignment('middle')
            .setBorder(
              true,
              true,
              true,
              true,
              true,
              false,
              BORDER,
              SpreadsheetApp.BorderStyle.SOLID
            );

          /*
           * Numeric columns
           */

          sheet
            .getRange(
              monthlyStartRow + 1,
              2,
              monthly.length - 1,
              2
            )
            .setHorizontalAlignment('right');

          /*
           * Alternate row shading
           */

          for (
            let i = 1;
            i < monthly.length;
            i++
          ) {

            if (i % 2 === 0) {

              sheet
                .getRange(
                  monthlyStartRow + i,
                  1,
                  1,
                  3
                )
                .setBackground(VERY_LIGHT_GREEN);
            }
          }
        }
      }

      /*
       * ============================
       * REPORT NOTE
       * ============================
       */

      const noteRow =
        monthlyStartRow +
        monthly.length +
        2;

      sheet
        .getRange(
          noteRow,
          1,
          1,
          8
        )
        .merge();

      sheet
        .getRange(noteRow, 1)
        .setValue(
          'Monthly figures are generated automatically from the SE Foundation database.'
        )
        .setFontFamily('Arial')
        .setFontSize(8)
        .setFontColor(GREY)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');

      sheet.setRowHeight(noteRow, 24);

      /*
       * ============================
       * FOOTER
       * ============================
       */

      const footerRow =
        noteRow + 2;

      sheet
        .getRange(
          footerRow,
          1,
          1,
          8
        )
        .merge();

      sheet
        .getRange(footerRow, 1)
        .setValue(
          'SE Foundation • Automatically Generated Financial Report • ' +
          stamp
        )
        .setFontFamily('Arial')
        .setFontSize(8)
        .setFontColor(GREY)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');

      /*
       * ============================
       * FINAL FORMATTING
       * ============================
       */

      sheet
        .getRange(
          1,
          1,
          footerRow,
          8
        )
        .setVerticalAlignment('middle');

      SpreadsheetApp.flush();

      /*
       * ============================
       * CREATE PDF
       * ============================
       */

      const tempFile =
        DriveApp.getFileById(
          tempSpreadsheet.getId()
        );

      const pdfBlob =
        tempFile
          .getAs(MimeType.PDF)
          .setName(
            reportName + '.pdf'
          );

      const pdfFile =
        folder.createFile(pdfBlob);

      /*
       * Delete temporary spreadsheet.
       */

      tempFile.setTrashed(true);

      /*
       * ============================
       * SUCCESS
       * ============================
       */

      return {

        message:
          'Financial report generated successfully.\n\n' +
          'Saved to:\n' +
          folder.getName() +
          '\n\n' +
          pdfFile.getName(),

        url:
          pdfFile.getUrl()
      };

    } catch (e) {

      /*
       * Cleanup temporary spreadsheet
       * if report generation fails.
       */

      if (tempSpreadsheet) {

        try {

          DriveApp
            .getFileById(
              tempSpreadsheet.getId()
            )
            .setTrashed(true);

        } catch (cleanupError) {

          console.error(
            cleanupError &&
            cleanupError.message
              ? cleanupError.message
              : cleanupError
          );
        }
      }

      console.error(
        e && e.stack
          ? e.stack
          : e
      );

      throw userError_(
        'The financial report could not be generated.\n\n' +
        'Error: ' +
        (
          e && e.message
            ? e.message
            : 'Unknown error'
        )
      );
    }

  });
}
/**
 * Extracts a Google Drive folder ID from either:
 *
 * 1. Raw ID:
 *    1AbCdEfGhIjKlMnOpQrStUvWxYz
 *
 * 2. Folder URL:
 *    https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
 *
 * 3. URL with parameters:
 *    https://drive.google.com/drive/folders/ID?usp=sharing
 */
function extractDriveFolderId_(value) {

  const input = String(value || '').trim();

  if (!input) return '';

  // Full Google Drive folder URL
  const urlMatch = input.match(
    /\/folders\/([a-zA-Z0-9_-]+)/
  );

  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }

  // URL containing ?id=...
  const idMatch = input.match(
    /[?&]id=([a-zA-Z0-9_-]+)/
  );

  if (idMatch && idMatch[1]) {
    return idMatch[1];
  }

  // Raw folder ID
  return input.replace(/\s+/g, '');
}
function clearConfigCache_() {
  CFG_CACHE_ = null;
}


/* ============================ UI OPENERS / MENU WRAPPERS ============================ */
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }
function modal_(file, title, w, h, vars) {
  const t = HtmlService.createTemplateFromFile(file); Object.keys(vars || {}).forEach(function (k) { t[k] = vars[k]; });
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(w).setHeight(h), title);
}
function showDonationForm() { menuRun_(function () { modal_('DonationForm', 'Donation Form', 520, 640); }); }
function showExpenseForm() { menuRun_(function () { modal_('ExpenseForm', 'Expense Form', 520, 660); }); }
function searchDonor() { menuRun_(function () { modal_('SearchDonor', 'Search & Manage Donors', 640, 560); }); }
function showAdminPanel() { menuRun_(function () { SpreadsheetApp.getUi().showSidebar(HtmlService.createTemplateFromFile('AdminSidebar').evaluate().setTitle('SE Foundation Admin')); }); }
function openSearchDonor() { modal_('SearchDonor', 'Search & Manage Donors', 640, 560); }
function openManageDonor(donorId) { modal_('ManageDonor', 'Manage Donor', 560, 640, { donorId: String(donorId) }); }
function openManageDonation(recordId) { modal_('ManageDonation', 'Manage Donation', 480, 500, { recordId: String(recordId) }); }
function menuSynchronize() { menuRun_(synchronizeDatabase); }
function menuRepair() { menuRun_(repairDatabase); }
function menuReset() { menuRun_(resetMonthlyDonationStatus); }
function menuReport() { menuRun_(generateReport); }

/* ============================ SERVER API FOR HTML ============================ */
function getFormBootstrap() { return api_(function () { const c = getConfig_(); return { statuses: STATUS_LIST, categories: c.categories, today: fmtDate_(new Date()) }; }); }
function adminValidate() { return api_(function () { const i = validateDatabase_(); return { issues: i.slice(0, 100), total: i.length }; }); }
function adminSync() { return api_(synchronizeDatabase); }
function adminRepair() { return api_(repairDatabase); }
function adminReset() { return api_(resetMonthlyDonationStatus); }
function adminReport() { return api_(generateReport); }
function getAdminSummary() {
  return api_(function () {
    const c = getConfig_(), pub = getSheet_(APP.SHEETS.PUBLIC).getRange('A4:B9').getDisplayValues();
    return { validStatus: c.validStatus, folderSet: !!c.folderId, metrics: pub };
  });
}
