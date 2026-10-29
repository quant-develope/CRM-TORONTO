// Водители: «Свободны» — нет незавершённых заявок, «Заняты» — есть назначенная и не выполненная.
const { all } = require('./db');
const { ACTIVE } = require('./roles');
const { html, fullName, phoneLink, statusFlag, when } = require('./html');

const ACTIVE_SQL = ACTIVE.map((s) => `'${s}'`).join(', ');

async function driversBoard() {
  const drivers = await all("SELECT * FROM users WHERE role = 'driver' AND active = 1 ORDER BY first_name, last_name");
  const jobs = await all(`SELECT id, driver_id, status, address, arrive_at FROM orders WHERE status IN (${ACTIVE_SQL}) AND driver_id IS NOT NULL
                          ORDER BY arrive_at, id`);
  const byDriver = new Map();
  for (const j of jobs) {
    if (!byDriver.has(j.driver_id)) byDriver.set(j.driver_id, []);
    byDriver.get(j.driver_id).push(j);
  }
  const free = drivers.filter((d) => !byDriver.has(d.id));
  const busy = drivers.filter((d) => byDriver.has(d.id)).map((d) => ({ ...d, jobs: byDriver.get(d.id) }));
  return { drivers, free, busy };
}

function boardBlock({ free, busy }) {
  return html`
<div class="board">
  <section class="board-col">
    <h2><span class="dot dot-green"></span>Свободны <b>${free.length}</b></h2>
    ${free.length ? html`<ul>${free.map((d) => html`<li><b>${fullName(d)}</b><span class="muted small">${phoneLink(d.phone)}</span>
      <span><a href="/orders/new?driver=${d.id}">Назначить заявку →</a></span></li>`)}</ul>` : html`<p class="empty">Свободных нет</p>`}
  </section>
  <section class="board-col">
    <h2><span class="dot dot-orange"></span>Заняты <b>${busy.length}</b></h2>
    ${busy.length ? html`<ul>${busy.map((d) => html`<li><b>${fullName(d)}</b><span class="muted small">${phoneLink(d.phone)}</span>
      ${d.jobs.map((j) => html`<span><a href="/orders/${j.id}">№${j.id}</a> · ${when(j.arrive_at)} · ${statusFlag(j.status)}<br><span class="muted small">${j.address}</span></span>`)}</li>`)}</ul>`
    : html`<p class="empty">Все свободны</p>`}
  </section>
</div>`;
}

module.exports = { driversBoard, boardBlock, ACTIVE_SQL };
