/* ================================================================
   SANILYX — PROXY GEMINI (api/gemini.js, funzione serverless Vercel)
   Il browser chiama POST /api/gemini con { parti, json, sistema, storico }.
   Qui si aggiunge la chiave (mai esposta al client) e si inoltra a Gemini.

   La chiave sta QUI, nel codice (niente variabili d'ambiente): scrivila nel blocco
   "CONFIGURAZIONE" qui sotto e fai un nuovo deploy.
   ATTENZIONE: chiunque legga questo file vede la chiave. Non pubblicarlo su un
   repository pubblico (GitHub revoca/segnala le chiavi Google trovate nel codice).
   ================================================================ */

/* ---------- CONFIGURAZIONE ---------- */
const GEMINI_API_KEY = 'AQ.Ab8RN6Jm75sP6N3EtvSWAY55zv3WLIIXD8RhEJjNEveDWgdx1A';   // obbligatoria, es. "AIza..."  (https://aistudio.google.com)
const GEMINI_MODEL = 'gemini-3.5-flash-lite';           // modello usato (elenco: https://ai.google.dev/gemini-api/docs/models)
/* ------------------------------------ */
// Risposta d'errore nello stesso formato di Gemini ({ error: { message } }),
// così il client la legge allo stesso modo in tutti i casi.
const errore = (res, status, message) => res.status(status).json({ error: { message } });

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return errore(res, 405, 'Metodo non consentito: usa POST.');
  }

  const chiave = GEMINI_API_KEY, modello = GEMINI_MODEL;
  if (!chiave || chiave.startsWith('INSERISCI')) return errore(res, 500, 'GEMINI_API_KEY non configurata sul server.');

  // Vercel interpreta già il JSON; se arrivasse come stringa lo leggiamo noi.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const { parti, json = false, sistema = null, storico = [] } = body || {};
  if (!Array.isArray(parti) || !Array.isArray(storico)) return errore(res, 400, 'Richiesta non valida: "parti" e "storico" devono essere array.');

  // Stessa struttura che prima costruiva il client
  const corpo = { contents: [...storico, { role: 'user', parts: parti }] };
  if (sistema) corpo.systemInstruction = { parts: [{ text: String(sistema) }] };
  if (json) corpo.generationConfig = { responseMimeType: 'application/json', temperature: 0 };

  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modello)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chiave },
      body: JSON.stringify(corpo)
    });
  } catch (e) {
    return errore(res, 502, 'Impossibile contattare Gemini: ' + (e && e.message ? e.message : 'errore di rete'));
  }

  // Si restituisce al client la risposta di Gemini così com'è (stesso status, stesso JSON)
  const dati = await r.json().catch(() => null);
  if (dati === null) return errore(res, 502, 'Risposta non valida da Gemini (status ' + r.status + ').');
  return res.status(r.status).json(dati);
};
