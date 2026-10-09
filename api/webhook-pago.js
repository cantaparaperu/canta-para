export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ recibido: true });
  }

  const paymentId = req.body?.data?.id;
  const tipo = req.body?.type;

  if (tipo !== 'payment' || !paymentId) {
    return res.status(200).json({ recibido: true });
  }

  async function anotar(pedidoId, texto) {
    if (!pedidoId) return;
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}`, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ debug_info: texto })
    });
  }

  try {
    const respuestaPago = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
      }
    });
    const pago = await respuestaPago.json();
    const pedidoId = pago.external_reference;

    await anotar(pedidoId, `status: ${pago.status} | ext_ref: ${pedidoId} | paymentId: ${paymentId}`);

    if (pago.status === 'approved') {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}`, {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ estado: 'PAGADO' })
      });

      const respuestaPedido = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}&select=*`,
        {
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );
      const filas = await respuestaPedido.json();
      const pedido = filas?.[0];

      await anotar(pedidoId, `pedido encontrado: ${pedido ? 'SI' : 'NO'}`);

      if (pedido) {
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

        const respuestaSuno = await fetch('https://api.sunoapi.org/api/v1/generate', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SUNO_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(cuerpo)
        });

        const resultadoSuno = await respuestaSuno.json();
        const taskId = resultadoSuno?.data?.taskId || resultadoSuno?.taskId;

        await anotar(pedidoId, `suno respondio: ${JSON.stringify(resultadoSuno).slice(0, 300)}`);

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}`, {
          method: 'PATCH',
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ estado: 'GENERANDO', factory_task_id: taskId })
        });
      }
    }

    return res.status(200).json({ recibido: true });
  } catch (error) {
    return res.status(200).json({ recibido: true, error: error.message });
  }
}
