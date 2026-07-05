/**
 * twitch-watcher — Railway сервис для детекта streaming suspension на Twitch
 *
 * ENV-переменные (настраиваются в Railway Dashboard → Variables):
 *   TWITCH_LOGINS       — логины через запятую: drakeoffc,5opka,mellsher
 *   TELEGRAM_BOT_TOKEN  — токен бота (тот же, что в Apps Script)
 *   TELEGRAM_CHAT_IDS   — chat_id через запятую (тот же, что TELEGRAM_CHAT_ID в Apps Script)
 *   CHECK_INTERVAL_MIN  — интервал проверки в минутах (по умолчанию 1)
 */

const { chromium } = require('playwright');
const fs = require('fs');

// ---------- конфиг ----------
const LOGINS = (process.env.TWITCH_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 1) * 60 * 1000;
const STATE_FILE = '/tmp/twitch_status.json';

// Точная фраза из баннера (Twitch пишет именно это)
const SUSPENSION_TEXT = 'cannot stream at this time';

// ---------- хранилище статусов (переживает перезапуск через файл) ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); }
  catch (e) { console.error('[state] save failed:', e.message); }
}

// ---------- Telegram ----------
async function sendTelegram(text) {
  if (!BOT_TOKEN || CHAT_IDS.length === 0) return;
  for (const chatId of CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
      const data = await res.json();
      if (!data.ok) console.error('[telegram] error:', data.description);
    } catch (e) {
      console.error('[telegram] fetch failed:', e.message);
    }
  }
}

// ---------- проверка одного канала ----------
async function checkChannel(page, login) {
  try {
    await page.goto(`https://www.twitch.tv/${login}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Ждём пока React отрендерит контент (до 10 секунд)
    await page.waitForTimeout(6000);

    const bodyText = (await page.textContent('body')).toLowerCase();
    const isSuspended = bodyText.includes(SUSPENSION_TEXT);

    return { ok: true, isSuspended };
  } catch (e) {
    console.error(`[${login}] page error:`, e.message);
    return { ok: false, isSuspended: false };
  }
}

// ---------- основной цикл ----------
async function runCheck() {
  if (LOGINS.length === 0) {
    console.log('[warn] TWITCH_LOGINS не задан — нечего проверять');
    return;
  }

  const state = loadState();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US'
    });
    const page = await context.newPage();

    for (const login of LOGINS) {
      const result = await checkChannel(page, login);
      if (!result.ok) continue;

      const prevStatus = state[login] || 'ok'; // 'ok' | 'suspended'
      const newStatus = result.isSuspended ? 'suspended' : 'ok';

      console.log(`[${login}] ${prevStatus} → ${newStatus}`);

      if (prevStatus !== 'suspended' && newStatus === 'suspended') {
        // Новый стриминг-бан!
        await sendTelegram(
          `🚫 <b>${login}</b> — streaming suspension!\n` +
          `twitch.tv/${login} — канал виден, но не может вести трансляции.\n` +
          `Время: ${new Date().toLocaleString('ru-RU')}`
        );
        state[login] = 'suspended';
        saveState(state);
      } else if (prevStatus === 'suspended' && newStatus === 'ok') {
        // Бан снят
        await sendTelegram(
          `✅ <b>${login}</b> — streaming suspension снят!\n` +
          `twitch.tv/${login} снова может вести трансляции.\n` +
          `Время: ${new Date().toLocaleString('ru-RU')}`
        );
        state[login] = 'ok';
        saveState(state);
      }

      // Небольшая пауза между каналами чтобы не выглядеть как бот
      await page.waitForTimeout(2000);
    }

    await context.close();
  } catch (e) {
    console.error('[browser] critical error:', e.message);
    await sendTelegram(`⚠️ twitch-watcher: ошибка браузера — ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ---------- запуск ----------
if (LOGINS.length === 0) {
  console.error('TWITCH_LOGINS не задан. Добавь переменную в Railway → Variables.');
  process.exit(1);
}
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN не задан.');
  process.exit(1);
}

console.log(`[start] Мониторим каналы: ${LOGINS.join(', ')}`);
console.log(`[start] Интервал: ${INTERVAL_MS / 60000} мин`);

// Первая проверка сразу
runCheck().then(() => {
  // Потом по расписанию
  setInterval(runCheck, INTERVAL_MS);
});
