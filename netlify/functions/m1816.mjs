// Intermediario para la API de 1816 (https://api.1816.com.ar/v1).
// La API Key vive en la variable de entorno API_1816_KEY de Netlify: nunca
// llega al navegador, al HTML ni al repo. Esta función pide el token de 24 h,
// atiende SOLO los pedidos predefinidos de abajo y deja la respuesta guardada
// en la red de Netlify (CDN) para que todos los visitantes compartan la misma
// copia: 1816 se consulta como máximo una vez por período, no una por visita.
//
//   ?q=snap&grupo=sob|prov&fuente=byma|homo&moneda=mep|ccl[&dia=prev]
//   ?q=hist&ticker=AL30           (TIR de 1 año, MEP, fuente BYMA)
//   ?q=bal                         (saldo de créditos, no consume créditos)

const API = 'https://api.1816.com.ar/v1';

// ── Universo permitido (nada fuera de esta lista llega a 1816) ──────────────
const SOB = ['AL29','AL30','AL35','AE38','AL41','AO27','AO28','AN29','AO29',
             'GD29','GD30','GD35','GD38','GD41','GD46','PAY0'];
const GLOBALES = ['GD29','GD30','GD35','GD38','GD41','GD46'];
const PROV = ['BA37D','BB37D','BC37D','BDC33','BDC36','Bueair27','CH24D','CO24','CO26','CO27',
              'CO32','CO35','ERF25','ERM33','JUS22','Muni27','NDG34','NDT11','NDT25','PMM29',
              'PUA36','PUL26','RIF25','RND25','SA24D','SF27D','SFD34','SJO35','TFU27'];
const GRUPOS = { sob: SOB, prov: PROV.concat(GLOBALES) }; // prov lleva Globales para el spread
const CAMPOS = ['precioClean','variacionDiaria','tea','duration','paridad',
                'currentYield','volumenMontoDiario','ultimaOperacion'];
const HIST_OK = new Set(SOB.concat(PROV).map((t) => t.toUpperCase()));

// ── Token (se reutiliza mientras la instancia siga activa) ──────────────────
let TOKEN = null, TOKEN_EXP = 0;
function env(k) {
  try { if (globalThis.Netlify && Netlify.env) { const v = Netlify.env.get(k); if (v) return v; } } catch (e) {}
  return process.env[k];
}
async function getToken(force) {
  if (!force && TOKEN && Date.now() < TOKEN_EXP - 5 * 60e3) return TOKEN;
  const apiKey = env('API_1816_KEY');
  if (!apiKey) throw httpErr(500, 'Falta la variable de entorno API_1816_KEY en Netlify (y un deploy después de cargarla).');
  const r = await fetch(API + '/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey, module: env('API_1816_MODULE') || 'mercado' }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.token) throw httpErr(r.status === 401 || r.status === 403 ? 502 : 502,
    '1816 rechazó la API Key (' + r.status + '). Revisá que API_1816_KEY sea la clave vigente y del módulo correcto.');
  TOKEN = j.token;
  TOKEN_EXP = Date.now() + (Number(j.expiresIn) || 86400) * 1000;
  return TOKEN;
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function call(path, params) {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v == null) return;
    (Array.isArray(v) ? v : [v]).forEach((x) => qs.append(k, String(x)));
  });
  const url = API + path + (qs.toString() ? '?' + qs : '');
  for (let intento = 0; intento < 2; intento++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + (await getToken(intento > 0)), Accept: 'application/json' } });
    if (r.status === 401 && intento === 0) continue; // token vencido: se pide otro una vez
    const j = await r.json().catch(() => null);
    if (r.status === 402) throw httpErr(402, 'Sin créditos de 1816 por hoy. El monitor muestra el último dato guardado.');
    if (r.status === 429) throw httpErr(429, '1816 pidió bajar la frecuencia de consultas (429).');
    if (!r.ok) throw httpErr(502, '1816 respondió ' + r.status + (j && j.message ? ': ' + j.message : ''));
    return { json: j, credits: Number(r.headers.get('x-1816-credits')) || null };
  }
}

// ── Horario de mercado (Argentina, UTC-3, sin horario de verano) ────────────
function ar(d) { return new Date(d.getTime() - 3 * 3600e3); } // campos UTC = hora local AR
function isoAR(d) { return ar(d).toISOString().slice(0, 10); }
function habil(d) { const w = ar(d).getUTCDay(); return w !== 0 && w !== 6; }
function prevHabil(d) { let x = new Date(d.getTime() - 86400e3); while (!habil(x)) x = new Date(x.getTime() - 86400e3); return x; }
function minutosAR(d) { const a = ar(d); return a.getUTCHours() * 60 + a.getUTCMinutes(); }
function abierto(d) { const m = minutosAR(d); return habil(d) && m >= 10 * 60 + 55 && m <= 17 * 60 + 15; }
function segHastaApertura(d) {
  let x = new Date(d.getTime());
  for (let i = 0; i < 8; i++) {
    const a = ar(x); const ap = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), 11, 0) + 3 * 3600e3;
    if (habil(x) && ap > d.getTime()) return Math.round((ap - d.getTime()) / 1000);
    x = new Date(x.getTime() + 86400e3);
  }
  return 12 * 3600;
}
function ttlSnap(now, prev) {
  if (prev) return Math.min(segHastaApertura(now) + 3600, 86400); // el cierre anterior no cambia en el día
  if (abierto(now)) return 600;                                   // rueda: cada 10 minutos
  const m = minutosAR(now);
  if (habil(now) && m > 17 * 60 + 15 && m < 18 * 60 + 30) return 1200; // captar el cierre definitivo
  return Math.max(600, segHastaApertura(now));                    // fuera de horario: hasta la apertura
}
function ttlHist(now) { // la historia cambia una vez por día: hasta las 18:30 del próximo día hábil
  const a = ar(now); let corte = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), 18, 30) + 3 * 3600e3;
  if (corte <= now.getTime() || !habil(now)) { let x = new Date(now.getTime() + 86400e3); while (!habil(x)) x = new Date(x.getTime() + 86400e3);
    const b = ar(x); corte = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), 18, 30) + 3 * 3600e3; }
  return Math.max(3600, Math.round((corte - now.getTime()) / 1000));
}

function vacio(inst) { return !Object.values(inst || {}).some((o) => o && o.precioClean != null); }

function respond(status, body, ttl) {
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (ttl) {
    h['Cache-Control'] = 'public, max-age=60';
    h['Netlify-CDN-Cache-Control'] = 'public, durable, s-maxage=' + ttl + ', stale-while-revalidate=120';
    h['Netlify-Vary'] = 'query=q|grupo|fuente|moneda|dia|ticker';
  } else h['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(body), { status, headers: h });
}

export default async (req) => {
  const u = new URL(req.url), p = u.searchParams, q = p.get('q'), now = new Date();
  try {
    if (q === 'snap') {
      const tickers = GRUPOS[p.get('grupo')];
      if (!tickers) return respond(400, { error: 'grupo inválido' });
      const fuente = p.get('fuente') === 'homo' ? 'homo-1816' : 'byma';
      const moneda = p.get('moneda') === 'ccl' ? 'ccl' : 'mep';
      const prev = p.get('dia') === 'prev';
      // Antes de la apertura, en feriados o fines de semana el día pedido viene vacío:
      // se retrocede de a un día hábil (máximo 4) hasta encontrar operaciones.
      let fecha = prev ? prevHabil(now) : (habil(now) ? now : prevHabil(now));
      let out = null, credits = 0;
      for (let i = 0; i < 4; i++) {
        const r = await call('/mercado/indicadores', { tickers, campos: CAMPOS, fuente, moneda, plazo: 1, fechaOperacion: isoAR(fecha) });
        credits += r.credits || 0; out = r.json;
        if (!vacio(out && out.instrumentos)) break;
        fecha = prevHabil(fecha);
      }
      return respond(200, Object.assign({}, out, { _meta: { leido: now.toISOString(), creditos: credits || null, grupo: p.get('grupo'), dia: prev ? 'prev' : 'hoy' } }), ttlSnap(now, prev));
    }
    if (q === 'hist') {
      const t = String(p.get('ticker') || '');
      if (!HIST_OK.has(t.toUpperCase())) return respond(400, { error: 'ticker no permitido' });
      const orig = SOB.concat(PROV).find((x) => x.toUpperCase() === t.toUpperCase());
      const desde = new Date(now.getTime() - 364 * 86400e3);
      const r = await call('/mercado/series', { tickers: [orig], campos: ['tea'], fuente: 'byma', moneda: 'mep', plazo: 1,
        fechaInicial: isoAR(desde), fechaFinal: isoAR(now) });
      return respond(200, Object.assign({}, r.json, { _meta: { leido: now.toISOString(), creditos: r.credits } }), ttlHist(now));
    }
    if (q === 'bal') {
      const r = await call('/creditos/balance', {});
      return respond(200, r.json, 300);
    }
    return respond(400, { error: 'pedido no reconocido' });
  } catch (e) {
    return respond(e.status && e.status < 600 ? e.status : 502, { error: e.message || String(e) });
  }
};
