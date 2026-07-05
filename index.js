const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const fs = require('fs');

const LOGINS = (process.env.TWITCH_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 1) * 60 * 1000;
const STATE_FILE = '/tmp/twitch_status.json';
const SESSION_FILE = '/tmp/twitch-session.json';
const SUSPENSION_CLASS = 'home-carousel-info--suspended';
const SUSPENSION_TEXT  = 'cannot stream at this time';

// Сессия хранится в env как base64, декодируем при старте
function loadSession() {
  const b64 = process.env.TWITCH_SESSION || '';
  if (!b64) { console.warn('[session] TWITCH_SESSION не задан'); return null; }
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    fs.writeFileSync(SESSION_FILE, json);
    console.log('[session] сессия загружена из env');
    return SESSION_FILE;
  } catch (e) {
    console.error('[session] ошибка декодирования:', e.message);
    return null;
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8'); } catch (e) {}
}

async function sendTelegram(text) {
  for (const chatId of CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
    } catch (e) {}
  }
}

async function checkChannel(page, login) {
  const gqlResponses = [];
  try {
    page.on('response', async (resp) => {
      if (!resp.url().includes('gql.twitch.tv')) return;
      try { gqlResponses.push(await resp.json()); } catch (e) {}
    });

    await page.goto(`https://www.twitch.tv/${login}`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    await page.waitForTimeout(10000);

    const html = await page.content();
    const allGql = JSON.stringify(gqlResponses).toLowerCase();
    const integrityOk = !allGql.includes('integritycheckfailed') &&
                        !allGql.includes('failed integrity check');
    const isSuspended = html.includes(SUSPENSION_CLASS) ||
                        html.toLowerCase().includes(SUSPENSION_TEXT);

    console.log(`[${login}] suspended:${isSuspended} integrity_ok:${integrityOk} gql:${gqlResponses.length}`);
    return { ok: true, isSuspended };
  } catch (e) {
    console.error(`[${login}] error: ${e.message}`);
    return { ok: false, isSuspended: false };
  }
}

async function runCheck(sessionFile) {
  const state = loadState();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--window-size=1280,800']
    });

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 }
    };

    // Загружаем сохранённую сессию если есть
    if (sessionFile) {
      contextOptions.storageState = sessionFile;
      console.log('[session] контекст создан с сохранённой сессией');
    } else {
      console.warn('[session] работаем без сессии');
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    for (const login of LOGINS) {
      const result = await checkChannel(page, login);
      if (!result.ok) continue;
      const prev = state[login] || 'ok';
      const next = result.isSuspended ? 'suspended' : 'ok';
      if (prev !== 'suspended' && next === 'suspended') {
        console.log(`[${login}] 🚫 SUSPENSION DETECTED`);
        await sendTelegram(`🚫 <b>${login}</b> — streaming suspension!\ntwitch.tv/${login}\nВремя: ${new Date().toLocaleString('ru-RU')}`);
        state[login] = 'suspended'; saveState(state);
      } else if (prev === 'suspended' && next === 'ok') {
        console.log(`[${login}] ✅ suspension lifted`);
        await sendTelegram(`✅ <b>${login}</b> — suspension снят!\nВремя: ${new Date().toLocaleString('ru-RU')}`);
        state[login] = 'ok'; saveState(state);
      }
      await page.waitForTimeout(500);
    }
    await context.close().catch(() => {});
  } catch (e) { console.error('[browser]', e.message); }
  finally { if (browser) await browser.close().catch(() => {}); }
}

if (!BOT_TOKEN || CHAT_IDS.length === 0) { console.error('BOT_TOKEN/CHAT_IDS не заданы'); process.exit(1); }
if (LOGINS.length === 0) { console.error('TWITCH_LOGINS не задан'); process.exit(1); }

const sessionFile = loadSession();
console.log(`[start] Мониторим: ${LOGINS.join(', ')} | Интервал: ${INTERVAL_MS/60000} мин`);
runCheck(sessionFile).then(() => setInterval(() => runCheck(sessionFile), INTERVAL_MS));
