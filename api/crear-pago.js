// Precio de la canción en soles (debe coincidir con PRECIO_SOLES de index.html)
const PRECIO_SOLES = 25;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { pedidoId, paraQuien } = req.body;

  const preferencia = {
    items: [
      {
        title: 'Canción personalizada - Canta Para',
        description: paraQuien ? `Para: ${paraQuien}` : 'Canción personalizada',
        quantity: 1,
        currency_id: 'PEN',
        unit_price: PRECIO_SOLES
      }
    ],
    back_urls: {
      success: 'https://cantapara.vercel.app',
      failure: 'https://cantapara.vercel.app',
      pending: 'https://cantapara.vercel.app'
    },
    auto_return: 'approved',
    notification_url: 'https://cantapara.vercel.app/api/webhook-pago',
    external_reference: pedidoId || ''
  };

  try {
    const respuesta = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preferencia)
    });

    const resultado = await respuesta.json();

    if (!respuesta.ok) {
      return res.status(respuesta.status).json({ error: 'Mercado Pago rechazó la solicitud', detalle: resultado });
    }

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({ error: 'No se pudo contactar a Mercado Pago', detalle: error.message });
  }
}
