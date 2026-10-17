// Сборка сайта для выкладки: папка _site.
// • calc.js встраивается прямо в index.html — календарь остаётся одним файлом и работает без лишних загрузок;
// • у sw.js меняется имя кэша, чтобы телефоны сразу получили новую версию;
// • если в скриптах страницы синтаксическая ошибка — сборка падает и ничего не выкладывается.
const fs = require("node:fs");
const vm = require("node:vm");

const OUT = "_site";
const ver = (process.env.GITHUB_SHA || Date.now().toString(16)).slice(0, 7);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const TAG = '<script src="calc.js"></script>';
let html = fs.readFileSync("index.html", "utf8");
if (!html.includes(TAG)) throw new Error("В index.html нет строки " + TAG);
const calc = fs.readFileSync("calc.js", "utf8");
html = html.replace(TAG, () => "<script>\n" + calc + "\n</script>");

// Проверка: каждый встроенный скрипт должен разбираться без ошибок
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((code, i) => {
  try { new vm.Script(code, { filename: "index.html#script" + (i + 1) }); }
  catch (e) { throw new Error("Ошибка в скрипте №" + (i + 1) + " index.html: " + e.message); }
});
// И общий расчёт должен загружаться в странице
const ctx = {}; vm.runInNewContext(calc, ctx);
if (!ctx.SmenyCalc || typeof ctx.SmenyCalc.calc !== "function") throw new Error("calc.js не создаёт SmenyCalc");

fs.writeFileSync(OUT + "/index.html", html);
const sw = fs.readFileSync("sw.js", "utf8").replace(/const CACHE = "[^"]*";/, 'const CACHE = "smeny-' + ver + '";');
fs.writeFileSync(OUT + "/sw.js", sw);
for (const f of fs.readdirSync(".")) if (/^(manifest\.webmanifest|icon-[\w-]+\.png|calc\.js)$/.test(f)) fs.copyFileSync(f, OUT + "/" + f);
fs.writeFileSync(OUT + "/.nojekyll", "");
console.log("Собрано в " + OUT + ": версия " + ver + ", скриптов проверено: " + scripts.length + ", файлов: " + fs.readdirSync(OUT).length);
