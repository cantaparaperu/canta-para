// Revisión diaria automática (Vercel Cron, ver vercel.json):
//  1) borra los enlaces de canciones vencidas (pasan a EXPIRADO)
//  2) avisa por Telegram si hay pedidos pagados atascados o con error
//  3) avisa si el saldo de sunoapi.org está bajo
// Si defines CRON_SECRET en Vercel, solo Vercel puede ejecutarla.

const UMBRAL_CREDITOS = 120; // 12 créditos por pedido => unos 10 pedidos de margen
const MINUTOS_ATASCADO = 60; // GENERANDO desde hace más de esto => se avisa

async function avisarDueno(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(texto).slice(0, 3500) }),
      signal: AbortSignal.timeout(5000)
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

function cabecerasSupabase(extra = {}) {
  return {
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function consultarPedidos(filtro) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos?${filtro}`, {
    headers: cabecerasSupabase(),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`Supabase respondió ${r.status}`);
  const filas = await r.json();
  return Array.isArray(filas) ? filas : [];
}

async function actualizarPedidos(filtro, campos) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos?${filtro}`, {
    method: 'PATCH',
    headers: cabecerasSupabase({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(campos),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`Supabase respondió ${r.status}`);
  const filas = await r.json();
  return Array.isArray(filas) ? filas : [];
}

// ---- Guardar la canción terminada (misma lógica que api/estado-pedido.js) ----
const HORAS_DISPONIBLE = 48; // margen para el cliente que cerró la página y vuelve después

async function resolverPedidoSiListo(pedido) {
  if (!pedido || pedido.estado !== 'GENERANDO' || !pedido.factory_task_id) return false;
  const rSuno = await fetch(
    `https://api.sunoapi.org/api/v1/generate/record-info?taskId=${encodeURIComponent(pedido.factory_task_id)}`,
    { headers: { 'Authorization': `Bearer ${process.env.SUNO_API_KEY}` }, signal: AbortSignal.timeout(8000) }
  );
  const suno = await rSuno.json();
  const pistas = (suno?.data?.response?.sunoData || []).filter(p => p && p.audio_url);
  if (suno?.data?.status !== 'SUCCESS' || pistas.length < 1) return false;
  const vence = new Date(Date.now() + HORAS_DISPONIBLE * 3600 * 1000).toISOString();
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedido.id}&estado=eq.GENERANDO`,
    {
      method: 'PATCH',
      headers: cabecerasSupabase({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({
        estado: 'LISTO',
        audio_1_url: pistas[0].audio_url,
        audio_2_url: (pistas[1] || pistas[0]).audio_url,
        expires_at: vence,
        debug_info: `listo: ${pistas.length} pistas`
      }),
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!r.ok) return false;
  const filas = await r.json();
  return Array.isArray(filas) && filas.length > 0;
}

async function creditosSuno() {
  try {
    const r = await fetch('https://api.sunoapi.org/api/v1/generate/credit', {
      headers: { 'Authorization': `Bearer ${process.env.SUNO_API_KEY}` },
      signal: AbortSignal.timeout(5000)
    });
    const d = await r.json();
    const valor = typeof d?.data === 'number' ? d.data : (d?.data?.credits ?? d?.data?.credit);
    return Number.isFinite(Number(valor)) ? Number(valor) : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const secreto = process.env.CRON_SECRET;
  if (secreto && req.headers.authorization !== `Bearer ${secreto}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const resumen = { vencidos: 0, atascados: 0, conError: 0, creditos: null, avisos: [] };

  try {
    // 1) Vencidos: borrar enlaces
    const ahora = new Date().toISOString();
    const vencidos = await actualizarPedidos(
      `estado=eq.LISTO&expires_at=lt.${encodeURIComponent(ahora)}`,
      { estado: 'EXPIRADO', audio_1_url: null, audio_2_url: null }
    );
    resumen.vencidos = vencidos.length;

    // 2) Atascados: pagados que llevan mucho tiempo en GENERANDO
    const limite = new Date(Date.now() - MINUTOS_ATASCADO * 60 * 1000).toISOString();
    const generando = await consultarPedidos(
      `estado=eq.GENERANDO&created_at=lt.${encodeURIComponent(limite)}&select=*`
    );
    const sinResolver = [];
    for (const p of generando) {
      let resuelto = false;
      try { resuelto = await resolverPedidoSiListo(p); } catch (e) { /* queda sin resolver */ }
      if (resuelto) resumen.resueltos = (resumen.resueltos || 0) + 1;
      else sinResolver.push(p);
    }
    const atascados = sinResolver.filter(p => !String(p.debug_info || '').includes('alertado-atascado'));
    resumen.atascados = atascados.length;

    if (atascados.length > 0) {
      const ids = atascados.map(p => '#' + p.id).join(', ');
      await avisarDueno(`⏳ Canta Para: ${atascados.length} pedido(s) llevan más de ${MINUTOS_ATASCADO} min generando: ${ids}. Revisa en Supabase (tabla pedidos) y en sunoapi.org.`);
      // marcarlos para no repetir el mismo aviso cada día
      for (const p of atascados) {
        const previo = String(p.debug_info || '').slice(0, 700);
        try {
          await actualizarPedidos(`id=eq.${p.id}&estado=eq.GENERANDO`, { debug_info: `${previo} | alertado-atascado` });
        } catch (e) { /* si no se pudo marcar, se avisará de nuevo mañana */ }
      }
    }

    // 3) Con error: pagados que no recibieron su canción
    const conError = await consultarPedidos('estado=eq.ERROR_GENERACION&select=id');
    resumen.conError = conError.length;
    if (conError.length > 0) {
      await avisarDueno(`🚨 Canta Para: ${conError.length} pedido(s) pagados siguen en ERROR_GENERACION sin canción: ${conError.map(p => '#' + p.id).join(', ')}. Hay clientes esperando.`);
    }

    // 4) Saldo de sunoapi.org
    const creditos = await creditosSuno();
    resumen.creditos = creditos;
    if (creditos !== null && creditos < UMBRAL_CREDITOS) {
      await avisarDueno(`⚠️ Canta Para: saldo bajo en sunoapi.org. Quedan ${creditos} créditos (unos ${Math.floor(creditos / 12)} pedidos). Recarga pronto.`);
    }

    return res.status(200).json(resumen);
  } catch (error) {
    await avisarDueno(`🚨 Canta Para: la revisión diaria automática falló: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
}
