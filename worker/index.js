// Catálogo Marqueza — Worker de Cloudflare
// - Sirve la página (archivos estáticos del repositorio)
// - /api/telegram : recibe lo que se envía al bot y publica el producto
// - /api/productos: lista de productos publicados por Telegram (la página la lee)
// - /api/img/:id  : fotos de esos productos
// - /api/setup    : conecta el bot de Telegram con este Worker (se abre una sola vez)
//
// Necesita: base de datos D1 enlazada como DB y el secreto TELEGRAM_TOKEN.

import { parseCaption, NOMBRE_CAT, plantillaDe } from './parse.js';

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
  await tg(env, 'setMyDescription', { description: 'Bot del catálogo de Marqueza Accesorios. Envía la foto con los datos del producto, toca la categoría y se publica en la web.' });
  await tg(env, 'setMyCommands', { commands: [
    { command: 'plantilla', description: 'Ver la plantilla para publicar' },
    { command: 'cancelar', description: 'Cancelar el producto en curso' }
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
    } else if (cmd === 'plantilla' || cmd === 'nuevo' || cmd === 'start' || CMDS[cmd]) {
      ctx.waitUntil(enviarPlantilla(env, chatId));
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

// Fotos recibidas con los datos en el texto: si falta la categoría se pide con botones
async function recibirFotos(env, chatId, caption, fileIds, msgIds) {
  const r = parseCaption(caption || '');
  if (!r.ok) {
    await tg(env, 'sendMessage', { chat_id: chatId, reply_to_message_id: msgIds[0], allow_sending_without_reply: true, parse_mode: 'HTML',
      text: '⚠️ No pude publicar:\n• ' + escHtml(r.errores.join('\n• ')) +
        '\n\nVuelve a enviar la foto y escribe los datos en el mismo mensaje (pie de foto), así:\n\n<code>' + escHtml(plantillaDe()) + '</code>' });
    return;
  }
  const prod = r.producto;
  if (prod.cat && (prod.cat !== 'perfumeria' || prod.sub)) return publicarProducto(env, chatId, prod, fileIds, msgIds);
  const d = { step: prod.cat ? 'tipo' : 'cat', data: prod, files: fileIds, msgs: msgIds };
  await guardarBorrador(env, chatId, d);
  await tg(env, 'sendMessage', { chat_id: chatId, reply_to_message_id: msgIds[0], allow_sending_without_reply: true, parse_mode: 'HTML',
    text: textoResumen(d) + '\n\n' + (d.step === 'cat' ? '👇 Toca la categoría para publicar:' : '👇 ¿Dama, hombre o unisex?'),
    reply_markup: { inline_keyboard: d.step === 'cat' ? TECLADO_CAT : TECLADO_TIPO } });
}

const TECLADO_CAT = [
  [{ text: 'Accesorios', callback_data: 'cat:accesorios' }, { text: 'Bolsos', callback_data: 'cat:bolsos' }],
  [{ text: 'Maquillaje', callback_data: 'cat:maquillaje' }, { text: 'Rodio y Covergold', callback_data: 'cat:rodio' }],
  [{ text: 'Perfumería', callback_data: 'cat:perfumeria' }],
  [{ text: '❌ Cancelar', callback_data: 'x' }]
];
const TECLADO_TIPO = [
  [{ text: 'Dama', callback_data: 'tipo:Dama' }, { text: 'Hombre', callback_data: 'tipo:Hombre' }, { text: 'Unisex', callback_data: 'tipo:Unisex' }],
  [{ text: '❌ Cancelar', callback_data: 'x' }]
];

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

function precioTexto(p) {
  return p.mayor != null ? `Al mayor ${fmt(p.mayor)} c/u · Al detal ${fmt(p.detal)} c/u` : `${fmt(p.price)}${p.unit ? ' ' + p.unit : ''}`;
}
function textoResumen(d) {
  const p = d.data;
  return `📦 <b>${escHtml(p.name)}</b>\n${p.desc ? escHtml(p.desc) + '\n' : ''}Precio: ${precioTexto(p)}\nFotos: ${d.files.length}` +
    (p.cat ? `\nCategoría: ${NOMBRE_CAT[p.cat]}` : '');
}

async function textoBorrador(env, chatId, texto, m) {
  const d = await leerBorrador(env, chatId);
  if (d) return responder(env, chatId, 'Toca uno de los botones del producto de arriba 👆 para publicarlo, o ❌ Cancelar.', m.message_id);
  return ayuda(env, chatId);
}

async function boton(env, cq) {
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const [accion, valor] = cq.data.split(':');
  if (accion === 'noop') return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const d = await leerBorrador(env, chatId);
  if (!d) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Este producto ya se publicó o se canceló. Para otro, envía la foto con los datos.', show_alert: true });
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const editar = (extra, teclado) => tg(env, 'editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
    text: textoResumen(d) + (extra ? '\n\n' + extra : ''), reply_markup: { inline_keyboard: teclado || [] } });

  if (accion === 'x') {
    await env.DB.prepare('DELETE FROM drafts WHERE chat_id = ?').bind(chatId).run();
    return editar('❌ Cancelado. No se publicó.');
  }
  if (accion === 'cat' && d.step === 'cat') {
    d.data.cat = valor;
    if (valor === 'perfumeria' && !d.data.sub) {
      d.step = 'tipo'; await guardarBorrador(env, chatId, d);
      return editar('👇 ¿Dama, hombre o unisex?', TECLADO_TIPO);
    }
    if (valor !== 'perfumeria' && d.data.sub) { d.data.desc = [d.data.desc, d.data.sub].filter(Boolean).join(' · '); d.data.sub = null; }
  } else if (accion === 'tipo' && d.step === 'tipo') {
    d.data.sub = valor;
  } else return;
  await env.DB.prepare('DELETE FROM drafts WHERE chat_id = ?').bind(chatId).run();
  await editar(`⏳ Publicando en ${NOMBRE_CAT[d.data.cat]}${d.data.sub ? ' · ' + d.data.sub : ''}…`);
  await publicarProducto(env, chatId, d.data, d.files, d.msgs);
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
async function enviarPlantilla(env, chatId) {
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text:
    '📋 <b>Cómo publicar</b>\n1️⃣ Elige la foto (o varias)\n2️⃣ En el pie de foto pega esto y llena los datos\n3️⃣ Envía y toca la categoría\n\nToca el recuadro para copiarlo 👇' });
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `<code>${escHtml(plantillaDe())}</code>` });
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text:
    '• Un solo precio: llena <b>Precio</b> (ej: 5.000 cada set) y deja vacíos mayor y detal.\n' +
    '• Precio al mayor y al detal: llena esos dos y deja Precio vacío.\n' +
    '• Descripción es opcional.\n• En perfumes, el bot te pregunta Dama / Hombre / Unisex con botones.' });
}
async function ayuda(env, chatId) {
  await enviarPlantilla(env, chatId);
}

async function publicarProducto(env, chatId, prod, fileIds, msgIds) {
  if (prod.cat === 'perfumeria' && prod.raw) {
    const l = prod.raw.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü]/g, '');
    if (l.length > 3 && l === l.toUpperCase()) prod.name = prod.raw.toLowerCase().replace(/(^|[\s'’(-])(\p{L})/gu, (x, a, b) => a + b.toUpperCase());
  }
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
