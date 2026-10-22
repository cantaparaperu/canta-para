// Precio de la canción en soles (debe coincidir con PRECIO_SOLES de index.html)
const PRECIO_SOLES = 29;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { pedidoId, paraQuien, correo, nombre } = req.body || {};

  const preferenciaBase = {
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
      success: 'https://cantapara.app',
      failure: 'https://cantapara.app',
      pending: 'https://cantapara.app'
    },
    auto_return: 'approved',
    // Sin pagos en efectivo/cajero: solo tarjeta, Yape y dinero en cuenta (pago inmediato)
    payment_methods: {
      excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }]
    },
    notification_url: 'https://cantapara.app/api/webhook-pago',
    external_reference: pedidoId || ''
  };

  // Versión con más datos para el antifraude (id, categoría, comprador, nombre en el estado de cuenta).
  // Si Mercado Pago no la acepta por algún motivo, se usa la versión básica que ya funcionaba.
  const nombrePartes = String(nombre || '').trim().split(/\s+/);
  const payer = {};
  if (typeof correo === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) payer.email = correo;
  if (nombrePartes[0]) payer.name = nombrePartes[0];
  if (nombrePartes.length > 1) payer.surname = nombrePartes.slice(1).join(' ');
  const preferenciaMejorada = {
    ...preferenciaBase,
    items: [{ ...preferenciaBase.items[0], id: 'cancion-personalizada', category_id: 'services' }],
    statement_descriptor: 'CANTAPARA',
    ...(Object.keys(payer).length ? { payer } : {})
  };

  async function crear(preferencia) {
    const respuesta = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preferencia)
    });
    const resultado = await respuesta.json();
    return { respuesta, resultado };
  }

  try {
    let { respuesta, resultado } = await crear(preferenciaMejorada);
    if (!respuesta.ok) {
      ({ respuesta, resultado } = await crear(preferenciaBase));
    }

    if (!respuesta.ok) {
      return res.status(respuesta.status).json({ error: 'Mercado Pago rechazó la solicitud', detalle: resultado });
    }

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({ error: 'No se pudo contactar a Mercado Pago', detalle: error.message });
  }
}
