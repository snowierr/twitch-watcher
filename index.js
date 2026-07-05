const { chromium } = require('playwright');
const fs = require('fs');

const LOGINS = (process.env.TWITCH_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 1) * 60 * 1000;
const STATE_FILE = '/tmp/twitch_status.json';

// Единственная уникальная фраза из баннера суспенда
const SUSPENSION_PHRASE = 'cannot stream at this time';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); }
  catch (e) {}
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
    } catch (e) { console.error('[telegram]', e.message); }
  }
}

async function checkChannel(page, login) {
  try {
    await page.goto(`https://www.twitch.tv/${login}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Ждём пока React отрендерит контент — проверяем что тело выросло до нормального размера
    await page.waitForFunction(
      () => document.body.innerText.length > 3000,
      { timeout: 20000 }
    ).catch(() => {});

    // Дополнительные 2 секунды на асинхронные компоненты
    await page.waitForTimeout(2000);

    const bodyText = (await page.textContent('body')).toLowerCase();

    // ДИАГНОСТИКА: показываем первые 300 символов чтобы понять что реально приходит
    console.log(`[${login}] body preview: "${bodyText.substring(0, 300).replace(/\s+/g, ' ')}"`);

    const isSuspended = bodyText.includes(SUSPENSION_PHRASE);
    console.log(`[${login}] suspended: ${isSuspended} (body length: ${bodyText.length})`);
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
        '--window-size=1280,800'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    // Скрываем признаки автоматизации
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    for (const login of LOGINS) {
      const result = await checkChannel(page, login);
      if (!result.ok) continue;

      const prevStatus = state[login] || 'ok';
      const newStatus = result.isSuspended ? 'suspended' : 'ok';

      if (prevStatus !== 'suspended' && newStatus === 'suspended') {
        console.log(`[${login}] 🚫 SUSPENSION DETECTED`);
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

      await page.waitForTimeout(1000);
    }

    await context.close().catch(() => {});
  } catch (e) {
    // Не шлём алерт в телеграм при обычной ошибке браузера — просто логируем
    console.error('[browser] error:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN не задан'); process.exit(1); }
if (LOGINS.length === 0) { console.error('TWITCH_LOGINS не задан'); process.exit(1); }

console.log(`[start] Мониторим: ${LOGINS.join(', ')}`);
console.log(`[start] Интервал: ${INTERVAL_MS / 60000} мин`);

runCheck().then(() => setInterval(runCheck, INTERVAL_MS));
