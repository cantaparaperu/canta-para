export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { paraQuien, descripcion, letra, modoLetra, voz } = req.body;
  const vocalGender = voz === 'femenina' ? 'f' : 'm';
  const callBackUrl = 'https://cantapara.app/api/callback-suno';

  const cuerpo = modoLetra
    ? {
        customMode: true,
        instrumental: false,
        title: paraQuien || 'Mi canción',
        style: 'Pop',
        lyrics: letra,
        prompt: descripcion || 'Canción personalizada',
        vocalGender,
        model: 'V6',
        callBackUrl
      }
    : {
        customMode: false,
        instrumental: false,
        prompt: descripcion,
        vocalGender,
        model: 'V6',
        callBackUrl
      };

  try {
    const respuesta = await fetch('https://api.sunoapi.org/api/v1/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUNO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cuerpo)
    });

    const resultado = await respuesta.json();

    if (!respuesta.ok) {
      return res.status(respuesta.status).json({ error: 'sunoapi.org rechazó la solicitud', detalle: resultado });
    }

    return res.status(200).json(resultado);
  } catch (error) {
    return res.status(500).json({ error: 'No se pudo contactar a sunoapi.org', detalle: error.message });
  }
}
