import "./calc.js";
const SC = globalThis.SmenyCalc;
// Сервер бота «Смены» для Cloudflare Workers.
// Принимает график и баллы из календаря (только у тех, кто включил уведомления),
// отвечает на сообщения в чате и по расписанию присылает:
//   21:00 — что завтра: смена, доп. смена или выходной; по воскресеньям — итоги недели и копия данных;
//   21:45 — статистику за смену или напоминание внести баллы (с кнопками баллов);
//   22:00 — повторное напоминание, если баллы так и не внесены.
// Что присылать, человек выбирает в календаре: «Настройки» → «Уведомления» (там же пауза).
// В чате: число «26» записывает баллы за сегодня, «15.10 26» — за дату;
// команды /today /stats /money /schedule.
//
// Нужно в настройках Worker:
//   BOT_TOKEN   — секрет: токен бота от @BotFather
//   HOOK_SECRET — секрет: любой длинный пароль (латиница и цифры)
//   DB          — привязка KV-хранилища
//   Cron Triggers (время UTC): "0 18 * * *", "45 18 * * *", "0 19 * * *"
//   AI          — привязка Workers AI (для графика с фото)
// После обновления кода один раз откройте /setup?key=HOOK_SECRET.

const DEFAULT_APP = "https://s000008867.github.io/smeny-team/";
const APP_PREFIX = "https://s000008867.github.io/";
const TZ_OFFSET_H = 3; // Москва, без перехода на летнее время

const GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTH_NOM = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
const WD = ["воскресенье","понедельник","вторник","среду","четверг","пятницу","субботу"];
const WD_SHORT = ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];
const TYPE_NAME = { w: "смена", x: "доп. смена", o: "выходной", s: "больничный", a: "прогул" };

// ---------- общие помощники ----------
const enc = s => new TextEncoder().encode(s);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(msg)));
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
const plur = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return (m10 === 1 && m100 !== 11) ? a : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) ? b : c; };
const shifts = n => n + " " + plur(n, "смена", "смены", "смен");
const pointsN = n => n + " " + plur(Math.round(n), "балл", "балла", "баллов");
const f1 = v => (Math.round(v * 10) / 10).toString().replace(".", ",");
const money = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";
const key = (y, m) => y + "-" + String(m + 1).padStart(2, "0");

// Текущая дата по Москве: {y, m (0-11), d, hm (минуты от полуночи)}
function mskNow(ms = Date.now()) {
  const t = new Date(ms + TZ_OFFSET_H * 3600e3);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), hm: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function addDays(day, n) {
  const t = new Date(Date.UTC(day.y, day.m, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}
const dayId = day => key(day.y, day.m) + "-" + String(day.d).padStart(2, "0");
const ord = (y, m, d) => Date.UTC(y, m, d);
const ordOf = day => ord(day.y, day.m, day.d);
const wdOf = day => new Date(Date.UTC(day.y, day.m, day.d)).getUTCDay();

// ---------- расчёт: общий с календарём, файл calc.js (там же проверки) ----------
function makeCalc(data) {
  const months = data.months || {}, pts = data.points || {}, st = SC.opts(data.settings);
  const isShift = SC.isShift;
  const typeOn = day => (months[key(day.y, day.m)] || {})[day.d];
  const ptsOn = day => { const P = pts[key(day.y, day.m)] || {}; return P[day.d] != null ? +P[day.d] : null; };
  // Премия месяца m — за смены с 21 числа прошлого месяца по 20 число месяца m; «сегодня» — по Москве
  const calc = (y, m) => SC.calc(data, y, m, mskNow());
  const periodOf = day => SC.periodOf(day.y, day.m, day.d);
  const goalDay = v => SC.goalDay(st, v);

  // Серии и рекорды по дневным баллам (смены без баллов серию не прерывают)
  function records(today) {
    const tOrd = ordOf(today), list = [];
    for (const k in months) {
      const [y, mm] = k.split("-").map(Number), P = pts[k] || {};
      for (const d in months[k]) {
        if (!isShift(months[k][d]) || P[d] == null) continue;
        const o = ord(y, mm - 1, +d);
        if (o <= tOrd) list.push({ o, p: +P[d], y, m: mm - 1, d: +d });
      }
    }
    list.sort((a, b) => a.o - b.o);
    let cur = 0, best = 0, top = null, prevTop = null;
    for (const it of list) {
      if (it.p >= st.maxPts) { cur++; if (cur > best) best = cur; } else cur = 0;
      if (!top || it.p > top.p) top = it;
      if (it.o !== tOrd && (!prevTop || it.p > prevTop.p)) prevTop = it;
    }
    return { cur, best, top, prevTop, count: list.length };
  }
  return { st, typeOn, ptsOn, isShift, calc, periodOf, goalDay, records };
}

// ---------- тексты сообщений (HTML-разметка Telegram) ----------
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const bar = (frac, n = 10) => { const k = Math.max(0, Math.min(n, Math.round((frac || 0) * n))); return "▰".repeat(k) + "▱".repeat(n - k); };
const TYPE_EMO = { w: "🟢", x: "🔵", o: "⚪️", s: "🟣", a: "🔴" };
const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
const dd = day => day.d + " " + GEN[day.m];
const ddShort = day => day.d + " " + GEN[day.m].slice(0, 3);

function priceLines(c, s) {
  const out = [];
  if (!s.bonusDays || !s.pDone) return out;
  if (s.surplus >= 0) out.push("🛡 Запас: <b>" + pointsN(s.surplus) + "</b> — можно недобрать и сохранить полную премию");
  else {
    out.push("💎 Цена балла: <b>≈ " + money(s.price) + "</b> премии");
    if (s.projBonus < s.bonusMax - 0.5) out.push("🔮 Прогноз, если дальше по норме: " + money(s.projBonus) + " (−" + money(s.bonusMax - s.projBonus) + ")");
  }
  return out;
}
function recordLines(c, day) {
  const r = c.records(day), p = c.ptsOn(day), out = [];
  if (p != null && r.prevTop && p > r.prevTop.p) out.push("🚀 <b>Новый рекорд смены: " + p + "!</b> Прошлый — " + r.prevTop.p + " (" + ddShort(r.prevTop) + ")");
  if (r.cur >= 2) out.push("🔥 Серия: <b>" + shifts(r.cur) + "</b> подряд с нормой" + (r.cur === r.best && r.cur >= 3 ? " — лучшая!" : " (рекорд " + r.best + ")"));
  return out;
}
function periodBlock(c, s, per) {
  const max = +c.st.maxPts, pm = per.m === 0 ? 11 : per.m - 1, out = [];
  out.push("📊 <b>Период 21 " + GEN[pm].slice(0, 3) + " – 20 " + GEN[per.m].slice(0, 3) + "</b>");
  out.push("Набрано <b>" + f1(s.pSum) + "</b> из " + s.goal + " · " + shifts(s.pDone) + ", осталось " + s.left);
  out.push(bar(s.goal ? s.pSum / s.goal : 0) + " " + pct(s.pSum, s.goal) + "%");
  if (s.avgP != null) out.push("Средний <b>" + f1(s.avgP) + "</b> " + (s.avgP >= max ? "✅ премия полная" : "⚠️ ниже нормы " + max));
  if (s.perDay > 0) out.push("🎯 Нужно в день: <b>" + f1(s.perDay) + "</b> (" + f1(s.need) + " за " + shifts(s.left) + ")");
  else if (s.perDay === 0) out.push("🎯 Цель периода выполнена");
  return out;
}

function textTomorrow(data, today) {
  const c = makeCalc(data), tm = addDays(today, 1), t = c.typeOn(tm);
  const when = "<b>Завтра, " + dd(tm) + "</b>";
  if (c.isShift(t)) {
    const per = c.periodOf(tm), s = c.calc(per.y, per.m);
    const sh = (data.settings && data.settings.shift) || {}, hm = v => String(v || "").replace(/^0(\d):/, "$1:");
    const lines = [(t === "x" ? "🔵 " : "🟢 ") + when + " — " + (t === "x" ? "доп. смена" : "смена") + ", " + (hm(sh.from) || "9:30") + "–" + (hm(sh.to) || "21:30")];
    if (s.perDay > 0) lines.push("🎯 Цель: <b>" + pointsN(c.goalDay(s.perDay)) + "</b> (фактически " + f1(s.perDay) + ")");
    else if (s.perDay === 0) lines.push("🎯 Цель периода уже набрана — работайте в своём темпе");
    if (s.avgP != null) lines.push("Средний за период: " + f1(s.avgP));
    lines.push("Хорошей смены! 💪");
    return lines.join("\n");
  }
  if (t === "o") {
    const lines = ["⚪️ " + when + " — выходной. Отдыхайте! 😌"];
    const nx = nextShift(c, tm);
    if (nx) lines.push("Следующая смена — в " + WD[wdOf(nx)] + ", " + dd(nx));
    return lines.join("\n");
  }
  if (t === "s") return "🟣 " + when + " — больничный. Выздоравливайте!";
  return null;
}
function nextShift(c, from) { for (let i = 1; i <= 60; i++) { const d = addDays(from, i); if (c.isShift(c.typeOn(d))) return d; } return null; }

function textStats(data, day, title) {
  const c = makeCalc(data), p = c.ptsOn(day), t = c.typeOn(day);
  const per = c.periodOf(day), s = c.calc(per.y, per.m), month = c.calc(day.y, day.m), max = +c.st.maxPts;
  const lines = [title || ("🏁 <b>" + (t === "x" ? "Доп. смена" : "Смена") + " " + dd(day) + " окончена</b>")];
  lines.push(p >= max ? "✅ Баллы: <b>" + f1(p) + "</b> — норма " + max + " выполнена, +" + f1(p - max) : "Баллы: <b>" + f1(p) + "</b> — до нормы " + max + " не хватило " + f1(max - p));
  lines.push(...recordLines(c, day));
  lines.push("", ...periodBlock(c, s, per));
  lines.push(...priceLines(c, s));
  lines.push("", "💰 За " + MONTH_NOM[day.m] + ": <b>" + money(month.total) + "</b>");
  return lines.join("\n");
}

function textToday(data, today) {
  const c = makeCalc(data), t = c.typeOn(today), p = c.ptsOn(today);
  const head = (t ? TYPE_EMO[t] + " " : "▫️ ") + "<b>Сегодня, " + dd(today) + "</b> — " + (t ? TYPE_NAME[t] : "не отмечено");
  const lines = [head];
  if (c.isShift(t)) {
    const per = c.periodOf(today), s = c.calc(per.y, per.m);
    if (p != null) lines.push("✍️ Внесено: <b>" + pointsN(p) + "</b>" + (p >= c.st.maxPts ? " ✅" : ""));
    else if (s.perDay > 0) lines.push("🎯 Цель: <b>" + pointsN(c.goalDay(s.perDay)) + "</b> (фактически " + f1(s.perDay) + ")");
    else if (s.perDay === 0) lines.push("🎯 Цель периода уже набрана");
    lines.push("", "Пришлите число, например <b>26</b>, — запишу баллы.");
  } else {
    const nx = nextShift(c, today);
    if (nx) lines.push("Следующая смена — в " + WD[wdOf(nx)] + ", " + dd(nx));
  }
  return lines.join("\n");
}

function textPeriod(data, today) {
  const c = makeCalc(data), per = c.periodOf(today), s = c.calc(per.y, per.m);
  const lines = periodBlock(c, s, per);
  lines.push(...priceLines(c, s));
  lines.push("💰 Премия сейчас: <b>" + money(s.bonus) + "</b> из " + money(s.bonusMax));
  const r = c.records(today);
  if (r.top) lines.push("🏅 Рекорд смены " + f1(r.top.p) + " (" + ddShort(r.top) + ") · лучшая серия " + r.best);
  return lines.join("\n");
}

function textMoney(data, today) {
  const c = makeCalc(data), s = c.calc(today.y, today.m);
  const pm = today.m === 0 ? 11 : today.m - 1, py = today.m === 0 ? today.y - 1 : today.y, prev = c.calc(py, pm);
  const lines = ["💰 <b>" + MONTH_NOM[today.m][0].toUpperCase() + MONTH_NOM[today.m].slice(1) + "</b> — по отмеченным сменам", ""];
  lines.push("Смены: " + money(s.base));
  lines.push("Премия: " + money(s.bonus) + (s.bonus < s.bonusMax - 0.5 ? " <i>(полная " + money(s.bonusMax) + ")</i>" : " ✅"));
  lines.push("━━━━━━━━━━━━", "Итого: <b>" + money(s.total) + "</b>");
  if (prev.total > 0) { const d = s.total - prev.total; lines.push((d >= 0 ? "📈 На " + money(d) + " больше" : "📉 На " + money(-d) + " меньше") + ", чем за " + MONTH_NOM[pm]); }
  return lines.join("\n");
}

function textSchedule(data, today) {
  const c = makeCalc(data), lines = ["🗓 <b>Ближайшие 7 дней</b>", ""];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i), t = c.typeOn(d), p = c.ptsOn(d);
    const row = (t ? TYPE_EMO[t] : "▫️") + " " + WD_SHORT[wdOf(d)] + " " + ddShort(d) + " — " + (t ? TYPE_NAME[t] : "не отмечено") + (p != null ? " · " + f1(p) : "");
    lines.push(i === 0 ? "<b>" + row + "</b> ← сегодня" : row);
  }
  return lines.join("\n");
}

// Итоги недели: последние 7 дней против предыдущих 7
function textWeek(data, today) {
  const c = makeCalc(data);
  const span = (from, to) => { let n = 0, sum = 0, cnt = 0, norm = 0, best = null;
    for (let i = from; i <= to; i++) { const d = addDays(today, -i), t = c.typeOn(d); if (!c.isShift(t)) continue; n++; const p = c.ptsOn(d);
      if (p != null) { sum += p; cnt++; if (p >= c.st.maxPts) norm++; if (!best || p > best.p) best = { p, d }; } }
    return { n, sum, cnt, norm, best, avg: cnt ? sum / cnt : null }; };
  const a = span(0, 6), b = span(7, 13);
  const lines = ["🗓 <b>Неделя: " + ddShort(addDays(today, -6)) + " – " + ddShort(today) + "</b>", ""];
  if (!a.n) return lines.concat("Смен на этой неделе не было. Отдохнули — тоже результат 😌").join("\n");
  lines.push("Смен: <b>" + a.n + "</b>" + (a.cnt < a.n ? " (баллы внесены за " + a.cnt + ")" : ""));
  if (a.cnt) {
    lines.push("Баллов: <b>" + f1(a.sum) + "</b> · средний <b>" + f1(a.avg) + "</b>");
    lines.push("Норма " + c.st.maxPts + "+: " + a.norm + " из " + a.cnt + "  " + bar(a.norm / a.cnt, 7));
    if (a.best) lines.push("🚀 Лучшая смена: " + f1(a.best.p) + " (" + ddShort(a.best.d) + ")");
    if (b.avg != null) { const df = a.avg - b.avg; lines.push((df >= 0 ? "📈 Средний выше прошлой недели на " : "📉 Средний ниже прошлой недели на ") + f1(Math.abs(df))); }
  }
  return lines.join("\n");
}

// Рекорды и серии
function textRecords(data, today) {
  const c = makeCalc(data), r = c.records(today), lines = ["🏅 <b>Рекорды</b>", ""];
  if (!r.count) return lines.concat("Пока нечего показать — вносите баллы после смен.").join("\n");
  lines.push("🚀 Рекорд смены: <b>" + f1(r.top.p) + "</b> (" + dd(r.top) + ")");
  lines.push("🔥 Лучшая серия с нормой: <b>" + shifts(r.best) + "</b>" + (r.cur ? " · сейчас " + r.cur : ""));
  // лучший средний за период и сильный день недели
  const seen = new Set(); let bestAvg = null; const wd = {};
  for (const k in (data.months || {})) {
    const [y, mm] = k.split("-").map(Number);
    for (const [py, pm] of [[y, mm - 1], [mm === 12 ? y + 1 : y, mm % 12]]) { const kk = key(py, pm); if (seen.has(kk)) continue; seen.add(kk);
      const s = c.calc(py, pm); if (s.pDone >= 5 && s.avgP != null && (!bestAvg || s.avgP > bestAvg.v)) bestAvg = { v: s.avgP, m: pm }; }
    const P = (data.points || {})[k] || {};
    for (const d in data.months[k]) { if (!c.isShift(data.months[k][d]) || P[d] == null) continue; const w = wdOf({ y, m: mm - 1, d: +d }); (wd[w] = wd[w] || []).push(+P[d]); }
  }
  if (bestAvg) lines.push("📊 Лучший средний за период: <b>" + f1(bestAvg.v) + "</b> (премия за " + MONTH_NOM[bestAvg.m] + ")");
  let bw = null; for (const w in wd) { if (wd[w].length < 2) continue; const v = wd[w].reduce((x, y) => x + y, 0) / wd[w].length; if (!bw || v > bw.v) bw = { w: +w, v }; }
  if (bw) lines.push("📅 Сильнее всего — в " + WD[bw.w] + ": в среднем " + f1(bw.v));
  lines.push("✍️ Смен с баллами: " + r.count);
  return lines.join("\n");
}

// «Что если»: как изменится средний и премия, если на ближайшей смене набрать N
function textIf(data, today, n) {
  const c0 = makeCalc(data);
  let day = null; for (let i = 0; i <= 40; i++) { const d = addDays(today, i); if (c0.isShift(c0.typeOn(d)) && c0.ptsOn(d) == null) { day = d; break; } }
  if (!day) return "🔮 Не нашёл ближайшую смену без баллов. Отметьте смены в календаре.";
  const per = c0.periodOf(day), before = c0.calc(per.y, per.m);
  const copy = JSON.parse(JSON.stringify(data)); copy.points = copy.points || {}; const k = key(day.y, day.m);
  copy.points[k] = Object.assign({}, copy.points[k] || {}, { [day.d]: n });
  const after = makeCalc(copy).calc(per.y, per.m);
  const lines = ["🔮 <b>Если " + (ordOf(day) === ordOf(today) ? "сегодня" : dd(day)) + " набрать " + n + "</b>", ""];
  lines.push("Средний: " + (before.avgP != null ? f1(before.avgP) : "—") + " → <b>" + (after.avgP != null ? f1(after.avgP) : "—") + "</b>");
  lines.push("Премия: " + money(before.bonus) + " → <b>" + money(after.bonus) + "</b>" + (after.bonus >= after.bonusMax - 0.5 ? " ✅ полная" : ""));
  const d = after.bonus - before.bonus; if (Math.abs(d) >= 1) lines.push(d > 0 ? "Это +" + money(d) + " к премии 💰" : "Это −" + money(-d) + " от премии");
  if (after.perDay > 0) lines.push("Дальше нужно в день: " + f1(after.perDay));
  return lines.join("\n");
}

const HELP = "<b>Что умеет бот</b>\n\n" +
  "✍️ <b>26</b> — записать баллы за сегодня\n" +
  "✍️ <b>вчера 26</b> или <b>15.10 26</b> — за другой день\n" +
  "🔮 <b>если 30</b> — что будет со средним и премией\n\n" +
  "/menu — меню с кнопками\n" +
  "/today — что сегодня и цель\n" +
  "/stats — период премии, средний, запас\n" +
  "/money — заработок за месяц\n" +
  "/week — итоги недели\n" +
  "/schedule — график на 7 дней\n" +
  "/records — рекорды и серии\n" +
  "/backup — прислать копию данных файлом\n" +
  "/donate — поддержать проект ⭐\n\n" +
  "Каждый вечер: в 21:00 — что завтра, в 21:45 — итоги смены. По воскресеньям — итоги недели. Что присылать, выбирается в календаре: «Настройки» → «Уведомления».";
const MENU_HEAD = "☰ <b>Смены</b> — календарь механика\nВыберите, что показать 👇";

// ---------- Поддержка звёздами Telegram ----------
const DONATE_AMOUNTS = [50, 100, 250, 500];
const DONATE_HEAD = "⭐ <b>Поддержать «Смены»</b>\n\nКалендарь бесплатный и без рекламы. Если он помогает считать смены и зарплату — можно поддержать разработку звёздами Telegram.\n\nЭто по желанию: всё и так работает 🙂\nВыберите сумму 👇";
const donateKb = () => ({ inline_keyboard: [
  DONATE_AMOUNTS.slice(0, 2).map(n => ({ text: "⭐ " + n, callback_data: "don:" + n })),
  DONATE_AMOUNTS.slice(2).map(n => ({ text: "⭐ " + n, callback_data: "don:" + n })),
] });
const invoiceOf = n => ({ title: "Поддержка «Смен»", description: "Спасибо, что поддерживаете календарь механика! Звёзды пойдут на развитие приложения.",
  payload: "don:" + n, currency: "XTR", prices: [{ label: "Поддержка", amount: n }] });
async function onPaid(env, msg) {
  const p = msg.successful_payment, n = +p.total_amount || 0, from = msg.from || {};
  const sum = (+(await env.DB.get("don:sum")) || 0) + n;
  await env.DB.put("don:sum", String(sum));
  let log = []; try { log = JSON.parse((await env.DB.get("don:log")) || "[]"); } catch (e) {}
  log.unshift({ id: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(" "), un: from.username || "", n, ch: p.telegram_payment_charge_id, t: Date.now() });
  await env.DB.put("don:log", JSON.stringify(log.slice(0, 200)));
  await send(env, msg.chat.id, "💛 <b>Спасибо за поддержку!</b>\nПолучено " + n + " ⭐. Это очень помогает развивать «Смены».", null);
  const owner = await env.DB.get("owner");
  if (owner) {
    const who = esc(log[0].name || "без имени") + (from.username ? " (@" + esc(from.username) + ")" : "");
    await send(env, +owner, "⭐ <b>Поддержка: " + n + " звёзд</b>\nОт: " + who + "\nВсего собрано: " + sum + " ⭐\n\nВернуть, если платёж ошибочный:\n<code>/refund " + from.id + " " + esc(p.telegram_payment_charge_id) + "</code>", null);
  }
}

// ---------- Telegram ----------
async function tg(env, method, body) {
  const r = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false }));
}
const appButton = (url, text) => ({ inline_keyboard: [[{ text: "📅 " + (text || "Открыть календарь"), web_app: { url } }, { text: "☰ Меню", callback_data: "m:menu" }]] });
const menuKb = url => ({ inline_keyboard: [
  [{ text: "📅 Открыть календарь", web_app: { url: url || DEFAULT_APP } }],
  [{ text: "🛠 Сегодня", callback_data: "m:today" }, { text: "📊 Период", callback_data: "m:stats" }],
  [{ text: "💰 Деньги", callback_data: "m:money" }, { text: "🗓 Неделя", callback_data: "m:week" }],
  [{ text: "📆 График", callback_data: "m:sched" }, { text: "🏅 Рекорды", callback_data: "m:rec" }],
  [{ text: "❓ Помощь", callback_data: "m:help" }],
] });
const replyKb = { keyboard: [[{ text: "🛠 Сегодня" }, { text: "📊 Период" }], [{ text: "💰 Деньги" }, { text: "🗓 Неделя" }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: "Баллы, например 26" };
async function send(env, chatId, text, url, button, markup) {
  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup || appButton(url || DEFAULT_APP, button) });
}
// Файл в чат (копия данных)
async function sendFile(env, chatId, name, text, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption || ""); fd.append("parse_mode", "HTML");
  fd.append("document", new Blob([text], { type: "application/json" }), name);
  const r = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendDocument", { method: "POST", body: fd });
  return r.json().catch(() => ({ ok: false }));
}
// Копия в формате «Скачать копию» из календаря — её можно загрузить через «Восстановить из файла»
async function sendBackup(env, u, today) {
  const d = u.data || {};
  const body = { app: "salary-calendar", version: 2, exportedAt: new Date().toISOString(), settings: d.settings || {}, months: d.months || {}, points: d.points || {}, totals: d.totals || {}, days: d.days || {}, pays: d.pays || {} };
  const name = "смены-" + dayId(today) + ".json";
  const nm = Object.keys(body.months).filter(k => Object.keys(body.months[k] || {}).length).length;
  return sendFile(env, u.id, name, JSON.stringify(body),
    "💾 <b>Копия данных «Смен»</b> на " + dd(today) + " · месяцев: " + nm + "\nЧтобы восстановить: календарь → «Настройки» → «Синхронизация и копии» → «Восстановить из файла».");
}
const notifsOf = u => Object.assign({ eve: true, end: true, rem2: true, week: true, backup: false }, (u.data && u.data.settings && u.data.settings.notifs) || {});
const pausedOn = (u, today) => { const p = u.data && u.data.settings && u.data.settings.pauseUntil; return !!(p && dayId(today) < p); };

// Кнопки с баллами под напоминанием
function pointsKeyboard(day, appUrl) {
  const id = dayId(day), row = vals => vals.map(v => ({ text: String(v), callback_data: "pt:" + id + ":" + v }));
  return { inline_keyboard: [row([18, 20, 22, 24]), row([26, 28, 30, 32]), [{ text: "✏️ Другое число — в календаре", web_app: { url: (appUrl || DEFAULT_APP) + "#points" } }]] };
}

// Проверка данных запуска мини-приложения (initData) по подписи Telegram
async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash"); if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => k + "=" + v).join("\n");
  const secret = await hmac("WebAppData", botToken);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const authDate = +params.get("auth_date") || 0;
  if (Date.now() / 1000 - authDate > 7 * 86400) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}

// ---------- хранилище ----------
const userKey = id => "u:" + id;
async function getUser(env, id) { const v = await env.DB.get(userKey(id)); return v ? JSON.parse(v) : null; }
async function putUser(env, u) {
  const keep = {}; const cutoff = dayId(addDays(mskNow(), -3));
  for (const k in (u.sent || {})) if (k.slice(0, 10) >= cutoff) keep[k] = 1;
  u.sent = keep;
  u.inbox = (u.inbox || []).filter(it => Date.now() - it.at < 30 * 86400e3);
  await env.DB.put(userKey(u.id), JSON.stringify(u));
}
async function allUsers(env) {
  const out = []; let cursor;
  do {
    const r = await env.DB.list({ prefix: "u:", cursor });
    for (const k of r.keys) { const v = await env.DB.get(k.name); if (v) out.push(JSON.parse(v)); }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

// Баллы, присланные в чат: сразу в копию данных на сервере и во «входящие» для календаря
function applyPoints(u, day, p) {
  u.data = u.data || {}; u.data.points = u.data.points || {};
  const k = key(day.y, day.m);
  u.data.points[k] = Object.assign({}, u.data.points[k] || {}, { [day.d]: p });
  u.inbox = (u.inbox || []).filter(it => !(it.k === k && it.d === day.d));
  u.inbox.push({ k, d: day.d, p, at: Date.now() });
}
function reapplyInbox(u) {
  for (const it of (u.inbox || [])) {
    u.data.points = u.data.points || {};
    u.data.points[it.k] = Object.assign({}, u.data.points[it.k] || {}, { [it.d]: it.p });
  }
}

// Разбор сообщения с баллами: «26», «15.10 26», «вчера 26»
function parsePoints(text, today) {
  const t = String(text || "").trim().toLowerCase().replace(",", ".");
  let m;
  if ((m = t.match(/^(\d{1,3})$/))) return { day: null, p: +m[1] };
  if ((m = t.match(/^вчера\s+(\d{1,3})$/))) return { day: addDays(today, -1), p: +m[1] };
  if ((m = t.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,3})$/))) {
    let y = m[3] ? +m[3] : today.y; if (y < 100) y += 2000;
    const day = { y, m: +m[2] - 1, d: +m[1] };
    if (day.m < 0 || day.m > 11 || day.d < 1 || day.d > 31) return { error: "date" };
    if (!m[3] && ordOf(day) > ordOf(today)) day.y--; // «28.12» в январе — прошлый год
    return { day, p: +m[4] };
  }
  return null;
}

async function recordFromChat(env, u, day, p, today) {
  const c = makeCalc(u.data || {});
  if (!c.isShift(c.typeOn(day))) return { ok: false, text: (ordOf(day) === ordOf(today) ? "Сегодня" : day.d + " " + GEN[day.m]) + " по графику не смена. Отметьте смену в календаре или пришлите баллы с датой: 15.10 26." };
  if (ordOf(day) > ordOf(today)) return { ok: false, text: "Эта смена ещё не наступила." };
  if (p > 200) return { ok: false, text: "Слишком большое число. Пришлите баллы за смену, например 26." };
  applyPoints(u, day, p);
  const isToday = ordOf(day) === ordOf(today);
  if (isToday) { u.sent = u.sent || {}; u.sent[dayId(day) + ":stats"] = 1; }
  const title = "✍️ <b>Записал: " + pointsN(p) + "</b> за " + (isToday ? "сегодня" : day.d + " " + GEN[day.m]);
  return { ok: true, text: textStats(u.data, day, title) + "\n\n<i>В календаре баллы появятся при следующем открытии.</i>" };
}

// Статистика или напоминание в конце смены. job: "end1" (21:45), "end2" (22:00), "sync" (баллы внесены позже)
async function endOfShift(env, u, job, today) {
  const c = makeCalc(u.data || {}), t = c.typeOn(today), N = notifsOf(u);
  if (!c.isShift(t) || pausedOn(u, today) || !N.end) return false;
  if (job === "end2" && !N.rem2) return false;
  const id = dayId(today), p = c.ptsOn(today);
  if (p != null) {
    if (u.sent[id + ":stats"]) return false;
    await send(env, u.id, textStats(u.data, today), u.appUrl, "Открыть календарь");
    u.sent[id + ":stats"] = 1; return true;
  }
  if (job === "end1" && !u.sent[id + ":rem1"]) {
    await send(env, u.id, "🏁 <b>Смена закончилась!</b>\nСколько баллов сегодня, " + today.d + " " + GEN[today.m] + "? Нажмите число или пришлите его сообщением 👇", null, null, pointsKeyboard(today, u.appUrl));
    u.sent[id + ":rem1"] = 1; return true;
  }
  if (job === "end2" && !u.sent[id + ":rem2"]) {
    await send(env, u.id, "⏰ Напоминаю: баллы за сегодня ещё не внесены.\nНажмите число или пришлите его сообщением 👇", null, null, pointsKeyboard(today, u.appUrl));
    u.sent[id + ":rem2"] = 1; return true;
  }
  return false;
}

async function runJob(env, job) {
  const today = mskNow(), users = await allUsers(env);
  for (const u of users) {
    if (!u.enabled) continue;
    u.sent = u.sent || {};
    let changed = false;
    try {
      if (job === "eve") {
        const N = notifsOf(u), id = dayId(today), sunday = wdOf(today) === 0, paused = pausedOn(u, today);
        if (N.eve && !paused && !u.sent[id + ":eve"]) { const txt = textTomorrow(u.data || {}, today); if (txt) await send(env, u.id, txt, u.appUrl); u.sent[id + ":eve"] = 1; changed = true; }
        if (sunday && N.week && !paused && !u.sent[id + ":week"]) { await send(env, u.id, textWeek(u.data || {}, today), u.appUrl); u.sent[id + ":week"] = 1; changed = true; }
        // Копия приходит и во время паузы: это не уведомление, а сохранность данных
        if (sunday && N.backup && !u.sent[id + ":bak"]) { await sendBackup(env, u, today); u.sent[id + ":bak"] = 1; changed = true; }
      } else {
        changed = await endOfShift(env, u, job, today);
      }
    } catch (e) { /* один пользователь не должен ломать рассылку остальным */ }
    if (changed) await putUser(env, u);
  }
}

const CRON_JOBS = { "0 18 * * *": "eve", "45 18 * * *": "end1", "0 19 * * *": "end2" };
const NEED_NOTIF = "🔔 <b>Сначала включите уведомления</b>\nОткройте календарь кнопкой ниже → вкладка «Настройки» → «Уведомления» → «Включить». После этого бот сможет записывать баллы и показывать статистику.";

async function handleMessage(env, msg) {
  const chatId = msg.chat.id, text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (msg.successful_payment) return onPaid(env, msg);
  try { await touchSeen(env, msg.from, "msg"); } catch (e) {}
  // Владелец бота: один раз отправить «/admin КЛЮЧ» (ключ — как в ссылке /setup)
  if (/^\/admin(\s|$)/i.test(text)) {
    const key = text.split(/\s+/)[1] || "";
    if (env.HOOK_SECRET && key === env.HOOK_SECRET) {
      await env.DB.put("owner", String(chatId));
      try { await tg(env, "deleteMessage", { chat_id: chatId, message_id: msg.message_id }); } catch (e) {}
      return send(env, chatId, "Готово: вы владелец бота. Команда /users покажет, кто пользуется календарём и ботом.\nСообщение с ключом я удалил.");
    }
    return send(env, chatId, "Неверный ключ.");
  }
  const u = await getUser(env, chatId), appUrl = (u && u.appUrl) || DEFAULT_APP, today = mskNow();
  const cmd = text.toLowerCase().split(/[\s@]/)[0];
  // Владелец отвечает на сообщение из «Написать разработчику» — ответ уходит автору
  const rt = msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption || "");
  const fbm = rt && rt.match(/#fb(\d+)/);
  if (fbm && text) {
    const owner = await env.DB.get("owner");
    if (owner && owner === String(chatId)) {
      const r = await send(env, +fbm[1], "💬 <b>Ответ разработчика:</b>\n" + esc(text), null);
      return send(env, chatId, r.ok ? "✅ Ответ отправлен." : "Не удалось отправить: человек мог остановить бота.");
    }
  }
  if (cmd === "/backup" || cmd === "копия") {
    if (!(u && u.enabled && u.data)) return send(env, chatId, NEED_NOTIF, appUrl);
    const r = await sendBackup(env, u, today);
    if (!r.ok) return send(env, chatId, "Не получилось отправить файл. Попробуйте позже.", appUrl);
    return;
  }
  if (cmd === "/users") {
    const owner = await env.DB.get("owner");
    if (owner && owner === String(chatId)) return send(env, chatId, await textUsers(env));
  }
  if (cmd === "/donate" || cmd === "поддержать" || /^\/start\s+donate/i.test(text)) return send(env, chatId, DONATE_HEAD, null, null, donateKb());
  if (cmd === "/paysupport") return send(env, chatId, "💳 <b>Вопрос по оплате</b>\nНапишите сюда, что случилось, начав со слова «оплата» — разработчик ответит. Ошибочный платёж вернём полностью.", null);
  if (/^оплата\b/i.test(text)) {
    const owner = await env.DB.get("owner");
    if (owner) await send(env, +owner, "💳 <b>Вопрос по оплате</b>\nОт: " + esc([msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "без имени") + (msg.from.username ? " (@" + esc(msg.from.username) + ")" : "") + "\n\n" + esc(text.slice(0, 1000)) + "\n\n<i>Ответьте на это сообщение — ответ уйдёт автору.</i> #fb" + chatId, null);
    return send(env, chatId, "Передал разработчику. Ответ придёт сюда.", null);
  }
  if (cmd === "/refund") {
    const owner = await env.DB.get("owner");
    if (owner && owner === String(chatId)) {
      const [, uid, ch] = text.split(/\s+/);
      const r = await tg(env, "refundStarPayment", { user_id: +uid, telegram_payment_charge_id: ch || "" });
      if (r.ok) {
        let log = []; try { log = JSON.parse((await env.DB.get("don:log")) || "[]"); } catch (e) {}
        const it = log.find(x => x.ch === ch); if (it) { it.ref = 1; await env.DB.put("don:log", JSON.stringify(log)); await env.DB.put("don:sum", String(Math.max(0, (+(await env.DB.get("don:sum")) || 0) - it.n))); }
        await send(env, +uid, "↩️ Звёзды возвращены.", null);
      }
      return send(env, chatId, r.ok ? "✅ Звёзды возвращены." : "Не получилось: " + esc(r.description || "проверьте id и номер платежа"));
    }
  }
  if (cmd === "/start") {
    await send(env, chatId, "👋 <b>Привет!</b> Это «Смены» — календарь смен, баллов и зарплаты механика.\n\nКнопки внизу — быстрые ответы, а календарь открывается кнопкой «Календарь» слева от поля ввода.", appUrl, null, replyKb);
    return send(env, chatId, MENU_HEAD, appUrl, null, menuKb(appUrl));
  }
  if (cmd === "/menu" || cmd === "меню") return send(env, chatId, MENU_HEAD, appUrl, null, menuKb(appUrl));
  if (cmd === "/help" || cmd === "помощь") return send(env, chatId, HELP, appUrl);
  const ready = u && u.enabled && u.data;
  const plain = text.toLowerCase().replace(/[^\p{L}\d\s]/gu, "").trim();
  const cmds = { "/today": textToday, "сегодня": textToday, "/stats": textPeriod, "итог": textPeriod, "статистика": textPeriod, "период": textPeriod,
    "/money": textMoney, "деньги": textMoney, "/schedule": textSchedule, "график": textSchedule, "/week": textWeek, "неделя": textWeek, "/records": textRecords, "рекорды": textRecords };
  const fn = cmds[cmd] || cmds[plain];
  if (fn) return send(env, chatId, ready ? fn(u.data, today) : NEED_NOTIF, appUrl);
  const ifm = text.toLowerCase().match(/^(?:\/if|если)\s*(\d{1,3}(?:[.,]\d)?)?$/);
  if (ifm) {
    if (!ready) return send(env, chatId, NEED_NOTIF, appUrl);
    if (!ifm[1]) return send(env, chatId, "🔮 Напишите, сколько баллов хотите набрать, например: <b>если 30</b>", appUrl);
    return send(env, chatId, textIf(u.data, today, parseFloat(ifm[1].replace(",", "."))), appUrl);
  }
  const parsed = parsePoints(text, today);
  if (parsed) {
    if (!ready) return send(env, chatId, NEED_NOTIF, appUrl);
    if (parsed.error) return send(env, chatId, "Не понял дату. Пример: 15.10 26.", appUrl);
    let day = parsed.day;
    if (!day) {
      day = { y: today.y, m: today.m, d: today.d };
      const c = makeCalc(u.data);
      // После полуночи число без даты относится ко вчерашней смене, если сегодня не смена
      if (!c.isShift(c.typeOn(day)) && today.hm < 6 * 60 && c.isShift(c.typeOn(addDays(today, -1)))) day = addDays(today, -1);
    }
    u.sent = u.sent || {};
    const r = await recordFromChat(env, u, day, parsed.p, today);
    if (r.ok) await putUser(env, u);
    return send(env, chatId, r.text, appUrl);
  }
  return send(env, chatId, "🤔 Не понял сообщение.\n\n" + HELP, appUrl);
}

async function handleCallback(env, cq) {
  const data = String(cq.data || ""), m = data.match(/^pt:(\d{4})-(\d{2})-(\d{2}):(\d{1,3})$/);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const dn = data.match(/^don:(\d+)$/);
  if (dn && chatId) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    if (DONATE_AMOUNTS.includes(+dn[1])) await tg(env, "sendInvoice", Object.assign({ chat_id: chatId }, invoiceOf(+dn[1])));
    return;
  }
  const mm = data.match(/^m:(\w+)$/);
  if (mm && chatId) {
    const u = await getUser(env, chatId), appUrl = (u && u.appUrl) || DEFAULT_APP, today = mskNow(), ready = u && u.enabled && u.data;
    const F = { today: textToday, stats: textPeriod, money: textMoney, week: textWeek, sched: textSchedule, rec: textRecords };
    const body = mm[1] === "menu" ? MENU_HEAD : mm[1] === "help" ? HELP : F[mm[1]] ? (ready ? F[mm[1]](u.data, today) : NEED_NOTIF) : MENU_HEAD;
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    const r = await tg(env, "editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: body, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: menuKb(appUrl) });
    if (!r.ok && !/not modified/.test(r.description || "")) await send(env, chatId, body, appUrl, null, menuKb(appUrl));
    return;
  }
  if (!m || !chatId || cq.from.id !== chatId) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  const u = await getUser(env, chatId), today = mskNow();
  if (!u || !u.enabled || !u.data) { await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Включите уведомления в календаре", show_alert: true }); return; }
  const day = { y: +m[1], m: +m[2] - 1, d: +m[3] }, p = +m[4];
  u.sent = u.sent || {};
  const r = await recordFromChat(env, u, day, p, today);
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: r.ok ? "Записано: " + p : "Не записано" });
  if (r.ok) {
    await putUser(env, u);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: r.text, parse_mode: "HTML", reply_markup: appButton(u.appUrl || DEFAULT_APP) });
  } else await send(env, chatId, r.text, u.appUrl);
}


// ---------- график с фото: распознавание нейросетью Cloudflare (привязка AI) ----------
const VISION_MODELS = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.2-11b-vision-instruct"];
function schedulePrompt(name, hint) {
  return "На изображении таблица графика работы (скриншот или фото Google Таблицы). " +
    "В строке заголовка — даты вида ДД.ММ и дни недели, каждый столбец — один день месяца. " +
    "Слева — ФИО сотрудников, рядом могут быть столбцы «Смены» и «Часы». " +
    "Найди строку сотрудника, у которого в ФИО есть «" + name + "» (возможна опечатка в одной-двух буквах). " +
    "Прочитай слева направо значение ячейки этой строки под КАЖДОЙ датой: число часов (например 12, 9, 11), буквы (В, От, Б, П, Д) или пусто. " +
    "Следи, чтобы значение было именно под своей датой и именно в этой строке, не путай с соседними строками. " +
    (hint ? "Если год или месяц не видны, считай, что это " + hint + ". " : "") +
    "Ответь ТОЛЬКО JSON без пояснений: " +
    "{\"fio\":\"ФИО как написано\",\"month\":номер месяца,\"year\":год или null,\"shifts\":число из столбца «Смены» в этой строке или null," +
    "\"cells\":[{\"d\":число дня,\"v\":\"значение ячейки\"}]}. Если такого сотрудника нет, верни {\"fio\":null}.";
}
function pickJson(text) {
  if (text && typeof text === "object") return text;
  const t = String(text || ""); const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}
async function readSchedule(env, image, name, hint) {
  const prompt = schedulePrompt(name, hint), errors = [];
  for (const model of VISION_MODELS) {
    try {
      let r;
      if (model.includes("llama-4")) {
        r = await env.AI.run(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] }], max_tokens: 2500, temperature: 0 });
      } else {
        try { await env.AI.run(model, { prompt: "agree" }); } catch (e) {}
        r = await env.AI.run(model, { messages: [{ role: "user", content: prompt }], image, max_tokens: 2500, temperature: 0 });
      }
      const out = r && (r.response !== undefined ? r.response : r.result && r.result.response);
      const j = pickJson(out);
      if (j) { j.model = model; return j; }
      errors.push(model + ": не JSON");
    } catch (e) { errors.push(model + ": " + (e && e.message || e)); }
  }
  throw new Error(errors.join(" | "));
}


// ---------- кто пользуется ботом и календарём (видит только владелец, команда /users) ----------
const seenKey = id => "s:" + id;
async function touchSeen(env, from, kind, app) {
  if (!from || !from.id) return;
  const k = seenKey(from.id), t = Date.now();
  let s = null; try { s = JSON.parse((await env.DB.get(k)) || "null"); } catch (e) {}
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 60), un = from.username || "";
  // Не чаще одной записи в 10 минут, если ничего не поменялось — бережём лимиты хранилища
  if (s && t - (s.last || 0) < 10 * 60e3 && s.name === name && s.un === un && (!app || s.app === app)) return;
  s = s || { id: from.id, first: t, opens: 0, msgs: 0 };
  s.name = name || s.name || ""; s.un = un || s.un || ""; if (app) s.app = app;
  if (kind === "open") { s.opens = (s.opens || 0) + 1; s.lastOpen = t; } else { s.msgs = (s.msgs || 0) + 1; s.lastMsg = t; }
  s.last = t;
  await env.DB.put(k, JSON.stringify(s));
}
async function listPrefix(env, prefix) {
  const out = []; let cursor;
  do { const r = await env.DB.list({ prefix, cursor }); for (const k of r.keys) out.push(k.name); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}
function agoText(ms) {
  if (!ms) return "давно";
  const d = new Date(ms + TZ_OFFSET_H * 3600e3), n = new Date(Date.now() + TZ_OFFSET_H * 3600e3);
  const hm = String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  const day = x => Math.floor(x.getTime() / 86400e3), diff = day(n) - day(d);
  if (diff === 0) return "сегодня " + hm;
  if (diff === 1) return "вчера " + hm;
  if (diff < 7) return diff + " дн. назад";
  return String(d.getUTCDate()).padStart(2, "0") + "." + String(d.getUTCMonth() + 1).padStart(2, "0");
}
async function textUsers(env) {
  const seen = {}, keys = await listPrefix(env, "s:");
  for (const k of keys) { try { const v = JSON.parse((await env.DB.get(k)) || "null"); if (v) seen[v.id] = v; } catch (e) {} }
  const notif = {};
  for (const k of await listPrefix(env, "u:")) { try { const v = JSON.parse((await env.DB.get(k)) || "null"); if (v) notif[v.id] = !!v.enabled; } catch (e) {} }
  for (const id in notif) if (!seen[id]) seen[id] = { id: +id, name: "", un: "", last: 0 };
  const list = Object.values(seen).sort((a, b) => (b.last || 0) - (a.last || 0));
  const n = new Date(Date.now() + TZ_OFFSET_H * 3600e3), dayStart = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - TZ_OFFSET_H * 3600e3;
  const today = list.filter(x => x.last >= dayStart).length, week = list.filter(x => x.last >= Date.now() - 7 * 86400e3).length;
  const withNotif = list.filter(x => notif[x.id]).length;
  let out = "👥 <b>Пользователи «Смен»: " + list.length + "</b>"; out += "\nСегодня заходили: " + today + " · за 7 дней: " + week + "\nС уведомлениями: " + withNotif + "\n";
  list.forEach((x, i) => {
    if (out.length > 3700) return;
    const who = esc(x.name || "без имени") + (x.un ? " (@" + esc(x.un) + ")" : "") + (!x.name && !x.un ? " · id " + x.id : "");
    const extra = [agoText(x.last), notif[x.id] ? "🔔" : "", x.app || "", x.opens ? x.opens + " откр." : ""].filter(Boolean).join(" · ");
    out += "\n" + (i + 1) + ". " + who + " — " + extra;
  });
  if (out.length > 3700) out += "\n…и ещё " + list.length + " (список обрезан)";
  const dsum = +(await env.DB.get("don:sum")) || 0;
  if (dsum) out += "\n\n⭐ Поддержка звёздами: всего " + dsum;
  return out + "\n\n🔔 — включены уведомления. «откр.» — сколько раз открывали календарь (не чаще раза в 10 минут).";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Календарь присылает график и баллы
    if (url.pathname === "/sync" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user || !user.id) return json({ ok: false, error: "auth" }, 401);
      const appUrl = typeof body.appUrl === "string" && body.appUrl.startsWith(APP_PREFIX) ? body.appUrl.split("#")[0] : DEFAULT_APP;
      const prev = await getUser(env, user.id);
      const u = prev || { id: user.id, sent: {}, inbox: [] };
      const wasOn = !!u.enabled;
      const before = prev ? JSON.stringify([prev.enabled, prev.appUrl, prev.data, (prev.inbox || []).length]) : "";
      u.enabled = !!body.enabled; u.appUrl = appUrl; u.updated = Date.now();
      if (body.data && typeof body.data === "object") u.data = body.data;
      // Календарь подтвердил, что забрал баллы из чата
      if (body.inboxAck) u.inbox = (u.inbox || []).filter(it => it.at > +body.inboxAck);
      reapplyInbox(u);
      if (JSON.stringify(u).length > 200000) return json({ ok: false, error: "too_big" }, 413);
      let sentNow = false;
      if (u.enabled && !wasOn) {
        await send(env, u.id, "🔔 <b>Уведомления включены.</b>\nВ 21:00 — что завтра: смена или выходной.\nВ 21:45 — статистика за смену или напоминание внести баллы, в 22:00 — повтор.\nПо воскресеньям — итоги недели.\nВыбрать, что присылать, или поставить паузу: календарь → «Настройки» → «Уведомления».\n\n" + HELP, appUrl);
      }
      // Баллы внесли после конца смены — сразу присылаем статистику
      const today = mskNow();
      if (u.enabled && today.hm >= 21 * 60 + 30) { u.sent = u.sent || {}; sentNow = await endOfShift(env, u, "sync", today); }
      // Бережём лимит записей: сохраняем, только если что-то поменялось
      const after = JSON.stringify([u.enabled, u.appUrl, u.data, (u.inbox || []).length]);
      if (after !== before || sentNow) await putUser(env, u);
      return json({ ok: true, enabled: u.enabled, sentNow });
    }

    // Календарь отмечается при открытии — для статистики владельца (/users)
    if (url.pathname === "/hello" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user || !user.id) return json({ ok: false, error: "auth" }, 401);
      const app = typeof body.appUrl === "string" ? (body.appUrl.includes("smeny-team") ? "команда" : "личная") : "";
      try { await touchSeen(env, user, "open", app); } catch (e) {}
      return json({ ok: true });
    }

    // Календарь забирает баллы, присланные в чат
    if (url.pathname === "/pull" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user || !user.id) return json({ ok: false, error: "auth" }, 401);
      const u = await getUser(env, user.id);
      return json({ ok: true, inbox: (u && u.inbox) || [] });
    }

    // Календарь присылает фото графика — возвращаем распознанную строку сотрудника
    if (url.pathname === "/schedule" && request.method === "POST") {
      if (!env.AI) return json({ ok: false, error: "no_ai" }, 503);
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
      const image = String(body.image || ""), name = String(body.name || "").trim().slice(0, 60);
      if (!/^data:image\/(png|jpe?g|webp);base64,/.test(image) || image.length > 6e6) return json({ ok: false, error: "bad_image" }, 400);
      if (name.length < 2) return json({ ok: false, error: "no_name" }, 400);
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      // Защита от злоупотреблений: не больше 25 распознаваний в день на человека
      const who = user && user.id ? "u" + user.id : "ip" + (request.headers.get("CF-Connecting-IP") || "?");
      const limKey = "lim:" + dayId(mskNow()) + ":" + who, used = +(await env.DB.get(limKey)) || 0;
      if (used >= 25) return json({ ok: false, error: "limit" }, 429);
      await env.DB.put(limKey, String(used + 1), { expirationTtl: 2 * 86400 });
      try {
        const r = await readSchedule(env, image, name, String(body.hint || "").slice(0, 40));
        return json({ ok: true, result: r });
      } catch (e) { return json({ ok: false, error: "ai_failed", detail: String(e.message || e).slice(0, 500) }, 502); }
    }

    // Ошибка в календаре у пользователя — коротко владельцу бота
    if (url.pathname === "/err" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
      const owner = await env.DB.get("owner"); if (!owner) return json({ ok: false, error: "no_owner" });
      const user = body.initData ? await verifyInitData(body.initData, env.BOT_TOKEN) : null;
      const who = user && user.id ? "u" + user.id : "ip" + (request.headers.get("CF-Connecting-IP") || "?");
      const limKey = "lim:" + dayId(mskNow()) + ":err" + who, used = +(await env.DB.get(limKey)) || 0;
      if (used >= 5) return json({ ok: false, error: "limit" });
      await env.DB.put(limKey, String(used + 1), { expirationTtl: 2 * 86400 });
      const name = user ? esc([user.first_name, user.last_name].filter(Boolean).join(" ") || "без имени") + (user.username ? " (@" + esc(user.username) + ")" : "") : "браузер (не Telegram)";
      const cut = (v, n) => esc(String(v || "").slice(0, n));
      await send(env, +owner, "⚠️ <b>Ошибка в календаре</b>\nУ: " + name + "\nВерсия: " + cut(body.ver, 12) + " · " + cut(body.app, 20) + "\n\n<code>" + cut(body.msg, 300) + "</code>\n" + cut(body.where, 120) + (body.ua ? "\n<i>" + cut(body.ua, 90) + "</i>" : ""), null);
      return json({ ok: true });
    }

    // Календарь просит прислать копию данных в чат прямо сейчас
    if (url.pathname === "/backup" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user || !user.id) return json({ ok: false, error: "auth" }, 401);
      const u = await getUser(env, user.id);
      if (!u || !u.enabled || !u.data) return json({ ok: false, error: "no_data" }, 409);
      const limKey = "lim:" + dayId(mskNow()) + ":bak" + user.id, used = +(await env.DB.get(limKey)) || 0;
      if (used >= 10) return json({ ok: false, error: "limit" }, 429);
      await env.DB.put(limKey, String(used + 1), { expirationTtl: 2 * 86400 });
      const r = await sendBackup(env, u, mskNow());
      return json({ ok: !!r.ok });
    }

    // Кнопка «Поддержать» в календаре: ссылка на счёт в звёздах
    if (url.pathname === "/donate" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user || !user.id) return json({ ok: false, error: "auth" }, 401);
      const n = +body.n;
      if (!DONATE_AMOUNTS.includes(n)) return json({ ok: false, error: "amount" }, 400);
      const r = await tg(env, "createInvoiceLink", invoiceOf(n));
      return json(r.ok ? { ok: true, link: r.result } : { ok: false, error: "tg" }, r.ok ? 200 : 502);
    }

    // «Написать разработчику» из календаря — сообщение уходит владельцу бота
    if (url.pathname === "/feedback" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user || !user.id) return json({ ok: false, error: "auth" }, 401);
      const text = String(body.text || "").trim().slice(0, 1000);
      if (text.length < 3) return json({ ok: false, error: "empty" }, 400);
      const owner = await env.DB.get("owner");
      if (!owner) return json({ ok: false, error: "no_owner" }, 503);
      const limKey = "lim:" + dayId(mskNow()) + ":fb" + user.id, used = +(await env.DB.get(limKey)) || 0;
      if (used >= 5) return json({ ok: false, error: "limit" }, 429);
      await env.DB.put(limKey, String(used + 1), { expirationTtl: 2 * 86400 });
      const who = esc([user.first_name, user.last_name].filter(Boolean).join(" ") || "без имени") + (user.username ? " (@" + esc(user.username) + ")" : "");
      const meta = [body.app ? esc(String(body.app).slice(0, 20)) : "", body.ver ? "версия " + esc(String(body.ver).slice(0, 10)) : ""].filter(Boolean).join(" · ");
      const r = await send(env, +owner, "💬 <b>Сообщение из календаря</b>\nОт: " + who + (meta ? "\n" + meta : "") + "\n\n" + esc(text) + "\n\n<i>Ответьте на это сообщение (свайп влево) — ответ уйдёт автору.</i> #fb" + user.id, null);
      return json({ ok: !!r.ok });
    }

    // Сообщения и нажатия кнопок в боте
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.HOOK_SECRET) return new Response("forbidden", { status: 403 });
      const upd = await request.json().catch(() => null);
      try {
        if (upd && upd.message && upd.message.chat && upd.message.chat.type === "private") await handleMessage(env, upd.message);
        else if (upd && upd.callback_query) await handleCallback(env, upd.callback_query);
        else if (upd && upd.pre_checkout_query) {
          const ok = /^don:\d+$/.test(upd.pre_checkout_query.invoice_payload || "") && upd.pre_checkout_query.currency === "XTR";
          await tg(env, "answerPreCheckoutQuery", ok ? { pre_checkout_query_id: upd.pre_checkout_query.id, ok: true } : { pre_checkout_query_id: upd.pre_checkout_query.id, ok: false, error_message: "Счёт устарел, откройте /donate ещё раз." });
        }
      } catch (e) { /* Telegram не должен получать ошибку, иначе будет повторять */ }
      return new Response("ok");
    }

    // После каждого обновления кода: подключить бота и команды
    if (url.pathname === "/setup") {
      if (!env.HOOK_SECRET || url.searchParams.get("key") !== env.HOOK_SECRET) return new Response("Неверный ключ", { status: 403 });
      const r = await tg(env, "setWebhook", { url: url.origin + "/webhook", secret_token: env.HOOK_SECRET, allowed_updates: ["message", "callback_query", "pre_checkout_query"], drop_pending_updates: true });
      await tg(env, "setMyCommands", { commands: [
        { command: "menu", description: "☰ Меню с кнопками" },
        { command: "today", description: "🛠 Что сегодня и цель на смену" },
        { command: "stats", description: "📊 Период премии: баллы, средний, запас" },
        { command: "money", description: "💰 Заработок за месяц" },
        { command: "week", description: "🗓 Итоги недели" },
        { command: "schedule", description: "📆 График на 7 дней" },
        { command: "records", description: "🏅 Рекорды и серии" },
        { command: "if", description: "🔮 Что если набрать N баллов" },
        { command: "backup", description: "💾 Прислать копию данных файлом" },
        { command: "donate", description: "⭐ Поддержать проект" },
        { command: "help", description: "❓ Что умеет бот" },
      ] });
      await tg(env, "setMyDescription", { description: "🛠 «Смены» — календарь механика.\n\n📅 Отмечайте смены и баллы\n🎯 Бот считает, сколько нужно в день до нормы\n💰 Показывает зарплату и премию\n🔔 Вечером напоминает о завтрашней смене и спрашивает баллы\n🏆 Награды, рекорды и итоги месяца\n\nНажмите «Старт», чтобы начать." });
      await tg(env, "setMyShortDescription", { short_description: "Календарь смен, баллов и зарплаты механика: цель на день, премия, напоминания, награды." });
      const me = await tg(env, "getMe", {});
      return new Response(
        (r.ok ? "Готово: бот @" + (me.result && me.result.username) + " подключён к серверу, команды обновлены." : "Ошибка: " + (r.description || "проверьте BOT_TOKEN")) +
        "\nАдрес сервера для календаря: " + url.origin,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // Проверка вручную: /run?key=...&job=eve|end1|end2
    if (url.pathname === "/run") {
      if (!env.HOOK_SECRET || url.searchParams.get("key") !== env.HOOK_SECRET) return new Response("Неверный ключ", { status: 403 });
      const job = url.searchParams.get("job");
      if (!["eve", "end1", "end2"].includes(job)) return new Response("job: eve, end1 или end2", { status: 400 });
      await runJob(env, job);
      return new Response("Запущено: " + job, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return new Response("Сервер бота «Смены» работает.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    const job = CRON_JOBS[event.cron];
    if (job) ctx.waitUntil(runJob(env, job));
  },
};
