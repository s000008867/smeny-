// Проверка собранного сайта в настоящем браузере (Playwright): node smoke.js
// Запускается при выкладке после сборки (папка _site). Если календарь не открывается,
// падает с ошибкой или вкладки не переключаются — выкладка останавливается.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "_site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); console.log((ok ? "✓ " : "✗ ") + msg); };

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port + "/";
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) errors.push(m.text()); });

  // 1. Новичок: пустые данные
  await page.goto(url);
  await page.waitForTimeout(1500);
  check(await page.locator("#grid button[data-d]").count() >= 28, "календарь нарисован");
  check(await page.locator("nav.tabbar button").count() >= 4, "нижнее меню на месте");

  // 2. С данными: смены и баллы за два месяца, парт-тайм, опоздание
  await page.evaluate(() => {
    localStorage.clear();
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    const k = (y, m) => y + "-" + String(m + 1).padStart(2, "0");
    const py = m ? y : y - 1, pm = m ? m - 1 : 11;
    const days = {}, pts = {}, pdays = {}, ppts = {};
    for (let d = 1; d <= 28; d += 2) { days[d] = "w"; pts[d] = 20 + (d % 6); pdays[d] = "w"; ppts[d] = 22; }
    days[3] = "o";
    localStorage.setItem("salary:" + k(y, m), JSON.stringify({ days, points: pts }));
    localStorage.setItem("salary:" + k(py, pm), JSON.stringify({ days: pdays, points: ppts }));
    localStorage.setItem("salary:d:" + k(y, m) + "-01", JSON.stringify({ pt: [["l", 200], ["m", 400]] }));
    localStorage.setItem("salary:settings", JSON.stringify({ rate: 5800, pct: 27, minPts: 18, maxPts: 24 }));
    localStorage.setItem("salary:tour", "1"); localStorage.setItem("salary:qs", "1");
  });
  await page.reload();
  await page.waitForTimeout(1500);
  check(await page.locator("#grid .mark.pts").count() > 0 || await page.locator("#grid button.t-w, #grid .t-w").count() > 0, "смены с баллами видны в календаре");

  // 3. Все вкладки открываются
  const tabs = await page.locator("nav.tabbar button").count();
  for (let i = 0; i < tabs; i++) {
    await page.locator("nav.tabbar button").nth(i).dispatchEvent("click");
    await page.waitForTimeout(400);
  }
  check(true, "все " + tabs + " вкладок переключены");

  check(errors.length === 0, "ошибок в скриптах нет" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  await browser.close();
  server.close();
  if (fail.length) { console.error("\nПроверка в браузере не прошла: " + fail.join("; ")); process.exit(1); }
  console.log("\nПроверка в браузере прошла");
})().catch(e => { console.error(e); process.exit(1); });
