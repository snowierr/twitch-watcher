const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const fs = require('fs');

const LOGINS = (process.env.TWITCH_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 1) * 60 * 1000;
const STATE_FILE = '/tmp/twitch_status.json';
const SUSPENSION_CLASS = 'home-carousel-info--suspended';
const SUSPENSION_TEXT  = 'cannot stream at this time';

const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

// Токен хранится в памяти процесса — не зависит от /tmp
let currentToken   = process.env.TWITCH_USER_TOKEN || '';
let currentRefresh = process.env.TWITCH_USER_REFRESH || '';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8'); } catch (e) {}
}

async function validateToken(token) {
  if (!token) return { valid: false, reason: 'empty token' };
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': 'OAuth ' + token }
    });
    const body = await res.json().catch(() => ({}));
    const valid = res.status === 200;
    console.log(`[token] validate → status:${res.status} login:${body.login || '—'} expires_in:${body.expires_in || '—'}`);
    return { valid, reason: valid ? 'ok' : (body.message || String(res.status)) };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

async function refreshToken() {
  if (!currentRefresh) { console.warn('[token] TWITCH_USER_REFRESH не задан'); return false; }
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) { console.warn('[token] CLIENT_ID/SECRET не заданы'); return false; }
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRefresh,
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET
      })
    });
    const data = await res.json();
    console.log(`[token] refresh → status:${res.status} has_access:${!!data.access_token} has_refresh:${!!data.refresh_token}`);
    if (data.access_token) {
      currentToken   = data.access_token;
      currentRefresh = data.refresh_token || currentRefresh;
      // Сразу валидируем новый токен
      const check = await validateToken(currentToken);
      console.log(`[token] new token valid: ${check.valid} (${check.reason})`);
      return check.valid;
    }
    console.error('[token] рефреш вернул:', JSON.stringify(data));
    return false;
  } catch (e) {
    console.error('[token] ошибка рефреша:', e.message);
    return false;
  }
}

async function ensureValidToken() {
  const check = await validateToken(currentToken);
  if (check.valid) return true;
  console.log(`[token] токен невалиден (${check.reason}), рефреш...`);
  const refreshed = await refreshToken();
  if (!refreshed) {
    await sendTelegram('⚠️ twitch-watcher: токен истёк и рефреш не удался. Нужна повторная авторизация через Apps Script.');
    return false;
  }
  return true;
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
    await page.addInitScript(() => {
      ['TwitchBrowserConsent','cookiesConsent','consent-banner','cookieConsent'].forEach(k => {
        try { localStorage.setItem(k, JSON.stringify({ analytics:true, ads:true, accepted:true, date:Date.now() })); } catch(e) {}
      });
    });
    page.on('response', async (resp) => {
      if (!resp.url().includes('gql.twitch.tv')) return;
      try { gqlResponses.push(await resp.json()); } catch (e) {}
    });
    await page.goto(`https://www.twitch.tv/${login}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if (/decline|reject|accept/i.test(btn.textContent || '')) btn.click();
      });
    });
    await page.waitForTimeout(10000);
    const html = await page.content();
    const allGql = JSON.stringify(gqlResponses).toLowerCase();
    const integrityOk = !allGql.includes('integritycheckfailed') && !allGql.includes('failed integrity check');
    const isSuspended = html.includes(SUSPENSION_CLASS) || html.toLowerCase().includes(SUSPENSION_TEXT);
    console.log(`[${login}] suspended:${isSuspended} integrity_ok:${integrityOk} gql:${gqlResponses.length}`);
    return { ok: true, isSuspended };
  } catch (e) {
    console.error(`[${login}] error: ${e.message}`);
    return { ok: false, isSuspended: false };
  }
}

async function runCheck() {
  const tokenOk = await ensureValidToken();
  const state = loadState();
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
    if (tokenOk && currentToken) {
      await context.addCookies([{
        name: 'auth-token', value: currentToken,
        domain: '.twitch.tv', path: '/', secure: true, sameSite: 'Lax'
      }]);
      console.log('[auth] auth-token установлен');
    } else {
      console.warn('[auth] работаем без авторизации');
    }
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
console.log(`[start] Мониторим: ${LOGINS.join(', ')} | Интервал: ${INTERVAL_MS/60000} мин`);
runCheck().then(() => setInterval(runCheck, INTERVAL_MS));
