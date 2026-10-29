import { Router, Response_, makeRequest } from './mini';
import { connect, get, run, all, verifyPassword, hashPassword } from './db';
import { html, layout, brandLogo, pushBanner, fullName, date, when, utcToLocal, roleTag, statusFlag, todayLocal } from './html';
import { can, is } from './roles';
import { driversBoard, boardBlock, ACTIVE_SQL } from './board';
import orders from './routes/orders';
import jobs, { driverHome } from './routes/jobs';
import staff from './routes/staff';
import report from './routes/report';
import { eventsFor, lastEventId, vapidKeys } from './push';

const SESSION_DAYS = 30;
const COOKIE = 'toronto_session';
const FLASH = 'toronto_flash';
const MAX_FAILED = 10;

const app = new Router();

app.use(async (req, res, next) => {
  const token = req.cookies[COOKIE];
  if (token) {
    const session = await get("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')", token);
    if (session) {
      req.user = await get('SELECT * FROM users WHERE id = ? AND active = 1', session.user_id);
      req.sessionToken = token;
    }
  }
  const secure = req.url.protocol === 'https:';
  // Сообщение показывается сразу на этой странице или, после redirect, на следующей (через cookie).
  res.flash = (message) => { res.flashMessage = message; };
  res.page = (title, body, { refresh } = {}) => {
    const flash = res.flashMessage || req.cookies[FLASH];
    res.flashMessage = null;
    if (req.cookies[FLASH]) res.cookie(FLASH, '', { maxAge: 0, secure });
    res.send(String(layout({ user: req.user, title, body, path: (req.baseUrl + req.path).replace(/\/$/, '') || '/', flash, refresh })));
  };
  res.denied = () => res.status(403).page('Нет доступа', html`<p>У вашей роли нет прав на это действие.</p><p><a href="/">На главную</a></p>`);
  req.secure = secure;
  next();
});

// --- Вход / выход ---

function loginPage(error, login = '') {
  return String(layout({
    title: 'Вход',
    body: html`
<div class="login">
  <form method="post" action="/login" class="card">
    <div class="brand big">${brandLogo()}TORONTO CRM</div>
    ${error ? html`<div class="error">${error}</div>` : ''}
    <label>Логин<input name="login" value="${login}" autocomplete="username" autocapitalize="none" required autofocus></label>
    <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
    <button>Войти</button>
  </form>
</div>`,
  }));
}

function logAuth(req, userId, login, event) {
  return run('INSERT INTO auth_log (user_id, login, event, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
    userId, login, event, req.ip, String(req.headers['user-agent'] || '').slice(0, 300));
}

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(loginPage());
});

app.post('/login', async (req, res) => {
  const login = String(req.body.login || '').trim();
  const password = String(req.body.password || '');

  // Не больше 10 неудачных попыток за 15 минут с одного IP.
  const failed = await get(`SELECT COUNT(*) AS n FROM auth_log WHERE ip = ? AND event = 'failed'
                            AND created_at > datetime('now', '-15 minutes')`, req.ip);
  if (failed.n >= MAX_FAILED) {
    await logAuth(req, null, login, 'blocked');
    return res.status(429).send(loginPage('Слишком много попыток. Попробуйте через 15 минут.', login));
  }

  const user = await get('SELECT * FROM users WHERE login = ?', login);
  if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
    await logAuth(req, user ? user.id : null, login, user && !user.active ? 'inactive' : 'failed');
    return res.status(401).send(loginPage('Неверный логин или пароль', login));
  }

  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  await run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`, token, user.id);
  await logAuth(req, user.id, user.login, 'login');
  res.cookie(COOKIE, token, { maxAge: SESSION_DAYS * 864e5, secure: req.secure });
  res.redirect('/');
});

app.post('/logout', async (req, res) => {
  if (req.user) {
    await run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
    await logAuth(req, req.user.id, req.user.login, 'logout');
  }
  res.clearCookie(COOKIE);
  res.redirect('/login');
});

// Всё остальное только для вошедших.
app.use((req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
});

app.get('/', async (req, res) => {
  const u = req.user;
  if (is(u, 'driver')) return driverHome(req, res);
  const count = async (sql, ...p) => (await get(sql, ...p)).n;
  const board = await driversBoard();
  const upcoming = await all(`SELECT o.*, u.first_name, u.last_name, u.login FROM orders o LEFT JOIN users u ON u.id = o.driver_id
                              WHERE o.status IN (${ACTIVE_SQL}) ORDER BY o.arrive_at, o.id LIMIT 12`);
  const counts = {
    active: await count(`SELECT COUNT(*) AS n FROM orders WHERE status IN (${ACTIVE_SQL})`),
    waiting: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'assigned'"),
    done: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'done' AND substr(done_at, 1, 10) = ?", todayLocal()),
  };
  res.page(`Здравствуйте, ${fullName(u)}`, html`
${pushBanner('Включите, чтобы узнавать, когда водитель принял заявку, приехал, начал и закончил работу.')}
<div class="toolbar"><span>Роль: ${roleTag(u.role)}</span><a href="/orders/new" class="button">+ Новая заявка</a></div>
<div class="stats">
  <a href="/orders?status=active" class="stat"><b>${counts.active}</b><span>активных заявок</span></a>
  <a href="/orders?status=active" class="stat"><b>${counts.waiting}</b><span>ждут принятия водителем</span></a>
  <a href="/report" class="stat"><b>${counts.done}</b><span>выполнено сегодня</span></a>
  <a href="/drivers" class="stat"><b>${board.free.length}</b><span>водителей свободны</span></a>
</div>
<div class="desk-split">
  <div>${board.drivers.length ? boardBlock(board, { compact: true }) : html`<p class="notice">Водителей пока нет. ${can.manageStaff(u) ? html`<a href="/staff/new?role=driver">Добавить водителя →</a>` : 'Их добавляет Quant.'}</p>`}</div>
  <section>
    <h2 class="flush">Ближайшие заявки</h2>
    ${upcoming.length ? html`<div class="table-wrap"><table>
    <tr><th>Приезд</th><th>Адрес</th><th>Водитель</th><th>Статус</th></tr>
    ${upcoming.map((o) => html`<tr><td class="nowrap"><a href="/orders/${o.id}">${when(o.arrive_at)}</a></td><td>${o.address}</td><td>${fullName(o)}</td><td>${statusFlag(o.status)}</td></tr>`)}
    </table></div><p><a href="/orders">Все заявки →</a></p>` : html`<p class="muted">Активных заявок нет. <a href="/orders/new">Создать заявку →</a></p>`}
  </section>
</div>`, { refresh: 60 });
});

app.get('/drivers', async (req, res) => {
  if (!can.manageOrders(req.user)) return res.denied();
  res.page('Свободны / заняты', boardBlock(await driversBoard()), { refresh: 30 });
});

// Смена своего пароля — для всех.
app.get('/account', (req, res) => {
  res.page('Мой пароль', html`
<form method="post" action="/account" class="grid">
  <label>Текущий пароль<input name="current" type="password" autocomplete="current-password" required></label>
  <label>Новый пароль<input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
  <div><button>Сменить пароль</button></div>
</form>`);
});

app.post('/account', async (req, res) => {
  const password = String(req.body.password || '');
  if (!(await verifyPassword(String(req.body.current || ''), req.user.password_hash))) {
    res.flash('Текущий пароль неверный.');
    return res.redirect('/account');
  }
  if (password.length < 6) {
    res.flash('Новый пароль — не короче 6 символов.');
    return res.redirect('/account');
  }
  await run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), req.user.id);
  await run('DELETE FROM sessions WHERE user_id = ? AND token != ?', req.user.id, req.sessionToken);
  res.flash('Пароль изменён.');
  res.redirect('/');
});

// --- Уведомления ---

const json = (res, data, status = 200) => {
  res.headers.set('content-type', 'application/json; charset=utf-8');
  res.headers.set('cache-control', 'no-store');
  return res.status(status).send(JSON.stringify(data));
};

// Новые события после after (для всплывающих уведомлений и для service worker при push).
app.get('/api/events', async (req, res) => {
  if (req.query.after === undefined) return json(res, { last: await lastEventId(req.user), events: [] });
  // Push без содержимого: service worker просит последнее событие.
  if (req.query.after === 'latest') return json(res, { events: await eventsFor(req.user, 0, 1) });
  json(res, { events: (await eventsFor(req.user, req.query.after)).reverse() });
});

app.get('/push/key', async (req, res) => json(res, { key: (await vapidKeys()).publicKey }));

app.post('/push/subscribe', async (req, res) => {
  const sub = await req.raw.json().catch(() => null);
  if (!sub || !/^https:\/\//.test(String(sub.endpoint || ''))) return json(res, { ok: false }, 400);
  await run(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
             ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id`,
  req.user.id, sub.endpoint, String(sub.keys?.p256dh || ''), String(sub.keys?.auth || ''));
  json(res, { ok: true });
});

app.post('/push/unsubscribe', async (req, res) => {
  const sub = await req.raw.json().catch(() => ({}));
  await run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', String(sub.endpoint || ''), req.user.id);
  json(res, { ok: true });
});

app.get('/auth-log', async (req, res) => {
  if (!can.viewAuthLog(req.user)) return res.denied();
  const events = { login: 'Вход', logout: 'Выход', failed: 'Неверный пароль', inactive: 'Учётная запись отключена', blocked: 'Заблокировано (много попыток)' };
  const rows = await all(`SELECT l.*, u.first_name, u.last_name, u.role FROM auth_log l LEFT JOIN users u ON u.id = l.user_id
                          ORDER BY l.id DESC LIMIT 500`);
  res.page('Журнал входов', html`
<p class="muted">Последние 500 событий, время Торонто.</p>
<div class="table-wrap"><table>
<tr><th>Время</th><th>Логин</th><th>Сотрудник</th><th>Событие</th><th>IP</th><th>Браузер</th></tr>
${rows.map((r) => html`<tr class="${r.event === 'login' || r.event === 'logout' ? '' : 'warn'}">
  <td class="nowrap">${date(utcToLocal(r.created_at))}</td><td>${r.login}</td><td>${r.user_id && r.role ? html`${fullName(r)} ${roleTag(r.role)}` : '—'}</td>
  <td>${events[r.event] || r.event}</td><td>${r.ip}</td><td class="small">${r.user_agent}</td></tr>`)}
</table></div>`);
});

app.use('/orders', orders);
app.use('/jobs', jobs);
app.use('/staff', staff);
app.use('/report', report);

app.use((req, res) => res.status(404).page('Страница не найдена', html`<p><a href="/">На главную</a></p>`));

// ИИ-краулеры: сайт закрыт для них (см. также public/robots.txt и X-Robots-Tag).
const AI_BOTS = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|Claude-User|Claude-SearchBot|anthropic-ai|CCBot|Google-Extended|GoogleOther|Applebot-Extended|PerplexityBot|Perplexity-User|Bytespider|Amazonbot|meta-externalagent|meta-externalfetcher|FacebookBot|cohere-ai|cohere-training-data-crawler|Diffbot|ImagesiftBot|Omgilibot|Omgili|YouBot|AI2Bot|Ai2Bot-Dolma|DuckAssistBot|MistralAI-User|PanguBot|Timpibot|Kangaroo Bot|Webzio-Extended|img2dataset|Scrapy|SemrushBot-OCOB|TikTokSpider|iaskspider|Petalbot/i;
const NO_AI = 'noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai';

export default {
  async fetch(request, env, ctx) {
    if (AI_BOTS.test(request.headers.get('user-agent') || '')) {
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': NO_AI } });
    }
    const res = new Response_();
    res.headers.set('x-robots-tag', NO_AI);
    try {
      await connect(env);
      const req = await makeRequest(request);
      req.waitUntil = (job) => ctx.waitUntil(job);
      await app.handle(req, res);
      if (res.flashMessage && res.statusCode === 302) res.cookie(FLASH, res.flashMessage, { maxAge: 60e3, secure: req.secure });
      return res.toResponse();
    } catch (err) {
      console.error(err);
      return new Response(`Ошибка сервера: ${err.message}`, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  },
};
