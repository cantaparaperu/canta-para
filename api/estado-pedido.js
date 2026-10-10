// Consulta el estado de UN pedido del cliente que inició sesión.
// Si la canción está en proceso, le pregunta a sunoapi.org y, cuando termina,
// guarda los enlaces de audio y pasa el pedido a LISTO.

const HORAS_DISPONIBLE = 48; // margen para quien cerró la página y vuelve después
const ESTADOS_FALLO_SUNO = [
  'CREATE_TASK_FAILED',
  'GENERATE_AUDIO_FAILED',
  'CALLBACK_EXCEPTION',
  'SENSITIVE_WORD_ERROR'
];

// ---- Avisos al dueño por Telegram (si no están configurados, no hace nada) ----
async function avisarDueno(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(texto).slice(0, 3500) }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    // un aviso que falla nunca debe romper el proceso del cliente
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

async function actualizarPedido(pedidoId, campos, filtroExtra = '') {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(pedidoId)}${filtroExtra}`,
    {
      method: 'PATCH',
      headers: cabecerasSupabase({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(campos)
    }
  );
  if (!r.ok) return [];
  const filas = await r.json();
  return Array.isArray(filas) ? filas : [];
}

// Instrucción para sunoapi: el nombre de la persona va SIEMPRE, y se cuida el largo máximo (500)
function armarPrompt(pedido) {
  const nombre = String(pedido.dedicado_a || '').trim().slice(0, 60);
  const base = String(pedido.descripcion || 'Canción personalizada').trim();
  const pre = nombre ? `Canción dedicada a ${nombre}; menciona su nombre solo un par de veces, de forma natural, sin repetirlo en exceso. ` : '';
  return (pre + base).slice(0, 490);
}

async function pedirCancion(pedido) {
  const vocalGender = pedido.voz === 'femenina' ? 'f' : 'm';
  const callBackUrl = 'https://cantapara.app/api/callback-suno';

  const cuerpo = pedido.modo_letra
    ? {
        customMode: true,
        instrumental: false,
        title: pedido.dedicado_a || 'Mi canción',
        style: 'Pop',
        lyrics: pedido.letra || pedido.descripcion || 'Canción personalizada',
        prompt: pedido.descripcion || 'Canción personalizada',
        vocalGender,
        model: 'V6',
        callBackUrl
      }
    : {
        customMode: false,
        instrumental: false,
        prompt: armarPrompt(pedido),
        vocalGender,
        model: 'V6',
        callBackUrl
      };

  const respuesta = await fetch('https://api.sunoapi.org/api/v1/generate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SUNO_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(8000)
  });
  const resultado = await respuesta.json();
  const taskId = resultado?.data?.taskId || resultado?.taskId;
  return { resultado, taskId, ok: respuesta.ok && resultado?.code === 200 && !!taskId };
}

function respuestaPedido(pedido) {
  const listo = pedido.estado === 'LISTO';
  return {
    estado: pedido.estado,
    dedicado_a: pedido.dedicado_a || '',
    audio_1_url: listo ? pedido.audio_1_url : null,
    audio_2_url: listo ? pedido.audio_2_url : null
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const id = req.query.id;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!id || !/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'Falta el número de pedido' });
  }
  if (!token) {
    return res.status(401).json({ error: 'Falta iniciar sesión' });
  }

  try {
    // 1) ¿Quién es el cliente? (se verifica el token con Supabase)
    const rUsuario = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${token}`
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!rUsuario.ok) {
      return res.status(401).json({ error: 'Sesión no válida' });
    }
    const usuario = await rUsuario.json();

    // 2) Buscar el pedido y comprobar que es de este cliente
    const rPedido = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${id}&select=*`,
      { headers: cabecerasSupabase(), signal: AbortSignal.timeout(8000) }
    );
    const filas = await rPedido.json();
    let pedido = Array.isArray(filas) ? filas[0] : null;

    if (!pedido || pedido.user_id !== usuario.id) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // 3) Si ya venció el plazo, borrar los enlaces
    if (pedido.estado === 'LISTO' && pedido.expires_at && new Date(pedido.expires_at) < new Date()) {
      const vencido = await actualizarPedido(
        pedido.id,
        { estado: 'EXPIRADO', audio_1_url: null, audio_2_url: null },
        '&estado=eq.LISTO'
      );
      pedido = vencido[0] || { ...pedido, estado: 'EXPIRADO' };
      return res.status(200).json(respuestaPedido(pedido));
    }

    // 4) Si la canción está en proceso, preguntar a sunoapi.org
    if (pedido.estado === 'GENERANDO' && pedido.factory_task_id) {
      const rSuno = await fetch(
        `https://api.sunoapi.org/api/v1/generate/record-info?taskId=${encodeURIComponent(pedido.factory_task_id)}`,
        {
          headers: { 'Authorization': `Bearer ${process.env.SUNO_API_KEY}` },
          signal: AbortSignal.timeout(8000)
        }
      );
      const suno = await rSuno.json();
      const estadoSuno = suno?.data?.status;
      const pistas = (suno?.data?.response?.sunoData || []).filter(p => p && p.audio_url);

      if (estadoSuno === 'SUCCESS' && pistas.length >= 1) {
        const vence = new Date(Date.now() + HORAS_DISPONIBLE * 3600 * 1000).toISOString();
        const guardado = await actualizarPedido(
          pedido.id,
          {
            estado: 'LISTO',
            audio_1_url: pistas[0].audio_url,
            audio_2_url: (pistas[1] || pistas[0]).audio_url,
            expires_at: vence,
            debug_info: `listo: ${pistas.length} pistas`
          },
          '&estado=eq.GENERANDO'
        );
        if (guardado[0]) pedido = guardado[0];
        else {
          // otro revisor ya lo guardó: leer el estado actual
          const r2 = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${id}&select=*`,
            { headers: cabecerasSupabase() }
          );
          const f2 = await r2.json();
          if (Array.isArray(f2) && f2[0]) pedido = f2[0];
        }
      } else if (ESTADOS_FALLO_SUNO.includes(estadoSuno)) {
        const yaReintento = String(pedido.debug_info || '').includes('reintento');
        if (!yaReintento) {
          // Un reintento automático antes de rendirse
          let intento;
          try {
            intento = await pedirCancion(pedido);
          } catch (e) {
            intento = { ok: false, resultado: { error: e.message } };
          }
          if (intento.ok) {
            const nuevo = await actualizarPedido(
              pedido.id,
              {
                factory_task_id: intento.taskId,
                debug_info: `reintento tras ${estadoSuno}: ${intento.taskId}`
              },
              '&estado=eq.GENERANDO'
            );
            if (nuevo[0]) pedido = nuevo[0];
          } else {
            const fallo = await actualizarPedido(
              pedido.id,
              {
                estado: 'ERROR_GENERACION',
                debug_info: `reintento fallo tras ${estadoSuno}: ${JSON.stringify(intento.resultado).slice(0, 500)}`
              },
              '&estado=eq.GENERANDO'
            );
            if (fallo[0]) {
              pedido = fallo[0];
              await avisarDueno(`🚨 Canta Para: el pedido #${pedido.id} (ya pagado) falló en sunoapi.org y el reintento también. Estado: ERROR_GENERACION. Detalle: ${String(pedido.debug_info || '').slice(0, 300)}`);
            }
          }
        } else {
          const fallo = await actualizarPedido(
            pedido.id,
            { estado: 'ERROR_GENERACION', debug_info: `reintento agotado: ${estadoSuno}` },
            '&estado=eq.GENERANDO'
          );
          if (fallo[0]) {
            pedido = fallo[0];
            await avisarDueno(`🚨 Canta Para: el pedido #${pedido.id} (ya pagado) falló dos veces en sunoapi.org (${estadoSuno}). Estado: ERROR_GENERACION. Hay que revisarlo a mano.`);
          }
        }
      }
    }

    return res.status(200).json(respuestaPedido(pedido));
  } catch (error) {
    // El cliente seguirá consultando: un fallo puntual no debe asustarlo
    return res.status(200).json({
      estado: 'CONSULTANDO',
      aviso: 'No se pudo revisar ahora, reintentando',
      detalle: error.message
    });
  }
}
