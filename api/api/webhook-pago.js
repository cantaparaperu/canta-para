export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ recibido: true });
  }

  const paymentId = req.body?.data?.id;
  const tipo = req.body?.type;

  if (tipo !== 'payment' || !paymentId) {
    return res.status(200).json({ recibido: true });
  }

  try {
    const respuestaPago = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
      }
    });
    const pago = await respuestaPago.json();

    if (pago.status === 'approved') {
      const pedidoId = pago.external_reference;

      await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}`, {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ estado: 'PAGADO' })
      });
    }

    return res.status(200).json({ recibido: true });
  } catch (error) {
    return res.status(200).json({ recibido: true, error: error.message });
  }
}
