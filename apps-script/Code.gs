/**
 * Learning Champion Dashboard — Pizza 4P's Learning & Development
 *
 * Luồng dữ liệu:
 *   TalentLMS API --(6h sáng mỗi ngày)--> sheet "LMS Learning Progress"
 *   Các sheet --(tính toán)--> "ảnh chụp" (snapshot) lưu trong sheet ẩn "_Snapshot"
 *   Web app (live link) chỉ đọc snapshot => nhanh, nhiều người xem cùng lúc vẫn ổn.
 *
 * Khi admin bấm "Chốt", snapshot không tự cập nhật nữa cho tới khi bấm "Sync lại"
 * hoặc "Mở chốt".
 */

var SHEETS = {
  DETAILED: 'Detailed list',
  RESTAURANTS: 'Restaurant list',
  LMS: 'LMS Learning Progress',
  MANAGERS: 'Manager list',
  CONFIG: 'Config',
  SNAPSHOT: '_Snapshot'
};
var TZ = 'Asia/Ho_Chi_Minh';
var LMS_HEADERS = ['EmployeeCode', 'EmployeeName', 'Progress Status', 'Completion Date', 'Course', 'Course ID'];
var CONFIG_DEFAULTS = [
  ['Campaign Name', 'Learning Champion in October', 'Tên chiến dịch hiển thị trên dashboard'],
  ['Campaign Start', '05/10/2026', 'Ngày bắt đầu (dd/mm/yyyy)'],
  ['Expected End', '23/10/2026', 'Ngày dự kiến chốt (dd/mm/yyyy) — chỉ để hiển thị, chốt thật bằng nút "Chốt"'],
  ['Course IDs', '689', 'Mã khóa học TalentLMS. Nhiều khóa: cách nhau bằng dấu phẩy, VD: 689, 701'],
  ['TalentLMS Domain', 'pizza4ps.talentlms.com', 'Tên miền TalentLMS'],
  ['Employee Code Field', 'PZ Code', 'Tên custom field chứa mã nhân viên. Nếu trống sẽ dùng Username'],
  ['Final Min %', '80', 'Khi chốt mà < 3 nhà hàng đạt 100%: lấy thêm nhà hàng có tỉ lệ LỚN HƠN mức này'],
  ['Admin Emails', '', 'Email admin (được bấm Chốt/Sync). Chủ sở hữu script luôn là admin. Nhiều email cách nhau bằng dấu phẩy']
];
var SNAPSHOT_CHUNK = 40000;   // ký tự / ô trong sheet (giới hạn 50.000)
var CACHE_CHUNK = 25000;      // ký tự / key cache (giới hạn 100KB)
var CACHE_SECONDS = 21600;    // 6 giờ

/* ============================== WEB APP ============================== */

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle("Learning Champion · Pizza 4P's")
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Dữ liệu tổng cho dashboard (không chứa danh sách nhân viên). */
function getDashboardData() {
  var email = currentEmail_();
  var access = getAccess_(email);
  var snap = loadSnapshot_();
  var props = PropertiesService.getScriptProperties();
  var out = {
    generatedAt: snap.generatedAt,
    frozen: snap.frozen,
    frozenAt: snap.frozenAt,
    mode: snap.mode,
    campaign: snap.campaign,
    courses: snap.courses,
    restaurants: snap.restaurants.map(function (r) {
      return { name: r.name, total: r.total, completed: r.completed, pct: r.pct, lastCompletion: r.lastCompletion };
    }),
    leaderboard: snap.leaderboard,
    totals: snap.totals,
    viewer: { email: email, isAdmin: access.isAdmin, canViewAll: access.canViewAll },
    detailRestaurants: access.canViewAll
      ? snap.restaurants.map(function (r) { return r.name; })
      : access.restaurants.filter(function (n) { return snap.details.hasOwnProperty(n); })
  };
  if (access.isAdmin) {
    out.admin = {
      lastPullAt: Number(props.getProperty('LAST_PULL_AT')) || null,
      lastPullRows: Number(props.getProperty('LAST_PULL_ROWS')) || 0,
      lastError: props.getProperty('LAST_ERROR') || '',
      warnings: snap.warnings
    };
  }
  return out;
}

/** Bảng chi tiết của 1 nhà hàng — chỉ trả về khi người xem có quyền. */
function getRestaurantDetail(restaurant) {
  var access = getAccess_(currentEmail_());
  if (!access.canViewAll && access.restaurants.indexOf(restaurant) === -1) {
    throw new Error('NO_ACCESS');
  }
  var snap = loadSnapshot_();
  return snap.details[restaurant] || [];
}

/* ---------------------------- Nút admin ---------------------------- */

function adminPullTalentLMS() {
  requireAdmin_();
  var rows = pullFromTalentLMS();
  if (!isFrozen_()) buildSnapshot();
  return rows;
}

function adminSyncFromSheet() {
  requireAdmin_();
  buildSnapshot();
  return true;
}

function adminFreeze() {
  requireAdmin_();
  setFrozen_(true, currentEmail_());
  buildSnapshot();
  return true;
}

function adminUnfreeze() {
  requireAdmin_();
  setFrozen_(false, '');
  buildSnapshot();
  return true;
}

/* ============================ MENU TRONG SHEET ============================ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🏆 Learning Champion')
    .addItem('1. Thiết lập ban đầu', 'setup')
    .addItem('2. Lưu TalentLMS API key', 'promptApiKey')
    .addItem('3. Kiểm tra kết nối TalentLMS', 'testTalentLMS')
    .addItem('4. Bật lịch tự động 6h sáng', 'installDailyTrigger')
    .addSeparator()
    .addItem('Lấy dữ liệu TalentLMS ngay', 'menuPull')
    .addItem('Cập nhật dashboard từ sheet (Sync)', 'menuSync')
    .addItem('Chốt bảng xếp hạng', 'menuFreeze')
    .addItem('Mở chốt', 'menuUnfreeze')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActive();
  var cfg = ss.getSheetByName(SHEETS.CONFIG) || ss.insertSheet(SHEETS.CONFIG);
  if (cfg.getLastRow() === 0) cfg.appendRow(['Key', 'Value', 'Ghi chú']);
  var existing = cfg.getRange(1, 1, cfg.getLastRow(), 1).getValues().map(function (r) { return String(r[0]).trim(); });
  CONFIG_DEFAULTS.forEach(function (row) {
    if (existing.indexOf(row[0]) === -1) cfg.appendRow(row);
  });
  cfg.getRange('B:B').setNumberFormat('@');

  var lms = ss.getSheetByName(SHEETS.LMS) || ss.insertSheet(SHEETS.LMS);
  lms.getRange(1, 1, 1, LMS_HEADERS.length).setValues([LMS_HEADERS]).setFontWeight('bold');

  if (!ss.getSheetByName(SHEETS.MANAGERS)) ss.insertSheet(SHEETS.MANAGERS);
  var snap = ss.getSheetByName(SHEETS.SNAPSHOT) || ss.insertSheet(SHEETS.SNAPSHOT);
  snap.hideSheet();

  SpreadsheetApp.getUi().alert('Đã thiết lập xong. Kiểm tra sheet "Config" rồi làm bước 2: Lưu TalentLMS API key.');
}

function promptApiKey() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('TalentLMS API key', 'Dán API key vào đây (key được lưu bảo mật trong Script Properties, không lưu trong sheet):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var key = res.getResponseText().trim();
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty('TALENTLMS_API_KEY', key);
  ui.alert('Đã lưu API key.');
}

function testTalentLMS() {
  var ui = SpreadsheetApp.getUi();
  try {
    var cfg = readConfig_();
    var field = findCodeFieldKey_(cfg.codeField);
    var lines = ['Kết nối thành công tới ' + cfg.domain,
      cfg.codeField ? ('Custom field "' + cfg.codeField + '": ' + (field ? 'tìm thấy (' + field + ')' : 'KHÔNG tìm thấy → sẽ dùng Username')) : 'Dùng Username làm mã nhân viên'];
    cfg.courseIds.forEach(function (id) {
      var c = tlmsGet_('courses/id:' + id);
      var learners = (c.users || []).filter(isLearner_).length;
      lines.push('Khóa ' + id + ': "' + c.name + '" — ' + learners + ' học viên');
    });
    ui.alert(lines.join('\n'));
  } catch (err) {
    ui.alert('Lỗi: ' + err.message);
  }
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().atHour(6).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  SpreadsheetApp.getUi().alert('Đã bật lịch: mỗi ngày khoảng 6:00–7:00 sáng (giờ Việt Nam).');
}

function menuPull() { var n = pullFromTalentLMS(); if (!isFrozen_()) buildSnapshot(); toast_('Đã lấy ' + n + ' dòng từ TalentLMS' + (isFrozen_() ? ' (dashboard đang CHỐT nên chưa cập nhật)' : ' và cập nhật dashboard')); }
function menuSync() { buildSnapshot(); toast_('Đã cập nhật dashboard từ sheet'); }
function menuFreeze() { setFrozen_(true, currentEmail_()); buildSnapshot(); toast_('Đã CHỐT bảng xếp hạng'); }
function menuUnfreeze() { setFrozen_(false, ''); buildSnapshot(); toast_('Đã mở chốt'); }

/** Chạy tự động mỗi sáng. */
function dailyJob() {
  var props = PropertiesService.getScriptProperties();
  try {
    pullFromTalentLMS();
    if (!isFrozen_()) buildSnapshot();
  } catch (err) {
    props.setProperty('LAST_ERROR', Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm') + ' — ' + err.message);
    throw err;
  }
}

/* ============================== TALENTLMS ============================== */

function tlmsGet_(path) {
  var key = PropertiesService.getScriptProperties().getProperty('TALENTLMS_API_KEY');
  if (!key) throw new Error('Chưa lưu TalentLMS API key (menu 🏆 → 2).');
  var url = 'https://' + readConfig_().domain + '/api/v1/' + path;
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(key + ':') },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    var msg = res.getContentText();
    try { msg = JSON.parse(msg).error.message; } catch (e) { /* giữ nguyên */ }
    throw new Error('TalentLMS ' + code + ' (' + path.split('?')[0] + '): ' + String(msg).slice(0, 200));
  }
  return JSON.parse(res.getContentText());
}

function findCodeFieldKey_(fieldName) {
  if (!fieldName) return null;
  var fields;
  try { fields = tlmsGet_('getcustomregistrationfields'); } catch (e) { return null; }
  var target = fieldName.trim().toLowerCase();
  for (var i = 0; i < (fields || []).length; i++) {
    if (String(fields[i].name).trim().toLowerCase() === target) return fields[i].key;
  }
  return null;
}

function isLearner_(u) {
  return String(u.role || 'learner').toLowerCase() !== 'instructor';
}

/** Lấy tiến độ các khóa trong Config từ TalentLMS và ghi đè sheet "LMS Learning Progress". */
function pullFromTalentLMS() {
  var cfg = readConfig_();
  if (!cfg.courseIds.length) throw new Error('Sheet Config chưa có Course IDs.');
  var fieldKey = findCodeFieldKey_(cfg.codeField);

  var userIndex = {};
  tlmsGet_('users').forEach(function (u) {
    var code = fieldKey && u[fieldKey] ? u[fieldKey] : u.login;
    userIndex[String(u.id)] = {
      code: normCode(code),
      name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
    };
  });

  var rows = [];
  cfg.courseIds.forEach(function (courseId) {
    var course = tlmsGet_('courses/id:' + courseId);
    (course.users || []).filter(isLearner_).forEach(function (cu) {
      var user = userIndex[String(cu.id)] || { code: '', name: cu.name || '' };
      if (!user.code) return;
      var ts = Number(cu.completed_on_timestamp);
      var pct = Number(cu.completion_percentage) || 0;
      var status = ts ? 'Completed' : (pct > 0 ? pct + '%' : 'Not started');
      rows.push([user.code, user.name || cu.name || '', status, ts ? new Date(ts * 1000) : '', course.name, String(courseId)]);
    });
  });

  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.LMS) || SpreadsheetApp.getActive().insertSheet(SHEETS.LMS);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, LMS_HEADERS.length).setValues([LMS_HEADERS]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, LMS_HEADERS.length).setValues(rows);
    sheet.getRange(2, 4, rows.length, 1).setNumberFormat('dd/mm/yyyy hh:mm:ss');
    sheet.getRange(2, 6, rows.length, 1).setNumberFormat('@');
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('LAST_PULL_AT', String(Date.now()));
  props.setProperty('LAST_PULL_ROWS', String(rows.length));
  props.deleteProperty('LAST_ERROR');
  return rows.length;
}

/* ============================== SNAPSHOT ============================== */

function buildSnapshot() {
  var cfg = readConfig_();
  var frozen = isFrozen_();
  var props = PropertiesService.getScriptProperties();

  var employees = readTable_(SHEETS.DETAILED, ['employeecode', 'restaurant']).map(function (r) {
    return { code: normCode(r.employeecode), name: String(r.employeename || '').trim(),
      restaurant: String(r.restaurant || '').trim(), func: String(r['function'] || '').trim() };
  });
  var restaurants = readTable_(SHEETS.RESTAURANTS, ['restaurant']).map(function (r) {
    return { name: String(r.restaurant || '').trim(), storeCode: String(r['store code'] || '').trim() };
  });
  var progress = readTable_(SHEETS.LMS, ['employeecode', 'progress status', 'completion date']).map(function (r) {
    return { code: normCode(r.employeecode), status: r['progress status'], dateMs: parseDateTime(r['completion date']),
      courseId: String(r['course id'] || '').trim(), courseName: String(r.course || '').trim() };
  });

  var result = computeStats({
    employees: employees, restaurants: restaurants, progress: progress,
    courseIds: cfg.courseIds, finalMode: frozen, finalMinPct: cfg.finalMinPct
  });

  var snap = {
    generatedAt: Date.now(),
    frozen: frozen,
    frozenAt: frozen ? Number(props.getProperty('FROZEN_AT')) || null : null,
    mode: frozen ? 'final' : 'live',
    campaign: { name: cfg.name, start: cfg.start, expectedEnd: cfg.expectedEnd },
    courses: result.courses,
    restaurants: result.restaurants,
    leaderboard: result.leaderboard,
    totals: result.totals,
    details: result.details,
    warnings: result.warnings
  };
  saveSnapshot_(snap);
  return snap;
}

function saveSnapshot_(snap) {
  var json = JSON.stringify(snap);
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEETS.SNAPSHOT);
  if (!sheet) { sheet = ss.insertSheet(SHEETS.SNAPSHOT); sheet.hideSheet(); }
  var chunks = splitString_(json, SNAPSHOT_CHUNK);
  sheet.clearContents();
  sheet.getRange(1, 1, chunks.length, 1).setNumberFormat('@').setValues(chunks.map(function (c) { return [c]; }));
  putCache_(json);
}

function loadSnapshot_() {
  var json = getCache_();
  if (!json) {
    var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.SNAPSHOT);
    if (sheet && sheet.getLastRow() > 0) {
      json = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(function (r) { return r[0]; }).join('');
      putCache_(json);
    }
  }
  return json ? JSON.parse(json) : buildSnapshot();
}

function putCache_(json) {
  var cache = CacheService.getScriptCache();
  var ver = String(Date.now());
  var chunks = splitString_(json, CACHE_CHUNK);
  var entries = {};
  chunks.forEach(function (c, i) { entries['snap_' + ver + '_' + i] = c; });
  entries.snap_meta = JSON.stringify({ ver: ver, count: chunks.length });
  try { cache.putAll(entries, CACHE_SECONDS); } catch (e) { cache.remove('snap_meta'); }
}

function getCache_() {
  var cache = CacheService.getScriptCache();
  var meta = cache.get('snap_meta');
  if (!meta) return null;
  meta = JSON.parse(meta);
  var keys = [];
  for (var i = 0; i < meta.count; i++) keys.push('snap_' + meta.ver + '_' + i);
  var got = cache.getAll(keys);
  var parts = [];
  for (var j = 0; j < keys.length; j++) {
    if (got[keys[j]] == null) return null;
    parts.push(got[keys[j]]);
  }
  return parts.join('');
}

function splitString_(s, size) {
  var out = [];
  for (var i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
}

/* ============================ QUYỀN TRUY CẬP ============================ */

function currentEmail_() {
  return normEmail(Session.getActiveUser().getEmail());
}

function getAccess_(email) {
  var map = getAccessMap_();
  var isAdmin = !!email && map.admins.indexOf(email) !== -1;
  return {
    isAdmin: isAdmin,
    canViewAll: isAdmin || (!!email && map.managers.indexOf(email) !== -1),
    restaurants: email ? (map.byEmail[email] || []) : []
  };
}

/** Đọc quyền từ sheet (cache 5 phút) — không phụ thuộc vào việc Chốt. */
function getAccessMap_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('access_map');
  if (hit) return JSON.parse(hit);

  var byEmail = {};
  var rSheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.RESTAURANTS);
  if (rSheet && rSheet.getLastRow() > 1) {
    var values = rSheet.getDataRange().getValues();
    var headers = values[0].map(normHeader);
    var iName = headers.indexOf('restaurant');
    var iMails = [];
    headers.forEach(function (h, i) { if (h.indexOf('manager') !== -1 && h.indexOf('email') !== -1) iMails.push(i); });
    values.slice(1).forEach(function (row) {
      var name = String(row[iName] || '').trim();
      if (!name) return;
      iMails.forEach(function (i) {
        splitEmails(row[i]).forEach(function (e) {
          byEmail[e] = byEmail[e] || [];
          if (byEmail[e].indexOf(name) === -1) byEmail[e].push(name);
        });
      });
    });
  }

  var managers = [];
  var mSheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.MANAGERS);
  if (mSheet && mSheet.getLastRow() > 0) {
    mSheet.getRange(1, 1, mSheet.getLastRow(), 3).getValues().forEach(function (row) {
      row.forEach(function (cell) { splitEmails(cell).forEach(function (e) { managers.push(e); }); });
    });
  }

  var admins = readConfig_().adminEmails.slice();
  var owner = normEmail(Session.getEffectiveUser().getEmail());
  if (owner) admins.push(owner);

  var map = { byEmail: byEmail, managers: managers, admins: admins };
  cache.put('access_map', JSON.stringify(map), 300);
  return map;
}

function requireAdmin_() {
  if (!getAccess_(currentEmail_()).isAdmin) throw new Error('NOT_ADMIN');
}

/* ============================== TIỆN ÍCH SHEET ============================== */

function readConfig_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.CONFIG);
  var kv = {};
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
      kv[String(r[0]).trim().toLowerCase()] = r[1];
    });
  }
  function get(key) {
    var k = key.toLowerCase();
    if (kv.hasOwnProperty(k)) return kv[k];
    for (var i = 0; i < CONFIG_DEFAULTS.length; i++) if (CONFIG_DEFAULTS[i][0] === key) return CONFIG_DEFAULTS[i][1];
    return '';
  }
  return {
    name: String(get('Campaign Name')),
    start: parseDateTime(get('Campaign Start')),
    expectedEnd: parseDateTime(get('Expected End')),
    courseIds: String(get('Course IDs')).split(/[,;\s]+/).map(function (s) { return s.trim(); }).filter(Boolean),
    domain: String(get('TalentLMS Domain')).replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim(),
    codeField: String(get('Employee Code Field')).trim(),
    finalMinPct: Number(get('Final Min %')) || 80,
    adminEmails: splitEmails(get('Admin Emails'))
  };
}

/** Đọc sheet thành mảng object theo tiêu đề cột (không phân biệt hoa thường). */
function readTable_(name, required) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Không tìm thấy sheet "' + name + '"');
  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  var headers = values[0].map(normHeader);
  (required || []).forEach(function (h) {
    if (headers.indexOf(h) === -1) throw new Error('Sheet "' + name + '" thiếu cột "' + h + '"');
  });
  return values.slice(1).map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { if (h) o[h] = row[i]; });
    return o;
  });
}

function isFrozen_() {
  return PropertiesService.getScriptProperties().getProperty('FROZEN') === '1';
}

function setFrozen_(on, by) {
  var props = PropertiesService.getScriptProperties();
  if (on) {
    props.setProperties({ FROZEN: '1', FROZEN_AT: String(Date.now()), FROZEN_BY: by || '' });
  } else {
    props.setProperty('FROZEN', '0');
    props.deleteProperty('FROZEN_AT');
    props.deleteProperty('FROZEN_BY');
  }
}

function toast_(msg) {
  SpreadsheetApp.getActive().toast(msg, 'Learning Champion', 8);
}

/* ======================= LOGIC TÍNH TOÁN (thuần, có test) ======================= */

function normHeader(h) { return String(h || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function normCode(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
function normEmail(v) { return String(v || '').trim().toLowerCase(); }

function splitEmails(v) {
  return String(v || '').split(/[\s,;]+/).map(normEmail).filter(function (e) { return e.indexOf('@') > 0; });
}

/**
 * Chuyển ô ngày/giờ thành mili-giây (giờ Việt Nam).
 * Hỗ trợ: Date của Google Sheets, "dd/mm/yyyy", "dd/mm/yyyy hh:mm[:ss]", "yyyy-mm-dd[ hh:mm[:ss]]".
 */
function parseDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v.getTime();
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  var y, mo, d;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else {
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    y = +m[1]; mo = +m[2]; d = +m[3];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Giờ Việt Nam = UTC+7
  return Date.UTC(y, mo - 1, d, (+m[4] || 0) - 7, +m[5] || 0, +m[6] || 0);
}

function isCompletedRow(status, dateMs) {
  return String(status == null ? '' : status).trim().toLowerCase() === 'completed' && dateMs != null;
}

function displayStatus(status) {
  if (typeof status === 'number') {
    var pct = status > 0 && status < 1 ? Math.round(status * 100) : Math.round(status);
    return pct > 0 ? pct + '%' : 'Not started';
  }
  var s = String(status == null ? '' : status).trim();
  return s || 'Not started';
}

/**
 * Tính tỉ lệ hoàn thành & bảng xếp hạng.
 * - Nhân viên hoàn thành = hoàn thành TẤT CẢ khóa trong courseIds (status Completed + có ngày).
 * - Mốc của nhà hàng = thời điểm hoàn thành muộn nhất trong số nhân viên đã hoàn thành.
 * - Live: chỉ nhà hàng đạt 100%, sớm hơn xếp trên.
 * - Final (đã chốt): nếu < 3 nhà hàng 100%, lấy thêm nhà hàng có % > finalMinPct
 *   (% cao hơn xếp trên, bằng % thì mốc sớm hơn xếp trên).
 */
function computeStats(input) {
  var courseIds = (input.courseIds || []).map(String);
  var singleCourse = courseIds.length === 1 ? courseIds[0] : null;
  var warnings = { unknownRestaurant: 0, duplicateEmployee: 0, progressNotInList: 0 };

  var courseNames = {};
  var prog = {}; // code -> courseId -> row
  input.progress.forEach(function (p) {
    if (!p.code) return;
    var cid = p.courseId || singleCourse;
    if (!cid || courseIds.indexOf(cid) === -1) return;
    if (p.courseName) courseNames[cid] = p.courseName;
    prog[p.code] = prog[p.code] || {};
    var prev = prog[p.code][cid];
    // Nếu trùng dòng, ưu tiên dòng đã hoàn thành
    if (!prev || (!isCompletedRow(prev.status, prev.dateMs) && isCompletedRow(p.status, p.dateMs))) prog[p.code][cid] = p;
  });

  var byName = {};
  var restaurants = [];
  input.restaurants.forEach(function (r) {
    if (!r.name || byName[r.name]) return;
    byName[r.name] = { name: r.name, storeCode: r.storeCode || '', total: 0, completed: 0, pct: 0, lastCompletion: null };
    restaurants.push(byName[r.name]);
  });

  var details = {};
  restaurants.forEach(function (r) { details[r.name] = []; });
  var seen = {};
  var totalEmp = 0, totalDone = 0;

  input.employees.forEach(function (e) {
    if (!e.code) return;
    if (seen[e.code]) { warnings.duplicateEmployee++; return; }
    seen[e.code] = true;
    var r = byName[e.restaurant];
    if (!r) { warnings.unknownRestaurant++; return; }

    var done = courseIds.length > 0;
    var finishedAt = null;
    courseIds.forEach(function (cid) {
      var p = prog[e.code] && prog[e.code][cid];
      var ok = p && isCompletedRow(p.status, p.dateMs);
      if (ok) { if (finishedAt === null || p.dateMs > finishedAt) finishedAt = p.dateMs; }
      else done = false;
      details[r.name].push({
        code: e.code, name: e.name, func: e.func, courseId: cid,
        status: p ? displayStatus(p.status) : 'Not enrolled',
        completed: !!ok,
        date: ok ? p.dateMs : (p && p.dateMs) || null
      });
    });

    r.total++; totalEmp++;
    if (done) {
      r.completed++; totalDone++;
      if (r.lastCompletion === null || finishedAt > r.lastCompletion) r.lastCompletion = finishedAt;
    }
  });

  Object.keys(prog).forEach(function (code) { if (!seen[code]) warnings.progressNotInList++; });

  restaurants.forEach(function (r) {
    r.pct = r.total ? Math.round((r.completed / r.total) * 1000) / 10 : 0;
  });

  var byTime = function (a, b) {
    var ta = a.lastCompletion === null ? Infinity : a.lastCompletion;
    var tb = b.lastCompletion === null ? Infinity : b.lastCompletion;
    return ta - tb || a.name.localeCompare(b.name);
  };
  var full = restaurants.filter(function (r) { return r.total > 0 && r.completed === r.total; }).sort(byTime);
  var board = full.slice(0, 3);
  if (input.finalMode && board.length < 3) {
    var minPct = input.finalMinPct == null ? 80 : input.finalMinPct;
    var rest = restaurants.filter(function (r) {
      return r.total > 0 && r.completed < r.total && (r.completed / r.total) * 100 > minPct;
    }).sort(function (a, b) { return (b.completed / b.total) - (a.completed / a.total) || byTime(a, b); });
    board = board.concat(rest.slice(0, 3 - board.length));
  }

  return {
    courses: courseIds.map(function (id) { return { id: id, name: courseNames[id] || ('Course ' + id) }; }),
    restaurants: restaurants,
    leaderboard: board.map(function (r, i) {
      return { rank: i + 1, name: r.name, pct: r.pct, total: r.total, completed: r.completed, lastCompletion: r.lastCompletion };
    }),
    totals: { employees: totalEmp, completed: totalDone, fullRestaurants: full.length, restaurants: restaurants.length },
    details: details,
    warnings: warnings
  };
}
