import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());

// Variables de entorno cargadas desde el panel de despliegue
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// RUTA DE PRUEBA: Verificar que el servidor esté vivo
app.get('/', (req, res) => {
  res.send('API de Asistente Legal funcionando correctamente.');
});

// ENDPOINT PRINCIPAL: Procesar Notificación Judicial
app.post('/api/procesar-providencia', async (req, res) => {
  try {
    const { textoNotificacion, organizacionId } = req.body;

    if (!textoNotificacion || !organizacionId) {
      return res.status(400).json({ error: 'Faltan parámetros obligatorios (textoNotificacion o organizacionId).' });
    }

    // 1. Extraer datos con Gemini Flash usando responseSchema estricto
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

    // 2. Buscar si el proceso ya existe en la base de datos de esta firma
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

    // 3. Obtener listas de partes y responsables del despacho
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

// ENDPOINT SECUNDARIO: Guardar o actualizar expediente
app.post('/api/guardar-expediente', async (req, res) => {
  try {
    const { expedienteId, organizacionId, materia, numProceso, cliente, contraparte, tipoProceso, estado, proximasAcciones, responsableId } = req.body;

    if (expedienteId) {
      const { data, error } = await supabase
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
      const { data, error } = await supabase
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
