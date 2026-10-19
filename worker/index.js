// Catálogo Marqueza — Worker de Cloudflare
// - Sirve la página (archivos estáticos del repositorio)
// - /api/telegram : recibe lo que se envía al bot y publica el producto
// - /api/productos: lista de productos publicados por Telegram (la página la lee)
// - /api/img/:id  : fotos de esos productos
// - /api/setup    : conecta el bot de Telegram con este Worker (se abre una sola vez)
//
// Necesita: base de datos D1 enlazada como DB y el secreto TELEGRAM_TOKEN.

import { parseCaption, PLANTILLA, NOMBRE_CAT, plantillaDe } from './parse.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, ts INTEGER, cat TEXT, name TEXT, descr TEXT, price INTEGER, unit TEXT, mayor INTEGER, detal INTEGER, sub TEXT, imgs TEXT, chat_id INTEGER)`,
  `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data BLOB, type TEXT)`,
  `CREATE TABLE IF NOT EXISTS msgmap (chat_id INTEGER, msg_id INTEGER, product_id TEXT, PRIMARY KEY (chat_id, msg_id))`,
  `CREATE TABLE IF NOT EXISTS pending (group_id TEXT PRIMARY KEY, chat_id INTEGER, caption TEXT, last INTEGER, done INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS drafts (chat_id INTEGER PRIMARY KEY, step TEXT, data TEXT, files TEXT, msgs TEXT, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS pending_photos (group_id TEXT, msg_id INTEGER, file_id TEXT, PRIMARY KEY (group_id, msg_id))`
];
let schemaListo = false;
async function asegurarTablas(env) {
  if (schemaListo) return;
  await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
  schemaListo = true;
}

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

async function secretoWebhook(env) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('marqueza:' + env.TELEGRAM_TOKEN));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function tg(env, metodo, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${metodo}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
const responder = (env, chatId, texto, replyTo) =>
  tg(env, 'sendMessage', { chat_id: chatId, text: texto, reply_to_message_id: replyTo, allow_sending_without_reply: true });

const fmt = n => '$' + Number(n).toLocaleString('es-CO');

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/productos') return await listar(env);
      if (p.startsWith('/api/img/')) return await imagen(env, p.slice(9), request, ctx);
      if (p === '/api/telegram' && request.method === 'POST') return await webhook(request, env, ctx);
      if (p === '/api/setup') return await setup(env, url);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
    return env.ASSETS.fetch(request);
  }
};

async function setup(env, url) {
  if (!env.TELEGRAM_TOKEN) return json({ ok: false, error: 'Falta el secreto TELEGRAM_TOKEN en Cloudflare' }, 400);
  await asegurarTablas(env);
  const hook = await tg(env, 'setWebhook', {
    url: `${url.origin}/api/telegram`,
    secret_token: await secretoWebhook(env),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });
  await tg(env, 'setMyDescription', { description: 'Bot del catálogo de Marqueza Accesorios. Envía la foto del producto y te pregunto los datos para publicarlo en la web.' });
  await tg(env, 'setMyCommands', { commands: [
    { command: 'nuevo', description: 'Publicar un producto (paso a paso)' },
    { command: 'cancelar', description: 'Cancelar el producto en curso' },
    { command: 'accesorios', description: 'Plantilla rápida: Accesorios' },
    { command: 'bolsos', description: 'Plantilla rápida: Bolsos' },
    { command: 'maquillaje', description: 'Plantilla rápida: Maquillaje' },
    { command: 'rodio', description: 'Plantilla rápida: Rodio' },
    { command: 'perfumeria', description: 'Plantilla rápida: Perfumería' }
  ] });
  const me = await tg(env, 'getMe', {});
  return json({ ok: hook.ok, webhook: hook.description, bot: me.result && me.result.username });
}

async function listar(env) {
  await asegurarTablas(env);
  const { results } = await env.DB.prepare('SELECT id, ts, cat, name, descr, price, unit, mayor, detal, sub, imgs FROM products ORDER BY ts DESC').all();
  const productos = results.map(r => {
    const o = { id: r.id, cat: r.cat, name: r.name, desc: r.descr || '', unit: r.unit || '', imgs: JSON.parse(r.imgs).map(i => '/api/img/' + i), nuevo: true, ts: r.ts };
    if (r.mayor != null) { o.mayor = r.mayor; o.detal = r.detal; if (r.sub) o.sub = r.sub; } else o.price = r.price;
    return o;
  });
  return json(productos, 200, { 'cache-control': 'public, max-age=5' });
}

async function imagen(env, id, request, ctx) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const row = await env.DB.prepare('SELECT data, type FROM images WHERE id = ?').bind(id).first();
  if (!row) return new Response('No encontrada', { status: 404 });
  const res = new Response(new Uint8Array(row.data), { headers: { 'content-type': row.type || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

async function webhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await secretoWebhook(env)) {
    return new Response('forbidden', { status: 403 });
  }
  await asegurarTablas(env);
  const update = await request.json();
  if (update.callback_query) { ctx.waitUntil(boton(env, update.callback_query)); return json({ ok: true }); }
  const m = update.message;
  if (!m) return json({ ok: true });
  const chatId = m.chat.id;

  // Texto sin foto
  if (!m.photo && !esImagenDocumento(m)) {
    const original = (m.text || '').trim();
    const t = original.toLowerCase();
    const cmd = t.startsWith('/') ? t.slice(1).split(/[@\s]/)[0] : '';
    const CMDS = { accesorios: 'accesorios', bolsos: 'bolsos', maquillaje: 'maquillaje', rodio: 'rodio', perfumeria: 'perfumeria', perfumes: 'perfumeria' };
    if (t === 'borrar' || t === 'eliminar') {
      ctx.waitUntil(borrar(env, chatId, m));
    } else if (cmd === 'cancelar') {
      ctx.waitUntil((async () => { await env.DB.prepare('DELETE FROM drafts WHERE chat_id = ?').bind(chatId).run(); await responder(env, chatId, '❌ Cancelado. Cuando quieras, envía la foto del siguiente producto.'); })());
    } else if (cmd === 'nuevo' || cmd === 'start') {
      ctx.waitUntil(responder(env, chatId, '📸 Envía la foto del producto (o varias fotos juntas en un álbum). Luego te pregunto los datos.'));
    } else if (CMDS[cmd]) {
      ctx.waitUntil(enviarPlantilla(env, chatId, CMDS[cmd]));
    } else if (original) {
      ctx.waitUntil(textoBorrador(env, chatId, original, m));
    }
    return json({ ok: true });
  }

  const fileId = archivo(m);
  if (m.media_group_id) {
    // Álbum: llegan varias fotos por separado; se juntan en un solo producto
    const g = String(m.media_group_id);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO pending (group_id, chat_id, caption, last) VALUES (?, ?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET last = excluded.last, caption = COALESCE(excluded.caption, pending.caption)')
        .bind(g, chatId, m.caption || null, Date.now()),
      env.DB.prepare('INSERT OR IGNORE INTO pending_photos (group_id, msg_id, file_id) VALUES (?, ?, ?)').bind(g, m.message_id, fileId)
    ]);
    ctx.waitUntil((async () => {
      await new Promise(r => setTimeout(r, 4500));
      const row = await env.DB.prepare('SELECT * FROM pending WHERE group_id = ?').bind(g).first();
      if (!row || row.done || Date.now() - row.last < 4000) return;
      const lock = await env.DB.prepare('UPDATE pending SET done = 1 WHERE group_id = ? AND done = 0').bind(g).run();
      if (!lock.meta || lock.meta.changes !== 1) return;
      const { results } = await env.DB.prepare('SELECT msg_id, file_id FROM pending_photos WHERE group_id = ? ORDER BY msg_id').bind(g).all();
      await recibirFotos(env, chatId, row.caption, results.map(r => r.file_id), results.map(r => r.msg_id));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM pending_photos WHERE group_id = ?').bind(g),
        env.DB.prepare('DELETE FROM pending WHERE group_id = ?').bind(g)
      ]);
    })());
  } else {
    ctx.waitUntil(recibirFotos(env, chatId, m.caption, [fileId], [m.message_id]));
  }
  return json({ ok: true });
}

// Fotos recibidas: con plantilla llena se publican directo; sin texto empieza el paso a paso con botones
async function recibirFotos(env, chatId, caption, fileIds, msgIds) {
  if (caption && caption.trim()) {
    const r = parseCaption(caption);
    if (r.ok) return publicarProducto(env, chatId, r.producto, fileIds, msgIds);
    await responder(env, chatId, '⚠️ No pude leer el texto de la foto:\n• ' + r.errores.join('\n• ') + '\n\nNo te preocupes, te pregunto los datos paso a paso 👇', msgIds[0]);
  }
  const d = { step: 'cat', data: {}, files: fileIds, msgs: msgIds };
  await guardarBorrador(env, chatId, d);
  await tg(env, 'sendMessage', { chat_id: chatId, reply_to_message_id: msgIds[0], allow_sending_without_reply: true,
    text: `📸 Recibí ${fileIds.length > 1 ? fileIds.length + ' fotos' : 'la foto'}.\n\n1️⃣ ¿En qué categoría va?`,
    reply_markup: { inline_keyboard: [
      [{ text: 'Accesorios', callback_data: 'cat:accesorios' }, { text: 'Bolsos', callback_data: 'cat:bolsos' }],
      [{ text: 'Maquillaje', callback_data: 'cat:maquillaje' }, { text: 'Rodio y Covergold', callback_data: 'cat:rodio' }],
      [{ text: 'Perfumería', callback_data: 'cat:perfumeria' }],
      [{ text: '❌ Cancelar', callback_data: 'x' }]
    ] } });
}

async function leerBorrador(env, chatId) {
  const row = await env.DB.prepare('SELECT * FROM drafts WHERE chat_id = ?').bind(chatId).first();
  if (!row) return null;
  if (Date.now() - row.updated > 6 * 3600e3) { await env.DB.prepare('DELETE FROM drafts WHERE chat_id = ?').bind(chatId).run(); return null; }
  return { step: row.step, data: JSON.parse(row.data), files: JSON.parse(row.files), msgs: JSON.parse(row.msgs) };
}
async function guardarBorrador(env, chatId, d) {
  await env.DB.prepare('INSERT OR REPLACE INTO drafts (chat_id, step, data, files, msgs, updated) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(chatId, d.step, JSON.stringify(d.data), JSON.stringify(d.files), JSON.stringify(d.msgs), Date.now()).run();
}

const BTN_CANCELAR = [{ text: '❌ Cancelar', callback_data: 'x' }];
async function preguntar(env, chatId, d) {
  const n = d.data.cat === 'perfumeria' ? { titulo: 3, desc: 4, mayor: 5, detal: 6 } : { titulo: 2, desc: 3, ptipo: 4, precio: 5, mayor: 5, detal: 6 };
  const num = k => ['', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'][n[k]] || '▪️';
  const q = {
    tipo: { text: '2️⃣ ¿Es de dama, hombre o unisex?', kb: [[{ text: 'Dama', callback_data: 'tipo:Dama' }, { text: 'Hombre', callback_data: 'tipo:Hombre' }, { text: 'Unisex', callback_data: 'tipo:Unisex' }], BTN_CANCELAR] },
    titulo: { text: `${num('titulo')} Escribe el título del producto.\nEj: Set de collar, anillo y 2 pinzas`, kb: [BTN_CANCELAR] },
    desc: { text: `${num('desc')} Escribe la descripción (medidas, colores, ml…).\nSi no tiene, toca Omitir.`, kb: [[{ text: 'Omitir ⏭️', callback_data: 'desc:-' }], BTN_CANCELAR] },
    ptipo: { text: `${num('ptipo')} ¿Cómo es el precio?`, kb: [[{ text: 'Un solo precio', callback_data: 'ptipo:unico' }], [{ text: 'Al mayor y al detal', callback_data: 'ptipo:md' }], BTN_CANCELAR] },
    precio: { text: `${num('precio')} Escribe el precio y, si quieres, cómo se vende.\nEj: 5.000 cada set · 12.000 c/u · 800 la bolsa`, kb: [BTN_CANCELAR] },
    mayor: { text: `${num('mayor')} Escribe el precio AL MAYOR (cada uno).\nEj: 40.000`, kb: [BTN_CANCELAR] },
    detal: { text: `${num('detal')} Escribe el precio AL DETAL (cada uno).\nEj: 55.000`, kb: [BTN_CANCELAR] }
  }[d.step];
  await tg(env, 'sendMessage', { chat_id: chatId, text: q.text, reply_markup: { inline_keyboard: q.kb } });
}

function productoDe(d) {
  const x = d.data;
  return { cat: x.cat, name: x.name, desc: x.desc || '', sub: x.cat === 'perfumeria' ? (x.sub || null) : null,
    price: x.price ?? null, unit: x.unit || '', mayor: x.mayor ?? null, detal: x.detal ?? null };
}
function precioTexto(p) {
  return p.mayor != null ? `Al mayor ${fmt(p.mayor)} c/u · Al detal ${fmt(p.detal)} c/u` : `${fmt(p.price)}${p.unit ? ' ' + p.unit : ''}`;
}
async function resumen(env, chatId, d) {
  const p = productoDe(d);
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML',
    text: `👀 <b>Revisa antes de publicar</b>\n\n<b>${escHtml(p.name)}</b>\n${p.desc ? escHtml(p.desc) + '\n' : ''}Categoría: ${NOMBRE_CAT[p.cat]}${p.sub ? ' · ' + p.sub : ''}\nPrecio: ${precioTexto(p)}\nFotos: ${d.files.length}`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Publicar', callback_data: 'pub' }], [{ text: '✏️ Empezar de nuevo', callback_data: 'redo' }, { text: '❌ Cancelar', callback_data: 'x' }]] } });
}

function leerPrecio(txt) {
  const m = txt.match(/\$?\s*(\d[\d.,]*)\s*(mil\b)?/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/[.,\s]/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const valor = m[2] && n < 1000 ? n * 1000 : n;
  const resto = txt.slice(txt.indexOf(m[0]) + m[0].length).replace(/^[\s.:,-]+|[\s.]+$/g, '').replace(/^mil\b\s*/i, '');
  return { n: valor, unit: resto.toLowerCase() };
}

async function textoBorrador(env, chatId, texto, m) {
  const d = await leerBorrador(env, chatId);
  if (!d || ['cat', 'tipo', 'ptipo'].includes(d.step) || d.step === 'confirm') {
    if (d && d.step !== 'confirm') { await responder(env, chatId, 'Toca uno de los botones de arriba 👆 (o /cancelar).', m.message_id); return; }
    if (d && d.step === 'confirm') { await responder(env, chatId, 'Toca ✅ Publicar o ❌ Cancelar en el resumen de arriba 👆', m.message_id); return; }
    return ayuda(env, chatId);
  }
  const limpio = texto.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
  const oracion = s => { const l = s.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü]/g, ''); return l.length > 3 && l === l.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s; };
  if (d.step === 'titulo') {
    if (limpio.length < 2) return responder(env, chatId, 'Escribe un título un poco más largo.', m.message_id);
    const mayus = (() => { const l = limpio.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü]/g, ''); return l.length > 3 && l === l.toUpperCase(); })();
    const titulo = d.data.cat === 'perfumeria' && mayus ? limpio.toLowerCase().replace(/(^|[\s'’(-])(\p{L})/gu, (x, a, b) => a + b.toUpperCase()) : oracion(limpio);
    d.data.name = titulo.slice(0, 140); d.step = 'desc';
  } else if (d.step === 'desc') {
    d.data.desc = oracion(limpio).slice(0, 600);
    d.step = d.data.cat === 'perfumeria' ? 'mayor' : 'ptipo';
  } else if (d.step === 'precio' || d.step === 'mayor' || d.step === 'detal') {
    const p = leerPrecio(limpio);
    if (!p) return responder(env, chatId, 'No entendí el precio. Escríbelo con números, por ejemplo: 5.000', m.message_id);
    if (d.step === 'precio') { d.data.price = p.n; d.data.unit = p.unit; d.step = 'confirm'; }
    else if (d.step === 'mayor') { d.data.mayor = p.n; d.step = 'detal'; }
    else { d.data.detal = p.n; d.step = 'confirm'; }
  }
  await guardarBorrador(env, chatId, d);
  if (d.step === 'confirm') await resumen(env, chatId, d); else await preguntar(env, chatId, d);
}

async function boton(env, cq) {
  const chatId = cq.message.chat.id;
  const [accion, valor] = cq.data.split(':');
  const d = await leerBorrador(env, chatId);
  const marcar = async elegido => {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✔️ ' + elegido, callback_data: 'noop' }]] } });
  };
  if (accion === 'noop') return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!d) { await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Este producto ya se cerró. Envía la foto de nuevo.', show_alert: true }); return; }
  if (accion === 'x') {
    await env.DB.prepare('DELETE FROM drafts WHERE chat_id = ?').bind(chatId).run();
    await marcar('Cancelado');
    return responder(env, chatId, '❌ Cancelado. Cuando quieras, envía la foto del siguiente producto.');
  }
  if (accion === 'cat' && d.step === 'cat') {
    d.data.cat = valor; await marcar(NOMBRE_CAT[valor]);
    d.step = valor === 'perfumeria' ? 'tipo' : 'titulo';
  } else if (accion === 'tipo' && d.step === 'tipo') {
    d.data.sub = valor; await marcar(valor); d.step = 'titulo';
  } else if (accion === 'desc' && d.step === 'desc') {
    d.data.desc = ''; await marcar('Sin descripción');
    d.step = d.data.cat === 'perfumeria' ? 'mayor' : 'ptipo';
  } else if (accion === 'ptipo' && d.step === 'ptipo') {
    await marcar(valor === 'md' ? 'Al mayor y al detal' : 'Un solo precio');
    d.step = valor === 'md' ? 'mayor' : 'precio';
  } else if (accion === 'redo' && d.step === 'confirm') {
    await marcar('Empezar de nuevo');
    return recibirFotos(env, chatId, null, d.files, d.msgs);
  } else if (accion === 'pub' && d.step === 'confirm') {
    await marcar('Publicando…');
    await env.DB.prepare('DELETE FROM drafts WHERE chat_id = ?').bind(chatId).run();
    return publicarProducto(env, chatId, productoDe(d), d.files, d.msgs);
  } else {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Ese paso ya pasó. Sigue con la última pregunta 👇' });
  }
  await guardarBorrador(env, chatId, d);
  await preguntar(env, chatId, d);
}

function esImagenDocumento(m) {
  return m.document && /^image\//.test(m.document.mime_type || '');
}
function archivo(m) {
  if (m.photo) {
    // la versión más grande que no pase de 1280 px (liviana para la web)
    const tallas = [...m.photo].sort((a, b) => a.width * a.height - b.width * b.height);
    const ok = tallas.filter(t => Math.max(t.width, t.height) <= 1280);
    return (ok.length ? ok[ok.length - 1] : tallas[0]).file_id;
  }
  return m.document.file_id;
}

const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function enviarPlantilla(env, chatId, cat) {
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML',
    text: `📋 Plantilla de <b>${NOMBRE_CAT[cat]}</b> — toca el recuadro para copiarla:` });
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `<code>${escHtml(plantillaDe(cat))}</code>` });
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text:
    '1️⃣ Elige la foto (o varias) del producto\n2️⃣ Pega la plantilla en el pie de foto y llena los datos\n3️⃣ Envía\n\n' +
    (cat === 'perfumeria' ? '• Llena Precio mayor y Precio detal.\n• En Tipo deja solo una opción: Dama, Hombre o Unisex.\n'
      : '• Si tiene un solo precio, llena solo <b>Precio</b> (ej: 5.000 cada set).\n• Si tiene precio al mayor y al detal, llena esos dos y deja Precio vacío.\n') +
    '• Lo que no apliques déjalo vacío.' });
}
async function ayuda(env, chatId) {
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text:
    '👋 Hola. Para publicar en el catálogo:\n\n📸 Envía la foto del producto (o varias en un álbum) y te pregunto los datos con botones.\n\nSi prefieres llenar todo de una vez, usa la plantilla rápida: /accesorios /bolsos /maquillaje /rodio /perfumeria\n\nPara quitar un producto de la web: responde a su mensaje ✅ Publicado con la palabra <b>borrar</b>.' });
}

async function publicarProducto(env, chatId, prod, fileIds, msgIds) {
  const imgs = [];
  for (const fid of fileIds.slice(0, 8)) {
    const info = await tg(env, 'getFile', { file_id: fid });
    if (!info.ok) continue;
    if (info.result.file_size > 1900000) {
      await responder(env, chatId, '⚠️ Una de las imágenes es muy pesada. Envíala como foto (no como archivo).', msgIds[0]);
      return;
    }
    const bin = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${info.result.file_path}`);
    const data = await bin.arrayBuffer();
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const tipo = /\.png$/i.test(info.result.file_path) ? 'image/png' : /\.webp$/i.test(info.result.file_path) ? 'image/webp' : 'image/jpeg';
    await env.DB.prepare('INSERT INTO images (id, data, type) VALUES (?, ?, ?)').bind(id, data, tipo).run();
    imgs.push(id);
  }
  if (!imgs.length) {
    await responder(env, chatId, '⚠️ No pude descargar la foto. Intenta enviarla de nuevo.', msgIds[0]);
    return;
  }
  const id = 'tg_' + Date.now().toString(36);
  await env.DB.prepare('INSERT INTO products (id, ts, cat, name, descr, price, unit, mayor, detal, sub, imgs, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, Date.now(), prod.cat, prod.name, prod.desc, prod.price, prod.unit, prod.mayor, prod.detal, prod.sub, JSON.stringify(imgs), chatId).run();

  const precio = precioTexto(prod);
  const conf = await responder(env, chatId,
    `✅ Publicado en el catálogo\n\n${prod.name}\nCategoría: ${NOMBRE_CAT[prod.cat]}\nPrecio: ${precio}\nFotos: ${imgs.length}\n\nPara quitarlo, responde a este mensaje con: borrar`, msgIds[0]);
  const ids = [...msgIds];
  if (conf.ok) ids.push(conf.result.message_id);
  await env.DB.batch(ids.map(mid => env.DB.prepare('INSERT OR REPLACE INTO msgmap (chat_id, msg_id, product_id) VALUES (?, ?, ?)').bind(chatId, mid, id)));
}

async function borrar(env, chatId, m) {
  if (!m.reply_to_message) {
    await responder(env, chatId, 'Para borrar, mantén presionado el mensaje del producto (o el ✅ Publicado), toca Responder y escribe: borrar', m.message_id);
    return;
  }
  const map = await env.DB.prepare('SELECT product_id FROM msgmap WHERE chat_id = ? AND msg_id = ?').bind(chatId, m.reply_to_message.message_id).first();
  if (!map) { await responder(env, chatId, 'No encontré un producto publicado en ese mensaje.', m.message_id); return; }
  const prod = await env.DB.prepare('SELECT name, imgs FROM products WHERE id = ?').bind(map.product_id).first();
  if (!prod) { await responder(env, chatId, 'Ese producto ya estaba borrado.', m.message_id); return; }
  const imgs = JSON.parse(prod.imgs);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM products WHERE id = ?').bind(map.product_id),
    env.DB.prepare('DELETE FROM msgmap WHERE product_id = ?').bind(map.product_id),
    ...imgs.map(i => env.DB.prepare('DELETE FROM images WHERE id = ?').bind(i))
  ]);
  await responder(env, chatId, `🗑️ Borrado del catálogo: ${prod.name}`, m.message_id);
}
