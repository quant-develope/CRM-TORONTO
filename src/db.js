// База данных Cloudflare D1. Схема создаётся автоматически при первом запросе.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  login TEXT NOT NULL,
  event TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Заявка на уборку снега. Время приезда и отметки этапов — по времени Торонто (YYYY-MM-DD HH:MM).
-- pay_method: cash — наличные, card — трансфер. notify_client = 1 — по прибытии позвонить клиенту, 0 — сразу начинать.
-- status: assigned → accepted → arrived → started → done; cancelled — отменена.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  arrive_at TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  pay_method TEXT NOT NULL DEFAULT 'cash',
  worker_pay REAL NOT NULL DEFAULT 0,
  task TEXT NOT NULL DEFAULT '',
  notify_client INTEGER NOT NULL DEFAULT 0,
  driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT '',
  assigned_at TEXT,
  accepted_at TEXT,
  arrived_at TEXT,
  started_at TEXT,
  done_at TEXT,
  cancelled_at TEXT,
  paid_amount REAL,
  paid_method TEXT,
  settled_at TEXT,
  settled_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- События для уведомлений. target_user_id — кому (водителю о новой заявке); NULL — всем Quant и КЦ (смена статуса).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT '',
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Телефоны и браузеры, на которые отправляются push-уведомления.
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL DEFAULT '',
  auth TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Настройки сайта (ключи VAPID для push).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Входящие звонки на номер Twilio. status: ringing — звонит, answered — оператор ответил, missed — никто не ответил (перезвонить).
-- Заявки с сайтов хранятся здесь же: status site — нужно позвонить клиенту; source — сайт, lead_name / lead_address / note — что клиент написал в форме.
-- order_id — заявка, созданная по этому звонку.
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  call_sid TEXT NOT NULL UNIQUE,
  from_number TEXT NOT NULL DEFAULT '',
  to_number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ringing',
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Сайты, которые обслуживают Quant, Веб и КЦ. phones — номера через запятую.
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  phones TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Кто какой сайт ведёт.
CREATE TABLE IF NOT EXISTS user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

-- База клиентов. phone10 — последние 10 цифр номера (по ним узнаём клиента). owner_id — оператор клиента:
-- тот, на чей номер (сайта) клиент дозвонился первым, или тот, кто создал его первую заявку.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  phone10 TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_number TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Номера телефонии и их операторы: клиент, позвонивший на этот номер, закрепляется за оператором,
-- а звонок переадресуется на личный телефон оператора (users.phone).
CREATE TABLE IF NOT EXISTS lines (
  number10 TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  forward_to TEXT NOT NULL DEFAULT ''
);

-- Входящие SMS на номера телефонии.
CREATE TABLE IF NOT EXISTS sms (
  id INTEGER PRIMARY KEY,
  from_number TEXT NOT NULL DEFAULT '',
  to_number TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS orders_driver ON orders (driver_id, status);
CREATE INDEX IF NOT EXISTS orders_status ON orders (status, arrive_at)
`;

// Учётная запись Quant создаётся при первом запуске. В коде хранится только хэш пароля (PBKDF2-SHA256), не сам пароль.
const QUANT_LOGIN = 'Quant';
const QUANT_HASH = 'pbkdf2$100000$59c06a7bd99276dc6ee4cace1b022b78$e79a0b8c3de297e64360681ee29a6f624c3d56482409661cd80fd23c5dc26bdd';

const PBKDF2_ITERATIONS = 100000;

let D1 = null;
let ready = null;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(hash)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !salt || !hash) return false;
  const test = new Uint8Array(await pbkdf2(password, unhex(salt), Number(iterations)));
  const expected = unhex(hash);
  if (test.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < test.length; i++) diff |= test[i] ^ expected[i];
  return diff === 0;
}

const prep = (sql, ...params) => D1.prepare(sql).bind(...params.map((p) => (p === undefined ? null : p)));

async function all(sql, ...params) { return (await prep(sql, ...params).all()).results; }
async function get(sql, ...params) { return (await prep(sql, ...params).first()) || undefined; }
async function run(sql, ...params) {
  const { meta } = await prep(sql, ...params).run();
  return { lastInsertRowid: meta.last_row_id, changes: meta.changes };
}

async function init() {
  const statements = SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean).map((s) => D1.prepare(s));
  await D1.batch(statements);
  if (!(await get('SELECT id FROM users WHERE login = ?', QUANT_LOGIN))) {
    await run("INSERT INTO users (login, password_hash, role, first_name) VALUES (?, ?, 'quant', 'Quant')", QUANT_LOGIN, QUANT_HASH);
  }
  await migrate();
  // Один раз: номера Quo (OpenPhone) Quant — Snow Cleaning (365) 360-8470 и (437) 535-2069. Дальше их меняют в «Звонки» → «Номера и операторы».
  if (!(await get("SELECT 1 AS ok FROM settings WHERE key = 'seed_quant_lines'"))) {
    for (const number of ['+13653608470', '+14375352069']) {
      await run(`INSERT INTO lines (number10, number, user_id) SELECT ?, ?, id FROM users WHERE login = ?
                 ON CONFLICT (number10) DO UPDATE SET user_id = excluded.user_id`, number.slice(-10), number, QUANT_LOGIN);
    }
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('seed_quant_lines', '1')");
  }
}

// Изменения схемы для баз, созданных раньше.
async function migrate() {
  // Все проверки одним обращением к базе, чтобы первый запрос после деплоя был быстрее.
  const [users, orders, calls] = (await D1.batch(['users', 'orders', 'calls'].map((t) => D1.prepare(`PRAGMA table_info(${t})`))))
    .map((r) => r.results.map((c) => c.name));
  // В сети / не в сети: сотрудник сам переключает ползунок в меню.
  const userColumns = users;
  if (!userColumns.includes('online')) await run('ALTER TABLE users ADD COLUMN online INTEGER NOT NULL DEFAULT 0');
  // Сколько и как клиент заплатил на самом деле (водитель отмечает при закрытии заявки).
  const orderColumns = orders;
  if (!orderColumns.includes('paid_amount')) await run('ALTER TABLE orders ADD COLUMN paid_amount REAL');
  if (!orderColumns.includes('paid_method')) await run('ALTER TABLE orders ADD COLUMN paid_method TEXT');
  // Наличные по заявке сданы (Quant отмечает в профиле водителя).
  if (!orderColumns.includes('settled_at')) await run('ALTER TABLE orders ADD COLUMN settled_at TEXT');
  if (!orderColumns.includes('settled_by')) await run('ALTER TABLE orders ADD COLUMN settled_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // Клиент заявки и звонка (база клиентов).
  if (!orderColumns.includes('client_id')) await run('ALTER TABLE orders ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL');
  const callColumns = calls;
  if (!callColumns.includes('client_id')) await run('ALTER TABLE calls ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL');
  // Заявки с сайтов (форма на сайте → «Звонки»).
  for (const col of ['source', 'lead_name', 'lead_address', 'note']) {
    if (!callColumns.includes(col)) await run(`ALTER TABLE calls ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  // Режим «принять код»: запись звонка и её расшифровка.
  if (!callColumns.includes('recording_url')) await run("ALTER TABLE calls ADD COLUMN recording_url TEXT NOT NULL DEFAULT ''");
  if (!callColumns.includes('transcript')) await run("ALTER TABLE calls ADD COLUMN transcript TEXT NOT NULL DEFAULT ''");
  // Куда переадресовать звонок на этот номер (если пусто — на личный телефон оператора).
  const lineColumns = (await all('PRAGMA table_info(lines)')).map((c) => c.name);
  if (!lineColumns.includes('forward_to')) await run("ALTER TABLE lines ADD COLUMN forward_to TEXT NOT NULL DEFAULT ''");
}

// Вызывается в начале каждого запроса.
async function connect(env) {
  if (!env.DB) throw new Error('Не подключена база D1 (binding DB). См. README.');
  D1 = env.DB;
  if (!ready) ready = init().catch((err) => { ready = null; throw err; });
  await ready;
}

module.exports = { connect, all, get, run, prep, hashPassword, verifyPassword, SCHEMA };
