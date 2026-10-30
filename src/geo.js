// Геолокация работников. Телефон работника присылает свою точку не постоянно, а только когда она нужна:
// КЦ создаёт заявку (системное предложение) или открывает заявку (как далеко работник). CRM ставит работнику
// geo_requested_at, его открытая страница CRM видит это при опросе /api/events и присылает точку в /api/geo.
// Точки берутся только у работников «в сети»; при выходе из сети точка стирается.
// Адрес → координаты: OpenStreetMap Nominatim (с кэшем в таблице geocodes). Время в пути: OSRM (без пробок).
const { get, all, run } = require('./db');
const { ACTIVE } = require('./roles');

const ACTIVE_SQL = ACTIVE.map((s) => `'${s}'`).join(', ');
const UA = 'TorontoCRM/1.0 (+https://crm-toronto1.unknwn-creation.workers.dev)';
// Точка свежее этого считается текущей, новую не спрашиваем.
const FRESH_SEC = 60;

// Ссылка на карту с координатами: …/@43.65,-79.38,15z, ?q=43.65,-79.38, ?destination=43.65,-79.38.
function coordsFromText(text) {
  const s = decodeURIComponent(String(text || ''));
  const m = s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/)
    || s.match(/[?&](?:q|query|destination|daddr|ll)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/)
    || s.match(/^\s*(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)\s*$/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

async function fetchJson(url, ms = 5000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status}`);
  return res.json();
}

// Короткая ссылка Google Карт (maps.app.goo.gl) — смотрим, куда она ведёт.
async function expandLink(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(4000) });
    return res.headers.get('location') || '';
  } catch (err) {
    return '';
  }
}

// Координаты адреса заявки или null, если адрес не найден на карте.
async function geocode(address) {
  const key = String(address || '').trim().slice(0, 500);
  if (!key) return null;
  const direct = coordsFromText(key);
  if (direct) return direct;
  const cached = await get('SELECT lat, lng FROM geocodes WHERE address = ?', key);
  if (cached) return { lat: cached.lat, lng: cached.lng };
  let point = null;
  try {
    if (/^https?:\/\//i.test(key)) {
      point = coordsFromText(await expandLink(key));
    } else {
      // Поиск в Канаде с приоритетом Большого Торонто.
      const q = new URLSearchParams({ q: key, format: 'json', limit: '1', countrycodes: 'ca', viewbox: '-80.2,44.3,-78.6,43.3' });
      const [hit] = await fetchJson(`https://nominatim.openstreetmap.org/search?${q}`);
      if (hit) point = { lat: Number(hit.lat), lng: Number(hit.lon) };
    }
  } catch (err) {
    console.error('geocode', err.message);
    return null;
  }
  if (point) await run('INSERT OR REPLACE INTO geocodes (address, lat, lng) VALUES (?, ?, ?)', key, point.lat, point.lng);
  return point;
}

// Расстояние по прямой, км.
function straightKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// Если сервис маршрутов не ответил: дорога ≈ 1.35 × прямая, средняя скорость по городу 35 км/ч.
const roughTrip = (from, to) => {
  const km = straightKm(from, to) * 1.35;
  return { km, min: Math.max(1, Math.round((km / 35) * 60)), rough: true };
};

// Путь на машине от каждой точки from до to: [{ km, min, rough }].
async function trips(froms, to) {
  if (!froms.length) return [];
  try {
    const points = [...froms, to].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const sources = froms.map((_, i) => i).join(';');
    const data = await fetchJson(`https://router.project-osrm.org/table/v1/driving/${points}?sources=${sources}&destinations=${froms.length}&annotations=duration,distance`);
    if (data.code !== 'Ok') throw new Error(data.code);
    return froms.map((from, i) => {
      const sec = data.durations[i][0];
      const m = data.distances[i][0];
      return sec === null ? roughTrip(from, to) : { km: m / 1000, min: Math.max(1, Math.round(sec / 60)), rough: false };
    });
  } catch (err) {
    console.error('route', err.message);
    return froms.map((from) => roughTrip(from, to));
  }
}

// Попросить телефоны работников прислать точку (если она не совсем свежая).
async function requestGeo(ids) {
  for (const id of ids) {
    await run(`UPDATE users SET geo_requested_at = datetime('now') WHERE id = ? AND role = 'driver' AND online = 1
               AND (geo_at IS NULL OR geo_at < datetime('now', '-${FRESH_SEC} seconds'))`, id);
  }
}

// Работнику пора прислать точку: его попросили позже, чем он присылал последнюю.
const geoWanted = (u) => Boolean(u && u.role === 'driver' && u.online && u.geo_requested_at && (!u.geo_at || u.geo_requested_at > u.geo_at));

async function saveGeo(user, { lat, lng, accuracy }) {
  lat = Number(lat);
  lng = Number(lng);
  if (!user || user.role !== 'driver' || !user.online || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return false;
  await run("UPDATE users SET lat = ?, lng = ?, geo_accuracy = ?, geo_at = datetime('now') WHERE id = ?",
    lat, lng, Math.round(Number(accuracy)) || null, user.id);
  return true;
}

const clearGeo = (userId) => run('UPDATE users SET lat = NULL, lng = NULL, geo_accuracy = NULL, geo_at = NULL, geo_requested_at = NULL WHERE id = ?', userId);

// Сколько минут назад получена точка.
const AGE_SQL = "CAST((julianday('now') - julianday(geo_at)) * 1440 AS INTEGER) AS geo_age";

// «только что», «3 мин назад», «2 ч назад».
function ageText(min) {
  if (min === null || min === undefined) return '';
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  return `${Math.floor(min / 60)} ч назад`;
}

const kmText = (km) => (km < 10 ? km.toFixed(1).replace('.', ',') : String(Math.round(km))) + ' км';

// Системное предложение: работники в сети — сначала с меньшим числом незакрытых заявок
// (среди равных — тот, кто ближе к концу своей заявки), затем ближе к адресу.
async function suggest(address, { exceptOrder } = {}) {
  const drivers = await all(`SELECT id, first_name, last_name, login, phone, lat, lng, geo_at, ${AGE_SQL} FROM users
                             WHERE role = 'driver' AND active = 1 AND online = 1`);
  await requestGeo(drivers.map((d) => d.id));
  const jobs = await all(`SELECT driver_id, status FROM orders WHERE status IN (${ACTIVE_SQL}) AND driver_id IS NOT NULL AND id != ?`, Number(exceptOrder) || 0);
  for (const d of drivers) {
    const mine = jobs.filter((j) => j.driver_id === d.id);
    d.jobs = mine.length;
    // Насколько далеко текущая заявка от конца: 0 — свободен, 4 — только назначена.
    d.stage = mine.length ? Math.max(...mine.map((j) => ACTIVE.length - ACTIVE.indexOf(j.status))) : 0;
  }
  const target = await geocode(address);
  const located = drivers.filter((d) => d.lat !== null && d.geo_at);
  if (target) {
    const t = await trips(located.map((d) => ({ lat: d.lat, lng: d.lng })), target);
    located.forEach((d, i) => { d.trip = t[i]; });
  }
  const far = (d) => (d.trip ? d.trip.min : Infinity);
  drivers.sort((a, b) => a.jobs - b.jobs || a.stage - b.stage || far(a) - far(b));
  return { target, drivers };
}

// Где работник по заявке: расстояние и сколько минут ехать до клиента.
async function orderDistance(order) {
  const d = await get(`SELECT id, online, lat, lng, geo_at, ${AGE_SQL} FROM users WHERE id = ?`, order.driver_id);
  if (!d) return { text: 'Работник не назначен.' };
  if (d.online) await requestGeo([d.id]);
  if (d.lat === null || !d.geo_at) {
    return { text: d.online ? 'Ждём местоположение с телефона работника…' : 'Работник не в сети — местоположение недоступно.', waiting: Boolean(d.online) };
  }
  const target = await geocode(order.address);
  if (!target) return { text: 'Адрес заявки не найден на карте — расстояние не посчитать.' };
  const [trip] = await trips([{ lat: d.lat, lng: d.lng }], target);
  const age = d.geo_age;
  // Едет, а точка не свежая: вычитаем, сколько он уже проехал по времени.
  const enRoute = order.status === 'accepted';
  const min = enRoute && age > 1 ? Math.max(1, trip.min - age) : trip.min;
  const text = enRoute
    ? `Едет: примерно ${min} мин до адреса клиента${min === trip.min ? ` (${kmText(trip.km)})` : ''}.`
    : `Работник в ${kmText(trip.km)} от адреса, ехать примерно ${min} мин.`;
  const notes = [`точка ${ageText(age)}`];
  if (trip.rough) notes.push('расчёт по прямой');
  else notes.push('без учёта пробок');
  return { text, note: notes.join(' · '), waiting: d.online && age >= 1 };
}

module.exports = { geocode, suggest, orderDistance, requestGeo, geoWanted, saveGeo, clearGeo, ageText, kmText, AGE_SQL };
