// Entrega la llave PÚBLICA de Culqi a la página (no es secreta).
// Así la llave se cambia solo en Vercel (CULQI_PUBLIC_KEY), sin tocar el código:
// en las copias de prueba usa la llave de prueba, y en producción la real.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const publicKey = process.env.CULQI_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(500).json({ error: 'Pago no configurado' });
  }
  return res.status(200).json({ publicKey });
}
