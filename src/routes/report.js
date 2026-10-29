// Отчёт за период: сколько заявок выполнил каждый водитель, сколько взято с клиентов и сколько начислено работникам.
const { Router } = require('../mini');
const { all } = require('../db');
const { can } = require('../roles');
const { html, fullName, money, todayLocal } = require('../html');

const r = new Router();

r.use((req, res, next) => (can.manageOrders(req.user) ? next() : res.denied()));

const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

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
      COALESCE(SUM(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'card' THEN o.worker_pay END), 0) AS pay_card
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
${rows.map((x) => html`<tr><td>${fullName(x)}</td><td>${x.n}</td><td>${money(x.cash)}</td><td>${money(x.card)}</td><td>${money(x.pay)}</td>
  <td>${money(x.cash + x.card - x.pay)}</td><td><b>${money(x.cash - x.pay)}</b>${handInNote(x)}</td></tr>`)}
<tr class="total"><td>Итого</td><td>${sum('n')}</td><td>${money(sum('cash'))}</td><td>${money(sum('card'))}</td><td>${money(sum('pay'))}</td>
  <td>${money(sum('cash') + sum('card') - sum('pay'))}</td><td>${money(sum('cash') - sum('pay'))}</td></tr>
</table></div>
<p class="muted small">* Водитель оставляет себе из наличных всю свою долю: и с наличных заявок, и с заявок по переводу (её вы не переводите ему отдельно).
Отрицательная сумма — наличных не хватило, компания доплачивает водителю.</p>`
    : html`<p class="muted">За этот период выполненных заявок нет.</p>`}`);
});

module.exports = r;
