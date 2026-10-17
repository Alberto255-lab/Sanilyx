/* ================================================================
   SANILYX — CONFIGURAZIONE SUPABASE (api/supabase.js, funzione serverless Vercel)
   Il browser chiama GET /api/supabase e riceve { url, key }: servono a collegarsi
   a Supabase per gli ACCOUNT (stesso account su più dispositivi).

   Come gemini.js, i valori stanno QUI, nel codice (niente variabili d'ambiente):
   scrivili nel blocco "CONFIGURAZIONE" e fai un nuovo deploy.

   Dove trovarli: https://supabase.com → il tuo progetto → Project Settings → API
     • Project URL                      → SUPABASE_URL
     • chiave "anon" o "publishable"    → SUPABASE_KEY   (sb_publishable_... oppure eyJ...)
   NON mettere mai qui la chiave "service_role" / "secret": questa funzione la
   consegna al browser. La chiave anon/publishable invece è pubblica per progettazione.
   ================================================================ */

/* ---------- CONFIGURAZIONE ---------- */
const SUPABASE_URL = 'INSERISCI_QUI_IL_PROJECT_URL';     // es. "https://abcdxyz.supabase.co"
const SUPABASE_KEY = 'INSERISCI_QUI_LA_CHIAVE_ANON';     // chiave anon / publishable
/* ------------------------------------ */

module.exports = function handler(req, res) {
  // CORS: serve per chiamare l'API da file:// (origine "null") o da altri domini
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: { message: 'Metodo non consentito: usa GET.' } });
  }
  if (!/^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL) || SUPABASE_KEY.startsWith('INSERISCI'))
    return res.status(500).json({ error: { message: 'SUPABASE_URL / SUPABASE_KEY non configurati in api/supabase.js.' } });
  if (/service_role|sb_secret_/.test(SUPABASE_KEY))
    return res.status(500).json({ error: { message: 'Chiave non valida: usa la chiave anon/publishable, mai quella segreta.' } });
  return res.status(200).json({ url: SUPABASE_URL, key: SUPABASE_KEY });
};
