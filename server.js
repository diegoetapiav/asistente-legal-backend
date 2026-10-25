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

// ENDPOINT: Listar expedientes del despacho para el usuario final
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

// ENDPOINT: Procesar Notificación Judicial con Gemini (con Fallback Automático)
app.post('/api/procesar-providencia', async (req, res) => {
  try {
    const { textoNotificacion, organizacionId, organizacion_id } = req.body;
    const orgId = organizacionId || organizacion_id;

    if (!textoNotificacion || !orgId) {
      return res.status(400).json({ error: 'Faltan parámetros obligatorios.' });
    }

    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Falta GEMINI_API_KEY.' });
    if (!supabase) return res.status(500).json({ error: 'Base de datos no conectada.' });

    const geminiPayload = {
      contents: [{
        parts: [{ text: `Extrae los datos de esta providencia o notificación judicial ecuatoriana:\n\n${textoNotificacion.slice(0, 4000)}` }]
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

    let jsonIa = null;
    const modelos = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.5-pro'];

    // Intento en cascada: si un modelo está congestionado, pasa al siguiente
    for (const modelo of modelos) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiPayload)
        });

        const data = await resp.json();
        if (!data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          jsonIa = data;
          break; // Respuesta exitosa obtenida
        }
        console.warn(`Aviso: ${modelo} no respondió con éxito, intentando siguiente modelo...`, data.error?.message);
      } catch (errLoop) {
        console.warn(`Error de red con ${modelo}:`, errLoop.message);
      }
