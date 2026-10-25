// Cobro con Culqi: recibe el token que genera la ventana de pago (tarjeta o Yape),
// cobra S/29 desde el servidor y, si Culqi aprueba, pide la canción UNA sola vez.
//
// Protecciones:
//  - El monto lo fija el servidor (nunca el navegador).
//  - Solo el dueño del pedido (sesión de Google) puede pagarlo.
//  - Un pedido ya pagado no se vuelve a cobrar.
//  - Antes de cobrar, el pedido se "reclama" de forma atómica (PENDIENTE_PAGO -> COBRANDO):
//    si llegan dos toques a la vez, solo uno puede cobrar.
//  - Si no se sabe si Culqi cobró (corte de red, error 5xx), NO se reintenta el cobro:
//    se avisa al dueño por Telegram para revisarlo en el panel de Culqi.

const PRECIO_SOLES = 29; // debe coincidir con PRECIO_SOLES de index.html y api/crear-pago.js
const MONTO_CENTIMOS = PRECIO_SOLES * 100;
const UMBRAL_CREDITOS = 120; // 12 créditos por pedido => unos 10 pedidos de margen

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

async function avisarSiSaldoBajo() {
  const creditos = await creditosSuno();
  if (creditos !== null && creditos < UMBRAL_CREDITOS) {
    await avisarDueno(`⚠️ Canta Para: saldo bajo en sunoapi.org. Quedan ${creditos} créditos (unos ${Math.floor(creditos / 12)} pedidos). Recarga pronto para que ningún cliente se quede sin su canción.`);
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
      body: JSON.stringify(campos),
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!r.ok) return [];
  const filas = await r.json();
  return Array.isArray(filas) ? filas : [];
}

// Instrucción para sunoapi (igual que en api/webhook-pago.js)
function armarPrompt(pedido) {
  const nombre = String(pedido.dedicado_a || '').trim().slice(0, 60);
  const base = String(pedido.descripcion || 'Canción personalizada').trim();
  const voz = pedido.voz === 'femenina'
    ? 'Cantada por una voz femenina (female vocals).'
    : 'Cantada por una voz masculina (male vocals).';
  const dedicada = nombre
    ? ` Dedicada a ${nombre} (quien recibe la canción, no quien canta); menciona su nombre entre 3 y 4 veces en total en toda la canción, de forma natural, sin pasar de 4.`
    : '';
  return (voz + dedicada + ' ' + base).slice(0, 900);
}

async function pedirCancion(pedido) {
  const vocalGender = pedido.voz === 'femenina' ? 'f' : 'm';
  const callBackUrl = 'https://cantapara.app/api/callback-suno';

  const cuerpo = pedido.modo_letra
    ? {
        customMode: true,
        instrumental: false,
        title: pedido.dedicado_a || 'Mi canción',
        style: pedido.voz === 'femenina' ? 'Pop, female vocals' : 'Pop, male vocals',
        negativeTags: pedido.voz === 'femenina' ? 'Male Vocals' : 'Female Vocals',
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

// Pedido ya PAGADO (reclamado): pide la canción y deja el estado en GENERANDO.
// Si Suno falla queda en ERROR_GENERACION (el cliente no paga de nuevo; se avisa al dueño).
async function generarCancion(pedido) {
  let intento;
  try {
    intento = await pedirCancion(pedido);
  } catch (e) {
    intento = { ok: false, resultado: { error: e.message } };
  }

  if (!intento.ok) {
    await actualizarPedido(pedido.id, {
      estado: 'ERROR_GENERACION',
      debug_info: `suno fallo: ${JSON.stringify(intento.resultado).slice(0, 600)}`
    });
    await avisarDueno(`🚨 Canta Para: el pedido #${pedido.id} ya está PAGADO (Culqi) pero sunoapi.org no aceptó crear la canción. El cliente NO debe pagar de nuevo. Detalle: ${JSON.stringify(intento.resultado).slice(0, 300)}`);
    return 'ERROR_GENERACION';
  }

  const guardado = await actualizarPedido(pedido.id, {
    estado: 'GENERANDO',
    factory_task_id: intento.taskId,
    debug_info: `suno respondio: ${JSON.stringify(intento.resultado).slice(0, 300)}`
  });
  if (guardado.length === 0) {
    await avisarDueno(`🚨 Canta Para: el pedido #${pedido.id} pidió su canción a Suno (tarea ${intento.taskId}) pero no se pudo guardar el estado GENERANDO. Revísalo en Supabase.`);
    return 'ERROR_GENERACION';
  }

  await avisarSiSaldoBajo();
  return 'GENERANDO';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { pedidoId, tokenId } = req.body || {};
  const sesion = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!pedidoId || !/^\d+$/.test(String(pedidoId))) {
    return res.status(400).json({ error: 'Falta el número de pedido' });
  }
  if (!sesion) {
    return res.status(401).json({ error: 'Falta iniciar sesión' });
  }
  if (!process.env.CULQI_SECRET_KEY) {
    await avisarDueno('🚨 Canta Para: falta la variable CULQI_SECRET_KEY en Vercel. Nadie puede pagar.');
    return res.status(500).json({ error: 'El pago no está disponible por ahora. Intenta en unos minutos.' });
  }

  try {
    // 1) ¿Quién es el cliente? (se verifica la sesión con Supabase)
    const rUsuario = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${sesion}`
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!rUsuario.ok) {
      return res.status(401).json({ error: 'Sesión no válida' });
    }
    const usuario = await rUsuario.json();

    // 2) El pedido debe existir y ser de este cliente
    const rPedido = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(pedidoId)}&select=*`,
      { headers: cabecerasSupabase(), signal: AbortSignal.timeout(8000) }
    );
    const filas = await rPedido.json();
    const pedido = Array.isArray(filas) ? filas[0] : null;
    if (!pedido || pedido.user_id !== usuario.id) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // 3) Pedido que ya se cobró con Culqi pero la canción falló: reintentar la canción SIN cobrar
    if (pedido.estado === 'ERROR_GENERACION' && String(pedido.mercado_pago_id || '').startsWith('culqi:chr_') && String(pedido.debug_info || '').startsWith('suno ')) {
      const reclamado = await actualizarPedido(pedido.id, { estado: 'PAGADO' }, '&estado=eq.ERROR_GENERACION');
      if (reclamado.length === 0) {
        return res.status(200).json({ estado: 'GENERANDO', yaPagado: true });
      }
      const estado = await generarCancion(reclamado[0]);
      return res.status(200).json({ estado, yaPagado: true });
    }

    // 4) Cualquier otro estado que no sea "pendiente de pago": NO se cobra
    if (pedido.estado !== 'PENDIENTE_PAGO') {
      return res.status(200).json({ estado: pedido.estado, yaPagado: true });
    }

    if (!tokenId || !/^[A-Za-z0-9_]{5,100}$/.test(String(tokenId))) {
      return res.status(400).json({ error: 'No se recibió el pago. Intenta de nuevo.' });
    }

    // 5) Reclamar el pedido ANTES de cobrar: solo una petición puede pasar a COBRANDO
    const reclamo = await actualizarPedido(
      pedido.id,
      { estado: 'COBRANDO', debug_info: 'cobrando con culqi' },
      '&estado=eq.PENDIENTE_PAGO'
    );
    if (reclamo.length === 0) {
      return res.status(200).json({ estado: 'COBRANDO', enCurso: true });
    }

    // 6) Cobrar en Culqi (el monto lo fija el servidor)
    let respuestaCulqi;
    let cargo;
    try {
      respuestaCulqi = await fetch('https://api.culqi.com/v2/charges', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.CULQI_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: MONTO_CENTIMOS,
          currency_code: 'PEN',
          email: usuario.email,
          source_id: String(tokenId),
          description: 'Canción personalizada - Canta Para',
          metadata: { pedido_id: String(pedido.id) }
        }),
        signal: AbortSignal.timeout(20000)
      });
      cargo = await respuestaCulqi.json();
    } catch (e) {
      // No sabemos si Culqi cobró o no: NO se reintenta el cobro, se avisa para revisar a mano
      await actualizarPedido(pedido.id, { debug_info: `culqi sin respuesta: ${e.message}`.slice(0, 600) }, '&estado=eq.COBRANDO');
      await avisarDueno(`🚨 Canta Para: el pedido #${pedido.id} no recibió respuesta de Culqi (${e.message}). Revisa en el panel de Culqi si se cobró S/${PRECIO_SOLES}. Si se cobró, genera la canción a mano; si no, pasa el pedido a PENDIENTE_PAGO en Supabase.`);
      return res.status(202).json({ estado: 'COBRANDO', revisar: true });
    }

    const aprobado = respuestaCulqi.ok && cargo && cargo.object === 'charge' && !!cargo.id;

    if (!aprobado) {
      const rechazo = respuestaCulqi.status >= 400 && respuestaCulqi.status < 500;
      if (!rechazo) {
        // Error de Culqi (5xx o respuesta rara): puede haberse cobrado, no reintentar
        await actualizarPedido(pedido.id, { debug_info: `culqi respuesta rara (${respuestaCulqi.status}): ${JSON.stringify(cargo).slice(0, 500)}` }, '&estado=eq.COBRANDO');
        await avisarDueno(`🚨 Canta Para: Culqi respondió ${respuestaCulqi.status} al cobrar el pedido #${pedido.id}. Revisa en el panel de Culqi si se cobró S/${PRECIO_SOLES}.`);
        return res.status(202).json({ estado: 'COBRANDO', revisar: true });
      }
      // Rechazo claro (tarjeta rechazada, código Yape inválido, etc.): se puede intentar de nuevo
      await actualizarPedido(
        pedido.id,
        { estado: 'PENDIENTE_PAGO', debug_info: `culqi rechazó (${respuestaCulqi.status}): ${JSON.stringify(cargo).slice(0, 500)}` },
        '&estado=eq.COBRANDO'
      );
      const mensaje = (cargo && (cargo.user_message || cargo.merchant_message)) || 'No se pudo completar el pago. Prueba con otra tarjeta o con Yape.';
      return res.status(402).json({ error: String(mensaje).slice(0, 300) });
    }

    // 7) Cobro aprobado: marcar PAGADO y guardar el número de cargo
    if (Number(cargo.amount) !== MONTO_CENTIMOS) {
      await avisarDueno(`⚠️ Canta Para: el pedido #${pedido.id} cobró ${cargo.amount} céntimos y se esperaban ${MONTO_CENTIMOS}. Revísalo en Culqi.`);
    }
    const pagado = await actualizarPedido(
      pedido.id,
      { estado: 'PAGADO', mercado_pago_id: `culqi:${cargo.id}`, debug_info: `culqi aprobado: ${cargo.id}` },
      '&estado=eq.COBRANDO'
    );
    if (pagado.length === 0) {
      await avisarDueno(`🚨 Canta Para: Culqi COBRÓ el pedido #${pedido.id} (cargo ${cargo.id}) pero no se pudo guardar como PAGADO. Pásalo a PAGADO en Supabase y genera la canción.`);
      return res.status(202).json({ estado: 'COBRANDO', revisar: true });
    }

    // 8) Pedir la canción (una sola vez)
    const estado = await generarCancion(pagado[0]);
    return res.status(200).json({ estado });
  } catch (error) {
    await avisarDueno(`🚨 Canta Para: error inesperado al cobrar el pedido #${pedidoId}: ${error.message}. Revisa el pedido en Supabase y en el panel de Culqi.`);
    return res.status(500).json({ error: 'No se pudo completar el pago. Si te cobraron, tu pedido está seguro; escríbenos a cantaparaperu@gmail.com.' });
  }
}
