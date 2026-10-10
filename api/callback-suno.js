// sunoapi.org llama aquí cuando termina una canción. No confiamos en el contenido
// del aviso: solo lo usamos como señal y volvemos a consultar el estado real.

function cabecerasSupabase(extra = {}) {
  return {
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
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

export default async function handler(req, res) {
  // Siempre responder 200 para que sunoapi.org no reintente sin parar
  try {
    const cuerpo = req.body || {};
    const taskId = cuerpo?.data?.task_id || cuerpo?.data?.taskId || cuerpo?.task_id || cuerpo?.taskId;
    if (req.method === 'POST' && taskId) {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/pedidos?factory_task_id=eq.${encodeURIComponent(taskId)}&estado=eq.GENERANDO&select=*`,
        { headers: cabecerasSupabase(), signal: AbortSignal.timeout(8000) }
      );
      const filas = await r.json();
      if (Array.isArray(filas) && filas[0]) {
        await resolverPedidoSiListo(filas[0]);
      }
    }
  } catch (e) {
    // si falla, la revisión diaria y la página del cliente lo resolverán
  }
  return res.status(200).json({ recibido: true });
}
