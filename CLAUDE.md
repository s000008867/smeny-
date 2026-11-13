# Смены — заметки для разработки

Календарь смен механика: зарплата, баллы, премия. Веб-приложение (PWA, Telegram Mini App) + Telegram-бот.

- `index.html` — всё приложение в одном файле (HTML+CSS+JS, ~4200 строк). Подключает `calc.js` через `<script src="calc.js"></script>` — эту строку не менять, `build.js` заменяет её встроенным кодом.
- `calc.js` — общий расчёт (`globalThis.SmenyCalc`), используют и страница, и бот (`worker.js` его импортирует/встраивает). Любое изменение расчёта — сначала тест в `calc test.js`.
- `calc test.js` — тесты (`node --test "calc test.js"`). Имя с пробелом — так файл сохраняет iPhone; workflow ищет `calc*test*.js`, не переименовывать.
- `worker.js` + `wrangler.toml` — бот на Cloudflare Workers (KV `DB`, Workers AI `AI`, cron 21:00/21:45/22:00 МСК).
- `sw.js` — service worker; имя кэша подменяется при сборке.
- Выкладка: push в `main` → `.github/workflows/deploy.yml` (тесты → GitHub Pages smeny-, репозиторий smeny-team, бот). Ветки кроме `main` не выкладываются.

- `smoke.js` — проверка собранного `_site` в браузере (Playwright): открытие, вкладки, ошибки в консоли. В CI идёт после сборки.

Проверка перед коммитом: `node --test "calc test.js" && node build.js && node smoke.js`.
Интерфейс на русском, пользователь — механик, грузит файлы с iPhone через веб-интерфейс GitHub.
