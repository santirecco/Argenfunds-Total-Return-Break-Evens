// Intermediario para la API de 1816 (https://api.1816.com.ar/v1).
import { getStore } from '@netlify/blobs';
// La API Key vive en la variable de entorno API_1816_KEY de Netlify: nunca
// llega al navegador, al HTML ni al repo. Esta función pide el token de 24 h,
// atiende SOLO los pedidos predefinidos de abajo y deja la respuesta guardada
// en Netlify Blobs (almacenamiento del sitio) con su vencimiento: mientras no
// venza, TODAS las visitas y recargas reciben esa copia y 1816 no se consulta.
// Además lleva la cuenta de créditos del día y deja de consultar al llegar al
// tope (API_1816_TOPE, por defecto 20.000), sirviendo el último dato guardado.
// Fuente única: BYMA (la que 1816 usa por defecto).
//
//   ?q=snap&grupo=sob|prov&moneda=mep|ccl[&dia=prev]
//   ?q=hist&ticker=AL30           (TIR de 1 año, MEP, fuente BYMA)
//   ?q=bal                         (saldo de créditos, no consume créditos)
//   ?q=extraer                     (UNA VEZ: página que baja los flujos de fondos de los
//                                   45 bonos de a uno, guarda el progreso y al terminar
//                                   ofrece descargar flujos_bonos_1816.json)

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

// ── Copia guardada + tope diario de créditos (Netlify Blobs) ────────────────
function tope() { const v = Number(env('API_1816_TOPE')); return v > 0 ? v : 20000; }
function store() { try { return getStore('m1816'); } catch (e) { return null; } }
async function guardado(key, ttlSeg, producir, now) {
  const st = store(), hoyAR = isoAR(now);
  let hit = null, usados = 0;
  if (st) {
    try { hit = await st.get(key, { type: 'json' }); } catch (e) {}
    if (hit && hit.exp > now.getTime()) return { body: hit.body, meta: { origen: 'guardado', leido: hit.at, proxima: new Date(hit.exp).toISOString() } };
    try { const c = await st.get('creditos-' + hoyAR, { type: 'json' }); usados = (c && c.usados) || 0; } catch (e) {}
    if (usados >= tope()) {
      if (hit) return { body: hit.body, meta: { origen: 'tope', leido: hit.at, usadosHoy: usados, tope: tope() } };
      throw httpErr(429, 'Se alcanzó el tope diario de ' + tope() + ' créditos de 1816 y no hay datos guardados para este pedido.');
    }
  }
  try {
    const r = await producir();
    const at = now.toISOString(), exp = now.getTime() + ttlSeg * 1000;
    if (st) {
      try { await st.setJSON(key, { body: r.body, at, exp }); } catch (e) {}
      try { await st.setJSON('creditos-' + hoyAR, { usados: usados + (r.creditos || 0) }); } catch (e) {}
    }
    return { body: r.body, meta: { origen: '1816', leido: at, proxima: new Date(exp).toISOString(), creditos: r.creditos, usadosHoy: usados + (r.creditos || 0), tope: tope(), sinAlmacen: !st } };
  } catch (e) {
    if (hit) return { body: hit.body, meta: { origen: 'viejo', leido: hit.at, error: e.message } };
    throw e;
  }
}

function vacio(inst) { return !Object.values(inst || {}).some((o) => o && o.precioClean != null); }

function respond(status, body, ttl) {
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (ttl) {
    h['Cache-Control'] = 'public, max-age=60';
    h['Netlify-CDN-Cache-Control'] = 'public, durable, s-maxage=' + ttl + ', stale-while-revalidate=120';
    h['Netlify-Vary'] = 'query=q|grupo|moneda|dia|ticker';
  } else h['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(body), { status, headers: h });
}

// Página de progreso de la extracción (se sirve con ?q=extraer)
const PAGINA_EXTRAER = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extracción de flujos · 1816</title><style>
body{margin:0;background:#070F1A;color:#CBD9E7;font:14px/1.5 Inter,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.c{width:min(560px,92vw);background:#0F1C2B;border:1px solid #243A52;border-radius:12px;padding:26px 28px}
h1{font-size:17px;margin:0 0 6px}p{margin:6px 0;color:#82A0BB}.bar{height:10px;border-radius:5px;background:#16273A;overflow:hidden;margin:18px 0 8px}
.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#1FD4B4,#5BA0F2);transition:width .3s}
#est{font-weight:600;color:#CBD9E7}#err{font-size:12px;color:#F0A53E;margin-top:10px}
a.b{display:none;margin-top:18px;padding:10px 16px;border-radius:8px;background:rgba(47,214,140,.14);border:1px solid rgba(47,214,140,.5);color:#2FD68C;font-weight:700;text-decoration:none}
</style></head><body><div class="c"><h1>Bajando los flujos de fondos de 1816</h1>
<p>Va de a un bono por vez para respetar el límite de 1816. Dejá esta página abierta; tarda uno o dos minutos.</p>
<div class="bar"><i id="b"></i></div><div id="est">Empezando…</div><div id="err"></div>
<a class="b" id="d" href="?q=extraer&descargar=1">Descargar flujos_bonos_1816.json</a></div>
<script>
async function paso(){
  try{
    const r=await fetch('?q=extraer&paso=1',{cache:'no-store'}); const j=await r.json();
    if(!r.ok){document.getElementById('est').textContent='Error: '+(j.error||r.status);setTimeout(paso,4000);return;}
    const hechos=j.total-j.faltan; document.getElementById('b').style.width=(hechos/j.total*100).toFixed(0)+'%';
    document.getElementById('est').textContent=hechos+' de '+j.total+' listos · '+j.creditos+' créditos usados'+(j.pausa?' · '+j.pausa:'');
    const e=Object.entries(j.errores||{}).filter(([k,v])=>v.definitivo);
    document.getElementById('err').textContent=e.length?'Sin flujos en 1816: '+e.map(([k])=>k).join(', '):'';
    if(j.listo){document.getElementById('est').textContent='Listo: '+j.bajados+' bonos con flujos · '+j.creditos+' créditos usados.';document.getElementById('d').style.display='inline-block';return;}
    setTimeout(paso,j.pausa?3000:600);
  }catch(e){document.getElementById('est').textContent='Reintentando…';setTimeout(paso,3000);}
}
paso();
</script></body></html>`;

export default async (req) => {
  const u = new URL(req.url), p = u.searchParams, q = p.get('q'), now = new Date();
  try {
    if (q === 'snap') {
      const grupo = p.get('grupo'), tickers = GRUPOS[grupo];
      if (!tickers) return respond(400, { error: 'grupo inválido' });
      const moneda = p.get('moneda') === 'ccl' ? 'ccl' : 'mep';
      const prev = p.get('dia') === 'prev';
      const ttl = ttlSnap(now, prev);
      const r = await guardado('snap-' + grupo + '-' + moneda + (prev ? '-prev' : ''), ttl, async () => {
        // Antes de la apertura, fines de semana y feriados el día pedido viene vacío:
        // se empieza por el último día hábil y se retrocede (máximo 4) hasta encontrar operaciones.
        let fecha = prev ? prevHabil(now) : (habil(now) && minutosAR(now) >= 10 * 60 + 55 ? now : prevHabil(now));
        let out = null, creditos = 0;
        for (let i = 0; i < 4; i++) {
          const x = await call('/mercado/indicadores', { tickers, campos: CAMPOS, fuente: 'byma', moneda, plazo: 1, fechaOperacion: isoAR(fecha) });
          creditos += x.credits || tickers.length * CAMPOS.length; out = x.json;
          if (!vacio(out && out.instrumentos)) break;
          fecha = prevHabil(fecha);
        }
        return { body: out, creditos };
      }, now);
      return respond(200, Object.assign({}, r.body, { _meta: Object.assign({ grupo, dia: prev ? 'prev' : 'hoy' }, r.meta) }), Math.min(ttl, 600));
    }
    if (q === 'hist') {
      const t = String(p.get('ticker') || '');
      if (!HIST_OK.has(t.toUpperCase())) return respond(400, { error: 'ticker no permitido' });
      const orig = SOB.concat(PROV).find((x) => x.toUpperCase() === t.toUpperCase());
      const ttl = ttlHist(now);
      const r = await guardado('hist-' + orig.toUpperCase(), ttl, async () => {
        const desde = new Date(now.getTime() - 364 * 86400e3);
        const x = await call('/mercado/series', { tickers: [orig], campos: ['tea'], fuente: 'byma', moneda: 'mep', plazo: 1,
          fechaInicial: isoAR(desde), fechaFinal: isoAR(now) });
        const ins = (x.json && x.json.instrumentos) || {}, k = Object.keys(ins)[0];
        const n = k && ins[k].tea ? ins[k].tea.length : 250;
        return { body: x.json, creditos: x.credits || n };
      }, now);
      return respond(200, Object.assign({}, r.body, { _meta: r.meta }), Math.min(ttl, 3600));
    }
    if (q === 'extraer') {
      // Extracción de flujos de fondos, de a un bono por vez y con pausas (1816 limita la
      // frecuencia). Avanza por tandas de ~7 s y guarda el progreso: la página que se abre
      // con ?q=extraer va pidiendo tandas sola hasta terminar y ofrece descargar el archivo.
      const st = store();
      if (!st) return respond(500, { error: 'No está disponible el almacenamiento del sitio (Netlify Blobs).' });
      const TODOS = SOB.concat(PROV), CURVAS = [8, 11, 18];
      const camposCF = ['fechaPagoEfectiva', 'fechaPagoTeorica', 'flujoAmortizacion', 'flujoInteres', 'flujoTotal'];
      let prog = null; try { prog = await st.get('cf-v2', { type: 'json' }); } catch (e) {}
      if (!prog) prog = { cashflow: {}, instrumentos: {}, errores: {}, creditos: 0, inicio: now.toISOString() };
      const faltan = () => TODOS.filter((t) => !prog.cashflow[t] && !(prog.errores[t] && prog.errores[t].definitivo)).length
                         + CURVAS.filter((id) => !prog.instrumentos[id]).length;
      if (p.get('descargar')) {
        return new Response(JSON.stringify(prog), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="flujos_bonos_1816.json"' } });
      }
      if (!p.get('paso')) return new Response(PAGINA_EXTRAER, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      const t0 = Date.now(), dormir = (ms) => new Promise((r) => setTimeout(r, ms));
      let usados = 0; try { const c = await st.get('creditos-' + isoAR(now), { type: 'json' }); usados = (c && c.usados) || 0; } catch (e) {}
      let gasto = 0, pausa = null;
      const tareas = CURVAS.filter((id) => !prog.instrumentos[id]).map((id) => ['curva', id])
        .concat(TODOS.filter((t) => !prog.cashflow[t] && !(prog.errores[t] && prog.errores[t].definitivo)).map((t) => ['cf', t]));
      for (const [tipo, id] of tareas) {
        if (Date.now() - t0 > 7000) break;
        if (usados + gasto >= tope()) { pausa = 'Se alcanzó el tope diario de créditos del monitor.'; break; }
        try {
          if (tipo === 'curva') { const x = await call('/mercado/instrumentos', { curvaId: id, soloPerforming: 'true' }); prog.instrumentos[id] = x.json; gasto += 1; }
          else { const x = await call('/mercado/cashflow/' + encodeURIComponent(id), { campos: camposCF }); prog.cashflow[id] = x.json; delete prog.errores[id];
            gasto += x.credits || ((x.json && x.json.cashflow && x.json.cashflow.length) || 1); }
        } catch (e) {
          if (e.status === 429) { pausa = '1816 pidió bajar el ritmo: se retoma en unos segundos.'; await dormir(2500); break; }
          if (e.status === 402) { pausa = e.message; break; }
          prog.errores[id] = { msg: e.message, definitivo: /respondió 4\d\d/.test(e.message) };
        }
        await dormir(400);
      }
      prog.creditos += gasto;
      try { await st.setJSON('cf-v2', prog); } catch (e) {}
      if (gasto) { try { await st.setJSON('creditos-' + isoAR(now), { usados: usados + gasto }); } catch (e) {} }
      const f = faltan();
      return respond(200, { total: TODOS.length + CURVAS.length, faltan: f, listo: f === 0, pausa,
        bajados: Object.keys(prog.cashflow).length, errores: prog.errores, creditos: prog.creditos });
    }
    if (q === 'bal') {
      const r = await call('/creditos/balance', {});
      const st = store(); let usados = null;
      if (st) { try { const c = await st.get('creditos-' + isoAR(now), { type: 'json' }); usados = (c && c.usados) || 0; } catch (e) {} }
      return respond(200, Object.assign({}, r.json, { _monitor: { usadosHoy: usados, tope: tope() } }), 300);
    }
    return respond(400, { error: 'pedido no reconocido' });
  } catch (e) {
    return respond(e.status && e.status < 600 ? e.status : 502, { error: e.message || String(e) });
  }
};
