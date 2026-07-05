const { chromium } = require('playwright');
const fs = require('fs');

const LOGINS = (process.env.TWITCH_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 1) * 60 * 1000;
const STATE_FILE = '/tmp/twitch_status.json';
const SUSPENSION_CLASS = 'home-carousel-info--suspended';

// Режим диагностики — только для drakeoffc, разово
const DIAG_LOGIN = process.env.DIAG_LOGIN || '';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); } catch (e) {}
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

// Рекурсивно ищем в JSON-объекте ключи содержащие паттерн
function deepSearch(obj, pattern, path = '', results = []) {
  if (!obj || typeof obj !== 'object') return results;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (pattern.test(k) || (typeof v === 'string' && pattern.test(v))) {
      results.push(`${p}: ${JSON.stringify(v).substring(0, 120)}`);
    }
    if (typeof v === 'object') deepSearch(v, pattern, p, results);
  }
  return results;
}

async function checkChannel(page, login) {
  const isDiag = login === DIAG_LOGIN;
  const gqlResponses = [];

  try {
    await page.addInitScript(() => {
      ['TwitchBrowserConsent','cookiesConsent','consent-banner','cookieConsent'].forEach(k => {
        try { localStorage.setItem(k, JSON.stringify({ analytics:true, ads:true, accepted:true, date:Date.now() })); } catch(e) {}
      });
    });

    // Перехватываем GQL ответы
    page.on('response', async (resp) => {
      if (!resp.url().includes('gql.twitch.tv')) return;
      try {
        const json = await resp.json();
        gqlResponses.push(json);
      } catch (e) {}
    });

    await page.goto(`https://www.twitch.tv/${login}`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if (/decline|reject|accept/i.test(btn.textContent || '')) btn.click();
      });
    });

    // Ждём GQL-ответов — не ждём settled, просто даём время
    await page.waitForTimeout(12000);

    const html = await page.content();
    const isSuspended = html.includes(SUSPENSION_CLASS);

    console.log(`[${login}] suspended:${isSuspended} gql_responses:${gqlResponses.length} html:${html.length}`);

    // Диагностика: ищем в GQL-ответах всё связанное с суспендом/стримингом
    if (isDiag) {
      const pattern = /suspend|ban|stream|enforce|restrict|cannot|offline|carousel/i;
      const found = [];
      gqlResponses.forEach((resp, i) => {
        const hits = deepSearch(resp, pattern);
        if (hits.length) {
          found.push(`=== Response #${i} ===`);
          found.push(...hits.slice(0, 10)); // max 10 хитов на ответ
        }
      });
      if (found.length) {
        console.log(`[DIAG ${login}] Found ${found.length} items:`);
        found.slice(0, 50).forEach(l => console.log(`  ${l}`));
      } else {
        console.log(`[DIAG ${login}] Nothing found in ${gqlResponses.length} GQL responses`);
      }
    }

    return { ok: true, isSuspended };
  } catch (e) {
    console.error(`[${login}] error: ${e.message}`);
    return { ok: false, isSuspended: false };
  }
}

async function runCheck() {
  const state = loadState();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-blink-features=AutomationControlled','--window-size=1280,800']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US', viewport: { width: 1280, height: 800 }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
    const page = await context.newPage();

    for (const login of LOGINS) {
      const result = await checkChannel(page, login);
      if (!result.ok) continue;
      const prev = state[login] || 'ok';
      const next = result.isSuspended ? 'suspended' : 'ok';
      if (prev !== 'suspended' && next === 'suspended') {
        await sendTelegram(`🚫 <b>${login}</b> — streaming suspension!\ntwitch.tv/${login}\nВремя: ${new Date().toLocaleString('ru-RU')}`);
        state[login] = 'suspended'; saveState(state);
      } else if (prev === 'suspended' && next === 'ok') {
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
console.log(`[start] Мониторим: ${LOGINS.join(', ')} | Интервал: ${INTERVAL_MS/60000} мин`);
runCheck().then(() => setInterval(runCheck, INTERVAL_MS));
