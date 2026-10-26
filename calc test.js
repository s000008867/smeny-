// Проверки общего расчёта «Смен». Запуск: node --test calc_test.js
// Выкладка (GitHub Actions) идёт только если все проверки прошли.
const test = require("node:test");
const assert = require("node:assert/strict");
require("./calc.js");
const S = globalThis.SmenyCalc;

const ST = { rate: 5800, pct: 27, minPts: 18, maxPts: 24, shift: { from: "09:30", to: "21:30" } };
const k = (y, m) => S.key(y, m);
// Октябрь 2026: период премии 21 сен – 20 окт. Смены 22, 24, 26, 28, 30 сен и 2, 4 … 20 окт.
function oct(points = {}, extra = {}) {
  const sep = {}, octM = {};
  for (let d = 22; d <= 30; d += 2) sep[d] = "w";
  for (let d = 2; d <= 30; d += 2) octM[d] = "w";
  return Object.assign({ months: { [k(2026, 8)]: sep, [k(2026, 9)]: octM }, points: { [k(2026, 8)]: points.sep || {}, [k(2026, 9)]: points.oct || {} }, totals: {}, settings: ST }, extra);
}
const AFTER = { y: 2026, m: 10, d: 1, hm: 600 }; // 1 ноября — период закрыт, смен «сегодня» нет
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || "") + " ожидалось " + b + ", получилось " + a);

test("оплата смен за месяц и полная премия без баллов", () => {
  const c = S.calc(oct(), 2026, 9, AFTER);
  assert.equal(c.cnt.w, 15);
  assert.equal(c.base, 15 * 5800);
  assert.equal(c.bonusDays, 15);                    // 5 в сентябре + 10 в октябре по 20-е
  near(c.bonus, 15 * 5800 * 0.27);
  near(c.total, c.base + c.bonus);
});

test("процент премии: ниже минимума 0, между минимумом и нормой — равномерно", () => {
  const st = S.opts(ST);
  assert.equal(S.pctFor(st, 17.9), 0);
  near(S.pctFor(st, 21), 27 * 3 / 6);
  assert.equal(S.pctFor(st, 24), 27);
  assert.equal(S.pctFor(st, 40), 27);
});

test("средний по дневным баллам", () => {
  const P = { sep: { 22: 24, 24: 24, 26: 24, 28: 24, 30: 24 }, oct: { 2: 21, 4: 21, 6: 21, 8: 21, 10: 21, 12: 21, 14: 21, 16: 21, 18: 21, 20: 21 } };
  const c = S.calc(oct(P), 2026, 9, AFTER);
  assert.equal(c.pSum, 5 * 24 + 10 * 21);
  assert.equal(c.pDone, 15);
  near(c.avgP, 22);
  near(c.bonus, 15 * 5800 * S.pctFor(S.opts(ST), 22) / 100);
});

test("общее количество из системы + смены после даты", () => {
  // 358 баллов по 14 октября включительно (12 смен), потом 16 и 18 по 26 баллов
  const D = oct({ oct: { 14: 30, 16: 26, 18: 26 } }, { totals: { [k(2026, 9)]: { pts: 358, upTo: "2026-10-14", dp: 30 } } });
  const c = S.calc(D, 2026, 9, AFTER);
  assert.equal(c.avgSrc, "manual");
  assert.equal(c.pSum, 358 + 26 + 26);
  assert.equal(c.pDone, 12 + 2);
});

test("ремонт добавили или убрали в день «по число» — итог меняется (баг 358/373)", () => {
  const T = { pts: 358, upTo: "2026-10-14", dp: 30 };
  const base = S.calc(oct({ oct: { 14: 30 } }, { totals: { [k(2026, 9)]: T } }), 2026, 9, AFTER).pSum;
  const plus = S.calc(oct({ oct: { 14: 34 } }, { totals: { [k(2026, 9)]: T } }), 2026, 9, AFTER).pSum;
  const minus = S.calc(oct({ oct: { 14: 24 } }, { totals: { [k(2026, 9)]: T } }), 2026, 9, AFTER).pSum;
  assert.equal(base, 358);
  assert.equal(plus, 362);   // +4 балла ремонтом
  assert.equal(minus, 352);  // ремонт на 6 баллов убрали
  // Все ремонты дня убрали — общее уменьшается на баллы этого дня
  assert.equal(S.calc(oct({}, { totals: { [k(2026, 9)]: T } }), 2026, 9, AFTER).pSum, 328);
});

test("идущая смена: её баллы видны в сумме, но не портят средний", () => {
  const P = { sep: { 22: 24, 24: 24, 26: 24, 28: 24, 30: 24 }, oct: { 2: 24, 4: 24, 6: 24, 8: 24, 10: 24, 12: 24, 14: 24, 16: 5 } };
  const during = S.calc(oct(P), 2026, 9, { y: 2026, m: 9, d: 16, hm: 13 * 60 });
  assert.equal(during.live, true);
  assert.equal(during.part, 5);
  assert.equal(during.pDone, 12);        // сегодняшняя ещё не отработана
  near(during.avgP, 24);                 // 5 частичных баллов средний не роняют
  const after = S.calc(oct(P), 2026, 9, { y: 2026, m: 9, d: 16, hm: 22 * 60 });
  assert.equal(after.live, false);
  assert.equal(after.pDone, 13);
  assert.ok(after.avgP < 24);
});

test("новый ремонт во время смены не поднимает норму на день (баг 358→362)", () => {
  const now = { y: 2026, m: 9, d: 16, hm: 14 * 60 };
  const P = n => ({ sep: { 22: 20, 24: 20, 26: 20, 28: 20, 30: 20 }, oct: { 2: 20, 4: 20, 6: 20, 8: 20, 10: 20, 12: 20, 14: 20, 16: n } });
  let prev = Infinity;
  for (const n of [0, 2, 6, 12, 20]) {
    const c = S.calc(oct(P(n)), 2026, 9, now);
    assert.ok(c.perDay <= prev, "норма выросла при " + n + " баллах: " + c.perDay);
    prev = c.perDay;
  }
});

test("смена с 21 числа идёт в премию следующего месяца, декабрь → январь", () => {
  assert.deepEqual(S.periodOf(2026, 9, 21), { y: 2026, m: 10 });
  assert.deepEqual(S.periodOf(2026, 9, 20), { y: 2026, m: 9 });
  assert.deepEqual(S.periodOf(2026, 11, 25), { y: 2027, m: 0 });
});

test("цель на смену — вверх до целого и не ниже минимума", () => {
  const st = S.opts(ST);
  assert.equal(S.goalDay(st, 24.1), 25);
  assert.equal(S.goalDay(st, 10), 18);
});

test("аванс фиксированный 43 300 ₽ при любом числе смен", () => {
  const D = oct();
  assert.equal(S.advance(D, 2026, 9), 43300);
  assert.equal(S.advance({ ...D, months: { [k(2026, 9)]: { 3: "w" } } }, 2026, 9), 43300);
  assert.equal(S.advance(D, 2026, 11), 0); // в месяце нет отметок — аванса нет
  const c = S.calc(D, 2026, 9, AFTER);
  near(S.salary(D, 2026, 9, AFTER), c.total - 43300);
});

test("старые настройки выплат без отметки сбрасываются на 20/5 и 43 300", () => {
  const P = S.payCfg({ payout: { adv: 25, mode: "half" } });
  assert.equal(P.adv, 20); assert.equal(P.sal, 5); assert.equal(P.mode, "fixed"); assert.equal(P.fix, 43300);
  assert.equal(S.payCfg({ payout: { adv: 25, sal: 10, mode: "fixed", fix: 40000, pv: 2 } }).adv, 25);
});

test("выплата в выходной или праздник — раньше, в ближайший рабочий день", () => {
  assert.deepEqual(S.payDay(2026, 5, 20), { y: 2026, m: 5, d: 19 });   // сб 20 июня → пт 19
  assert.deepEqual(S.payDay(2026, 8, 20), { y: 2026, m: 8, d: 18 });   // вс 20 сентября → пт 18
  assert.deepEqual(S.payDay(2026, 9, 20), { y: 2026, m: 9, d: 20 });   // вт 20 октября — без переноса
  assert.deepEqual(S.payDay(2027, 0, 5), { y: 2026, m: 11, d: 31 });   // 5 января праздники → чт 31 декабря
  const d = S.payDates({}, 2026, 11);
  assert.deepEqual(d.adv, { y: 2026, m: 11, d: 18 });                  // аванс за декабрь: вс 20 → пт 18
  assert.deepEqual(d.sal, { y: 2026, m: 11, d: 31 });                  // зарплата за декабрь: 5 января → 31 декабря
});

test("старые отметки true считаются обычной сменой, мусор пропускается", () => {
  const D = { months: { [k(2026, 9)]: { 1: true, 2: "w", 3: "zzz" } }, points: {}, totals: {}, settings: ST };
  const c = S.calc(D, 2026, 9, AFTER);
  assert.equal(c.cnt.w, 2);
  assert.equal(c.base, 2 * 5800);
});

test("доп. смена: своя ставка и участие в премии из настроек", () => {
  const st = { ...ST, types: { x: { pay: 7000, bonus: true }, s: { pay: 0, bonus: false }, a: { pay: 0, bonus: false } } };
  const D = { months: { [k(2026, 9)]: { 1: "x", 2: "s", 3: "a", 4: "o" } }, points: {}, totals: {}, settings: st };
  const c = S.calc(D, 2026, 9, AFTER);
  assert.equal(c.base, 7000);
  assert.equal(c.bonusDays, 1);
});

test("общее 0 в первый день периода во время смены — сегодняшние ремонты считаются (баг 34/12)", () => {
  // 21 окт: смена идёт, сохранили «общее 0 по 21 окт», когда за день было 22, потом стало 34
  const D = { months: { [k(2026, 9)]: { 21: "x" } }, points: { [k(2026, 9)]: { 21: 34 } },
    totals: { [k(2026, 10)]: { pts: 0, upTo: "2026-10-21", dp: 22 } }, settings: ST };
  const c = S.calc(D, 2026, 10, { y: 2026, m: 9, d: 21, hm: 20 * 60 });
  assert.equal(c.pSum, 34);
});

test("парт-тайм: цены по умолчанию и свои", () => {
  assert.deepEqual(S.ptPrices({}), { n: 100, l: 230, m: 450, h: 900, s: 1400 });
  assert.equal(S.ptPrices({ pt: { prices: { m: 500 } } }).m, 500);
  assert.equal(S.ptPrices({ pt: { prices: { m: "abc" } } }).m, 450); // мусор не ломает цену
});

test("парт-тайм: сумма за день и за месяц, старые цены сохраняются", () => {
  const days = {
    "2026-10-21": { pt: [["l", 230], ["m", 450], ["h", 900]] },
    "2026-10-22": { pt: [["s", 1400], ["n", 100], ["m", 400]] },   // средний записан по старой цене 400
    "2026-11-01": { pt: [["l", 230]] },                             // другой месяц — не считается
    "2026-10-23": { reps: [], note: "без парт-тайма" },
  };
  const d = S.ptDay(days["2026-10-21"].pt);
  assert.equal(d.sum, 1580); assert.equal(d.bikes, 3); assert.equal(d.by.m, 1);
  const M = S.ptMonth(days, 2026, 9);
  assert.equal(M.sum, 1580 + 1900);
  assert.equal(M.bikes, 6); assert.equal(M.days, 2);
  assert.deepEqual(M.best, { d: 22, sum: 1900, bikes: 3 });
  assert.equal(M.by.m, 2);
  assert.equal(M.perDay[21], 1580);
  near(M.avg, 1740);
  assert.equal(S.ptMonth({}, 2026, 9).sum, 0);
});

test("парт-тайм: выплата по четвергам за прошлую неделю (пн–вс)", () => {
  const days = {
    "2026-10-18": { pt: [["l", 230]] },                 // вс прошлой-прошлой недели — не в эту выплату
    "2026-10-19": { pt: [["m", 450]] },                 // пн
    "2026-10-25": { pt: [["s", 1400], ["n", 100]] },    // вс — последний день недели
    "2026-10-26": { pt: [["h", 900]] },                 // пн следующей недели
  };
  const fmt = o => o.y + "-" + (o.m + 1) + "-" + o.d;
  // понедельник 26 окт → ближайшая выплата чт 29 окт за 19–25 окт
  let p = S.ptNextPay(days, 2026, 9, 26);
  assert.equal(fmt(p.pay), "2026-10-29"); assert.equal(fmt(p.from), "2026-10-19"); assert.equal(fmt(p.to), "2026-10-25");
  assert.equal(p.sum, 1950); assert.equal(p.bikes, 3);
  // в сам четверг выплата — сегодня
  assert.equal(fmt(S.ptNextPay(days, 2026, 9, 29).pay), "2026-10-29");
  // в пятницу — уже следующий четверг, за неделю 26 окт – 1 ноя (через месяц)
  p = S.ptNextPay(days, 2026, 9, 30);
  assert.equal(fmt(p.pay), "2026-11-5"); assert.equal(fmt(p.to), "2026-11-1"); assert.equal(p.sum, 900);
  // недели октября: первая начинается 28 сентября, последняя кончается 1 ноября
  const W = S.ptWeeks(days, 2026, 9);
  assert.equal(fmt(W[0].from), "2026-9-28"); assert.equal(fmt(W[W.length - 1].to), "2026-11-1");
  assert.equal(W.reduce((a, w) => a + w.sum, 0), 230 + 450 + 1500 + 900);
  // переход через год
  assert.equal(fmt(S.ptNextPay({}, 2026, 11, 30).pay), "2026-12-31");
  assert.equal(fmt(S.ptNextPay({}, 2027, 0, 1).pay), "2027-1-7");
});
