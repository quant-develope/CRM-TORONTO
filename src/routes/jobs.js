// Заявки водителя: принять → навигатор → «На месте» → «Позвонить» или «Начать» → «Закончено, оплачено».
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { is, PAY_METHODS, PAY_HOW, paidAmount, paidMethod } = require('../roles');
const { html, raw, options, pushBanner, date, when, nowLocal, todayLocal, money, phoneHref, phoneLink, navUrl, wazeUrl, statusFlag } = require('../html');
const { ACTIVE_SQL } = require('../board');
const { notify } = require('../push');

const r = new Router();

r.use((req, res, next) => {
  if (!is(req.user, 'driver')) return res.denied();
  next();
});

const payLine = (o) => html`${money(o.price)} · ${PAY_HOW[o.pay_method]}`;
const otherMethod = (o) => (o.pay_method === 'card' ? 'cash' : 'card');

// Закрытие заявки: как в заявке; другим способом (наличные ↔ трансфер); другая сумма.
function doneActions(o) {
  const done = (fields, label, cls, confirm) => html`
  <form method="post" action="/jobs/${o.id}/done" onsubmit="return confirm('${confirm}')">
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button class="${cls}">${label}</button>
  </form>`;
  const other = otherMethod(o);
  return html`
  ${done({ amount: o.price, method: o.pay_method }, 'Закончено, оплачено', 'go', `Работа закончена и клиент заплатил ${money(o.price)} ${PAY_HOW[o.pay_method]}?`)}
  ${done({ amount: o.price, method: other }, other === 'card' ? 'Закончено, клиент платит переводом' : 'Закончено, клиент заплатил наличными', 'secondary',
    `Работа закончена, клиент платит ${money(o.price)} ${PAY_HOW[other]}?`)}
  <details class="other-sum">
    <summary class="button secondary">Клиент заплатил другую сумму</summary>
    <form method="post" action="/jobs/${o.id}/done" class="other-sum-form">
      <label>Сколько заплатил клиент, $<input name="amount" type="number" min="0" step="0.01" inputmode="decimal" required></label>
      <label>Как заплатил<select name="method">${options(PAY_METHODS, o.pay_method)}</select></label>
      <button class="go">Закончено</button>
    </form>
  </details>`;
}

// Кнопки для текущего этапа заявки.
function jobActions(o) {
  const post = (step, label, cls = '', confirm = '') => html`
  <form method="post" action="/jobs/${o.id}/${step}"${confirm ? html` onsubmit="return confirm('${confirm}')"` : ''}><button class="${cls}">${label}</button></form>`;
  const start = (cls) => post('start', 'Начать', cls);
  switch (o.status) {
    case 'assigned':
      return post('accept', 'Принять', 'go');
    case 'accepted':
      return html`
  <a href="${navUrl(o.address)}" class="button secondary" target="_blank" rel="noopener">Открыть навигатор</a>
  <a href="${wazeUrl(o.address)}" class="button secondary" target="_blank" rel="noopener">Навигатор Waze</a>
  ${post('arrived', 'На месте', 'go')}`;
    case 'arrived':
      return o.notify_client
        ? html`<a href="${phoneHref(o.client_phone)}" class="button go">Позвонить клиенту</a>${start('secondary')}`
        : start('go');
    case 'started':
      return doneActions(o);
    default:
      return '';
  }
}

function jobCard(o, { link = true } = {}) {
  return html`
<article class="job">
  <div class="job-head">
    <div><div class="job-time">${when(o.arrive_at)}</div><div class="muted small">${link ? html`<a href="/jobs/${o.id}">Заявка №${o.id}</a>` : html`Заявка №${o.id}`}</div></div>
    ${statusFlag(o.status)}
  </div>
  <dl class="facts">
    <dt>Адрес</dt><dd><b>${o.address}</b></dd>
    <dt>Клиент</dt><dd>${o.client_name || '—'} · ${phoneLink(o.client_phone)}</dd>
    <dt>Задача</dt><dd class="task-text">${o.task || '—'}</dd>
    <dt>Взять с клиента</dt><dd class="pay">${payLine(o)}</dd>
    <dt>Вы получите</dt><dd class="pay">${money(o.worker_pay)}</dd>
    <dt>По прибытии</dt><dd>${o.notify_client ? html`<span class="notify-yes">Сначала позвонить клиенту</span>` : 'Можно сразу приступать'}</dd>
  </dl>
  <div class="job-actions">${jobActions(o)}</div>
</article>`;
}

// Главная водителя: текущие заявки по времени приезда.
async function driverHome(req, res) {
  const jobs = await all(`SELECT * FROM orders WHERE driver_id = ? AND status IN (${ACTIVE_SQL}) ORDER BY arrive_at, id`, req.user.id);
  const today = await get(`SELECT COUNT(*) AS n, COALESCE(SUM(worker_pay), 0) AS pay FROM orders
                           WHERE driver_id = ? AND status = 'done' AND substr(done_at, 1, 10) = ?`, req.user.id, todayLocal());
  // Пока нет заявки в работе, страница обновляется сама — новая заявка появится без перезагрузки.
  const idle = jobs.every((j) => j.status === 'assigned');
  res.page(jobs.length ? 'Мои заявки' : 'Заявок нет', html`
${pushBanner('Включите, чтобы сразу узнавать о новой заявке.')}
${jobs.length ? html`<div class="jobs">${jobs.map((j) => jobCard(j))}</div>` : html`<p class="muted">Вы в списке «Свободны». Новая заявка появится здесь, страница обновляется сама.</p>`}
<p class="muted">Сегодня выполнено: ${today.n} · заработано ${money(today.pay)}. <a href="/jobs/done">Выполненные →</a></p>`, { refresh: idle ? 30 : 0 });
}

r.get('/done', async (req, res) => {
  const rows = await all("SELECT * FROM orders WHERE driver_id = ? AND status = 'done' ORDER BY done_at DESC LIMIT 200", req.user.id);
  const total = rows.reduce((s, o) => s + o.worker_pay, 0);
  res.page('Выполненные заявки', rows.length ? html`
<div class="table-wrap"><table>
<tr><th>Закончено</th><th>Адрес</th><th>Взято с клиента</th><th>Вам</th></tr>
${rows.map((o) => html`<tr><td class="nowrap">${date(o.done_at)}</td><td>${o.address}</td><td class="nowrap">${money(paidAmount(o))} <span class="muted small">${PAY_METHODS[paidMethod(o)]}</span></td><td class="nowrap">${money(o.worker_pay)}</td></tr>`)}
<tr class="total"><td colspan="3">Итого (последние ${rows.length})</td><td class="nowrap">${money(total)}</td></tr>
</table></div>` : html`<p class="muted">Пока нет выполненных заявок.</p>`);
});

const own = (req) => get('SELECT * FROM orders WHERE id = ? AND driver_id = ?', req.params.id, req.user.id);

r.get('/:id', async (req, res) => {
  const o = await own(req);
  if (!o) return res.status(404).page('Заявка не найдена', html`<p><a href="/">На главную</a></p>`);
  // Сразу после «Принять» открываем навигатор; кнопка остаётся на странице.
  const autoNav = req.query.nav === '1' && o.status === 'accepted';
  res.page(`Заявка №${o.id}`, html`
${jobCard(o, { link: false })}
${autoNav ? raw(`<script>location.href = ${JSON.stringify(navUrl(o.address)).replace(/</g, '\\u003c')};</script>`) : ''}
<p><a href="/">← Мои заявки</a></p>`);
});

// Переход на следующий этап: только из ожидаемого статуса, чтобы повторное нажатие ничего не ломало.
const STEP = {
  accept: ['assigned', 'accepted', 'accepted_at'],
  arrived: ['accepted', 'arrived', 'arrived_at'],
  start: ['arrived', 'started', 'started_at'],
  done: ['started', 'done', 'done_at'],
};

r.post('/:id/:step', async (req, res) => {
  const step = STEP[req.params.step];
  if (!step) return res.status(404).page('Страница не найдена', html`<p><a href="/">На главную</a></p>`);
  const [from, to, column] = step;
  const { changes } = await run(`UPDATE orders SET status = ?, ${column} = ? WHERE id = ? AND driver_id = ? AND status = ?`,
    to, nowLocal(), req.params.id, req.user.id, from);
  if (changes && to === 'done') {
    const o = await own(req);
    const amount = Number(req.body.amount);
    await run('UPDATE orders SET paid_amount = ?, paid_method = ? WHERE id = ?',
      Number.isFinite(amount) && amount >= 0 && req.body.amount !== '' ? amount : o.price, PAY_METHODS[req.body.method] ? req.body.method : o.pay_method, o.id);
  }
  if (changes) await notify(req, { order: await own(req), status: to });
  if (to === 'done' && changes) {
    res.flash('Заявка закрыта. Спасибо!');
    return res.redirect('/');
  }
  res.redirect(`/jobs/${req.params.id}${to === 'accepted' && changes ? '?nav=1' : ''}`);
});

module.exports = r;
module.exports.driverHome = driverHome;
