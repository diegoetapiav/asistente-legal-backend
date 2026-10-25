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

// RUTA DE PRUEBA
app.get('/', (req, res) => {
  res.send('API de Asistente Legal funcionando correctamente.');
});

// NUEVO ENDPOINT: Listar expedientes del despacho para el usuario final
app.get('/api/listar-expedientes', async (req, res) => {
  try {
    const { organizacionId } = req.query;
    if (!organizacionId) {
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
      .eq('organizacion_id', organizacionId)
      .order('actualizado_en', { ascending: false });

    if (error) throw error;

    return res.status(200).json({ expedientes: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ENDPOINT: Procesar Notificación Judicial con Gemini
app.post('/api/procesar-providencia', async (req, res) => {
  try {
    const { textoNotificacion, organizacionId } = req.body;

    if (!textoNotificacion || !organizacionId) {
      return res.status(400).json({ error: 'Faltan parámetros obligatorios.' });
    }

    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Falta GEMINI_API_KEY.' });
    if (!supabase) return res.status(500).json({ error: 'Base de datos no conectada.' });

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const geminiPayload = {
      contents: [{
        parts: [{ text: `Extrae los datos de esta providencia o notificación judicial:\n\n${textoNotificacion.slice(0, 4000)}` }]
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
        maxOutputTokens: 1200
      }
    };

    const respuestaIa = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload)
    });

    const jsonIa = await respuestaIa.json();
    if (jsonIa.error) throw new Error(jsonIa.error.message);

    const datosExtraidos = JSON.parse(jsonIa.candidates[0].content.parts[0].text);

    // Búsqueda de coincidencias
    let coincidencias = [];
    const soloDigitos = (datosExtraidos.numProceso || '').replace(/\D/g, '');

    if (soloDigitos.length >= 4) {
      const { data: expedientesExistentes } = await supabase
        .from('expedientes')
        .select('id, num_proceso, cliente, contraparte, materia, tipo_proceso')
        .eq('organizacion_id', organizacionId);

      if (expedientesExistentes) {
        coincidencias = expedientesExistentes.filter(exp => {
          const numLimpio = String(exp.num_proceso || '').replace(/\D/g, '');
          return numLimpio && (numLimpio === soloDigitos || numLimpio.includes(soloDigitos));
        });
      }
    }

    // Listas de partes y responsables
    const { data: listaExpedientes } = await supabase
      .from('expedientes')
      .select('cliente, contraparte')
      .eq('organizacion_id', organizacionId);

    const { data: listaResponsables } = await supabase
      .from('usuarios')
      .select('id, nombre_completo')
      .eq('organizacion_id', organizacionId);

    const partesSet = new Set();
    listaExpedientes?.forEach(e => {
      if (e.cliente) partesSet.add(e.cliente);
      if (e.contraparte) partesSet.add(e.contraparte);
    });

    return res.status(200).json({
      datosIA: datosExtraidos,
      coincidencias: coincidencias,
      listas: {
        partes: Array.from(partesSet).sort(),
        responsables: listaResponsables || []
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

    const { expedienteId, organizacionId, materia, numProceso, cliente, contraparte, tipoProceso, estado, proximasAcciones, responsableId } = req.body;

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
        .eq('organizacion_id', organizacionId);

      if (error) throw error;
      return res.status(200).json({ mensaje: 'Expediente actualizado exitosamente.' });
    } else {
      const { error } = await supabase
        .from('expedientes')
        .insert([{
          organizacion_id: organizacionId,
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
