// Webhook de Mercado Pago: confirma el pago y pide la canción UNA sola vez.
// Si algo falla responde 500 para que Mercado Pago reintente el aviso solo.

// ---- Avisos al dueño por Telegram (si no están configurados, no hace nada) ----
const UMBRAL_CREDITOS = 120; // 12 créditos por pedido => unos 10 pedidos de margen

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
      body: JSON.stringify(campos)
    }
  );
  if (!r.ok) return [];
  const filas = await r.json();
  return Array.isArray(filas) ? filas : [];
}

async function anotar(pedidoId, texto) {
  if (!pedidoId) return;
  try {
    await actualizarPedido(pedidoId, { debug_info: String(texto).slice(0, 900) });
  } catch (e) {
    // anotar nunca debe romper el proceso
  }
}

async function pedirCancion(pedido) {
  const vocalGender = pedido.voz === 'femenina' ? 'f' : 'm';
  const callBackUrl = 'https://cantapara.vercel.app/api/callback-suno';

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
        prompt: pedido.descripcion || 'Canción personalizada',
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ recibido: true });
  }

  const paymentId = req.body?.data?.id;
  const tipo = req.body?.type;

  if (tipo !== 'payment' || !paymentId) {
    return res.status(200).json({ recibido: true });
  }

  let pedidoId = null;
  let reclamado = false;

  try {
    // 1) Consultar el pago real a Mercado Pago (no confiamos solo en el aviso)
    const respuestaPago = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!respuestaPago.ok) {
      return res.status(500).json({ error: 'No se pudo consultar el pago, reintentar' });
    }
    const pago = await respuestaPago.json();
    pedidoId = pago.external_reference;

    if (!pedidoId) {
      return res.status(200).json({ recibido: true, aviso: 'pago sin pedido' });
    }

    await anotar(pedidoId, `status: ${pago.status} | ext_ref: ${pedidoId} | paymentId: ${paymentId}`);

    if (pago.status !== 'approved') {
      return res.status(200).json({ recibido: true });
    }

    // 2) Buscar el pedido y comprobar que el monto pagado alcanza
    const respuestaPedido = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${encodeURIComponent(pedidoId)}&select=*`,
      { headers: cabecerasSupabase() }
    );
    const filas = await respuestaPedido.json();
    const pedido = Array.isArray(filas) ? filas[0] : null;

    if (!pedido) {
      await anotar(pedidoId, `pedido NO encontrado | paymentId: ${paymentId}`);
      return res.status(200).json({ recibido: true });
    }

    if (Number(pago.transaction_amount) < Number(pedido.precio)) {
      await anotar(pedidoId, `monto insuficiente: pagó ${pago.transaction_amount}, precio ${pedido.precio} | paymentId: ${paymentId}`);
      await avisarDueno(`⚠️ Canta Para: el pedido #${pedidoId} pagó ${pago.transaction_amount} y el precio era ${pedido.precio}. No se generó la canción. Revísalo.`);
      return res.status(200).json({ recibido: true });
    }

    // 3) Reclamar el pedido de forma atómica: solo UN aviso puede pasar de
    //    PENDIENTE_PAGO (o ERROR_GENERACION, para reintentar) a PAGADO.
    const filasReclamadas = await actualizarPedido(
      pedidoId,
      { estado: 'PAGADO', mercado_pago_id: String(paymentId) },
      '&estado=in.(PENDIENTE_PAGO,ERROR_GENERACION)'
    );

    if (filasReclamadas.length === 0) {
      // Otro aviso ya lo procesó: no pedimos la canción dos veces
      return res.status(200).json({ recibido: true, duplicado: true });
    }

    reclamado = true;

    // 4) Pedir la canción
    let intento;
    try {
      intento = await pedirCancion(pedido);
    } catch (e) {
      intento = { ok: false, resultado: { error: e.message } };
    }

    if (!intento.ok) {
      await actualizarPedido(pedidoId, {
        estado: 'ERROR_GENERACION',
        debug_info: `suno fallo: ${JSON.stringify(intento.resultado).slice(0, 600)}`
      });
      await avisarDueno(`🚨 Canta Para: el pedido #${pedidoId} ya está PAGADO pero sunoapi.org no aceptó crear la canción. Se reintentará solo cuando Mercado Pago vuelva a avisar. Detalle: ${JSON.stringify(intento.resultado).slice(0, 300)}`);
      // 500 => Mercado Pago volverá a avisar y se reintentará solo
      return res.status(500).json({ error: 'No se pudo pedir la canción, reintentar' });
    }

    const guardado = await actualizarPedido(pedidoId, {
      estado: 'GENERANDO',
      factory_task_id: intento.taskId,
      debug_info: `suno respondio: ${JSON.stringify(intento.resultado).slice(0, 300)}`
    });
    if (guardado.length === 0) {
      throw new Error('No se pudo guardar el estado GENERANDO');
    }

    // Después de cada canción pedida, revisar que no se acabe el saldo
    await avisarSiSaldoBajo();

    return res.status(200).json({ recibido: true });
  } catch (error) {
    if (pedidoId) {
      if (reclamado) {
        // Quedó a medias: dejarlo reintentable en el próximo aviso
        await actualizarPedido(pedidoId, {
          estado: 'ERROR_GENERACION',
          debug_info: `error webhook: ${error.message}`.slice(0, 900)
        }, '&estado=eq.PAGADO');
        await avisarDueno(`🚨 Canta Para: el pedido #${pedidoId} quedó a medias tras el pago (${error.message}). Quedó en ERROR_GENERACION y se reintentará con el próximo aviso de Mercado Pago.`);
      } else {
        await anotar(pedidoId, `error webhook: ${error.message}`);
      }
    }
    return res.status(500).json({ error: error.message });
  }
}
