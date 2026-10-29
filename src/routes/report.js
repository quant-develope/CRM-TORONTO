// Отчёт за период: сколько заявок выполнил каждый водитель, сколько взято с клиентов и сколько начислено работникам.
// Профиль водителя: заявки, наличные по которым ещё не сданы; Quant и Веб отмечают, что деньги сданы.
const { Router } = require('../mini');
const { get, all, run } = require('../db');
const { can, PAY_METHODS, paidAmount, paidMethod } = require('../roles');
const { html, fullName, money, date, todayLocal, nowLocal, phoneLink } = require('../html');

const r = new Router();

r.use((req, res, next) => (can.manageOrders(req.user) ? next() : res.denied()));

const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// Сколько водитель должен сдать по заявке: наличные от клиента минус его доля (по заявке на перевод — минус).
const DUE_SQL = "(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'cash' THEN COALESCE(o.paid_amount, o.price) ELSE 0 END - o.worker_pay)";
// Уже закрыто по деньгам: плюс — водитель сдал, минус — компания доплатила водителю.
const settledNote = (v) => (v >= 0 ? `уже сдано ${money(v)}` : `водителю уже доплачено ${money(-v)}`);
const due = (o) => (paidMethod(o) === 'cash' ? paidAmount(o) : 0) - o.worker_pay;

// Расшифровка «Сдать наличных»: наличные − доля с наличных заявок − доля с заявок по переводу.
const handInNote = (x) => html`<br><span class="muted small">${money(x.cash)} − ${money(x.pay_cash)} (с наличных)${x.pay_card ? html` − ${money(x.pay_card)} (с перевода)` : ''}</span>`;

r.get('/', async (req, res) => {
  const from = isDay(req.query.from) ? req.query.from : todayLocal();
  const to = isDay(req.query.to) ? req.query.to : from;
  const rows = await all(`SELECT u.id, u.first_name, u.last_name, u.login, COUNT(o.id) AS n,
      COALESCE(SUM(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'cash' THEN COALESCE(o.paid_amount, o.price) END), 0) AS cash,
      COALESCE(SUM(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'card' THEN COALESCE(o.paid_amount, o.price) END), 0) AS card,
      COALESCE(SUM(o.worker_pay), 0) AS pay,
      COALESCE(SUM(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'cash' THEN o.worker_pay END), 0) AS pay_cash,
      COALESCE(SUM(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'card' THEN o.worker_pay END), 0) AS pay_card,
      COALESCE(SUM(CASE WHEN o.settled_at IS NULL THEN ${DUE_SQL} END), 0) AS owed
    FROM orders o JOIN users u ON u.id = o.driver_id
    WHERE o.status = 'done' AND substr(o.done_at, 1, 10) BETWEEN ? AND ?
    GROUP BY u.id ORDER BY n DESC, u.first_name`, from, to);
  const sum = (k) => rows.reduce((s, x) => s + x[k], 0);
  res.page('Отчёт', html`
<form method="get" class="filters">
  <label>С <input type="date" name="from" value="${from}"></label>
  <label>По <input type="date" name="to" value="${to}"></label>
  <button>Показать</button>
</form>
<div class="stats money">
  <div class="stat"><b>${sum('n')}</b><span>выполнено заявок</span></div>
  <div class="stat"><b>${money(sum('cash') + sum('card'))}</b><span>взято с клиентов</span></div>
  <div class="stat"><b>${money(sum('pay'))}</b><span>доля работников</span></div>
  <div class="stat"><b>${money(sum('cash') + sum('card') - sum('pay'))}</b><span>ваш доход</span></div>
</div>
${rows.length ? html`<div class="table-wrap"><table>
<tr><th>Водитель</th><th>Заявок</th><th>Наличные</th><th>Трансфер</th><th>Доля работника</th><th>Ваш доход</th><th>Сдать наличных*</th></tr>
${rows.map((x) => html`<tr><td><a href="/report/driver/${x.id}">${fullName(x)}</a></td><td>${x.n}</td><td>${money(x.cash)}</td><td>${money(x.card)}</td><td>${money(x.pay)}</td>
  <td>${money(x.cash + x.card - x.pay)}</td><td><b>${money(x.owed)}</b>${Math.abs(x.owed - (x.cash - x.pay)) < 0.005 ? handInNote(x) : html`<br><span class="muted small">${settledNote(x.cash - x.pay - x.owed)}</span>`}</td></tr>`)}
<tr class="total"><td>Итого</td><td>${sum('n')}</td><td>${money(sum('cash'))}</td><td>${money(sum('card'))}</td><td>${money(sum('pay'))}</td>
  <td>${money(sum('cash') + sum('card') - sum('pay'))}</td><td>${money(sum('owed'))}</td></tr>
</table></div>
<p class="muted small">* Водитель оставляет себе из наличных всю свою долю: и с наличных заявок, и с заявок по переводу (её вы не переводите ему отдельно).
Отрицательная сумма — наличных не хватило, компания доплачивает водителю.
Показано только то, что ещё не сдано; отметить сдачу — в профиле водителя (нажмите на имя).</p>`
    : html`<p class="muted">За этот период выполненных заявок нет.</p>`}`);
});

const driverOf = (req) => get("SELECT * FROM users WHERE id = ? AND role = 'driver'", req.params.id);

r.get('/driver/:id', async (req, res) => {
  const d = await driverOf(req);
  if (!d) return res.status(404).page('Водитель не найден', html`<p><a href="/report">← Отчёт</a></p>`);
  const open = await all("SELECT o.* FROM orders o WHERE o.driver_id = ? AND o.status = 'done' AND o.settled_at IS NULL ORDER BY o.done_at", d.id);
  const history = await all(`SELECT o.settled_at, o.settled_by, COUNT(*) AS n, SUM(${DUE_SQL}) AS total, u.first_name, u.last_name, u.login
    FROM orders o LEFT JOIN users u ON u.id = o.settled_by
    WHERE o.driver_id = ? AND o.settled_at IS NOT NULL GROUP BY o.settled_at, o.settled_by ORDER BY o.settled_at DESC LIMIT 50`, d.id);
  const owed = open.reduce((s, o) => s + due(o), 0);
  const settle = can.settleCash(req.user);
  res.page(fullName(d), html`
<p class="muted">Уборщик снега · ${phoneLink(d.phone)} · <a href="/report">← Отчёт</a></p>
<div class="stats money">
  <div class="stat"><b>${money(owed)}</b><span>${owed < 0 ? 'вы должны водителю' : 'не сдано наличных'}</span></div>
  <div class="stat"><b>${open.length}</b><span>${open.length === 1 ? 'несданная заявка' : 'несданных заявок'}</span></div>
</div>
${open.length ? html`
<form method="post" action="/report/driver/${d.id}/settle">
${settle ? html`<p class="muted small">Отметьте заявки, деньги по которым водитель ещё <b>не сдал</b>. Остальные будут отмечены сданными.</p>` : ''}
<div class="table-wrap"><table>
<tr>${settle ? html`<th>Не сдано</th>` : ''}<th>Заявка</th><th>Закончено</th><th>Адрес</th><th>Клиент заплатил</th><th>Доля работника</th><th>Сдать</th></tr>
${open.map((o) => html`<tr>
  ${settle ? html`<td><input type="checkbox" name="keep" value="${o.id}" aria-label="Заявка №${o.id} не сдана"></td>` : ''}
  <td><a href="/orders/${o.id}">№${o.id}</a></td><td class="nowrap">${date(o.done_at)}</td><td>${o.address}</td>
  <td class="nowrap">${money(paidAmount(o))} <span class="muted small">${PAY_METHODS[paidMethod(o)]}</span></td>
  <td class="nowrap">${money(o.worker_pay)}</td><td class="nowrap"><b>${money(due(o))}</b></td></tr>`)}
<tr class="total">${settle ? html`<td></td>` : ''}<td colspan="5">Итого</td><td class="nowrap">${money(owed)}</td></tr>
</table></div>
${settle ? html`<div class="actions">
  <button name="all" value="1" onclick="return confirm('Водитель сдал всё: ${money(owed)}?')">Вся сумма покрыта</button>
  <button class="secondary">Сохранить: отмеченные не сданы</button>
</div>` : ''}
</form>` : html`<p class="muted">Все наличные сданы.</p>`}
${history.length ? html`<h2>Сдано</h2>
<div class="table-wrap"><table>
<tr><th>Когда</th><th>Отметил</th><th>Заявок</th><th>Сумма</th>${settle ? html`<th></th>` : ''}</tr>
${history.map((h) => html`<tr><td class="nowrap">${date(h.settled_at)}</td><td>${h.login ? fullName(h) : '—'}</td><td>${h.n}</td><td class="nowrap">${money(h.total)}${h.total < 0 ? html` <span class="muted small">доплачено водителю</span>` : ''}</td>
  ${settle ? html`<td><form method="post" action="/report/driver/${d.id}/unsettle" onsubmit="return confirm('Вернуть эти заявки в несданные?')">
    <input type="hidden" name="at" value="${h.settled_at}"><button class="secondary small-btn">Отменить</button></form></td>` : ''}</tr>`)}
</table></div>` : ''}`);
});

r.post('/driver/:id/settle', async (req, res) => {
  if (!can.settleCash(req.user)) return res.denied();
  const d = await driverOf(req);
  if (!d) return res.redirect('/report');
  const keep = new Set([].concat(req.body.keep || []).map(String));
  const open = await all("SELECT id FROM orders WHERE driver_id = ? AND status = 'done' AND settled_at IS NULL", d.id);
  const ids = open.map((o) => o.id).filter((id) => req.body.all === '1' || !keep.has(String(id)));
  if (!ids.length) {
    res.flash('Ничего не отмечено сданным: все заявки остались несданными.');
    return res.redirect(`/report/driver/${d.id}`);
  }
  await run(`UPDATE orders SET settled_at = ?, settled_by = ? WHERE driver_id = ? AND settled_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    nowLocal(), req.user.id, d.id, ...ids);
  res.flash(`Отмечено сданными: ${ids.length} ${ids.length === 1 ? 'заявка' : ids.length < 5 ? 'заявки' : 'заявок'}.`);
  res.redirect(`/report/driver/${d.id}`);
});

r.post('/driver/:id/unsettle', async (req, res) => {
  if (!can.settleCash(req.user)) return res.denied();
  await run('UPDATE orders SET settled_at = NULL, settled_by = NULL WHERE driver_id = ? AND settled_at = ?', req.params.id, String(req.body.at || ''));
  res.flash('Заявки возвращены в несданные.');
  res.redirect(`/report/driver/${req.params.id}`);
});

module.exports = r;
