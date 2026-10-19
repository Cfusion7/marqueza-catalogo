// Lee el texto (caption) que se envía al bot con la plantilla y lo convierte en un producto.
// Plantilla:
//   #accesorios
//   TÍTULO DEL PRODUCTO
//   Descripción (opcional, una o varias líneas)
//   $5.000 cada set            ← precio único
//   Mayor $40.000 / Detal $55.000   ← perfumería (al mayor y al detal)

export const CATEGORIAS = {
  accesorios: 'accesorios', accesorio: 'accesorios',
  bolsos: 'bolsos', bolso: 'bolsos',
  maquillaje: 'maquillaje',
  rodio: 'rodio', covergold: 'rodio', joyeria: 'rodio', joyas: 'rodio',
  perfumeria: 'perfumeria', perfumes: 'perfumeria', perfume: 'perfumeria'
};
export const NOMBRE_CAT = {
  accesorios: 'Accesorios', bolsos: 'Bolsos', maquillaje: 'Maquillaje',
  rodio: 'Rodio y Covergold', perfumeria: 'Perfumería 1.1'
};

const sinTildes = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

function limpiar(s) {
  return s.replace(EMOJI, '').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').replace(/^[\s*•·\-–—]+/, '').trim();
}
function oracion(s) {
  // Si viene todo en MAYÚSCULAS, lo pasa a tipo oración.
  const letras = s.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü]/g, '');
  if (letras.length > 3 && letras === letras.toUpperCase()) {
    s = s.toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}
function numero(txt, mil) {
  let n = parseInt(String(txt).replace(/[.,\s]/g, ''), 10);
  if (!Number.isFinite(n)) return null;
  if (mil && n < 1000) n *= 1000;
  return n;
}
const RE_PRECIO = /\$\s*([\d.,]+)\s*(mil\b)?/i;
const RE_CAMPO = /^[\s*•\-]*(categoria|titulo|nombre|descripcion|precio|precio unico|precio mayor|precio al mayor|mayor|precio detal|precio al detal|detal|tipo|unidad|presentacion)\s*:/;

// Plantilla con campos ("Categoría: ...", "Título: ...", etc.). Los campos vacíos se ignoran.
function parseCampos(lineas) {
  const errores = [];
  const out = { cat: null, name: '', desc: '', unit: '', price: null, mayor: null, detal: null, sub: null };
  const campos = {}; let ultimo = null;
  for (const l of lineas) {
    const m = sinTildes(l).match(RE_CAMPO);
    if (m) {
      let k = m[1];
      if (k === 'nombre') k = 'titulo';
      if (k === 'precio unico') k = 'precio';
      if (k === 'precio al mayor' || k === 'mayor') k = 'precio mayor';
      if (k === 'precio al detal' || k === 'detal') k = 'precio detal';
      if (k === 'presentacion') k = 'unidad';
      campos[k] = l.slice(l.indexOf(':') + 1).trim();
      ultimo = k;
    } else if (ultimo === 'descripcion') {
      campos.descripcion = (campos.descripcion ? campos.descripcion + ' ' : '') + l;
    }
  }
  const vacio = v => !v || !limpiar(v.replace(/[_.]{2,}/g, '')) || /^(no|n\/a|-|ninguno|ninguna)$/i.test(limpiar(v));
  const val = k => vacio(campos[k]) ? '' : limpiar(campos[k]);
  const precioDe = txt => {
    const m = txt.match(/\$?\s*([\d][\d.,]*)\s*(mil\b)?/i);
    return m ? { n: numero(m[1], m[2]), resto: txt.slice(txt.indexOf(m[0]) + m[0].length).replace(EMOJI, '').replace(/^[\s.:,-]+|[\s.]+$/g, '').replace(/^mil\b\s*/i, '') } : null;
  };

  const c = sinTildes(val('categoria').replace(/^#/, ''));
  out.cat = CATEGORIAS[c] || CATEGORIAS[c.split(/\s+/)[0]] || (c.startsWith('rodio') ? 'rodio' : null);

  out.raw = val('titulo');
  out.name = oracion(out.raw);
  if (!out.name) errores.push('Falta el Título.');
  out.desc = oracion(val('descripcion'));

  const tipo = val('tipo').includes('/') ? '' : sinTildes(val('tipo'));
  if (/dama|mujer/.test(tipo)) out.sub = 'Dama';
  else if (/hombre|caballero/.test(tipo)) out.sub = 'Hombre';
  else if (/unisex/.test(tipo)) out.sub = 'Unisex';

  const pm = val('precio mayor') && precioDe(val('precio mayor'));
  const pd = val('precio detal') && precioDe(val('precio detal'));
  const pu = val('precio') && precioDe(val('precio'));
  if (pm || pd) {
    out.mayor = pm ? pm.n : null; out.detal = pd ? pd.n : null;
    if (!pm || !pd) {
      // si solo llenaron uno, se publica como precio único
      out.price = (pm || pd).n; out.mayor = out.detal = null;
      out.unit = val('unidad').toLowerCase() || (pm ? 'al mayor' : 'al detal');
    }
  } else if (pu) {
    out.price = pu.n; out.unit = (val('unidad') || pu.resto).toLowerCase();
  } else {
    errores.push('Falta el precio. Llena "Precio:" o "Precio mayor:" y "Precio detal:".');
  }
  if (out.mayor != null) out.unit = '';
  if (out.cat && out.cat !== 'perfumeria' && out.sub) { out.desc = [out.desc, out.sub].filter(Boolean).join(' · '); out.sub = null; }
  return errores.length ? { ok: false, errores, producto: out } : { ok: true, producto: out };
}

export function parseCaption(caption) {
  const errores = [];
  const out = { cat: null, name: '', desc: '', unit: '', price: null, mayor: null, detal: null, sub: null };
  if (!caption || !caption.trim()) {
    return { ok: false, errores: ['La foto llegó sin datos. Escribe título y precio en el pie de foto.'] };
  }
  let lineas = caption.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lineas.some(l => RE_CAMPO.test(sinTildes(l)))) return parseCampos(lineas);

  // 1) Categoría: un #hashtag en cualquier parte
  const tag = caption.match(/#([\p{L}]+)/u);
  if (tag) out.cat = CATEGORIAS[sinTildes(tag[1])] || null;
  if (!out.cat) {
    // también acepta la categoría escrita sola en la primera línea, sin #
    const primera = sinTildes(limpiar(lineas[0] || ''));
    if (CATEGORIAS[primera]) { out.cat = CATEGORIAS[primera]; lineas = lineas.slice(1); }
  }
  lineas = lineas.map(l => l.replace(/#[\p{L}]+/gu, '').trim()).filter(l => limpiar(l));

  // 2) Precios
  const resto = [];
  for (const l of lineas) {
    const s = sinTildes(l);
    const mMayor = s.match(/(?:al\s*)?(?:por\s*)?mayor[^\d$]*\$?\s*([\d.,]+)\s*(mil\b)?/i);
    const mDetal = s.match(/(?:al\s*)?detal[^\d$]*\$?\s*([\d.,]+)\s*(mil\b)?/i);
    if (mMayor || mDetal) {
      if (mMayor) out.mayor = numero(mMayor[1], mMayor[2]);
      if (mDetal) out.detal = numero(mDetal[1], mDetal[2]);
      continue;
    }
    const m = l.match(RE_PRECIO);
    if (m && out.price == null) {
      out.price = numero(m[1], m[2]);
      let unidad = l.slice(l.indexOf(m[0]) + m[0].length).replace(EMOJI, '').replace(/^[\s.:,-]+|[\s.]+$/g, '');
      unidad = unidad.replace(/^mil\b\s*/i, '');
      out.unit = unidad.toLowerCase();
      continue;
    }
    resto.push(l);
  }
  if (out.mayor != null || out.detal != null) {
    out.price = null; out.unit = '';
    if (out.mayor == null || out.detal == null) errores.push('Para precio al mayor y al detal escribe los dos, así: Mayor $40.000 / Detal $55.000');
  } else if (out.price == null) {
    errores.push('Falta el precio. Escríbelo con el signo $, por ejemplo: $5.000 cada set');
  }

  // 3) Dama / Hombre (perfumería)
  const todo = sinTildes(caption);
  if (/\b(dama|mujer)\b/.test(todo)) out.sub = 'Dama';
  else if (/\b(hombre|caballero)\b/.test(todo)) out.sub = 'Hombre';
  if (out.cat && out.cat !== 'perfumeria') out.sub = null;

  // 4) Título y descripción
  const textos = resto.map(limpiar).filter(Boolean);
  if (!textos.length) errores.push('Falta el título del producto (la línea después de la categoría).');
  out.raw = textos[0] || '';
  out.name = oracion(out.raw);
  out.desc = textos.slice(1).map(oracion).join(' ');
  if (out.name.length > 140) errores.push('El título es muy largo. Deja el título en una línea y la descripción en las siguientes.');

  return errores.length ? { ok: false, errores, producto: out } : { ok: true, producto: out };
}

export function plantillaDe() {
  return `Título: 
Descripción: 
Precio: 
Precio mayor: 
Precio detal: `;
}
export const PLANTILLA = plantillaDe();
