// Panel de administrador: borrar productos del catálogo (con papelera para restaurar).
// Necesita el secreto ADMIN_PASSWORD en Cloudflare. La sesión dura 12 horas.

const COOKIE = 'mz_admin';
const DURACION = 12 * 3600; // segundos
const MAX_FALLOS = 8;        // intentos fallidos permitidos…
const VENTANA = 15 * 60e3;   // …cada 15 minutos por dirección IP

export const SCHEMA_ADMIN = [
  `CREATE TABLE IF NOT EXISTS hidden (pid TEXT PRIMARY KEY, ts INTEGER, name TEXT, cat TEXT, img TEXT, perm INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS login_fails (ip TEXT, ts INTEGER)`
];

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

const enc = new TextEncoder();
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode('mz-admin|' + env.ADMIN_PASSWORD + '|' + (env.TELEGRAM_TOKEN || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function igual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function leerCookie(request) {
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}
async function sesionValida(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const v = leerCookie(request);
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Date.now() / 1000 > Number(exp)) return false;
  return igual(sig, await hmac(env, 'sesion:' + exp));
}

const ID_OK = /^(o_[a-z]+_[a-z0-9]+|tg_[a-z0-9]+)$/;
const txt = (s, n) => String(s == null ? '' : s).slice(0, n);

export async function rutaAdmin(request, env, url) {
  const p = url.pathname;
  const metodo = request.method;

  if (p === '/api/admin/login' && metodo === 'POST') {
    if (!env.ADMIN_PASSWORD) return json({ ok: false, error: 'Falta configurar la contraseña (ADMIN_PASSWORD) en Cloudflare.' }, 503);
    const ip = request.headers.get('cf-connecting-ip') || 'x';
    const desde = Date.now() - VENTANA;
    const f = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE ip = ? AND ts > ?').bind(ip, desde).first();
    if (f && f.n >= MAX_FALLOS) return json({ ok: false, error: 'Demasiados intentos. Espera 15 minutos.' }, 429);
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const ok = igual(await hmac(env, 'pw:' + String(body.password || '')), await hmac(env, 'pw:' + env.ADMIN_PASSWORD));
    if (!ok) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO login_fails (ip, ts) VALUES (?, ?)').bind(ip, Date.now()),
        env.DB.prepare('DELETE FROM login_fails WHERE ts < ?').bind(Date.now() - 24 * 3600e3)
      ]);
      return json({ ok: false, error: 'Contraseña incorrecta.' }, 401);
    }
    await env.DB.prepare('DELETE FROM login_fails WHERE ip = ?').bind(ip).run();
    const exp = Math.floor(Date.now() / 1000) + DURACION;
    const valor = exp + '.' + await hmac(env, 'sesion:' + exp);
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DURACION}` });
  }

  if (p === '/api/admin/logout' && metodo === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  // Todo lo demás exige sesión iniciada
  if (!await sesionValida(request, env)) return json({ ok: false, error: 'Sesión vencida. Vuelve a entrar.', configurado: !!env.ADMIN_PASSWORD }, 401);
  if (p === '/api/admin/yo') return json({ ok: true });

  if (p === '/api/admin/papelera' && metodo === 'GET') {
    const { results } = await env.DB.prepare('SELECT pid, ts, name, cat, img FROM hidden WHERE perm = 0 ORDER BY ts DESC').all();
    return json({ ok: true, items: results });
  }

  // Las acciones que cambian datos llegan solo desde la página (encabezado propio + JSON)
  if (metodo !== 'POST' || request.headers.get('x-admin') !== '1') return json({ ok: false, error: 'Solicitud no válida.' }, 400);
  let body = {};
  try { body = await request.json(); } catch (_) {}

  if (p === '/api/admin/borrar') {
    const items = (Array.isArray(body.items) ? body.items : []).filter(it => it && ID_OK.test(it.id)).slice(0, 1000);
    if (!items.length) return json({ ok: false, error: 'No llegó ningún producto.' }, 400);
    const ahora = Date.now();
    const stm = [];
    for (const it of items) {
      let name = txt(it.name, 200), cat = txt(it.cat, 20), img = txt(it.img, 200);
      if (it.id.startsWith('tg_')) {
        const r = await env.DB.prepare('SELECT name, cat, imgs FROM products WHERE id = ?').bind(it.id).first();
        if (!r) continue;
        name = r.name; cat = r.cat; img = '/api/img/' + JSON.parse(r.imgs)[0];
      } else if (!/^img\/[a-z]+_[a-z0-9]+\.webp$/.test(img)) img = '';
      stm.push(env.DB.prepare('INSERT OR REPLACE INTO hidden (pid, ts, name, cat, img, perm) VALUES (?, ?, ?, ?, ?, 0)').bind(it.id, ahora, name, cat, img));
    }
    for (let i = 0; i < stm.length; i += 100) await env.DB.batch(stm.slice(i, i + 100));
    return json({ ok: true, borrados: stm.length });
  }

  const ids = (Array.isArray(body.ids) ? body.ids : []).filter(id => ID_OK.test(id)).slice(0, 1000);
  if (!ids.length) return json({ ok: false, error: 'No llegó ningún producto.' }, 400);

  if (p === '/api/admin/restaurar') {
    const stm = ids.map(id => env.DB.prepare('DELETE FROM hidden WHERE pid = ? AND perm = 0').bind(id));
    for (let i = 0; i < stm.length; i += 100) await env.DB.batch(stm.slice(i, i + 100));
    return json({ ok: true, restaurados: ids.length });
  }

  if (p === '/api/admin/vaciar') {
    const stm = [];
    for (const id of ids) {
      if (id.startsWith('tg_')) {
        const r = await env.DB.prepare('SELECT imgs FROM products WHERE id = ?').bind(id).first();
        if (r) for (const im of JSON.parse(r.imgs)) stm.push(env.DB.prepare('DELETE FROM images WHERE id = ?').bind(im));
        stm.push(env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id));
        stm.push(env.DB.prepare('DELETE FROM msgmap WHERE product_id = ?').bind(id));
        stm.push(env.DB.prepare('DELETE FROM hidden WHERE pid = ?').bind(id));
      } else {
        // Los productos del catálogo original quedan ocultos para siempre
        stm.push(env.DB.prepare('UPDATE hidden SET perm = 1 WHERE pid = ?').bind(id));
      }
    }
    for (let i = 0; i < stm.length; i += 100) await env.DB.batch(stm.slice(i, i + 100));
    return json({ ok: true, eliminados: ids.length });
  }

  return json({ ok: false, error: 'No encontrado' }, 404);
}
