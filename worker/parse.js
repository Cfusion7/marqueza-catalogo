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

export function parseCaption(caption) {
  const errores = [];
  const out = { cat: null, name: '', desc: '', unit: '', price: null, mayor: null, detal: null, sub: null };
  if (!caption || !caption.trim()) {
    return { ok: false, errores: ['El mensaje no tiene texto. Escribe el texto con la plantilla en la misma publicación de la foto.'] };
  }
  let lineas = caption.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // 1) Categoría: un #hashtag en cualquier parte
  const tag = caption.match(/#([\p{L}]+)/u);
  if (tag) out.cat = CATEGORIAS[sinTildes(tag[1])] || null;
  if (!out.cat) {
    // también acepta la categoría escrita sola en la primera línea, sin #
    const primera = sinTildes(limpiar(lineas[0] || ''));
    if (CATEGORIAS[primera]) { out.cat = CATEGORIAS[primera]; lineas = lineas.slice(1); }
  }
  lineas = lineas.map(l => l.replace(/#[\p{L}]+/gu, '').trim()).filter(l => limpiar(l));
  if (!out.cat) errores.push('Falta la categoría en la primera línea: #accesorios, #bolsos, #maquillaje, #rodio o #perfumeria');

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
  if (out.cat !== 'perfumeria') out.sub = null;

  // 4) Título y descripción
  const textos = resto.map(limpiar).filter(Boolean);
  if (!textos.length) errores.push('Falta el título del producto (la línea después de la categoría).');
  out.name = oracion(textos[0] || '');
  out.desc = textos.slice(1).map(oracion).join(' ');
  if (out.name.length > 140) errores.push('El título es muy largo. Deja el título en una línea y la descripción en las siguientes.');

  return errores.length ? { ok: false, errores, producto: out } : { ok: true, producto: out };
}

export const PLANTILLA =
`#accesorios
TÍTULO DEL PRODUCTO
Descripción corta (opcional)
$5.000 cada set

Para perfumes:
#perfumeria
NOMBRE DEL PERFUME
100 ml · Dama
Mayor $40.000 / Detal $55.000

Categorías: #accesorios #bolsos #maquillaje #rodio #perfumeria`;
