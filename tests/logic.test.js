// Chạy: node tests/logic.test.js — kiểm tra logic xếp hạng bằng dữ liệu giả.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8'), ctx);
const { computeStats, parseDateTime } = ctx;
const T = s => parseDateTime(s);
const names = r => JSON.stringify(r.leaderboard.map(x => x.name));
const eq = (a, b) => assert.strictEqual(a, JSON.stringify(b));

// parseDateTime (giờ VN)
assert.strictEqual(T('05/10/2026 07:00'), Date.UTC(2026, 9, 5, 0, 0));
assert.strictEqual(T('2026-10-05'), Date.UTC(2026, 9, 4, 17, 0));
assert.strictEqual(T(''), null);
assert.strictEqual(T('abc'), null);

const restaurants = ['A', 'B', 'C', 'D', 'E'].map(n => ({ name: n }));
const emp = (code, r) => ({ code, name: 'Emp ' + code, restaurant: r, func: 'Kitchen' });
const done = (code, date, cid = '689') => ({ code, status: 'Completed', dateMs: T(date), courseId: cid });
const employees = [emp('A1', 'A'), emp('A2', 'A'), emp('B1', 'B'), emp('B2', 'B'), emp('C1', 'C'),
  emp('D1', 'D'), emp('D2', 'D'), emp('D3', 'D'), emp('D4', 'D'), emp('D5', 'D'), emp('D6', 'D'), emp('X1', 'Unknown')];
const progress = [
  done('A1', '06/10/2026 09:00'), done('A2', '07/10/2026 10:00'),       // A 100% @ 07/10 10:00
  done('B1', '06/10/2026 08:00'), done('B2', '07/10/2026 09:30'),       // B 100% @ 07/10 09:30 → hạng 1
  { code: 'C1', status: '45%', dateMs: null, courseId: '689' },          // C 0%
  ...['D1', 'D2', 'D3', 'D4', 'D5'].map(c => done(c, '08/10/2026 08:00')), // D 5/6 = 83.3%
  { code: 'D6', status: 'Completed', dateMs: null, courseId: '689' },    // Completed nhưng không có ngày → chưa tính
];

let r = computeStats({ employees, restaurants, progress, courseIds: ['689'] });
eq(names(r), ['B', 'A', 'D']);
assert.strictEqual(r.warnings.unknownRestaurant, 1);
assert.strictEqual(r.restaurants.find(x => x.name === 'D').pct, 83.3);
assert.strictEqual(r.restaurants.find(x => x.name === 'E').total, 0);
assert.strictEqual(r.details.C[0].status, '45%');

// C (0%) và E (không có NV) không bao giờ lên bảng
assert.ok(!JSON.parse(names(r)).includes('C'));

// NV mới vào B chưa học → B rớt khỏi bảng; hoàn thành muộn → mốc B đổi
const emp2 = employees.concat([emp('B3', 'B')]);
r = computeStats({ employees: emp2, restaurants, progress, courseIds: ['689'] });
eq(names(r), ['A', 'D', 'B']); // B còn 2/3 = 66,7%
r = computeStats({ employees: emp2, restaurants, progress: progress.concat([done('B3', '10/10/2026 12:00')]), courseIds: ['689'] });
eq(names(r), ['A', 'B', 'D']);

// Bằng tỉ lệ → người cuối hoàn thành sớm hơn xếp trên
r = computeStats({ employees: [emp('P1', 'D'), emp('Q1', 'E'), emp('Q2', 'E')].concat([emp('P2', 'D')]), restaurants,
  progress: [done('P1', '09/10/2026 10:00'), done('Q1', '08/10/2026 10:00')], courseIds: ['689'] });
eq(names(r), ['E', 'D']);

// Nhiều khóa: phải hoàn thành tất cả
r = computeStats({ employees, restaurants, progress, courseIds: ['689', '701'] });
assert.strictEqual(r.leaderboard.length, 0);
assert.strictEqual(r.totals.completed, 0);
r = computeStats({ employees, restaurants, courseIds: ['689', '701'],
  progress: progress.concat([done('A1', '09/10/2026 08:00', '701'), done('A2', '06/10/2026 08:00', '701')]) });
eq(names(r), ['A']);
assert.strictEqual(r.leaderboard[0].lastCompletion, T('09/10/2026 08:00'));
assert.strictEqual(r.details.A.length, 4);
assert.strictEqual(r.details.B.find(x => x.courseId === '701').status, 'Not enrolled');

// Sheet cũ không có cột Course ID + chỉ 1 khóa → vẫn khớp
r = computeStats({ employees, restaurants, courseIds: ['689'], progress: progress.map(p => ({ ...p, courseId: '' })) });
eq(names(r), ['B', 'A', 'D']);

console.log('All tests passed');
