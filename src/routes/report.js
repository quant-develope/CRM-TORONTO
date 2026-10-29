// Отчёт за период: сколько заявок выполнил каждый водитель, сколько взято с клиентов и сколько начислено работникам.
const { Router } = require('../mini');
const { all } = require('../db');
const { can } = require('../roles');
const { html, fullName, money, todayLocal } = require('../html');

const r = new Router();

r.use((req, res, next) => (can.manageOrders(req.user) ? next() : res.denied()));

const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

r.get('/', async (req, res) => {
  const from = isDay(req.query.from) ? req.query.from : todayLocal();
  const to = isDay(req.query.to) ? req.query.to : from;
  const rows = await all(`SELECT u.id, u.first_name, u.last_name, u.login, COUNT(o.id) AS n,
      COALESCE(SUM(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'cash' THEN COALESCE(o.paid_amount, o.price) END), 0) AS cash,
      COALESCE(SUM(CASE WHEN COALESCE(o.paid_method, o.pay_method) = 'card' THEN COALESCE(o.paid_amount, o.price) END), 0) AS card,
      COALESCE(SUM(o.worker_pay), 0) AS pay
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
  <div class="stat"><b>${money(sum('pay'))}</b><span>начислено работникам</span></div>
  <div class="stat"><b>${money(sum('cash') + sum('card') - sum('pay'))}</b><span>остаётся компании</span></div>
</div>
${rows.length ? html`<div class="table-wrap"><table>
<tr><th>Водитель</th><th>Заявок</th><th>Наличные</th><th>Трансфер</th><th>Начислено работнику</th><th>Сдать наличных*</th></tr>
${rows.map((x) => html`<tr><td>${fullName(x)}</td><td>${x.n}</td><td>${money(x.cash)}</td><td>${money(x.card)}</td><td>${money(x.pay)}</td><td>${money(x.cash - x.pay)}</td></tr>`)}
<tr class="total"><td>Итого</td><td>${sum('n')}</td><td>${money(sum('cash'))}</td><td>${money(sum('card'))}</td><td>${money(sum('pay'))}</td><td>${money(sum('cash') - sum('pay'))}</td></tr>
</table></div>
<p class="muted small">* Наличные, взятые водителем, минус его начисления. Отрицательная сумма — компания должна доплатить водителю.</p>`
    : html`<p class="muted">За этот период выполненных заявок нет.</p>`}`);
});

module.exports = r;
