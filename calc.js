/* «Смены» — общий расчёт для календаря и бота.
   Календарь (index.html) и бот (worker.js) считают деньги и баллы ОДНОЙ этой функцией,
   поэтому цифры в приложении и в боте всегда совпадают.
   Любое изменение здесь сначала проверяется тестами (calc_test.js) — без них ничего не выкладывается.

   Данные D = { months, points, totals, settings } — как их хранит календарь:
     months["2026-10"] = { 17: "w", 18: "o", ... }   w смена · x доп. смена · o выходной · s больничный · a прогул
     points["2026-10"] = { 17: 26, ... }             баллы за смену
     totals["2026-10"] = { pts, upTo, dp }           общее количество баллов из системы «по число включительно»
   now = { y, m, d, hm } — сегодняшний день (месяц с нуля) и минуты от полуночи; без него смена не считается идущей. */
(function (G) {
  "use strict";
  const VERSION = 1;
  const key = (y, m) => y + "-" + String(m + 1).padStart(2, "0");
  const ord = (y, m, d) => Date.UTC(y, m, d);
  const DEF = { rate: 5800, pct: 27, minPts: 18, maxPts: 24 };
  const TYPES0 = { x: { pay: null, bonus: true }, s: { pay: 0, bonus: false }, a: { pay: 0, bonus: false } };
  const KNOWN = { w: 1, x: 1, o: 1, s: 1, a: 1 };
  // Старые записи хранили true вместо типа — это обычная смена
  const tp = v => v === true ? "w" : KNOWN[v] ? v : null;

  function opts(settings) {
    const s = Object.assign({}, DEF, settings || {});
    s.rate = +s.rate; s.pct = +s.pct; s.minPts = +s.minPts; s.maxPts = +s.maxPts;
    s.types = Object.assign({}, TYPES0, s.types || {});
    return s;
  }
  const pay = (st, t) => t === "w" ? st.rate : t === "o" ? 0 :
    (st.types[t] && st.types[t].pay != null && st.types[t].pay !== "" ? +st.types[t].pay : st.rate);
  const inBonus = (st, t) => t === "w" ? true : t === "o" ? false : !!(st.types[t] && st.types[t].bonus);
  const isShift = t => t === "w" || t === "x";
  // Процент премии по среднему баллу: меньше минимума — 0, дальше равномерно до максимума
  function pctFor(st, p) {
    if (p == null) return st.pct;
    const lo = st.minPts, hi = st.maxPts;
    if (p >= hi) return st.pct;
    if (p < lo || hi <= lo) return 0;
    return st.pct * (p - lo) / (hi - lo);
  }
  const level = (st, p) => p >= st.maxPts ? "full" : p >= st.minPts ? "mid" : "low";

  // Оплата — за календарный месяц m. Премия — за смены с 21 числа прошлого месяца по 20 число месяца m включительно.
  function calc(D, y, m, now) {
    const st = opts(D.settings), months = D.months || {}, pts = D.points || {}, totals = D.totals || {};
    const cur = months[key(y, m)] || {};
    const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1, prev = months[key(py, pm)] || {};
    const cnt = { w: 0, x: 0, s: 0, a: 0, o: 0 };
    let base = 0;
    for (const d in cur) { const t = tp(cur[d]); if (!t) continue; cnt[t]++; base += pay(st, t); }
    let bonusBase = 0, bonusDays = 0, scored = 0, ptsSum = 0;
    const lv = { full: 0, mid: 0, low: 0 }, list = [], dates = [];
    const add = (days, P, from, to, mo, yy) => {
      for (const d in days) {
        const t = tp(days[d]);
        if (!t || +d < from || +d > to || !inBonus(st, t)) continue;
        const o = ord(yy, mo, +d);
        bonusBase += pay(st, t); bonusDays++; dates.push(o);
        const p = P && P[d] != null ? +P[d] : null;
        if (p != null) { scored++; ptsSum += p; lv[level(st, p)]++; list.push({ o, yy, mo, d: +d, p }); }
      }
    };
    add(prev, pts[key(py, pm)], 21, 31, pm, py);
    add(cur, pts[key(y, m)], 1, 20, m, y);

    // Сегодняшняя смена, пока идёт (до конца смены), не считается отработанной:
    // её баллы — частичные. Они видны в сумме, но не портят средний и цель на день.
    const tOrd = now ? ord(now.y, now.m, now.d) : -1;
    const [eh, em] = String((st.shift || {}).to || "21:30").split(":").map(Number);
    const live = !!now && dates.includes(tOrd) && now.hm < (isFinite(eh) ? eh : 21) * 60 + (isFinite(em) ? em : 30);
    const todayIt = list.find(it => it.o === tOrd);
    let pSum = ptsSum, pDone = scored, part = 0, counted = !!todayIt;
    // Общее количество из системы «по число включительно» + дневные баллы смен после этого числа
    const T0 = totals[key(y, m)], manual = !!(T0 && T0.pts != null && T0.upTo);
    if (manual) {
      const [ly, lm, ld] = String(T0.upTo).split("-").map(Number), lim = ord(ly, lm - 1, ld);
      let aSum = 0, aCnt = 0;
      for (const it of list) if (it.o > lim) { aSum += it.p; aCnt++; }
      // Баллы дня «по число», изменённые после сохранения общего (ремонт добавили или убрали), меняют итог
      let dl = 0;
      if (T0.dp != null) { const li = list.find(it => it.o === lim); dl = (li ? li.p : 0) - (+T0.dp || 0); }
      pSum = +T0.pts + aSum + dl;
      pDone = dates.filter(o => o <= lim).length + aCnt;
      counted = tOrd <= lim || !!todayIt;
      if (live && todayIt && (tOrd > lim || (T0.dp != null && tOrd === lim))) part = todayIt.p;
    } else if (live && todayIt) part = todayIt.p;
    if (live && counted) pDone--;

    const avgP = pDone ? (pSum - part) / pDone : null;
    const bonusPct = pctFor(st, avgP), bonus = bonusBase * bonusPct / 100, bonusMax = bonusBase * st.pct / 100;
    const goal = bonusDays * st.maxPts, left = bonusDays - pDone, need = goal - pSum;
    const perDay = need <= 0 ? 0 : left > 0 ? Math.ceil(need / left * 10 - 1e-9) / 10 : null;
    // Цена балла: сколько рублей премии меняет один балл, когда средний между минимумом и нормой
    const price = bonusDays && st.maxPts > st.minPts ? bonusBase * st.pct / 100 / (st.maxPts - st.minPts) / bonusDays : 0;
    // Запас: на сколько баллов можно недобрать и сохранить полную премию
    const surplus = pDone ? (pSum - part) - pDone * st.maxPts : 0;
    // Прогноз, если остальные смены будут ровно по норме
    const projAvg = bonusDays ? (pSum - part + left * st.maxPts) / bonusDays : null;
    const projBonus = bonusBase * pctFor(st, projAvg) / 100;
    return {
      cnt, base, bonus, bonusMax, bonusBase, bonusPct, total: base + bonus,
      bonusDays, scored, ptsSum, avg: scored ? ptsSum / scored : null, lv, list, dates, pm,
      pSum, pDone, avgP, avgSrc: manual ? "manual" : (scored ? "daily" : "none"), live, part,
      goal, left, need, perDay, price, surplus, projBonus,
    };
  }
  // Какой премиальный период у дня: с 21 числа — уже следующий месяц
  const periodOf = (y, m, d) => d >= 21 ? { y: m === 11 ? y + 1 : y, m: (m + 1) % 12 } : { y, m };
  // Цель на смену: фактически нужное, округлённое вверх, но не ниже дневного минимума
  const goalDay = (st, v) => Math.max(Math.ceil(v - 1e-9), st.minPts);

  // ---------- Выплаты ----------
  const PAYDEF = { adv: 20, sal: 5, mode: "fixed", fix: 43300, ndfl: false };
  // Старые настройки без отметки pv:2 сбрасываются на действующие правила
  function payCfg(settings) { let p = (settings && settings.payout) || {}; if (!p.pv) p = { ndfl: !!p.ndfl }; return Object.assign({}, PAYDEF, p); }
  const netv = (settings, v) => payCfg(settings).ndfl ? v * 0.87 : v;
  // Аванс за месяц: фиксированная сумма (если в месяце есть отметки) или оплата смен с 1 по 15 число
  function advance(D, y, m) {
    const P = payCfg(D.settings), days = (D.months || {})[key(y, m)] || {};
    if (P.mode === "fixed") return Object.keys(days).length ? Math.max(0, +P.fix || 0) : 0;
    const st = opts(D.settings); let s = 0;
    for (const d in days) { const t = tp(days[d]); if (t && +d <= 15) s += pay(st, t); }
    return netv(D.settings, s);
  }
  // Зарплата за месяц: всё за месяц (смены и премия) минус аванс; приходит в следующем месяце
  const salary = (D, y, m, now) => Math.max(0, netv(D.settings, calc(D, y, m, now).total) - advance(D, y, m));
  // Выплата в выходной или праздник переносится на ближайший рабочий день раньше (ст. 136 ТК РФ)
  const HOLI = ["01-01", "01-02", "01-03", "01-04", "01-05", "01-06", "01-07", "01-08", "02-23", "03-08", "05-01", "05-09", "06-12", "11-04"];
  function payDay(y, m, d) {
    let o = ord(y, m, d);
    for (let i = 0; i < 14; i++) {
      const x = new Date(o), g = x.getUTCDay(), md = String(x.getUTCMonth() + 1).padStart(2, "0") + "-" + String(x.getUTCDate()).padStart(2, "0");
      if (g !== 0 && g !== 6 && !HOLI.includes(md)) break;
      o -= 864e5;
    }
    const x = new Date(o);
    return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate() };
  }
  const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  // Даты выплат за месяц m: аванс в этом месяце, зарплата — в следующем
  function payDates(settings, y, m) {
    const P = payCfg(settings), ny = m === 11 ? y + 1 : y, nm = (m + 1) % 12;
    return {
      adv: payDay(y, m, Math.min(Math.max(1, +P.adv || 20), dim(y, m))),
      sal: payDay(ny, nm, Math.min(Math.max(1, +P.sal || 5), dim(ny, nm))),
    };
  }

  G.SmenyCalc = { VERSION, key, ord, opts, tp, pay, inBonus, isShift, pctFor, level, calc, periodOf, goalDay,
    PAYDEF, payCfg, netv, advance, salary, HOLI, payDay, payDates, dim };
})(typeof globalThis !== "undefined" ? globalThis : this);
