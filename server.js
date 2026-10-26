import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('ADVERTENCIA: Credenciales de Supabase incompletas.');
}

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) 
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) 
  : null;

// RUTA DE PRUEBA Y WARM-UP (Responde en <50ms para mantener vivo el backend)
app.get('/', (req, res) => {
  res.send('API de Asistente Legal funcionando a máxima velocidad.');
});

// ENDPOINT: Listar expedientes del despacho
app.get('/api/listar-expedientes', async (req, res) => {
  try {
    const { organizacionId, organizacion_id } = req.query;
    const orgId = organizacionId || organizacion_id;

    if (!orgId) {
      return res.status(400).json({ error: 'Falta el parámetro organizacionId.' });
    }

    if (!supabase) return res.status(500).json({ error: 'Base de datos no conectada.' });

    const { data, error } = await supabase
      .from('expedientes')
      .select(`
        id,
        materia,
        num_proceso,
        cliente,
        contraparte,
        tipo_proceso,
        estado_actual,
        proximas_acciones,
        actualizado_en,
        responsable:usuarios(nombre_completo)
      `)
      .eq('organizacion_id', orgId)
      .order('actualizado_en', { ascending: false });

    if (error) throw error;

    return res.status(200).json({ expedientes: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ENDPOINT ULTRA-RÁPIDO: Procesar Providencia con Gemini (< 5 segundos)
app.post('/api/procesar-providencia', async (req, res) => {
  try {
    const { textoNotificacion, organizacionId, organizacion_id } = req.body;
    const orgId = organizacionId || organizacion_id;

    if (!textoNotificacion || !orgId) {
      return res.status(400).json({ error: 'Faltan parámetros obligatorios.' });
    }

    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Falta GEMINI_API_KEY.' });
    if (!supabase) return res.status(500).json({ error: 'Base de datos no conectada.' });

    // 1. Recorte óptimo: el encabezado y resolución procesal caben en 2500 caracteres
    const extractoTexto = textoNotificacion.length > 2500 
      ? textoNotificacion.slice(0, 2500) 
      : textoNotificacion;

    const geminiPayload = {
      contents: [{
        parts: [{ 
          text: `Extrae en JSON estricto los datos procesales de esta providencia judicial de Ecuador:\n\n${extractoTexto}` 
        }]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            materia: { type: "STRING", enum: ["ACTIVOS CIVIL", "ACTIVOS PENAL", "I. PENALES", "TRÁMITES"] },
            numProceso: { type: "STRING" },
            cliente: { type: "STRING" },
            contraparte: { type: "STRING" },
            tipoProceso: { type: "STRING" },
            estado: { type: "STRING" },
            proximasAcciones: { type: "STRING" }
          },
          required: ["materia", "numProceso", "cliente", "contraparte", "tipoProceso", "estado", "proximasAcciones"]
        },
        temperature: 0.0,
        maxOutputTokens: 500 // Generación de respuesta inmediata
      }
    };

    // 2. Ejecución veloz con Flash (1.5 - 3 seg)
    let jsonIa = null;
    const flashUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

    try {
      const respFlash = await fetch(flashUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload)
      });
      const dataFlash = await respFlash.json();

      if (dataFlash.candidates?.[0]?.content?.parts?.[0]?.text) {
        jsonIa = dataFlash;
      } else {
        console.warn("Flash no devolvió texto, activando fallback pro...", dataFlash.error?.message);
      }
    } catch (errFlash) {
      console.warn("Error de red con Flash, pasando a fallback...", errFlash.message);
    }

    // 3. Fallback inmediato sin esperas artificiales si Flash se satura
    if (!jsonIa) {
      const proUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_API_KEY}`;
      const respPro = await fetch(proUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload)
      });
      const dataPro = await respPro.json();
      if (dataPro.error) throw new Error(dataPro.error.message);
      jsonIa = dataPro;
    }

    const datosExtraidos = JSON.parse(jsonIa.candidates[0].content.parts[0].text);
    const soloDigitos = (datosExtraidos.numProceso || '').replace(/\D/g, '');

    // 4. Consultas paralelas a Supabase con Promise.all (cero latencia agregada)
    const [resExpedientes, resUsuarios] = await Promise.all([
      supabase
        .from('expedientes')
        .select('id, num_proceso, cliente, contraparte, materia, tipo_proceso')
        .eq('organizacion_id', orgId),
      supabase
        .from('usuarios')
        .select('id, nombre_completo')
        .eq('organizacion_id', orgId)
    ]);

    const expedientesExistentes = resExpedientes.data || [];
    const listaResponsables = resUsuarios.data || [];

    // Búsqueda en memoria
    let coincidencias = [];
    if (soloDigitos.length >= 4) {
      coincidencias = expedientesExistentes.filter(exp => {
        const numLimpio = String(exp.num_proceso || '').replace(/\D/g, '');
        return numLimpio && (numLimpio === soloDigitos || numLimpio.includes(soloDigitos));
      });
    }

    const partesSet = new Set();
    expedientesExistentes.forEach(e => {
      if (e.cliente) partesSet.add(e.cliente);
      if (e.contraparte) partesSet.add(e.contraparte);
    });

    return res.status(200).json({
      datosIA: datosExtraidos,
      coincidencias: coincidencias,
      listas: {
        partes: Array.from(partesSet).sort(),
        responsables: listaResponsables
      }
    });

  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error al procesar la providencia.' });
  }
});

// ENDPOINT: Guardar o actualizar expediente
app.post('/api/guardar-expediente', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Base de datos no configurada.' });

    const { 
      expedienteId, 
      organizacionId, 
      organizacion_id, 
      materia, 
      numProceso, 
      cliente, 
      contraparte, 
      tipoProceso, 
      estado, 
      proximasAcciones, 
      responsableId 
    } = req.body;

    const orgId = organizacionId || organizacion_id;

    if (expedienteId) {
      const { error } = await supabase
        .from('expedientes')
        .update({
          materia,
          cliente,
          contraparte,
          tipo_proceso: tipoProceso,
          estado_actual: estado,
          proximas_acciones: proximasAcciones,
          responsable_id: responsableId || null,
          actualizado_en: new Date()
        })
        .eq('id', expedienteId)
        .eq('organizacion_id', orgId);

      if (error) throw error;
      return res.status(200).json({ mensaje: 'Expediente actualizado exitosamente.' });
    } else {
      const { error } = await supabase
        .from('expedientes')
        .insert([{
          organizacion_id: orgId,
          materia,
          num_proceso: numProceso,
          cliente,
          contraparte,
          tipo_proceso: tipoProceso,
          estado_actual: estado,
          proximas_acciones: proximasAcciones,
          responsable_id: responsableId || null
        }]);

      if (error) throw error;
      return res.status(200).json({ mensaje: 'Nuevo expediente registrado exitosamente.' });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
