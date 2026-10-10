export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { pedidoId } = req.body;

  if (!pedidoId) {
    return res.status(400).json({ error: 'Falta el pedidoId' });
  }

  try {
    // 1. Buscar el pedido en Supabase
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

    if (!filas || filas.length === 0) {
      return res.status(404).json({ error: 'No se encontró ese pedido en Supabase' });
    }

    const pedido = filas[0];

    // 2. Pedirle a sunoapi.org que genere la canción
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

    if (!respuestaSuno.ok) {
      return res.status(respuestaSuno.status).json({ error: 'sunoapi.org rechazó la solicitud', detalle: resultadoSuno });
    }

    const taskId = resultadoSuno?.data?.taskId || resultadoSuno?.taskId;

    // 3. Guardar el taskId en Supabase y pasar el pedido a GENERANDO
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}`, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ estado: 'GENERANDO', factory_task_id: taskId })
    });

    return res.status(200).json({ ok: true, taskId, resultadoSuno });
  } catch (error) {
    return res.status(500).json({ error: 'Falló la prueba', detalle: error.message });
  }
}
