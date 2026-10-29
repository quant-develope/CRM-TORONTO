// Небольшой роутер в стиле Express поверх fetch() для Cloudflare Workers.

// Разбор формы с ключами вида items[0][name] в вложенные объекты.
function parseForm(params) {
  const out = {};
  for (const [key, value] of params) {
    const parts = key.split(/\[|\]\[|\]/).filter((p, i) => i === 0 || p !== '');
    let node = out;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        if (part in node) node[part] = [].concat(node[part], value);
        else node[part] = value;
      } else {
        if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
        node = node[part];
      }
    });
  }
  return out;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

class Response_ {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    this.body = null;
    this.done = false;
  }

  status(code) { this.statusCode = code; return this; }

  send(body) { this.body = String(body); this.done = true; return this; }

  // Файл: байты, тип и имя для скачивания.
  file(bytes, type, filename) {
    this.headers.set('content-type', type);
    this.headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    this.headers.set('cache-control', 'private, no-store');
    this.body = bytes;
    this.done = true;
    return this;
  }

  redirect(location) {
    this.statusCode = 302;
    this.headers.set('location', location);
    this.done = true;
    return this;
  }

  cookie(name, value, { maxAge, httpOnly = true, secure = true, sameSite = 'Lax' } = {}) {
    let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSite}`;
    if (httpOnly) c += '; HttpOnly';
    if (secure) c += '; Secure';
    if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
    this.headers.append('set-cookie', c);
    return this;
  }

  clearCookie(name) { return this.cookie(name, '', { maxAge: 0 }); }

  // Готовый Response (например, поток файла из R2).
  raw(response) { this.response = response; this.done = true; return this; }

  toResponse() { return this.response || new Response(this.body, { status: this.statusCode, headers: this.headers }); }
}

function compile(path, prefix) {
  const keys = [];
  const src = path.replace(/\/$/, '').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  const re = new RegExp(`^${src}${prefix ? '(?=/|$)' : '/?$'}`);
  return { re, keys };
}

class Router {
  constructor() { this.layers = []; }

  use(pathOrFn, maybe) {
    const [path, fn] = typeof pathOrFn === 'string' ? [pathOrFn, maybe] : ['', pathOrFn];
    this.layers.push({ method: null, ...compile(path, true), fn, mount: fn instanceof Router });
    return this;
  }

  get(path, ...fns) { return this.add('GET', path, fns); }

  post(path, ...fns) { return this.add('POST', path, fns); }

  add(method, path, fns) {
    for (const fn of fns) this.layers.push({ method, ...compile(path, false), fn });
    return this;
  }

  // Проходит по слоям по очереди, как Express: middleware вызывает next(), чтобы идти дальше.
  async handle(req, res, path = req.path, base = '') {
    for (const layer of this.layers) {
      if (res.done) return true;
      if (layer.method && layer.method !== req.method) continue;
      const m = layer.re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(layer.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (layer.mount) {
        const rest = path.slice(m[0].length) || '/';
        const prevBase = req.baseUrl;
        req.baseUrl = base + m[0];
        req.path = rest;
        if (await layer.fn.handle(req, res, rest, req.baseUrl)) return true;
        req.baseUrl = prevBase;
        req.path = path;
        continue;
      }
      req.params = params;
      let called = false;
      await layer.fn(req, res, () => { called = true; });
      if (res.done || !called) return true;
    }
    return res.done;
  }
}

async function makeRequest(request) {
  const url = new URL(request.url);
  const req = {
    method: request.method,
    url,
    path: url.pathname,
    baseUrl: '',
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(request.headers),
    cookies: parseCookies(request.headers.get('cookie') || ''),
    ip: request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '',
    body: {},
    params: {},
    raw: request, // тело не форм (например, загрузка файла потоком) читается отсюда
  };
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/x-www-form-urlencoded')) {
      req.body = parseForm(new URLSearchParams(await request.text()));
    } else if (type.includes('multipart/form-data')) {
      req.body = parseForm(await request.formData());
    }
  }
  return req;
}

module.exports = { Router, Response_, makeRequest, parseForm };
