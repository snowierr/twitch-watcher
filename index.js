const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs = require('fs');

const LOGINS = (process.env.TWITCH_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 1) * 60 * 1000;
const STATE_FILE = '/tmp/twitch_status.json';
const TOKEN_FILE = '/tmp/twitch_token.json';
const SUSPENSION_CLASS = 'home-carousel-info--suspended';
const SUSPENSION_TEXT  = 'cannot stream at this time';

const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const INITIAL_TOKEN        = process.env.TWITCH_USER_TOKEN || '';
const INITIAL_REFRESH      = process.env.TWITCH_USER_REFRESH || '';

// ---------- хранилище состояния ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8'); } catch (e) {}
}

// ---------- токен (с рефрешем) ----------
function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (e) {
    return { access: INITIAL_TOKEN, refresh: INITIAL_REFRESH };
  }
}
function saveToken(t) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t), 'utf8'); } catch (e) {}
}

async function refreshAccessToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.warn('[token] TWITCH_CLIENT_ID/SECRET не заданы — рефреш невозможен');
    return null;
  }
  const t = loadToken();
  if (!t.refresh) { console.warn('[token] refresh token отсутствует'); return null; }

  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh,
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET
      })
    });
    const data = await res.json();
    if (data.access_token) {
      const newToken = { access: data.access_token, refresh: data.refresh_token || t.refresh };
      saveToken(newToken);
      console.log('[token] токен обновлён');
      return newToken.access;
    } else {
      console.error('[token] рефреш не удался:', JSON.stringify(data));
      return null;
    }
  } catch (e) {
    console.error('[token] ошибка рефреша:', e.message);
    return null;
  }
}

async function getValidToken() {
  let t = loadToken();
  if (t.access) return t.access;
  return await refreshAccessToken();
}

// ---------- Telegram ----------
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

// ---------- проверка канала ----------
async function checkChannel(page, login) {
  const gqlResponses = [];
  try {
    await page.addInitScript(() => {
      ['TwitchBrowserConsent','cookiesConsent','consent-banner','cookieConsent'].forEach(k => {
        try { localStorage.setItem(k, JSON.stringify({ analytics:true, ads:true, accepted:true, date:Date.now() })); } catch(e) {}
      });
    });

    page.on('response', async (resp) => {
      if (!resp.url().includes('gql.twitch.tv')) return;
      try { gqlResponses.push(await resp.json()); } catch (e) {}
    });

    await page.goto(`https://www.twitch.tv/${login}`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if (/decline|reject|accept/i.test(btn.textContent || '')) btn.click();
      });
    });

    await page.waitForTimeout(10000);

    const html = await page.content();
    const allGql = JSON.stringify(gqlResponses).toLowerCase();
    const hasIntegrityFailure = allGql.includes('integritycheckfailed') || allGql.includes('failed integrity check');
    const hasClass = html.includes(SUSPENSION_CLASS);
    const hasText  = html.toLowerCase().includes(SUSPENSION_TEXT);
    const isSuspended = hasClass || hasText;

    // Если integrity всё ещё падает — токен истёк, пробуем рефреш
    if (hasIntegrityFailure) {
      return { ok: true, isSuspended, tokenExpired: true };
    }

    console.log(`[${login}] suspended:${isSuspended} integrity_ok:true gql:${gqlResponses.length} html:${html.length}`);
    return { ok: true, isSuspended, tokenExpired: false };
  } catch (e) {
    console.error(`[${login}] error: ${e.message}`);
    return { ok: false, isSuspended: false };
  }
}

// ---------- основной цикл ----------
async function runCheck() {
  const state = loadState();
  let token = await getValidToken();
  if (!token) {
    console.error('[run] нет действующего токена, пропускаем цикл');
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--window-size=1280,800']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US', viewport: { width: 1280, height: 800 }
    });

    await context.addCookies([{
      name: 'auth-token', value: token,
      domain: '.twitch.tv', path: '/', secure: true, sameSite: 'Lax'
    }]);

    const page = await context.newPage();
    let needsRefresh = false;

    for (const login of LOGINS) {
      const result = await checkChannel(page, login);
      if (!result.ok) continue;

      if (result.tokenExpired) {
        console.log(`[${login}] integrity failed — токен истёк, нужен рефреш`);
        needsRefresh = true;
        continue; // не обновляем статус при невалидном токене
      }

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

    // Если токен истёк — рефрешим и очищаем кеш, чтобы следующий цикл взял новый
    if (needsRefresh) {
      const newToken = await refreshAccessToken();
      if (!newToken) {
        await sendTelegram('⚠️ twitch-watcher: user token истёк и рефреш не удался. Нужно заново авторизоваться через Apps Script.');
      }
    }
  } catch (e) { console.error('[browser]', e.message); }
  finally { if (browser) await browser.close().catch(() => {}); }
}

if (!BOT_TOKEN || CHAT_IDS.length === 0) { console.error('BOT_TOKEN/CHAT_IDS не заданы'); process.exit(1); }
if (LOGINS.length === 0) { console.error('TWITCH_LOGINS не задан'); process.exit(1); }
console.log(`[start] Мониторим: ${LOGINS.join(', ')} | Интервал: ${INTERVAL_MS/60000} мин`);
runCheck().then(() => setInterval(runCheck, INTERVAL_MS));
