export default async function handler(req, res) {
  const { taskId } = req.query;

  if (!taskId) {
    return res.status(400).json({ error: 'Falta el taskId' });
  }

  try {
    const respuesta = await fetch(
      `https://api.sunoapi.org/api/v1/generate/record-info?taskId=${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SUNO_API_KEY}`
        }
      }
    );

    const resultado = await respuesta.json();

    if (!respuesta.ok) {
      return res.status(respuesta.status).json({ error: 'sunoapi.org rechazó la consulta', detalle: resultado });
    }

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({ error: 'No se pudo contactar a sunoapi.org', detalle: error.message });
  }
}
