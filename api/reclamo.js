// Libro de Reclamaciones virtual: recibe la hoja, la guarda en Supabase y avisa al dueño.
// La tabla "reclamos" solo la toca el servidor (la clave de servicio); el público no puede leerla.

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
    // un aviso que falla nunca debe impedir que el cliente registre su hoja
  }
}

function cabeceras(extra = {}) {
  return {
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

const limpiar = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'El libro no está disponible en este momento. Escríbenos a cantaparaperu@gmail.com.' });
  }

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Campo trampa para robots: una persona real nunca lo llena
    if (b.sitio_web) return res.status(200).json({ numero: 'HR-0000-000000', fecha: new Date().toISOString() });

    const tipo = b.tipo === 'QUEJA' ? 'QUEJA' : (b.tipo === 'RECLAMO' ? 'RECLAMO' : null);
    const documentoTipo = ['DNI', 'CE', 'PASAPORTE'].includes(b.documento_tipo) ? b.documento_tipo : null;
    const fila = {
      tipo,
      nombre: limpiar(b.nombre, 120),
      documento_tipo: documentoTipo,
      documento_numero: limpiar(b.documento_numero, 20),
      domicilio: limpiar(b.domicilio, 200),
      telefono: limpiar(b.telefono, 20),
      correo: limpiar(b.correo, 120).toLowerCase(),
      menor_edad: b.menor_edad === true,
      representante: limpiar(b.representante, 120) || null,
      descripcion_servicio: limpiar(b.descripcion_servicio, 300),
      monto: Math.max(0, Math.min(1000, Number(b.monto) || 0)),
      pedido_ref: limpiar(b.pedido_ref, 40) || null,
      detalle: limpiar(b.detalle, 2000),
      pedido_consumidor: limpiar(b.pedido_consumidor, 1000)
    };

    // Validaciones simples y claras
    if (!tipo) return res.status(400).json({ error: 'Elige si es un reclamo o una queja.' });
    if (fila.nombre.length < 3) return res.status(400).json({ error: 'Escribe tu nombre completo.' });
    if (!documentoTipo) return res.status(400).json({ error: 'Elige el tipo de documento.' });
    const docOk = documentoTipo === 'DNI' ? /^\d{8}$/.test(fila.documento_numero) : /^[A-Za-z0-9]{6,20}$/.test(fila.documento_numero);
    if (!docOk) return res.status(400).json({ error: documentoTipo === 'DNI' ? 'El DNI debe tener 8 números.' : 'Revisa el número de tu documento.' });
    if (fila.domicilio.length < 5) return res.status(400).json({ error: 'Escribe tu domicilio.' });
    if (!/^[0-9+ ]{6,20}$/.test(fila.telefono)) return res.status(400).json({ error: 'Revisa tu número de teléfono.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fila.correo)) return res.status(400).json({ error: 'Revisa tu correo electrónico.' });
    if (fila.menor_edad && !fila.representante) return res.status(400).json({ error: 'Escribe el nombre de tu padre, madre o tutor.' });
    if (fila.descripcion_servicio.length < 3) return res.status(400).json({ error: 'Cuéntanos qué servicio compraste.' });
    if (fila.detalle.length < 10) return res.status(400).json({ error: 'Cuéntanos con más detalle qué pasó.' });
    if (fila.pedido_consumidor.length < 5) return res.status(400).json({ error: 'Cuéntanos qué solución esperas.' });
    if (b.acepta !== true) return res.status(400).json({ error: 'Debes aceptar la declaración para enviar la hoja.' });

    // Freno básico contra abuso: no más de 20 hojas por hora en todo el sitio
    const hace1h = new Date(Date.now() - 3600 * 1000).toISOString();
    const rCuenta = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/reclamos?created_at=gte.${encodeURIComponent(hace1h)}&select=id`,
      { headers: cabeceras({ 'Prefer': 'count=exact', 'Range': '0-0' }), signal: AbortSignal.timeout(8000) }
    );
    const total = parseInt((rCuenta.headers.get('content-range') || '').split('/')[1], 10);
    if (Number.isFinite(total) && total >= 20) {
      return res.status(429).json({ error: 'Hay muchos envíos ahora. Inténtalo en una hora o escríbenos a cantaparaperu@gmail.com.' });
    }

    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/reclamos`, {
      method: 'POST',
      headers: cabeceras({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(fila),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      await avisarDueno(`🚨 Canta Para: falló el guardado de una hoja de reclamación (${r.status}). Revisa la tabla "reclamos" en Supabase.`);
      return res.status(500).json({ error: 'No pudimos registrar tu hoja. Inténtalo de nuevo o escríbenos a cantaparaperu@gmail.com.' });
    }
    const guardada = (await r.json())[0];
    const anio = new Date(guardada.created_at).getUTCFullYear();
    const numero = `HR-${anio}-${String(guardada.id).padStart(6, '0')}`;

    await avisarDueno(`📒 Canta Para: nueva hoja de reclamación ${numero} (${tipo}) de ${fila.nombre}. Debes responder por escrito en un máximo de 15 días hábiles al correo ${fila.correo}.`);

    return res.status(200).json({ numero, fecha: guardada.created_at });
  } catch (e) {
    await avisarDueno(`🚨 Canta Para: error inesperado en el libro de reclamaciones: ${String(e.message).slice(0, 200)}`);
    return res.status(500).json({ error: 'No pudimos registrar tu hoja. Inténtalo de nuevo o escríbenos a cantaparaperu@gmail.com.' });
  }
}
