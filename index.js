/**
 * twitch-watcher — Railway сервис для детекта streaming suspension на Twitch
 *
 * ENV-переменные (Railway Dashboard → Variables):
 *   TWITCH_LOGINS       — логины через запятую: drakeoffc,5opka,mellsher
 *   TELEGRAM_BOT_TOKEN  — токен бота
 *   TELEGRAM_CHAT_IDS   — chat_id через запятую
 *   CHECK_INTERVAL_MIN  — интервал в минутах (по умолчанию 1)
 */

const { chromium } = require('playwright');
const fs = require('fs');

const LOGINS = (process.env.TWITCH_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 1) * 60 * 1000;
const STATE_FILE = '/tmp/twitch_status.json';

const SUSPENSION_PHRASES = [
  'cannot stream at this time',
  'violation of twitch',
  'community guidelines',           // на странице суспенда всегда есть
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); }
  catch (e) { console.error('[state] save failed:', e.message); }
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || CHAT_IDS.length === 0) return;
  for (const chatId of CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
    } catch (e) { console.error('[telegram] error:', e.message); }
  }
}

async function checkChannel(page, login) {
  try {
    // Патчим navigator.webdriver чтобы Twitch не детектировал автоматизацию
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete navigator.__proto__.webdriver;
    });

    // Грузим страницу, ждём пока не установится network idle (все XHR/fetch завершатся)
    await page.goto(`https://www.twitch.tv/${login}`, {
      waitUntil: 'networkidle',
      timeout: 45000
    });

    // Дополнительная пауза — React может рендерить после последнего сетевого запроса
    await page.waitForTimeout(3000);

    const bodyText = (await page.textContent('body')).toLowerCase();

    // Считаем совпадения — если все три фразы есть одновременно, это страница суспенда
    const hits = SUSPENSION_PHRASES.filter(p => bodyText.includes(p));
    const isSuspended = hits.length >= 2; // минимум 2 из 3 чтобы не было ложных срабатываний

    console.log(`[${login}] phrases found: ${hits.length}/3 — ${isSuspended ? 'SUSPENDED' : 'ok'}`);
    return { ok: true, isSuspended };

  } catch (e) {
    console.error(`[${login}] error: ${e.message}`);
    return { ok: false, isSuspended: false };
  }
}

async function runCheck() {
  if (LOGINS.length === 0) return;

  const state = loadState();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,800'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      // Эмулируем нормальный браузер — принимаем куки, JS и т.д.
      javaScriptEnabled: true,
    });

    const page = await context.newPage();

    for (const login of LOGINS) {
      const result = await checkChannel(page, login);
      if (!result.ok) continue;

      const prevStatus = state[login] || 'ok';
      const newStatus = result.isSuspended ? 'suspended' : 'ok';

      if (prevStatus !== 'suspended' && newStatus === 'suspended') {
        console.log(`[${login}] 🚫 NEW SUSPENSION DETECTED`);
        await sendTelegram(
          `🚫 <b>${login}</b> — streaming suspension!\n` +
          `twitch.tv/${login} — канал виден, но не может вести трансляции.\n` +
          `Время: ${new Date().toLocaleString('ru-RU')}`
        );
        state[login] = 'suspended';
        saveState(state);
      } else if (prevStatus === 'suspended' && newStatus === 'ok') {
        console.log(`[${login}] ✅ suspension lifted`);
        await sendTelegram(
          `✅ <b>${login}</b> — streaming suspension снят!\n` +
          `twitch.tv/${login} снова может вести трансляции.\n` +
          `Время: ${new Date().toLocaleString('ru-RU')}`
        );
        state[login] = 'ok';
        saveState(state);
      }

      // Пауза между каналами
      await page.waitForTimeout(1500);
    }

    await context.close();
  } catch (e) {
    console.error('[browser] critical error:', e.message);
    await sendTelegram(`⚠️ twitch-watcher: ошибка браузера — ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN не задан'); process.exit(1); }
if (LOGINS.length === 0) { console.error('TWITCH_LOGINS не задан'); process.exit(1); }

console.log(`[start] Мониторим: ${LOGINS.join(', ')}`);
console.log(`[start] Интервал: ${INTERVAL_MS / 60000} мин`);

runCheck().then(() => setInterval(runCheck, INTERVAL_MS));
