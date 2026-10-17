/* ================================================================
   SANILYX — sito web installabile come app  (sanilyx-web.js)
   File collegati: sanilyx-web.html (struttura) · sanilyx-web.css (stile) · sw.js (offline e notifiche)
   Carica dopo sql.js e jsPDF (CDN), che sono inclusi nell'HTML.
   ================================================================ */
/* ================================================================
   SANILYX — GUIDA DI CONFIGURAZIONE  (leggi prima di avviare!)
   ================================================================

   ▶ COME AVVIARE IL PROGETTO
   Il browser blocca Notification, Service Worker e (a volte) crypto
   se apri il file con doppio click (file://). Servi la cartella così:
        python3 -m http.server 8000      (poi apri http://localhost:8000)
   "localhost" è considerato sicuro dal browser: tutto funziona.

   ────────────────────────────────────────────────────────────────
   A. OTTENERE LA CHIAVE API DI GEMINI  (gratuita)
   ────────────────────────────────────────────────────────────────
     1. Vai su Google AI Studio:  https://aistudio.google.com
     2. Accedi con il tuo account Google
     3. Clicca su "Create API key" (o "Get API key")
     4. Se è la prima volta scegli "Create API key in new project"
     5. Copia la stringa (inizia con  AIza...)  e conservala al sicuro

   ────────────────────────────────────────────────────────────────
   B. CONFIGURARE LE CHIAVI (lato server: il browser non le vede mai)
   ────────────────────────────────────────────────────────────────
     Le chiavi NON stanno nel client né in Impostazioni: sono scritte nel codice
     delle due funzioni serverless di Vercel, nella cartella api/ del progetto
     (in cima a ciascun file, nel blocco "CONFIGURAZIONE"):
       • api/gemini.js → GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.5-flash-lite)
     Dopo ogni modifica serve un nuovo deploy. In locale: "npx vercel dev".
     Con "python3 -m http.server" le funzioni /api non esistono: l'AI non
     funziona. ATTENZIONE: le chiavi stanno nel codice, quindi NON pubblicare
     api/gemini.js su un repository pubblico.

   ────────────────────────────────────────────────────────────────
   C. LA PRIMA CHIAMATA A GEMINI (esempio con l'SDK ufficiale)
   ────────────────────────────────────────────────────────────────
       import { GoogleGenAI } from "@google/genai";
       const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

       async function analizzaDocumento(immagineBase64) {
         const response = await ai.models.generateContent({
           model: "gemini-3.5-flash-lite",
           contents: [
             { text: "Estrai da questa immagine i dati del farmaco: nome, dosaggio, frequenza, data inizio, data fine. Rispondi SOLO con JSON valido." },
             { inlineData: { mimeType: "image/jpeg", data: immagineBase64 } }
           ]
         });
         return JSON.parse(response.text);
       }
   Nel nostro codice facciamo ESATTAMENTE la stessa chiamata, ma con
   fetch() verso l'endpoint REST dell'SDK: niente import, niente build,
   un solo file. Vedi la funzione  gemini()  più sotto.
   NOTA: nel testo dell'esempio compariva "gemini-2.0-flash": quel modello
   è stato spento da Google, per questo usiamo  gemini-3.5-flash-lite
   (gratuito, accetta immagini). Se un giorno smette di funzionare cambia
   solo GEMINI_MODEL (elenco: https://ai.google.dev/gemini-api/docs/models).

   ────────────────────────────────────────────────────────────────
   D. NOTE DI SICUREZZA
   ────────────────────────────────────────────────────────────────
     • La chiave API NON va mai pubblicata su GitHub.
     • Se la chiave trapela: revocala SUBITO da Google AI Studio
       (sezione API keys → elimina/rigenera).
     • La chiave Gemini sta SOLO sul server: api/gemini.js la contiene nel
       codice e il browser non la vede mai (ma chi legge il codice sì: tieni
       il repository PRIVATO). Per un uso reale aggiungi a queste funzioni
       login e limiti di utilizzo (rate limit).
     • I dati sanitari restano nel browser (SQLite in localStorage);
       solo foto e domande vanno a Gemini quando le invii.
   ================================================================ */


/* ================================================================
   NUCLEO SANILYX — dati, logica e AI
   (Il sito si può anche installare come app: vedi sezione PWA in fondo.)
   Indice:  1 Utilità · 2 Lingue (i18n) · 3 Database · 4 Autenticazione
            5 Terapie e stati · 6 Notifiche e scheduler · 7 Gemini (AI)
            8 "Mi sento male" · 9 PDF per il medico · 10 Appuntamenti
            11 Referti di laboratorio
   Poi:     12 Interfaccia (le viste) · 13 Shell e avvio
   ================================================================ */

/* ---------- 1. UTILITÀ ---------- */
const pad = n => String(n).padStart(2, '0');
// Date come testo locale: "2026-10-16" e "2026-10-16 08:00" (ordinabili come stringhe)
function oggi()    { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function adesso()  { const d = new Date(); return `${oggi()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function aggiungiGiorni(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
}
function diffGiorni(a, b) { // giorni tra due date ISO
  const t = s => Date.UTC(...s.split('-').map((v, i) => i === 1 ? v - 1 : +v));
  return Math.round((t(b) - t(a)) / 864e5);
}
function fmtData(iso) { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
const dataValida = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function randomHex(nByte) {                       // numero casuale crittografico
  const a = new Uint8Array(nByte); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- 2. LINGUE (i18n) ----------
   Il codice e il database restano in italiano. Il testo mostrato viene tradotto al volo:
   • TESTI = tabella [italiano, inglese, spagnolo, francese, tedesco]. Se la prima voce è una
     RegExp (frasi con parti variabili: nomi, date, numeri) nelle traduzioni $1, $2… sono i
     gruppi catturati. Un testo non presente in tabella resta com'è (italiano).
   • Un MutationObserver traduce ogni testo/placeholder che compare nella pagina, e ricorda
     l'originale italiano: cambiare lingua non richiede di ridisegnare nulla.
   • tr('testo') serve dove il testo NON finisce nella pagina (notifiche di sistema, finestre
     confirm). Per AGGIUNGERE UNA LINGUA: aggiungila a LINGUE e a LINGUE_AI e metti la sua
     traduzione come ultima colonna di ogni riga. Per un testo nuovo: aggiungi una riga.   */
const LINGUE = { it: 'Italiano', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch' };
const LINGUE_AI = { it: 'italiano', en: 'English', es: 'español', fr: 'français', de: 'Deutsch' };   // per l'assistente AI
const LANG_KEY = 'sanilyx_lang';
let LANG = (() => {
  try { const s = localStorage.getItem(LANG_KEY); if (LINGUE[s]) return s; } catch (e) {}
  const b = (navigator.language || 'it').slice(0, 2).toLowerCase();    // prima volta: lingua del browser
  return LINGUE[b] ? b : 'it';
})();

const TESTI = [
  // --- schermata di caricamento, titoli, accesso ---
  ['Sanilyx — Gestione sanitaria personale', 'Sanilyx — Personal health management', 'Sanilyx — Gestión sanitaria personal', 'Sanilyx — Gestion de santé personnelle', 'Sanilyx — Persönliche Gesundheitsverwaltung'],
  ['Inizializzazione database…', 'Initializing database…', 'Inicializando base de datos…', 'Initialisation de la base de données…', 'Datenbank wird initialisiert…'],
  ['Caricamento terapie…', 'Loading therapies…', 'Cargando tratamientos…', 'Chargement des traitements…', 'Therapien werden geladen…'],
  ['Preparazione assistente…', 'Preparing assistant…', 'Preparando el asistente…', "Préparation de l'assistant…", 'Assistent wird vorbereitet…'],
  ['Quasi pronto…', 'Almost ready…', 'Casi listo…', 'Presque prêt…', 'Fast fertig…'],
  ['La tua salute,', 'Your health,', 'Tu salud,', 'Votre santé,', 'Deine Gesundheit,'],
  ['sempre sotto controllo.', 'always under control.', 'siempre bajo control.', 'toujours sous contrôle.', 'immer im Griff.'],
  ['Scansiona le prescrizioni, ricevi un promemoria per ogni dose e consulta lo storico delle tue terapie.', 'Scan your prescriptions, get a reminder for every dose and check your therapy history.', 'Escanea las recetas, recibe un recordatorio para cada dosis y consulta el historial de tus tratamientos.', "Scannez vos ordonnances, recevez un rappel pour chaque prise et consultez l'historique de vos traitements.", 'Scanne Rezepte, erhalte für jede Dosis eine Erinnerung und sieh dir den Verlauf deiner Therapien an.'],
  ['Scansione documenti con intelligenza artificiale', 'Document scanning with artificial intelligence', 'Escaneo de documentos con inteligencia artificial', "Scan de documents par intelligence artificielle", 'Dokumente scannen mit künstlicher Intelligenz'],
  ["Notifiche per ogni dose, anche l'ultima", 'Notifications for every dose, even the last one', 'Notificaciones para cada dosis, incluso la última', "Notifications pour chaque prise, même la dernière", 'Benachrichtigungen für jede Dosis, auch die letzte'],
  ['Registro malattie sempre consultabile', 'Illness log always at hand', 'Registro de enfermedades siempre consultable', 'Registre des maladies toujours consultable', 'Krankheitsregister jederzeit einsehbar'],
  ['Gestione sanitaria personale', 'Personal health management', 'Gestión sanitaria personal', 'Gestion de santé personnelle', 'Persönliche Gesundheitsverwaltung'],
  ['Sanilyx · dati salvati su questo browser', 'Sanilyx · data saved in this browser', 'Sanilyx · datos guardados en este navegador', 'Sanilyx · données enregistrées dans ce navigateur', 'Sanilyx · Daten in diesem Browser gespeichert'],
  ['La tua salute, sempre con te', 'Your health, always with you', 'Tu salud, siempre contigo', 'Votre santé, toujours avec vous', 'Deine Gesundheit, immer bei dir'],
  ['Lingua', 'Language', 'Idioma', 'Langue', 'Sprache'],
  ["Scegli la lingua dell'interfaccia e dell'assistente AI.", 'Choose the language of the interface and of the AI assistant.', 'Elige el idioma de la interfaz y del asistente de IA.', "Choisissez la langue de l'interface et de l'assistant IA.", 'Wähle die Sprache der Oberfläche und des KI-Assistenten.'],
  ['Indietro', 'Back', 'Atrás', 'Retour', 'Zurück'],
  ['Impossibile avviare il database (serve la connessione per caricare sql.js).', 'Unable to start the database (a connection is needed to load sql.js).', 'No se pudo iniciar la base de datos (hace falta conexión para cargar sql.js).', "Impossible de démarrer la base de données (une connexion est nécessaire pour charger sql.js).", 'Die Datenbank konnte nicht gestartet werden (zum Laden von sql.js ist eine Verbindung nötig).'],
  // --- login / registrazione ---
  ['Email', 'Email', 'Correo electrónico', 'E-mail', 'E-Mail'],
  ['Password', 'Password', 'Contraseña', 'Mot de passe', 'Passwort'],
  ['Accedi', 'Log in', 'Iniciar sesión', 'Se connecter', 'Anmelden'],
  ['Registrati', 'Sign up', 'Registrarse', "S'inscrire", 'Registrieren'],
  ['Nome', 'Name', 'Nombre', 'Nom', 'Name'],
  ['Password (min. 8 caratteri)', 'Password (min. 8 characters)', 'Contraseña (mín. 8 caracteres)', 'Mot de passe (min. 8 caractères)', 'Passwort (mind. 8 Zeichen)'],
  ['Ripeti password', 'Repeat password', 'Repite la contraseña', 'Répétez le mot de passe', 'Passwort wiederholen'],
  ['Crea account', 'Create account', 'Crear cuenta', 'Créer un compte', 'Konto erstellen'],
  ['Le due password non coincidono.', 'The two passwords do not match.', 'Las dos contraseñas no coinciden.', 'Les deux mots de passe ne correspondent pas.', 'Die beiden Passwörter stimmen nicht überein.'],
  ['Inserisci il tuo nome.', 'Enter your name.', 'Introduce tu nombre.', 'Saisissez votre nom.', 'Gib deinen Namen ein.'],
  ['Email non valida.', 'Invalid email.', 'Correo no válido.', 'E-mail invalide.', 'Ungültige E-Mail-Adresse.'],
  ['La password deve avere almeno 8 caratteri.', 'The password must be at least 8 characters long.', 'La contraseña debe tener al menos 8 caracteres.', 'Le mot de passe doit contenir au moins 8 caractères.', 'Das Passwort muss mindestens 8 Zeichen lang sein.'],
  ['Esiste già un account con questa email.', 'An account with this email already exists.', 'Ya existe una cuenta con este correo.', 'Un compte avec cet e-mail existe déjà.', 'Es gibt bereits ein Konto mit dieser E-Mail-Adresse.'],
  ['Email o password non corretti.', 'Incorrect email or password.', 'Correo o contraseña incorrectos.', 'E-mail ou mot de passe incorrect.', 'E-Mail oder Passwort falsch.'],
  ['Questo browser non supporta le notifiche.', 'This browser does not support notifications.', 'Este navegador no admite notificaciones.', 'Ce navigateur ne prend pas en charge les notifications.', 'Dieser Browser unterstützt keine Benachrichtigungen.'],
  // --- stato, terapie (messaggi del nucleo) ---
  ['Sano', 'Healthy', 'Sano', 'En bonne santé', 'Gesund'],
  ['In trattamento', 'In treatment', 'En tratamiento', 'En traitement', 'In Behandlung'],
  ['Non specificata', 'Not specified', 'No especificada', 'Non précisée', 'Nicht angegeben'],
  ['Inserisci il nome del farmaco.', 'Enter the medication name.', 'Introduce el nombre del medicamento.', 'Saisissez le nom du médicament.', 'Gib den Namen des Medikaments ein.'],
  [/^Date mancanti per (.+)\.$/, 'Missing dates for $1.', 'Faltan las fechas de $1.', 'Dates manquantes pour $1.', 'Fehlende Daten für $1.'],
  [/^(.+): la data di fine è prima dell'inizio\.$/, '$1: the end date is before the start date.', '$1: la fecha de fin es anterior al inicio.', "$1 : la date de fin est antérieure au début.", '$1: Das Enddatum liegt vor dem Beginn.'],
  [/^(.+): la terapia non può superare 365 giorni\.$/, '$1: the therapy cannot exceed 365 days.', '$1: el tratamiento no puede superar los 365 días.', '$1 : le traitement ne peut pas dépasser 365 jours.', '$1: Die Therapie darf 365 Tage nicht überschreiten.'],
  [/^Terapia con (.+) conclusa\.$/, 'Therapy with $1 completed.', 'Tratamiento con $1 concluido.', 'Traitement par $1 terminé.', 'Therapie mit $1 abgeschlossen.'],
  [/^"(.+)" è ora nel registro malattie\.$/, '"$1" is now in the illness log.', '«$1» ya está en el registro de enfermedades.', '« $1 » figure maintenant dans le registre des maladies.', '„$1“ steht jetzt im Krankheitsregister.'],
  ['Terapia completata: ora il tuo stato è "Sano".', 'Therapy completed: your status is now "Healthy".', 'Tratamiento completado: ahora tu estado es «Sano».', 'Traitement terminé : votre statut est maintenant « En bonne santé ».', 'Therapie abgeschlossen: Dein Status ist jetzt „Gesund“.'],
  ['Il tuo stato è "In trattamento".', 'Your status is "In treatment".', 'Tu estado es «En tratamiento».', 'Votre statut est « En traitement ».', 'Dein Status ist „In Behandlung“.'],
  // --- notifiche di sistema (usate con tr() nel codice) ---
  ['Ultima dose', 'Last dose', 'Última dosis', 'Dernière prise', 'Letzte Dosis'],
  ['Ora della dose', 'Dose time', 'Hora de la dosis', 'Heure de la prise', 'Zeit für die Dosis'],
  ['ore', 'at', 'a las', 'à', 'um'],
  ["Questa è l'ultima dose. Con questa la terapia è completata.", 'This is the last dose. With it the therapy is complete.', 'Esta es la última dosis. Con ella el tratamiento queda completado.', "C'est la dernière prise. Avec elle, le traitement est terminé.", 'Das ist die letzte Dosis. Damit ist die Therapie abgeschlossen.'],
  ["Oggi è l'ultimo giorno di terapia.", 'Today is the last day of therapy.', 'Hoy es el último día de tratamiento.', "Aujourd'hui est le dernier jour du traitement.", 'Heute ist der letzte Tag der Therapie.'],
  ['Sanilyx · notifica di prova', 'Sanilyx · test notification', 'Sanilyx · notificación de prueba', 'Sanilyx · notification de test', 'Sanilyx · Testbenachrichtigung'],
  ['Le notifiche funzionano correttamente.', 'Notifications are working correctly.', 'Las notificaciones funcionan correctamente.', 'Les notifications fonctionnent correctement.', 'Die Benachrichtigungen funktionieren einwandfrei.'],
  ['Notifica di prova inviata.', 'Test notification sent.', 'Notificación de prueba enviada.', 'Notification de test envoyée.', 'Testbenachrichtigung gesendet.'],
  // --- AI ---
  ['Formato immagine non leggibile (usa JPG o PNG).', 'Unreadable image format (use JPG or PNG).', 'Formato de imagen ilegible (usa JPG o PNG).', "Format d'image illisible (utilisez JPG ou PNG).", 'Bildformat nicht lesbar (verwende JPG oder PNG).'],
  ["L'AI non ha restituito un JSON valido. Riprova con una foto più nitida.", 'The AI did not return valid JSON. Try again with a sharper photo.', 'La IA no devolvió un JSON válido. Vuelve a intentarlo con una foto más nítida.', "L'IA n'a pas renvoyé de JSON valide. Réessayez avec une photo plus nette.", 'Die KI hat kein gültiges JSON geliefert. Versuche es mit einem schärferen Foto erneut.'],
  ['Gemini non ha restituito una risposta (contenuto bloccato o immagine illeggibile).', 'Gemini did not return a response (content blocked or unreadable image).', 'Gemini no devolvió ninguna respuesta (contenido bloqueado o imagen ilegible).', "Gemini n'a pas renvoyé de réponse (contenu bloqué ou image illisible).", 'Gemini hat keine Antwort geliefert (Inhalt blockiert oder Bild nicht lesbar).'],
  // --- dashboard ---
  ['Ciao,', 'Hello,', 'Hola,', 'Bonjour,', 'Hallo,'],
  ['Terapie attive', 'Active therapies', 'Tratamientos activos', 'Traitements actifs', 'Aktive Therapien'],
  ['Dosi di oggi', "Today's doses", 'Dosis de hoy', "Prises d'aujourd'hui", 'Heutige Dosen'],
  ['Malattie nel registro', 'Illnesses in the log', 'Enfermedades en el registro', 'Maladies dans le registre', 'Krankheiten im Register'],
  ['Stato attuale', 'Current status', 'Estado actual', 'Statut actuel', 'Aktueller Status'],
  ['Prossime dosi', 'Upcoming doses', 'Próximas dosis', 'Prochaines prises', 'Nächste Dosen'],
  [/^Oggi · (.+)$/, 'Today · $1', 'Hoy · $1', "Aujourd'hui · $1", 'Heute · $1'],
  ['Nessuna dose in programma', 'No doses scheduled', 'Ninguna dosis programada', 'Aucune prise prévue', 'Keine Dosen geplant'],
  ['Sei in stato "Sano". Se hai una nuova prescrizione, scansionala.', 'Your status is "Healthy". If you have a new prescription, scan it.', 'Tu estado es «Sano». Si tienes una receta nueva, escanéala.', 'Votre statut est « En bonne santé ». Si vous avez une nouvelle ordonnance, scannez-la.', 'Dein Status ist „Gesund“. Wenn du ein neues Rezept hast, scanne es.'],
  ['Nessuna dose futura.', 'No future doses.', 'Ninguna dosis futura.', 'Aucune prise à venir.', 'Keine künftigen Dosen.'],
  ['Scansiona un documento', 'Scan a document', 'Escanear un documento', 'Scanner un document', 'Dokument scannen'],
  ['In corso', 'Ongoing', 'En curso', 'En cours', 'Laufend'],
  [/^· fino al (.+)$/, '· until $1', '· hasta el $1', "· jusqu'au $1", '· bis $1'],
  ["Questo browser non supporta le notifiche: i promemoria compaiono solo dentro l'app.", 'This browser does not support notifications: reminders only appear inside the app.', 'Este navegador no admite notificaciones: los recordatorios solo aparecen dentro de la app.', "Ce navigateur ne prend pas en charge les notifications : les rappels n'apparaissent que dans l'app.", 'Dieser Browser unterstützt keine Benachrichtigungen: Erinnerungen erscheinen nur in der App.'],
  ['Attiva le notifiche', 'Turn on notifications', 'Activa las notificaciones', 'Activer les notifications', 'Benachrichtigungen aktivieren'],
  ["Così ti avvisiamo a ogni dose, compresa l'ultima.", 'So we can alert you at every dose, including the last one.', 'Así te avisamos en cada dosis, incluida la última.', "Ainsi, nous vous prévenons à chaque prise, y compris la dernière.", 'So erinnern wir dich bei jeder Dosis, auch bei der letzten.'],
  ['Attiva', 'Enable', 'Activar', 'Activer', 'Aktivieren'],
  ['Le notifiche sono bloccate dal browser: riattivale dalle impostazioni del sito per ricevere i promemoria.', 'Notifications are blocked by the browser: re-enable them in the site settings to receive reminders.', 'El navegador tiene bloqueadas las notificaciones: vuelve a activarlas en los ajustes del sitio para recibir recordatorios.', "Les notifications sont bloquées par le navigateur : réactivez-les dans les paramètres du site pour recevoir les rappels.", 'Benachrichtigungen sind vom Browser blockiert: Aktiviere sie in den Website-Einstellungen, um Erinnerungen zu erhalten.'],
  // --- scansiona ---
  ['Scansiona documento', 'Scan document', 'Escanear documento', 'Scanner un document', 'Dokument scannen'],
  ["Carica la foto di una ricetta o di un referto: l'AI legge farmaci, dosaggi e durata. Tu controlli e confermi.", 'Upload a photo of a prescription or a medical report: the AI reads medications, dosages and duration. You check and confirm.', 'Sube la foto de una receta o de un informe: la IA lee medicamentos, dosis y duración. Tú revisas y confirmas.', "Téléversez la photo d'une ordonnance ou d'un compte rendu : l'IA lit les médicaments, les dosages et la durée. Vous vérifiez et confirmez.", 'Lade ein Foto eines Rezepts oder Befunds hoch: Die KI liest Medikamente, Dosierungen und Dauer. Du prüfst und bestätigst.'],
  ['Scegli o trascina una foto', 'Choose or drag a photo', 'Elige o arrastra una foto', 'Choisissez ou glissez une photo', 'Foto auswählen oder hierher ziehen'],
  ['JPG o PNG', 'JPG or PNG', 'JPG o PNG', 'JPG ou PNG', 'JPG oder PNG'],
  ['Anteprima', 'Preview', 'Vista previa', 'Aperçu', 'Vorschau'],
  ['Analizza con AI', 'Analyze with AI', 'Analizar con IA', "Analyser avec l'IA", 'Mit KI analysieren'],
  ['Non ho trovato farmaci nel documento. Prova con una foto più nitida o inserisci a mano.', 'I did not find any medications in the document. Try a sharper photo or enter them manually.', 'No encontré medicamentos en el documento. Prueba con una foto más nítida o introdúcelos a mano.', "Je n'ai trouvé aucun médicament dans le document. Essayez avec une photo plus nette ou saisissez-les à la main.", 'Ich habe im Dokument keine Medikamente gefunden. Versuche ein schärferes Foto oder gib sie manuell ein.'],
  ['Inserisci a mano', 'Enter manually', 'Introducir a mano', 'Saisir à la main', 'Manuell eingeben'],
  ['Farmaco', 'Medication', 'Medicamento', 'Médicament', 'Medikament'],
  ['Rimuovi', 'Remove', 'Quitar', 'Retirer', 'Entfernen'],
  ['Dosaggio', 'Dosage', 'Dosis', 'Dosage', 'Dosierung'],
  ['es. 500 mg', 'e.g. 500 mg', 'p. ej. 500 mg', 'ex. 500 mg', 'z. B. 500 mg'],
  ['Dosi al giorno', 'Doses per day', 'Dosis al día', 'Prises par jour', 'Dosen pro Tag'],
  ['Inizio', 'Start', 'Inicio', 'Début', 'Beginn'],
  ['Fine', 'End', 'Fin', 'Fin', 'Ende'],
  ['Controlla e conferma', 'Check and confirm', 'Revisa y confirma', 'Vérifiez et confirmez', 'Prüfen und bestätigen'],
  ['Malattia / motivo della cura', 'Illness / reason for treatment', 'Enfermedad / motivo del tratamiento', 'Maladie / motif du traitement', 'Krankheit / Grund der Behandlung'],
  ['es. Influenza, Bronchite…', 'e.g. Flu, Bronchitis…', 'p. ej. Gripe, Bronquitis…', 'ex. Grippe, Bronchite…', 'z. B. Grippe, Bronchitis…'],
  ['Aggiungi farmaco', 'Add medication', 'Añadir medicamento', 'Ajouter un médicament', 'Medikament hinzufügen'],
  ['Salva terapie', 'Save therapies', 'Guardar tratamientos', 'Enregistrer les traitements', 'Therapien speichern'],
  ['Aggiungi almeno un farmaco.', 'Add at least one medication.', 'Añade al menos un medicamento.', 'Ajoutez au moins un médicament.', 'Füge mindestens ein Medikament hinzu.'],
  ['Terapie salvate: le notifiche sono programmate.', 'Therapies saved: notifications are scheduled.', 'Tratamientos guardados: las notificaciones están programadas.', 'Traitements enregistrés : les notifications sont programmées.', 'Therapien gespeichert: Die Benachrichtigungen sind geplant.'],
  // --- terapie ---
  ['Nuova', 'New', 'Nueva', 'Nouveau', 'Neu'],
  ['Tocca una terapia per vedere orari e avanzamento.', 'Tap a therapy to see times and progress.', 'Toca un tratamiento para ver horarios y progreso.', "Touchez un traitement pour voir les horaires et l'avancement.", 'Tippe auf eine Therapie, um Zeiten und Fortschritt zu sehen.'],
  [/^(\d+) dos[ei]\/giorno · fino al (.+)$/, '$1 dose(s)/day · until $2', '$1 dosis/día · hasta el $2', "$1 prise(s)/jour · jusqu'au $2", '$1 Dosis/Tag · bis $2'],
  ['Malattia', 'Illness', 'Enfermedad', 'Maladie', 'Krankheit'],
  ['Orari', 'Times', 'Horarios', 'Horaires', 'Zeiten'],
  ['Periodo', 'Period', 'Periodo', 'Période', 'Zeitraum'],
  ['Prossima dose', 'Next dose', 'Próxima dosis', 'Prochaine prise', 'Nächste Dosis'],
  [/^(\S+) ore (\d{2}:\d{2})$/, '$1 at $2', '$1 a las $2', '$1 à $2', '$1 um $2'],
  [/^Giorno (\d+) di (\d+)$/, 'Day $1 of $2', 'Día $1 de $2', 'Jour $1 sur $2', 'Tag $1 von $2'],
  ['Elimina terapia', 'Delete therapy', 'Eliminar tratamiento', 'Supprimer le traitement', 'Therapie löschen'],
  ['Nessuna terapia attiva', 'No active therapies', 'Ningún tratamiento activo', 'Aucun traitement actif', 'Keine aktiven Therapien'],
  ['Scansiona un documento medico o inserisci una terapia a mano.', 'Scan a medical document or enter a therapy manually.', 'Escanea un documento médico o introduce un tratamiento a mano.', 'Scannez un document médical ou saisissez un traitement à la main.', 'Scanne ein medizinisches Dokument oder gib eine Therapie manuell ein.'],
  ['Aggiungi terapia', 'Add therapy', 'Añadir tratamiento', 'Ajouter un traitement', 'Therapie hinzufügen'],
  ['Eliminare questa terapia e le sue notifiche?', 'Delete this therapy and its notifications?', '¿Eliminar este tratamiento y sus notificaciones?', 'Supprimer ce traitement et ses notifications ?', 'Diese Therapie und ihre Benachrichtigungen löschen?'],
  ['Terapia eliminata.', 'Therapy deleted.', 'Tratamiento eliminado.', 'Traitement supprimé.', 'Therapie gelöscht.'],
  // --- registro malattie ---
  ['Registro malattie', 'Illness log', 'Registro de enfermedades', 'Registre des maladies', 'Krankheitsregister'],
  ['Lo storico completo di malattie, farmaci, dosaggi e date.', 'The complete history of illnesses, medications, dosages and dates.', 'El historial completo de enfermedades, medicamentos, dosis y fechas.', "L'historique complet des maladies, médicaments, dosages et dates.", 'Der vollständige Verlauf von Krankheiten, Medikamenten, Dosierungen und Daten.'],
  ['Cerca malattia o farmaco…', 'Search illness or medication…', 'Buscar enfermedad o medicamento…', 'Rechercher une maladie ou un médicament…', 'Krankheit oder Medikament suchen…'],
  [/^(\S+) → in corso$/, '$1 → ongoing', '$1 → en curso', '$1 → en cours', '$1 → laufend'],
  ['Guarita', 'Recovered', 'Curada', 'Guérie', 'Genesen'],
  ['in corso', 'ongoing', 'en curso', 'en cours', 'laufend'],
  ['conclusa', 'completed', 'concluido', 'terminé', 'abgeschlossen'],
  [/^(\d+) dos[ei]\/giorno · dal (\S+) al (\S+) · (in corso|conclusa)$/, '$1 dose(s)/day · from $2 to $3 · $4', '$1 dosis/día · del $2 al $3 · $4', '$1 prise(s)/jour · du $2 au $3 · $4', '$1 Dosis/Tag · vom $2 bis $3 · $4'],
  ['Nessun risultato', 'No results', 'Sin resultados', 'Aucun résultat', 'Keine Ergebnisse'],
  ['Il registro è vuoto', 'The log is empty', 'El registro está vacío', 'Le registre est vide', 'Das Register ist leer'],
  ['Prova con un altro termine.', 'Try a different term.', 'Prueba con otro término.', 'Essayez un autre terme.', 'Versuche einen anderen Begriff.'],
  ['Le malattie compaiono qui quando salvi una terapia.', 'Illnesses appear here when you save a therapy.', 'Las enfermedades aparecen aquí cuando guardas un tratamiento.', "Les maladies apparaissent ici lorsque vous enregistrez un traitement.", 'Krankheiten erscheinen hier, sobald du eine Therapie speicherst.'],
  // --- assistente ---
  ['Risponde usando i tuoi dati reali: terapie, dosi e registro malattie.', 'Answers using your real data: therapies, doses and illness log.', 'Responde usando tus datos reales: tratamientos, dosis y registro de enfermedades.', 'Répond à partir de vos données réelles : traitements, prises et registre des maladies.', 'Antwortet anhand deiner echten Daten: Therapien, Dosen und Krankheitsregister.'],
  ['Quali farmaci sto prendendo?', 'Which medications am I taking?', '¿Qué medicamentos estoy tomando?', 'Quels médicaments suis-je en train de prendre ?', 'Welche Medikamente nehme ich gerade?'],
  ['Quando finisce la mia terapia?', 'When does my therapy end?', '¿Cuándo termina mi tratamiento?', 'Quand mon traitement se termine-t-il ?', 'Wann endet meine Therapie?'],
  ['Qual è la prossima dose?', 'What is my next dose?', '¿Cuál es la próxima dosis?', 'Quelle est la prochaine prise ?', 'Was ist meine nächste Dosis?'],
  ['Cosa ho avuto in passato?', 'What have I had in the past?', '¿Qué he tenido en el pasado?', "Qu'ai-je eu par le passé ?", 'Was hatte ich in der Vergangenheit?'],
  ['Scrivi una domanda…', 'Write a question…', 'Escribe una pregunta…', 'Écrivez une question…', 'Stelle eine Frage…'],
  ['Invia', 'Send', 'Enviar', 'Envoyer', 'Senden'],
  [/^Ciao (.+)! Chiedimi pure delle tue terapie o del tuo storico\.$/, 'Hi $1! Feel free to ask me about your therapies or your history.', '¡Hola $1! Pregúntame lo que quieras sobre tus tratamientos o tu historial.', 'Bonjour $1 ! Posez-moi vos questions sur vos traitements ou votre historique.', 'Hallo $1! Frag mich gern nach deinen Therapien oder deinem Verlauf.'],
  // --- impostazioni / profilo ---
  ['Impostazioni', 'Settings', 'Ajustes', 'Réglages', 'Einstellungen'],
  ['Notifiche e account.', 'Notifications and account.', 'Notificaciones y cuenta.', 'Notifications et compte.', 'Benachrichtigungen und Konto.'],
  ['Notifiche', 'Notifications', 'Notificaciones', 'Notifications', 'Benachrichtigungen'],
  ['Attive', 'On', 'Activadas', 'Activées', 'Aktiv'],
  ['Bloccate dal browser', 'Blocked by the browser', 'Bloqueadas por el navegador', 'Bloquées par le navigateur', 'Vom Browser blockiert'],
  ['Non ancora attivate', 'Not enabled yet', 'Aún no activadas', 'Pas encore activées', 'Noch nicht aktiviert'],
  ['Non supportate', 'Not supported', 'No compatibles', 'Non prises en charge', 'Nicht unterstützt'],
  ["Promemoria per ogni dose, con avviso sull'ultima.", 'A reminder for every dose, with a warning on the last one.', 'Un recordatorio para cada dosis, con aviso en la última.', "Un rappel pour chaque prise, avec un avertissement pour la dernière.", 'Eine Erinnerung für jede Dosis, mit Hinweis auf die letzte.'],
  ['Invia prova', 'Send test', 'Enviar prueba', 'Envoyer un test', 'Test senden'],
  ['Account', 'Account', 'Cuenta', 'Compte', 'Konto'],
  ['Esci', 'Log out', 'Cerrar sesión', 'Se déconnecter', 'Abmelden'],
  ['Cancella tutti i dati', 'Delete all data', 'Borrar todos los datos', 'Supprimer toutes les données', 'Alle Daten löschen'],
  ['Cancellare TUTTI i dati (account, terapie, registro) da questo browser? Non si può annullare.', 'Delete ALL data (account, therapies, log) from this browser? This cannot be undone.', '¿Borrar TODOS los datos (cuenta, tratamientos, registro) de este navegador? No se puede deshacer.', 'Supprimer TOUTES les données (compte, traitements, registre) de ce navigateur ? Cette action est irréversible.', 'ALLE Daten (Konto, Therapien, Register) aus diesem Browser löschen? Das lässt sich nicht rückgängig machen.'],
  // --- navigazione ---
  ['Dashboard', 'Dashboard', 'Panel', 'Tableau de bord', 'Übersicht'],
  ['Home', 'Home', 'Inicio', 'Accueil', 'Start'],
  ['Scansiona', 'Scan', 'Escanear', 'Scanner', 'Scannen'],
  ['Terapie', 'Therapies', 'Tratamientos', 'Traitements', 'Therapien'],
  ['Registro', 'Log', 'Registro', 'Registre', 'Register'],
  ['Profilo', 'Profile', 'Perfil', 'Profil', 'Profil'],
  // --- nuove funzioni: mi sento male, PDF, appuntamenti, referti ---
  ["Mi sento male", "I feel unwell", "Me siento mal", "Je me sens mal", "Mir geht es schlecht"],
  ["Esporta PDF", "Export PDF", "Exportar PDF", "Exporter en PDF", "PDF exportieren"],
  ["Sto meglio", "I feel better", "Me siento mejor", "Je me sens mieux", "Mir geht es besser"],
  ["Hai un episodio di sintomi aperto. Quando ti senti meglio, chiudilo.", "You have an open symptom episode. When you feel better, close it.", "Tienes un episodio de síntomas abierto. Cuando te sientas mejor, ciérralo.", "Vous avez un épisode de symptômes en cours. Quand vous vous sentez mieux, clôturez-le.", "Du hast eine offene Symptom-Episode. Wenn es dir besser geht, schließe sie."],
  ["Prossimi appuntamenti", "Upcoming appointments", "Próximas citas", "Prochains rendez-vous", "Nächste Termine"],
  ["Gestisci", "Manage", "Gestionar", "Gérer", "Verwalten"],
  ["Nessun appuntamento in programma", "No appointments scheduled", "No hay citas programadas", "Aucun rendez-vous prévu", "Keine Termine geplant"],
  ["Appuntamenti", "Appointments", "Citas", "Rendez-vous", "Termine"],
  ["Referti", "Lab reports", "Informes", "Résultats", "Befunde"],
  ["Descrivi cosa senti", "Describe what you feel", "Describe lo que sientes", "Décrivez ce que vous ressentez", "Beschreibe, was du spürst"],
  ["es. mal di gola e febbre da ieri sera…", "e.g. sore throat and fever since last night…", "p. ej. dolor de garganta y fiebre desde anoche…", "ex. mal de gorge et fièvre depuis hier soir…", "z. B. Halsschmerzen und Fieber seit gestern Abend…"],
  ["Segnalando i sintomi il tuo stato diventa \"In trattamento\"; l'AI li confronta con il tuo storico.", "By reporting symptoms your status becomes \"In treatment\"; the AI compares them with your history.", "Al indicar los síntomas tu estado pasa a \"En tratamiento\"; la IA los compara con tu historial.", "En signalant des symptômes, votre statut passe à « En traitement » ; l'IA les compare à votre historique.", "Wenn du Symptome meldest, wechselt dein Status auf „In Behandlung“; die KI vergleicht sie mit deinem Verlauf."],
  ["Annulla", "Cancel", "Cancelar", "Annuler", "Abbrechen"],
  ["Chiudi", "Close", "Cerrar", "Fermer", "Schließen"],
  ["Analizza sintomi", "Analyze symptoms", "Analizar síntomas", "Analyser les symptômes", "Symptome analysieren"],
  ["Descrivi i sintomi prima di continuare.", "Describe your symptoms before continuing.", "Describe los síntomas antes de continuar.", "Décrivez vos symptômes avant de continuer.", "Beschreibe deine Symptome, bevor du fortfährst."],
  ["Analisi dei sintomi", "Symptom analysis", "Análisis de los síntomas", "Analyse des symptômes", "Symptomanalyse"],
  ["Sintomi salvati, ma l'analisi non è disponibile:", "Symptoms saved, but the analysis is not available:", "Síntomas guardados, pero el análisis no está disponible:", "Symptômes enregistrés, mais l'analyse n'est pas disponible :", "Symptome gespeichert, aber die Analyse ist nicht verfügbar:"],
  ["Sintomi segnalati", "Reported symptoms", "Síntomas comunicados", "Symptômes signalés", "Gemeldete Symptome"],
  ["Episodio di sintomi", "Symptom episode", "Episodio de síntomas", "Épisode de symptômes", "Symptom-Episode"],
  ["PDF esportato.", "PDF exported.", "PDF exportado.", "PDF exporté.", "PDF exportiert."],
  ["Libreria PDF non caricata: controlla la connessione e riprova.", "PDF library not loaded: check your connection and try again.", "Biblioteca PDF no cargada: revisa la conexión e inténtalo de nuevo.", "Bibliothèque PDF non chargée : vérifiez la connexion et réessayez.", "PDF-Bibliothek nicht geladen: Prüfe die Verbindung und versuche es erneut."],
  ["Aggiungi visite ed esami: ti avvisiamo quando arriva il momento.", "Add visits and tests: we will notify you when the time comes.", "Añade visitas y pruebas: te avisamos cuando llegue el momento.", "Ajoutez visites et examens : nous vous prévenons au bon moment.", "Füge Arztbesuche und Untersuchungen hinzu: Wir erinnern dich rechtzeitig."],
  ["Nuovo appuntamento", "New appointment", "Nueva cita", "Nouveau rendez-vous", "Neuer Termin"],
  ["Titolo", "Title", "Título", "Titre", "Titel"],
  ["es. Visita cardiologo", "e.g. Cardiologist visit", "p. ej. Visita al cardiólogo", "ex. Visite chez le cardiologue", "z. B. Besuch beim Kardiologen"],
  ["Data", "Date", "Fecha", "Date", "Datum"],
  ["Ora", "Time", "Hora", "Heure", "Uhrzeit"],
  ["Note (facoltative)", "Notes (optional)", "Notas (opcional)", "Notes (facultatif)", "Notizen (optional)"],
  ["Aggiungi appuntamento", "Add appointment", "Añadir cita", "Ajouter le rendez-vous", "Termin hinzufügen"],
  ["Aggiungine uno qui sopra per ricevere un promemoria.", "Add one above to get a reminder.", "Añade una arriba para recibir un recordatorio.", "Ajoutez-en un ci-dessus pour recevoir un rappel.", "Füge oben einen hinzu, um eine Erinnerung zu erhalten."],
  ["Passati", "Past", "Pasadas", "Passés", "Vergangene"],
  ["Elimina", "Delete", "Eliminar", "Supprimer", "Löschen"],
  ["Appuntamento aggiunto.", "Appointment added.", "Cita añadida.", "Rendez-vous ajouté.", "Termin hinzugefügt."],
  ["Appuntamento eliminato.", "Appointment deleted.", "Cita eliminada.", "Rendez-vous supprimé.", "Termin gelöscht."],
  ["Inserisci il titolo dell'appuntamento.", "Enter the appointment title.", "Introduce el título de la cita.", "Saisissez le titre du rendez-vous.", "Gib den Titel des Termins ein."],
  ["Data o ora non valide.", "Invalid date or time.", "Fecha u hora no válidas.", "Date ou heure invalide.", "Ungültiges Datum oder ungültige Uhrzeit."],
  ["Eliminare questo appuntamento?", "Delete this appointment?", "¿Eliminar esta cita?", "Supprimer ce rendez-vous ?", "Diesen Termin löschen?"],
  ["Appuntamento", "Appointment", "Cita", "Rendez-vous", "Termin"],
  ["Oggi hai un appuntamento:", "Today you have an appointment:", "Hoy tienes una cita:", "Aujourd'hui, vous avez un rendez-vous :", "Heute hast du einen Termin:"],
  ["alle", "at", "a las", "à", "um"],
  ["Per ricevere i promemoria attiva le notifiche dalla Home o dalle Impostazioni.", "To receive reminders, turn on notifications from Home or Settings.", "Para recibir recordatorios, activa las notificaciones desde Inicio o Ajustes.", "Pour recevoir les rappels, activez les notifications depuis l'accueil ou les réglages.", "Aktiviere die Benachrichtigungen auf der Startseite oder in den Einstellungen, um Erinnerungen zu erhalten."],
  [/^(\S+) · ore (\S+)$/, "$1 · at $2", "$1 · a las $2", "$1 · à $2", "$1 · $2 Uhr"],
  ["Referto di laboratorio", "Lab report", "Informe de laboratorio", "Résultats de laboratoire", "Laborbefund"],
  ["Prescrizione / Ricetta", "Prescription", "Receta", "Ordonnance", "Rezept"],
  ["Scegli o trascina una foto o un PDF", "Choose or drag a photo or a PDF", "Elige o arrastra una foto o un PDF", "Choisissez ou glissez une photo ou un PDF", "Wähle oder ziehe ein Foto oder PDF"],
  ["JPG, PNG o PDF", "JPG, PNG or PDF", "JPG, PNG o PDF", "JPG, PNG ou PDF", "JPG, PNG oder PDF"],
  ["Data del referto", "Report date", "Fecha del informe", "Date des résultats", "Datum des Befunds"],
  ["Esame", "Test", "Prueba", "Examen", "Untersuchung"],
  ["Valore", "Value", "Valor", "Valeur", "Wert"],
  ["Unità", "Unit", "Unidad", "Unité", "Einheit"],
  ["Intervallo di riferimento", "Reference range", "Intervalo de referencia", "Intervalle de référence", "Referenzbereich"],
  ["Intervallo", "Range", "Intervalo", "Intervalle", "Bereich"],
  ["Stato", "Status", "Estado", "Statut", "Status"],
  ["Normale", "Normal", "Normal", "Normal", "Normal"],
  ["Alto", "High", "Alto", "Élevé", "Hoch"],
  ["Basso", "Low", "Bajo", "Bas", "Niedrig"],
  ["Aggiungi esame", "Add test", "Añadir prueba", "Ajouter un examen", "Untersuchung hinzufügen"],
  ["Salva referto", "Save report", "Guardar informe", "Enregistrer les résultats", "Befund speichern"],
  ["Non ho trovato valori nel referto. Prova con una foto più nitida o aggiungili a mano.", "I found no values in the report. Try a sharper photo or add them by hand.", "No he encontrado valores en el informe. Prueba con una foto más nítida o añádelos a mano.", "Je n'ai trouvé aucune valeur dans les résultats. Essayez une photo plus nette ou ajoutez-les à la main.", "Ich habe keine Werte im Befund gefunden. Versuche es mit einem schärferen Foto oder füge sie von Hand hinzu."],
  ["Aggiungi almeno un esame con nome e valore.", "Add at least one test with a name and a value.", "Añade al menos una prueba con nombre y valor.", "Ajoutez au moins un examen avec un nom et une valeur.", "Füge mindestens eine Untersuchung mit Name und Wert hinzu."],
  ["Referto salvato.", "Report saved.", "Informe guardado.", "Résultats enregistrés.", "Befund gespeichert."],
  [/^Referto del (.+)$/, "Report of $1", "Informe del $1", "Résultats du $1", "Befund vom $1"],
  [/^(\d+) esam[ei]$/, "$1 tests", "$1 pruebas", "$1 examens", "$1 Untersuchungen"],
  [/^(\d+) fuori range$/, "$1 out of range", "$1 fuera de rango", "$1 hors plage", "$1 außerhalb des Bereichs"],
  ["Nella norma", "Within range", "Dentro de lo normal", "Dans la norme", "Im Normbereich"],
  ["Nessun referto salvato", "No saved reports", "Ningún informe guardado", "Aucun résultat enregistré", "Keine gespeicherten Befunde"],
  ["Scansiona un referto di laboratorio per consultarne i valori qui.", "Scan a lab report to see its values here.", "Escanea un informe de laboratorio para consultar aquí sus valores.", "Scannez des résultats de laboratoire pour en consulter les valeurs ici.", "Scanne einen Laborbefund, um die Werte hier einzusehen."],
  ["Scansiona un referto", "Scan a report", "Escanear un informe", "Scanner des résultats", "Befund scannen"],
  ["Elimina referto", "Delete report", "Eliminar informe", "Supprimer les résultats", "Befund löschen"],
  ["Eliminare questo referto?", "Delete this report?", "¿Eliminar este informe?", "Supprimer ces résultats ?", "Diesen Befund löschen?"],
  ["Referto eliminato.", "Report deleted.", "Informe eliminado.", "Résultats supprimés.", "Befund gelöscht."],
  ["Il PDF è troppo grande (max 3 MB).", "The PDF is too large (max 3 MB).", "El PDF es demasiado grande (máx. 3 MB).", "Le PDF est trop volumineux (max. 3 Mo).", "Das PDF ist zu groß (max. 3 MB)."],
  ["Impossibile leggere il file.", "Unable to read the file.", "No se pudo leer el archivo.", "Impossible de lire le fichier.", "Die Datei konnte nicht gelesen werden."],
  ["I valori dei tuoi esami di laboratorio. In rosso quelli fuori dall'intervallo di riferimento.", "The values of your lab tests. Those outside the reference range are in red.", "Los valores de tus análisis de laboratorio. En rojo los que están fuera del intervalo de referencia.", "Les valeurs de vos analyses de laboratoire. En rouge celles hors de l'intervalle de référence.", "Die Werte deiner Laboruntersuchungen. Rot: außerhalb des Referenzbereichs."],
  ["Risponde usando i tuoi dati reali: terapie, dosi, registro malattie e referti.", "It answers using your real data: therapies, doses, illness log and lab reports.", "Responde con tus datos reales: tratamientos, dosis, registro de enfermedades e informes.", "Il répond à partir de vos données réelles : traitements, prises, registre des maladies et résultats.", "Antwortet mit deinen echten Daten: Therapien, Dosen, Krankheitsregister und Befunde."],
  ["Com'era il mio colesterolo nell'ultimo referto?", "What was my cholesterol in the latest report?", "¿Cómo estaba mi colesterol en el último informe?", "Comment était mon cholestérol dans les derniers résultats ?", "Wie war mein Cholesterin im letzten Befund?"],
  ["Scarica l'app", "Download the app", "Descargar la app", "Télécharger l'app", "App herunterladen"],
  ["App", "App", "App", "App", "App"],
  ["Installa Sanilyx sul telefono o sul computer: si apre in una finestra tutta sua, come una vera app, con la sua icona.", "Install Sanilyx on your phone or computer: it opens in its own window, like a real app, with its own icon.", "Instala Sanilyx en el móvil o en el ordenador: se abre en su propia ventana, como una app de verdad, con su icono.", "Installez Sanilyx sur votre téléphone ou ordinateur : elle s'ouvre dans sa propre fenêtre, comme une vraie app, avec sa propre icône.", "Installiere Sanilyx auf Handy oder Computer: Sie öffnet sich in einem eigenen Fenster wie eine echte App, mit eigenem Symbol."],
  ["Installa Sanilyx", "Install Sanilyx", "Instalar Sanilyx", "Installer Sanilyx", "Sanilyx installieren"],
  ["iPhone / iPad (Safari): tocca il pulsante Condividi, poi \"Aggiungi alla schermata Home\".", "iPhone / iPad (Safari): tap the Share button, then \"Add to Home Screen\".", "iPhone / iPad (Safari): toca el botón Compartir y luego \"Añadir a pantalla de inicio\".", "iPhone / iPad (Safari) : touchez le bouton Partager, puis « Sur l'écran d'accueil ».", "iPhone / iPad (Safari): Tippe auf „Teilen“ und dann auf „Zum Home-Bildschirm“."],
  ["Android (Chrome): apri il menu ⋮ e scegli \"Installa app\" (o \"Aggiungi a schermata Home\").", "Android (Chrome): open the ⋮ menu and choose \"Install app\" (or \"Add to Home screen\").", "Android (Chrome): abre el menú ⋮ y elige \"Instalar app\" (o \"Añadir a pantalla de inicio\").", "Android (Chrome) : ouvrez le menu ⋮ et choisissez « Installer l'application » (ou « Ajouter à l'écran d'accueil »).", "Android (Chrome): Öffne das Menü ⋮ und wähle „App installieren“ (oder „Zum Startbildschirm hinzufügen“)."],
  ["Computer (Chrome / Edge): clicca l'icona di installazione nella barra degli indirizzi, oppure menu ⋮ → \"Installa Sanilyx\".", "Computer (Chrome / Edge): click the install icon in the address bar, or menu ⋮ → \"Install Sanilyx\".", "Ordenador (Chrome / Edge): haz clic en el icono de instalación de la barra de direcciones, o menú ⋮ → \"Instalar Sanilyx\".", "Ordinateur (Chrome / Edge) : cliquez sur l'icône d'installation dans la barre d'adresse, ou menu ⋮ → « Installer Sanilyx ».", "Computer (Chrome / Edge): Klicke auf das Installationssymbol in der Adressleiste oder Menü ⋮ → „Sanilyx installieren“."],
  ["Per installare serve aprire il sito da https (o da localhost).", "To install, the site must be opened over https (or localhost).", "Para instalar hay que abrir el sitio por https (o localhost).", "Pour installer, le site doit être ouvert en https (ou localhost).", "Zum Installieren muss die Seite über https (oder localhost) geöffnet werden."],
  ["App installata.", "App installed.", "App instalada.", "App installée.", "App installiert."],
  ["Per sicurezza, ti consiglio di farti visitare da un medico. Questa è un'AI e non sostituisce un professionista sanitario.", "For safety, I recommend seeing a doctor. This is an AI and does not replace a healthcare professional.", "Por seguridad, te aconsejo que te vea un médico. Esto es una IA y no sustituye a un profesional sanitario.", "Par sécurité, je vous conseille de consulter un médecin. Ceci est une IA et ne remplace pas un professionnel de santé.", "Zur Sicherheit empfehle ich dir, einen Arzt aufzusuchen. Dies ist eine KI und ersetzt keine medizinische Fachperson."]
];

const _IDX = { en: 1, es: 2, fr: 3, de: 4 };
const _ESATTI = new Map(), _MODELLI = [];
TESTI.forEach(r => r[0] instanceof RegExp ? _MODELLI.push(r) : _ESATTI.set(r[0], r));

// tr(): traduce un testo italiano nella lingua corrente (se non lo conosce lo restituisce uguale)
function tr(s) {
  if (LANG === 'it' || typeof s !== 'string') return s;
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/), core = m[2];       // spazi attorno: li conserviamo
  if (!core) return s;
  const r = _ESATTI.get(core);
  if (r) return m[1] + r[_IDX[LANG]] + m[3];
  for (const p of _MODELLI) {
    const x = core.match(p[0]);
    if (x) return m[1] + p[_IDX[LANG]].replace(/\$(\d)/g, (_, n) => tr(x[n])) + m[3];
  }
  return s;
}

/* Traduzione automatica della pagina: ogni nodo ricorda l'originale italiano ("src") e l'ultimo
   testo scritto da noi ("out"). Se il codice dell'app riscrive il nodo, out ≠ testo attuale e
   il nuovo testo diventa il nuovo originale. Così si può passare da una lingua all'altra. */
const _ATTR = ['placeholder', 'title', 'aria-label', 'alt'], _SALTA = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT']);
const _memo = new WeakMap();
function _traduciTesto(n) {
  const cur = n.data, rec = _memo.get(n), src = rec && rec.out === cur ? rec.src : cur, out = tr(src);
  if (out !== cur) n.data = out;
  _memo.set(n, { src, out });
}
function _traduciAttr(el, a) {
  const cur = el.getAttribute(a); if (cur == null) return;
  const memo = el._i18n || (el._i18n = {}), rec = memo[a], src = rec && rec.out === cur ? rec.src : cur, out = tr(src);
  if (out !== cur) el.setAttribute(a, out);
  memo[a] = { src, out };
}
function traduciAlbero(root) {
  if (root.nodeType === 3) { if (root.parentNode && !_SALTA.has(root.parentNode.nodeName)) _traduciTesto(root); return; }
  if (root.nodeType !== 1 || _SALTA.has(root.nodeName)) return;
  _ATTR.forEach(a => _traduciAttr(root, a));
  const w = document.createTreeWalker(root, 5, { acceptNode: n => _SALTA.has(n.nodeName) ? 2 : 1 });   // 5 = elementi+testo; 2 = salta
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? _traduciTesto(n) : _ATTR.forEach(a => _traduciAttr(n, a));
}
new MutationObserver(ms => {
  if (LANG === 'it') return;                                       // in italiano non c'è nulla da fare
  for (const m of ms) {
    if (m.type === 'characterData') traduciAlbero(m.target);
    else if (m.type === 'attributes') _traduciAttr(m.target, m.attributeName);
    else m.addedNodes.forEach(traduciAlbero);
  }
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: _ATTR });

// Finestre native: il testo passa da tr()
const _confirmNativo = window.confirm.bind(window);
window.confirm = s => _confirmNativo(tr(s));

// Menu a tendina della lingua (si può mettere ovunque: i menu con class="lang-sel" restano sincronizzati)
const selettoreLingua = () => `<select class="lang-sel" aria-label="Lingua">${Object.entries(LINGUE).map(([k, n]) => `<option value="${k}" ${k === LANG ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
document.addEventListener('change', e => { if (e.target.matches && e.target.matches('select.lang-sel')) impostaLingua(e.target.value); });
document.querySelectorAll('[data-lang-sel]').forEach(el => { el.outerHTML = selettoreLingua(); });

function impostaLingua(l) {                                        // chiamata quando l'utente sceglie una lingua
  if (!LINGUE[l]) return;
  LANG = l;
  try { localStorage.setItem(LANG_KEY, l); } catch (e) {}
  document.documentElement.lang = l;
  traduciAlbero(document.documentElement);                         // tutto ciò che è già a schermo
  document.querySelectorAll('select.lang-sel').forEach(s => { s.value = l; });
  if (typeof UTENTE !== 'undefined' && UTENTE) sincronizzaSW(UTENTE.id);   // rinnova i testi delle notifiche già programmate
}
document.documentElement.lang = LANG;
traduciAlbero(document.documentElement);                           // prima passata (caricamento, schermata di accesso…)

/* ---------- 3. DATABASE SQLITE (sql.js = SQLite in WebAssembly) ----------
   GUIDA RAPIDA
   1) INIZIALIZZARE:  SQL = await initSqlJs({locateFile})  carica il motore .wasm;
                      new SQL.Database()  crea un DB vuoto in memoria;
                      new SQL.Database(bytes)  ne riapre uno salvato.
   2) SCRIVERE:       db.run("INSERT ... VALUES (?,?)", [a, b])   (i ? evitano SQL injection)
   3) LEGGERE:        stmt = db.prepare("SELECT ... WHERE id=?"); stmt.bind([1]);
                      while (stmt.step()) rows.push(stmt.getAsObject());   → funzione q()
   4) SALVARE:        db.export() restituisce i byte del file .sqlite → li convertiamo in
                      base64 e li mettiamo in localStorage  (funzione salva()).
   5) RICARICARE:     all'avvio leggiamo il base64, lo riconvertiamo in byte e lo passiamo
                      a new SQL.Database(bytes). Così i dati sopravvivono al refresh.   */
const DB_KEY = 'sanilyx_db';
let SQL, db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS utenti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- "salt:sha256(salt+password)"
  stato TEXT NOT NULL DEFAULT 'Sano'    -- 'Sano' oppure 'In trattamento'
);
CREATE TABLE IF NOT EXISTS farmaci (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  dosaggio TEXT,
  UNIQUE(nome, dosaggio)
);
CREATE TABLE IF NOT EXISTS malattie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utente_id INTEGER NOT NULL,
  nome TEXT NOT NULL,
  data_inizio TEXT NOT NULL,
  data_fine TEXT                        -- NULL = ancora in corso
);
CREATE TABLE IF NOT EXISTS terapie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utente_id INTEGER NOT NULL,
  farmaco_id INTEGER NOT NULL,
  malattia_id INTEGER,                  -- (aggiunta) collega la terapia alla malattia
  frequenza INTEGER NOT NULL DEFAULT 1, -- (aggiunta) dosi al giorno
  data_inizio TEXT NOT NULL,
  data_fine TEXT NOT NULL,
  stato TEXT NOT NULL DEFAULT 'attiva'  -- 'attiva' oppure 'conclusa'
);
CREATE TABLE IF NOT EXISTS notifiche (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terapia_id INTEGER NOT NULL,
  orario TEXT NOT NULL,                 -- "2026-10-16 08:00": una riga per ogni dose
  inviata INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessioni (   -- (aggiunta) per validare il token di sessione
  token TEXT PRIMARY KEY,
  utente_id INTEGER NOT NULL,
  scadenza INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS appuntamenti (   -- (aggiunta) promemoria di visite ed esami
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utente_id INTEGER NOT NULL,
  titolo TEXT NOT NULL,
  data TEXT NOT NULL,                   -- "2026-10-16"
  ora TEXT NOT NULL,                    -- "15:30"
  note TEXT,
  notificato INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS episodi_sintomi (   -- (aggiunta) "Mi sento male": sintomi + risposta AI
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utente_id INTEGER NOT NULL,
  malattia_id INTEGER NOT NULL,         -- la malattia "Sintomi segnalati"
  data TEXT NOT NULL,                   -- "2026-10-16 21:40"
  sintomi TEXT NOT NULL,
  risposta TEXT                         -- analisi dell AI (NULL se non e arrivata)
);
CREATE TABLE IF NOT EXISTS referti (    -- (aggiunta) referti di laboratorio
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utente_id INTEGER NOT NULL,
  data TEXT NOT NULL,                   -- data del referto
  creato TEXT NOT NULL                  -- quando lo hai salvato
);
CREATE TABLE IF NOT EXISTS esami_lab (  -- (aggiunta) un valore per riga
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referto_id INTEGER NOT NULL,
  nome TEXT NOT NULL,
  valore TEXT NOT NULL,
  unita TEXT,
  intervallo TEXT,                      -- intervallo di riferimento (NULL se non scritto)
  stato TEXT                            -- 'normale' | 'alto' | 'basso' (NULL se non determinabile)
);`;

const bytesToB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

async function initDB() {
  SQL = await initSqlJs({ locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${f}` });
  const salvato = localStorage.getItem(DB_KEY);
  db = salvato ? new SQL.Database(b64ToBytes(salvato)) : new SQL.Database(); // parte VUOTO
  db.run(SCHEMA);                                  // crea le tabelle se mancano
}
function salva() { localStorage.setItem(DB_KEY, bytesToB64(db.export())); }

// Lettura: restituisce un array di oggetti {colonna: valore}
function q(sql, params = []) {
  const st = db.prepare(sql); st.bind(params);
  const righe = []; while (st.step()) righe.push(st.getAsObject());
  st.free(); return righe;
}
// Scrittura: NON salva da sola (così possiamo raggruppare molte scritture e chiamare salva() una volta)
function run(sql, params = []) { db.run(sql, params); }
// Inserimento che restituisce l'id creato (NB: va letto PRIMA di salva(), che riapre la connessione)
function inserisci(sql, params = []) { db.run(sql, params); return q('SELECT last_insert_rowid() AS id')[0].id; }

/* ---------- 4. AUTENTICAZIONE ---------- */
// Password = SHA-256 con SALT casuale diverso per ogni utente. Salviamo "salt:hash".
async function sha256Hex(testo) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(testo));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(pw) { const salt = randomHex(16); return `${salt}:${await sha256Hex(salt + pw)}`; }
async function verificaPassword(pw, salvato) { const [salt, h] = salvato.split(':'); return (await sha256Hex(salt + pw)) === h; }

const SESSION_KEY = 'sanilyx_session';
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function registra(nome, email, pw) {
  email = email.trim().toLowerCase(); nome = nome.trim();
  if (!nome) throw new Error('Inserisci il tuo nome.');
  if (!emailOk(email)) throw new Error('Email non valida.');
  if (pw.length < 8) throw new Error('La password deve avere almeno 8 caratteri.');
  if (q('SELECT id FROM utenti WHERE email=?', [email]).length) throw new Error('Esiste già un account con questa email.');
  run('INSERT INTO utenti(nome,email,password_hash) VALUES (?,?,?)', [nome, email, await hashPassword(pw)]);
  salva();
}
async function login(email, pw) {
  const u = q('SELECT * FROM utenti WHERE email=?', [email.trim().toLowerCase()])[0];
  if (!u || !(await verificaPassword(pw, u.password_hash))) throw new Error('Email o password non corretti.');
  const token = randomHex(32);                     // token di sessione casuale
  run('INSERT INTO sessioni(token,utente_id,scadenza) VALUES (?,?,?)', [token, u.id, Date.now() + 30 * 864e5]);
  salva();
  localStorage.setItem(SESSION_KEY, token);        // la sessione vive in localStorage
  return u;
}
function utenteCorrente() {                        // null se non c'è una sessione valida
  const t = localStorage.getItem(SESSION_KEY);
  if (!t) return null;
  return q('SELECT u.* FROM sessioni s JOIN utenti u ON u.id=s.utente_id WHERE s.token=? AND s.scadenza>?', [t, Date.now()])[0] || null;
}
function logout() {
  const t = localStorage.getItem(SESSION_KEY);
  if (t) { run('DELETE FROM sessioni WHERE token=?', [t]); salva(); }
  localStorage.removeItem(SESSION_KEY);
}

/* ---------- 5. TERAPIE, MALATTIE E STATO UTENTE ---------- */
// Orari fissi delle dosi in base a quante volte al giorno
const ORARI = { 1: ['08:00'], 2: ['08:00', '20:00'], 3: ['08:00', '14:00', '20:00'], 4: ['08:00', '12:00', '16:00', '20:00'] };

// Salva una terapia (da scansione o inserimento manuale) e crea una notifica per ogni dose
function salvaTerapia(uid, t) {
  const farmaco = (t.farmaco || '').trim(), dosaggio = (t.dosaggio || '').trim();
  const malattia = (t.malattia || '').trim() || 'Non specificata';
  const freq = Math.min(4, Math.max(1, parseInt(t.frequenza) || 1));
  if (!farmaco) throw new Error('Inserisci il nome del farmaco.');
  if (!dataValida(t.data_inizio) || !dataValida(t.data_fine)) throw new Error(`Date mancanti per ${farmaco}.`);
  if (t.data_fine < t.data_inizio) throw new Error(`${farmaco}: la data di fine è prima dell'inizio.`);
  if (diffGiorni(t.data_inizio, t.data_fine) > 365) throw new Error(`${farmaco}: la terapia non può superare 365 giorni.`);

  let f = q('SELECT id FROM farmaci WHERE nome=? AND dosaggio=?', [farmaco, dosaggio])[0];
  const farmacoId = f ? f.id : inserisci('INSERT INTO farmaci(nome,dosaggio) VALUES (?,?)', [farmaco, dosaggio]);

  // stessa malattia ancora aperta? la riusiamo, altrimenti ne apriamo una nuova
  let m = q('SELECT id, data_inizio FROM malattie WHERE utente_id=? AND nome=? AND data_fine IS NULL', [uid, malattia])[0];
  let malattiaId;
  if (m) { malattiaId = m.id; if (t.data_inizio < m.data_inizio) run('UPDATE malattie SET data_inizio=? WHERE id=?', [t.data_inizio, m.id]); }
  else malattiaId = inserisci('INSERT INTO malattie(utente_id,nome,data_inizio) VALUES (?,?,?)', [uid, malattia, t.data_inizio]);

  const terapiaId = inserisci('INSERT INTO terapie(utente_id,farmaco_id,malattia_id,frequenza,data_inizio,data_fine) VALUES (?,?,?,?,?,?)',
    [uid, farmacoId, malattiaId, freq, t.data_inizio, t.data_fine]);

  // una riga in "notifiche" per ogni dose futura, da inizio (o da oggi) fino a data_fine
  const ora = adesso();
  for (let g = t.data_inizio > oggi() ? t.data_inizio : oggi(); g <= t.data_fine; g = aggiungiGiorni(g, 1))
    for (const o of ORARI[freq]) if (`${g} ${o}` > ora) run('INSERT INTO notifiche(terapia_id,orario) VALUES (?,?)', [terapiaId, `${g} ${o}`]);

  aggiornaStati(uid);                              // se era già finita, si chiude subito
  salva(); sincronizzaSW(uid);
  return terapiaId;
}

function eliminaTerapia(uid, terapiaId) {
  const t = q('SELECT malattia_id FROM terapie WHERE id=? AND utente_id=?', [terapiaId, uid])[0];
  if (!t) return;
  run('DELETE FROM notifiche WHERE terapia_id=?', [terapiaId]);
  run('DELETE FROM terapie WHERE id=?', [terapiaId]);
  if (!q('SELECT id FROM terapie WHERE malattia_id=?', [t.malattia_id]).length) run('DELETE FROM malattie WHERE id=?', [t.malattia_id]);
  aggiornaStati(uid); salva(); sincronizzaSW(uid);
}

/* Cuore della logica "Sano / In trattamento":
   - una terapia attiva senza più dosi da fare → "conclusa"
   - una malattia senza terapie attive → chiusa (data_fine) = entra nello storico come guarita
   - utente: "In trattamento" se ha terapie attive, altrimenti "Sano"
   - (aggiunta) la malattia "Sintomi segnalati" non si chiude da sola: resta aperta (e lo stato
     resta "In trattamento") finché l'utente non preme "Sto meglio"                       */
function aggiornaStati(uid) {
  const eventi = [];
  q(`SELECT t.id, f.nome FROM terapie t JOIN farmaci f ON f.id=t.farmaco_id
     WHERE t.utente_id=? AND t.stato='attiva'
       AND NOT EXISTS (SELECT 1 FROM notifiche n WHERE n.terapia_id=t.id AND n.inviata=0)`, [uid])
    .forEach(t => { run("UPDATE terapie SET stato='conclusa' WHERE id=?", [t.id]); eventi.push(`Terapia con ${t.nome} conclusa.`); });

  q(`SELECT m.id, m.nome FROM malattie m WHERE m.utente_id=? AND m.data_fine IS NULL
     AND m.nome<>? AND NOT EXISTS (SELECT 1 FROM terapie t WHERE t.malattia_id=m.id AND t.stato='attiva')`, [uid, MALATTIA_SINTOMI])
    .forEach(m => {
      const fine = q('SELECT MAX(data_fine) AS d FROM terapie WHERE malattia_id=?', [m.id])[0].d || oggi();
      run('UPDATE malattie SET data_fine=? WHERE id=?', [fine, m.id]);
      eventi.push(`"${m.nome}" è ora nel registro malattie.`);
    });

  const attive = q("SELECT COUNT(*) AS c FROM terapie WHERE utente_id=? AND stato='attiva'", [uid])[0].c + sintomiAperti(uid);
  const nuovo = attive ? 'In trattamento' : 'Sano';
  if (q('SELECT stato FROM utenti WHERE id=?', [uid])[0].stato !== nuovo) {
    run('UPDATE utenti SET stato=? WHERE id=?', [nuovo, uid]);
    eventi.push(nuovo === 'Sano' ? 'Terapia completata: ora il tuo stato è "Sano".' : 'Il tuo stato è "In trattamento".');
  }
  if (eventi.length) salva();
  return eventi;
}

// Query di lettura usate dall'interfaccia
const statoUtente = uid => q('SELECT stato FROM utenti WHERE id=?', [uid])[0].stato;
const terapieAttive = uid => q(`SELECT t.*, f.nome AS farmaco, f.dosaggio, m.nome AS malattia
  FROM terapie t JOIN farmaci f ON f.id=t.farmaco_id LEFT JOIN malattie m ON m.id=t.malattia_id
  WHERE t.utente_id=? AND t.stato='attiva' ORDER BY t.data_fine`, [uid]);
const prossimeDosi = (uid, n = 5) => q(`SELECT n.orario, f.nome AS farmaco, f.dosaggio
  FROM notifiche n JOIN terapie t ON t.id=n.terapia_id JOIN farmaci f ON f.id=t.farmaco_id
  WHERE t.utente_id=? AND n.inviata=0 ORDER BY n.orario LIMIT ?`, [uid, n]);
function dosiOggi(uid) {
  const r = q(`SELECT COUNT(*) AS tot, COALESCE(SUM(n.inviata),0) AS fatte FROM notifiche n
    JOIN terapie t ON t.id=n.terapia_id WHERE t.utente_id=? AND substr(n.orario,1,10)=?`, [uid, oggi()])[0];
  return r;
}
function registroMalattie(uid) {
  return q('SELECT * FROM malattie WHERE utente_id=? ORDER BY data_inizio DESC, id DESC', [uid]).map(m => ({
    ...m,
    episodi: q('SELECT data, sintomi, risposta FROM episodi_sintomi WHERE malattia_id=? ORDER BY id DESC', [m.id]),   // "Mi sento male"
    farmaci: q(`SELECT t.frequenza, t.data_inizio, t.data_fine, t.stato, f.nome, f.dosaggio
      FROM terapie t JOIN farmaci f ON f.id=t.farmaco_id WHERE t.malattia_id=? ORDER BY t.data_inizio`, [m.id])
  }));
}

/* ---------- 6. NOTIFICHE REALI E SCHEDULER ----------
   • Notification API: mostra la notifica di sistema (serve il permesso dell'utente).
   • Ogni 20 secondi controlliamo la tabella "notifiche": le dosi con orario <= adesso
     e inviata=0 vengono mostrate e segnate come inviate.
   • Se c'è un Service Worker (app mobile) mostriamo la notifica tramite lui e gli
     passiamo il calendario delle prossime dosi, così può avvisare anche con l'app chiusa
     (dove il browser lo consente: Periodic Background Sync su app installata).         */
const notificheSupportate = () => typeof Notification !== 'undefined';
async function chiediPermessoNotifiche() {
  if (!notificheSupportate()) throw new Error('Questo browser non supporta le notifiche.');
  return Notification.requestPermission();
}
async function swAttivo() {
  try { if (!('serviceWorker' in navigator)) return null; const r = await navigator.serviceWorker.getRegistration(); return r && r.active ? r : null; }
  catch (e) { return null; }
}
async function mostraNotifica(titolo, corpo, tag) {
  if (!notificheSupportate() || Notification.permission !== 'granted') return false;
  titolo = tr(titolo); corpo = tr(corpo);          // notifica di sistema: non passa dalla pagina, la traduciamo qui
  const opzioni = { body: corpo, tag, icon: typeof LOGO !== 'undefined' ? LOGO : undefined, requireInteraction: true };
  const reg = await swAttivo();
  if (reg) await reg.showNotification(titolo, opzioni); else new Notification(titolo, opzioni);
  return true;
}
// Testo della notifica; se è l'ultima dose lo dice esplicitamente
function testoDose(r) {
  const ultima = q('SELECT COUNT(*) AS c FROM notifiche WHERE terapia_id=? AND orario>?', [r.terapia_id, r.orario])[0].c === 0;
  const ultimoGiorno = r.orario.slice(0, 10) === r.data_fine;
  let corpo = `${r.farmaco} ${r.dosaggio || ''} · ${tr('ore')} ${r.orario.slice(11)}`.replace('  ', ' ');
  if (ultima) corpo += "\n" + tr("Questa è l'ultima dose. Con questa la terapia è completata.");
  else if (ultimoGiorno) corpo += "\n" + tr("Oggi è l'ultimo giorno di terapia.");
  return { titolo: ultima ? `${tr('Ultima dose')} · ${r.farmaco}` : `${tr('Ora della dose')} · ${r.farmaco}`, corpo, ultima };
}
const dosiDovute = (uid, finoA = adesso()) => q(`SELECT n.id, n.terapia_id, n.orario, t.data_fine, f.nome AS farmaco, f.dosaggio
  FROM notifiche n JOIN terapie t ON t.id=n.terapia_id JOIN farmaci f ON f.id=t.farmaco_id
  WHERE t.utente_id=? AND n.inviata=0 AND n.orario<=? ORDER BY n.orario`, [uid, finoA]);

async function inviaDosiDovute(uid) {
  const dovute = dosiDovute(uid);
  const limite = Date.now() - 2 * 3600e3;          // se l'app era chiusa da più di 2 ore non avvisiamo più
  for (const r of dovute) {
    const quando = new Date(r.orario.replace(' ', 'T')).getTime();
    if (quando >= limite) { const t = testoDose(r); await mostraNotifica(t.titolo, t.corpo, 'dose-' + r.id); if (typeof toast === 'function') toast(`${t.titolo} — ${t.corpo.split('\n').pop()}`, t.ultima ? 'warn' : 'ok'); }
    run('UPDATE notifiche SET inviata=1 WHERE id=?', [r.id]);
  }
  if (dovute.length) salva();
  return dovute.length;
}

// --- dialogo con il Service Worker (solo app mobile): dosi e appuntamenti ---
async function messaggioSW(msg) {
  const reg = await swAttivo(); if (!reg) return null;
  return new Promise(ok => {
    const canale = new MessageChannel(); canale.port1.onmessage = e => ok(e.data);
    reg.active.postMessage(msg, [canale.port2]); setTimeout(() => ok(null), 1500);
  });
}
async function sincronizzaSW(uid) {              // invia al SW le dosi dei prossimi 7 giorni
  if (!(await swAttivo())) return;
  const fino = aggiungiGiorni(oggi(), 7) + ' 23:59';
  const items = q(`SELECT n.id, n.terapia_id, n.orario, t.data_fine, f.nome AS farmaco, f.dosaggio
    FROM notifiche n JOIN terapie t ON t.id=n.terapia_id JOIN farmaci f ON f.id=t.farmaco_id
    WHERE t.utente_id=? AND n.inviata=0 AND n.orario<=?`, [uid, fino]).map(r => {
      const t = testoDose(r); return { id: r.id, quando: new Date(r.orario.replace(' ', 'T')).getTime(), titolo: t.titolo, corpo: t.corpo };
    });
  // appuntamenti dei prossimi 7 giorni: id testuale "app-N" per non confonderli con le dosi
  q('SELECT * FROM appuntamenti WHERE utente_id=? AND notificato=0 AND data>=? AND data<=?', [uid, oggi(), aggiungiGiorni(oggi(), 7)]).forEach(a => {
    const t = testoAppuntamento(a); items.push({ id: 'app-' + a.id, quando: new Date(`${a.data}T${a.ora}`).getTime(), titolo: t.titolo, corpo: t.corpo });
  });
  await messaggioSW({ tipo: 'programma', items });
  try { const reg = await navigator.serviceWorker.ready; if (reg.periodicSync) await reg.periodicSync.register('sanilyx-dosi', { minInterval: 15 * 60 * 1000 }); } catch (e) {}
}
async function riconciliaSW() {                  // dosi già notificate dal SW mentre l'app era chiusa
  const ids = await messaggioSW({ tipo: 'inviate' });
  if (ids && ids.length) {
    ids.forEach(id => String(id).startsWith('app-') ? run('UPDATE appuntamenti SET notificato=1 WHERE id=?', [+String(id).slice(4)]) : run('UPDATE notifiche SET inviata=1 WHERE id=?', [id]));
    salva(); await messaggioSW({ tipo: 'ack', ids });
  }
}

let _timer = null;
function avviaScheduler(uid, quandoCambia) {
  fermaScheduler();
  const tick = async () => {
    try {
      const n = (await inviaDosiDovute(uid)) + (await inviaAppuntamentiDovuti(uid)), ev = aggiornaStati(uid);   // dosi + appuntamenti
      ev.forEach(e => typeof toast === 'function' && toast(e));
      if (n || ev.length) { quandoCambia && quandoCambia(); sincronizzaSW(uid); }
    } catch (e) { console.error('Scheduler:', e); }
  };
  riconciliaSW().then(tick); _timer = setInterval(tick, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}
function fermaScheduler() { clearInterval(_timer); }

/* ---------- 7. GEMINI (AI) ----------
   La chiamata passa dal proxy serverless /api/gemini (api/gemini.js su Vercel):
   la chiave sta solo lato server (GEMINI_API_KEY), il browser non la vede mai.    */
async function gemini(parti, { json = false, sistema = null, storico = [] } = {}) {
  if (sistema && LANG !== 'it') sistema += `\nIMPORTANTE: rispondi sempre in ${LINGUE_AI[LANG]}, anche se queste istruzioni sono in italiano.`;
  const r = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parti, json, sistema, storico })
  });
  const dati = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gemini: ' + ((dati.error && dati.error.message) || r.status));
  const testo = dati.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!testo) throw new Error('Gemini non ha restituito una risposta (contenuto bloccato o immagine illeggibile).');
  return testo;
}

// Foto → JPEG ridimensionato (max 1600px) → base64 senza prefisso "data:"
function fileToBase64(file) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => ko(new Error('Formato immagine non leggibile (usa JPG o PNG).'));
    img.src = url;
  });
}

// SCANSIONE: foto del documento → JSON strutturato con le terapie
async function analizzaDocumento(immagineBase64) {
  const prompt = `Sei un assistente che legge documenti medici italiani (ricette, prescrizioni, referti, fogli di dimissione). Oggi è ${oggi()}.
Estrai le terapie farmacologiche presenti. Rispondi SOLO con JSON valido in questa forma:
{"malattia": string o null (diagnosi/motivo della cura se scritto),
 "terapie":[{"farmaco": string, "dosaggio": string (es. "500 mg"), "frequenza_al_giorno": intero da 1 a 4,
 "durata_giorni": intero o null, "data_inizio": "YYYY-MM-DD" o null, "data_fine": "YYYY-MM-DD" o null}]}
Se la data di inizio non è scritta usa la data di oggi. Se c'è la durata ma non la fine, calcola la fine.
Non inventare farmaci non presenti nel documento; se un dato non è leggibile usa null.`;
  const testo = await gemini([{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: immagineBase64 } }], { json: true });
  let d; try { d = JSON.parse(testo.replace(/^```json|```$/g, '').trim()); } catch (e) { throw new Error("L'AI non ha restituito un JSON valido. Riprova con una foto più nitida."); }
  return {
    malattia: d.malattia || '',
    terapie: (d.terapie || []).map(t => {
      const inizio = dataValida(t.data_inizio) ? t.data_inizio : oggi();
      const fine = dataValida(t.data_fine) ? t.data_fine : (t.durata_giorni > 0 ? aggiungiGiorni(inizio, t.durata_giorni - 1) : '');
      return { farmaco: t.farmaco || '', dosaggio: t.dosaggio || '', frequenza: Math.min(4, Math.max(1, parseInt(t.frequenza_al_giorno) || 1)), data_inizio: inizio, data_fine: fine };
    })
  };
}

// AI ASSISTANT: legge i dati veri dal DB e li passa come contesto
function contestoUtente(uid) {
  const u = q('SELECT nome, stato FROM utenti WHERE id=?', [uid])[0];
  return JSON.stringify({
    oggi: oggi(), ora: adesso().slice(11), nome: u.nome, stato: u.stato,
    terapie_attive: terapieAttive(uid).map(t => ({ farmaco: t.farmaco, dosaggio: t.dosaggio, malattia: t.malattia, dosi_al_giorno: t.frequenza, orari: ORARI[t.frequenza], dal: t.data_inizio, al: t.data_fine })),
    prossime_dosi: prossimeDosi(uid, 6).map(d => ({ quando: d.orario, farmaco: d.farmaco, dosaggio: d.dosaggio })),
    registro_malattie: registroMalattie(uid).map(m => ({ malattia: m.nome, dal: m.data_inizio, al: m.data_fine || 'in corso', farmaci: m.farmaci.map(f => ({ nome: f.nome, dosaggio: f.dosaggio, dosi_al_giorno: f.frequenza, dal: f.data_inizio, al: f.data_fine })) }))
  });
}
async function chiediAssistente(uid, domanda, storico = []) {
  const sistema = `Sei l'assistente di Sanilyx, app di gestione sanitaria personale. Rispondi in italiano, in modo chiaro e breve.
Usa SOLO i dati qui sotto per parlare della salute dell'utente; se un'informazione non c'è, dillo senza inventare.
Non sei un medico: non fare diagnosi né cambiare dosi, e per dubbi clinici invita a sentire medico o farmacista.
DATI REALI DELL'UTENTE (JSON): ${contestoUtente(uid)}`;
  return gemini([{ text: domanda }], { sistema, storico });
}

/* ---------- 8. "MI SENTO MALE" (recupero attivo) ----------
   L'utente descrive i sintomi → lo stato diventa "In trattamento" (si apre la malattia
   "Sintomi segnalati") → l'AI li confronta con storico e terapie recenti → la risposta
   viene mostrata e salvata come "episodio di sintomi" nel registro malattie.
   Finché l'episodio è aperto lo stato resta "In trattamento" (vedi aggiornaStati);
   si chiude col pulsante "Sto meglio".                                                   */
const MALATTIA_SINTOMI = 'Sintomi segnalati';
const AVVISO_MEDICO = "Per sicurezza, ti consiglio di farti visitare da un medico. Questa è un'AI e non sostituisce un professionista sanitario.";
const sintomiAperti = uid => q('SELECT COUNT(*) AS c FROM malattie WHERE utente_id=? AND nome=? AND data_fine IS NULL', [uid, MALATTIA_SINTOMI])[0].c;

// Storico malattie + terapie recenti (anche concluse) da passare all'AI. Va letto PRIMA di salvare il nuovo episodio.
function contestoSintomi(uid) {
  const malattie = registroMalattie(uid).filter(m => m.nome !== MALATTIA_SINTOMI)
    .map(m => ({ malattia: m.nome, dal: m.data_inizio, al: m.data_fine || 'in corso' }));
  const sintomiPrima = q('SELECT data, sintomi FROM episodi_sintomi WHERE utente_id=? ORDER BY id DESC LIMIT 3', [uid])
    .map(e => ({ quando: e.data, sintomi: e.sintomi }));
  const terapie = q(`SELECT f.nome, f.dosaggio, t.frequenza, t.data_inizio, t.data_fine, t.stato, m.nome AS malattia
    FROM terapie t JOIN farmaci f ON f.id=t.farmaco_id LEFT JOIN malattie m ON m.id=t.malattia_id
    WHERE t.utente_id=? ORDER BY t.data_fine DESC LIMIT 15`, [uid])
    .map(t => ({ farmaco: t.nome, dosaggio: t.dosaggio, malattia: t.malattia, dosi_al_giorno: t.frequenza, dal: t.data_inizio, al: t.data_fine, stato: t.stato }));
  return { storico: JSON.stringify({ malattie, sintomi_segnalati_in_precedenza: sintomiPrima }), terapie: JSON.stringify(terapie) };
}

// Salva l'episodio e porta l'utente in "In trattamento". Restituisce l'id dell'episodio.
function segnalaSintomi(uid, sintomi) {
  // un solo episodio aperto alla volta: se c'è già "Sintomi segnalati" lo riusiamo
  const m = q('SELECT id FROM malattie WHERE utente_id=? AND nome=? AND data_fine IS NULL', [uid, MALATTIA_SINTOMI])[0];
  const malattiaId = m ? m.id : inserisci('INSERT INTO malattie(utente_id,nome,data_inizio) VALUES (?,?,?)', [uid, MALATTIA_SINTOMI, oggi()]);
  const id = inserisci('INSERT INTO episodi_sintomi(utente_id,malattia_id,data,sintomi) VALUES (?,?,?,?)', [uid, malattiaId, adesso(), sintomi]);
  run("UPDATE utenti SET stato='In trattamento' WHERE id=?", [uid]);
  salva(); return id;
}

// "Sto meglio": chiude l'episodio; se non ci sono terapie attive lo stato torna "Sano". Restituisce i messaggi di stato.
function chiudiSintomi(uid) {
  run('UPDATE malattie SET data_fine=? WHERE utente_id=? AND nome=? AND data_fine IS NULL', [oggi(), uid, MALATTIA_SINTOMI]);
  const eventi = aggiornaStati(uid); salva(); return eventi;
}

// AI: sintomi + storico + terapie → analisi (sempre con l'avviso di farsi visitare)
async function analizzaSintomi(sintomi, ctx) {
  const prompt = `Sei l'assistente di Sanilyx. L'utente segnala questi sintomi: ${sintomi}.
Ecco lo storico delle sue malattie: ${ctx.storico}.
Ecco le terapie recenti (anche concluse): ${ctx.terapie}.
Analizza i sintomi in relazione allo storico. Se riesci a trovare una correlazione plausibile, spiega cosa potrebbe essere e cosa può fare nel frattempo. Se non riesci a trovare nulla di correlato, dillo chiaramente.
In OGNI caso, concludi SEMPRE con: "${AVVISO_MEDICO}"
Non fare diagnosi. Non prescrivere farmaci. Sii chiaro e breve.`;
  let r = (await gemini([{ text: prompt }], { sistema: "Sei l'assistente di Sanilyx. Rispondi in modo chiaro e breve." })).trim();
  if (!/medic|doctor|médec|arzt|ärzt/i.test(r.slice(-250))) r += '\n\n' + tr(AVVISO_MEDICO);   // rete di sicurezza: l'avviso c'è sempre
  return r;
}

/* ---------- 9. ESPORTAZIONE PDF PER IL MEDICO (una malattia alla volta) ----------
   Il pulsante "PDF" sta accanto a ogni malattia nel Registro.
   jsPDF (da CDN) crea il file nel browser: i dati non lasciano il dispositivo.
   Il documento è in italiano e usa i font standard del PDF (solo caratteri latini).        */
function esportaPDF(uid, malattiaId) {
  if (!window.jspdf) throw new Error('Libreria PDF non caricata: controlla la connessione e riprova.');
  const m = registroMalattie(uid).find(x => x.id === malattiaId);
  if (!m) throw new Error('Malattia non trovata.');
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const utente = q('SELECT nome FROM utenti WHERE id=?', [uid])[0], X = 15, LARG = 180, FONDO = 275;
  const BLU = [26, 58, 92], TESTO = [23, 48, 74], GRIGIO = [107, 127, 147];
  let y = 18;
  // scrive un testo andando a capo; quando finisce lo spazio apre una nuova pagina
  const riga = (testo, { size = 10, bold = false, colore = TESTO, rientro = 0 } = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...colore);
    for (const r of doc.splitTextToSize(String(testo), LARG - rientro)) {
      if (y > FONDO) { doc.addPage(); y = 20; }
      doc.text(r, X + rientro, y); y += size * 0.5;
    }
  };
  const spazio = mm => { y += mm; };
  const titolo = t => { spazio(4); riga(t, { size: 13, bold: true, colore: BLU }); spazio(1); };
  const nDosiPDF = f => `${f} ${f === 1 ? 'dose' : 'dosi'} al giorno`;

  // Intestazione: logo, nome utente, data di esportazione
  try { doc.addImage(LOGO, 'PNG', X, 12, 16, 16); } catch (e) { /* senza logo il PDF esce comunque */ }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(...BLU); doc.text('Sanilyx', X + 20, 21);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GRIGIO); doc.text('Storico sanitario personale', X + 20, 26);
  y = 38;
  riga(`Paziente: ${utente.nome}`, { size: 12, bold: true });
  riga(`Data di esportazione: ${fmtData(oggi())}`, { colore: GRIGIO });
  doc.setDrawColor(46, 196, 182); doc.setLineWidth(0.6); doc.line(X, y, X + LARG, y); spazio(2);

  // Una sola malattia: periodo, farmaci assunti (con dosaggio, dosi al giorno e date) ed eventuali sintomi riferiti
  riga(m.nome, { size: 15, bold: true, colore: BLU });
  riga(`Periodo: ${fmtData(m.data_inizio)} - ${m.data_fine ? fmtData(m.data_fine) : 'in corso'}  (${m.data_fine ? 'guarita' : 'in corso'})`, { colore: GRIGIO });

  titolo('Farmaci assunti');
  if (!m.farmaci.length) riga('Nessun farmaco registrato.', { colore: GRIGIO });
  m.farmaci.forEach(f => riga(`- ${f.nome} ${f.dosaggio || ''} | ${nDosiPDF(f.frequenza)} | dal ${fmtData(f.data_inizio)} al ${fmtData(f.data_fine)} (${f.stato === 'attiva' ? 'in corso' : 'conclusa'})`.replace('  ', ' '), { rientro: 3 }));

  if (m.episodi.length) {
    titolo('Sintomi riferiti');
    m.episodi.forEach(ep => riga(`- ${fmtData(ep.data.slice(0, 10))}: ${ep.sintomi}`, { rientro: 3 }));
  }

  // Footer su ogni pagina
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GRIGIO);
    doc.text('Documento generato automaticamente da Sanilyx. Non sostituisce la cartella clinica.', X, 288);
    doc.text(`Pagina ${p}/${n}`, X + LARG, 288, { align: 'right' });
  }
  // nome file: sanilyx-<malattia>-<data>.pdf (senza accenti né spazi)
  const slug = m.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'malattia';
  doc.save(`sanilyx-${slug}-${oggi()}.pdf`);
}

/* ---------- 10. APPUNTAMENTI ----------
   Tabella "appuntamenti". Lo scheduler (sezione 6) controlla anche questi: quando data = oggi,
   ora <= adesso e notificato = 0 mostra "Oggi hai un appuntamento: …" e mette notificato = 1.
   Nell'app mobile il calendario dei prossimi 7 giorni va anche al Service Worker (sincronizzaSW). */
const ORA_OK = /^([01]\d|2[0-3]):[0-5]\d$/;
function aggiungiAppuntamento(uid, a) {
  const titolo = (a.titolo || '').trim(), note = (a.note || '').trim();
  if (!titolo) throw new Error("Inserisci il titolo dell'appuntamento.");
  if (!dataValida(a.data) || !ORA_OK.test(a.ora || '')) throw new Error('Data o ora non valide.');
  const passato = `${a.data} ${a.ora}` <= adesso();         // già trascorso: lo salviamo senza notifica
  const id = inserisci('INSERT INTO appuntamenti(utente_id,titolo,data,ora,note,notificato) VALUES (?,?,?,?,?,?)', [uid, titolo, a.data, a.ora, note || null, passato ? 1 : 0]);
  salva(); sincronizzaSW(uid);
  return id;
}
function eliminaAppuntamento(uid, id) { run('DELETE FROM appuntamenti WHERE id=? AND utente_id=?', [id, uid]); salva(); sincronizzaSW(uid); }
const appuntamentiProssimi = (uid, n = 50) => q("SELECT * FROM appuntamenti WHERE utente_id=? AND data||' '||ora>=? ORDER BY data, ora LIMIT ?", [uid, adesso(), n]);
const appuntamentiPassati = (uid, n = 10) => q("SELECT * FROM appuntamenti WHERE utente_id=? AND data||' '||ora<? ORDER BY data DESC, ora DESC LIMIT ?", [uid, adesso(), n]);
function testoAppuntamento(a) { return { titolo: tr('Appuntamento'), corpo: `${tr('Oggi hai un appuntamento:')} ${a.titolo} ${tr('alle')} ${a.ora}` }; }

async function inviaAppuntamentiDovuti(uid) {
  run('UPDATE appuntamenti SET notificato=1 WHERE utente_id=? AND data<? AND notificato=0', [uid, oggi()]);   // giorni passati: niente più avvisi
  const dovuti = q('SELECT * FROM appuntamenti WHERE utente_id=? AND data=? AND ora<=? AND notificato=0 ORDER BY ora', [uid, oggi(), adesso().slice(11)]);
  const limite = Date.now() - 2 * 3600e3;                    // come per le dosi: dopo 2 ore non avvisiamo più
  for (const a of dovuti) {
    if (new Date(`${a.data}T${a.ora}`).getTime() >= limite) {
      const t = testoAppuntamento(a); await mostraNotifica(t.titolo, t.corpo, 'app-' + a.id);
      if (typeof toast === 'function') toast(t.corpo, 'warn');
    }
    run('UPDATE appuntamenti SET notificato=1 WHERE id=?', [a.id]);
  }
  if (dovuti.length) salva();
  return dovuti.length;
}

/* ---------- 11. REFERTI DI LABORATORIO ----------
   Foto o PDF → AI (analizzaReferto) → l'utente controlla → tabelle "referti" + "esami_lab".
   L'AI Assistant legge questi dati tramite contestoReferti().                                 */
// PDF → base64 (le immagini passano da fileToBase64, che le ridimensiona). Limite 3 MB: il proxy Vercel accetta max 4,5 MB.
function pdfToBase64(file) {
  return new Promise((ok, ko) => {
    if (file.size > 3 * 1024 * 1024) return ko(new Error('Il PDF è troppo grande (max 3 MB).'));
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1]);
    fr.onerror = () => ko(new Error('Impossibile leggere il file.'));
    fr.readAsDataURL(file);
  });
}

// Confronta valore e intervallo ("13.0 - 17.0", "< 200", "> 40"): 'normale' | 'alto' | 'basso' | null se non determinabile
function statoEsame(valore, range) {
  const v = parseFloat(String(valore).replace(',', '.'));
  const n = (String(range || '').replace(/,/g, '.').match(/\d+(\.\d+)?/g) || []).map(Number);
  if (isNaN(v) || !n.length) return null;
  if (/^\s*[<≤]/.test(range)) return v > n[0] ? 'alto' : 'normale';
  if (/^\s*[>≥]/.test(range)) return v < n[0] ? 'basso' : 'normale';
  if (n.length >= 2) return v < n[0] ? 'basso' : v > n[1] ? 'alto' : 'normale';
  return null;
}

// SCANSIONE REFERTO: foto/PDF → JSON con i valori degli esami
async function analizzaReferto(base64, mime = 'image/jpeg') {
  const prompt = `Sei un assistente che legge referti di laboratorio italiani. Oggi è ${oggi()}.
Estrai TUTTI i valori numerici presenti nel referto. Rispondi SOLO con JSON valido:
{"data_referto": "YYYY-MM-DD" o null,
 "esami": [{"nome": string, "valore": string, "unita": string, "range": string o null, "stato": "normale"|"alto"|"basso"}]}
Se il range non è scritto, usa null. Non inventare valori non presenti. Se un dato non è leggibile, usa null.`;
  const testo = await gemini([{ text: prompt }, { inlineData: { mimeType: mime, data: base64 } }], { json: true });
  let d; try { d = JSON.parse(testo.replace(/^```json|```$/g, '').trim()); } catch (e) { throw new Error("L'AI non ha restituito un JSON valido. Riprova con una foto più nitida."); }
  return {
    data: dataValida(d.data_referto) ? d.data_referto : oggi(),          // se la data non c'è usiamo oggi (l'utente può correggerla)
    esami: (Array.isArray(d.esami) ? d.esami : []).filter(e => e && e.nome && e.valore != null).map(e => {
      const valore = String(e.valore), range = e.range ? String(e.range) : '';
      // lo stato lo decide l'AI; se l'intervallo è leggibile lo ricontrolliamo noi con i numeri (più affidabile)
      const stato = statoEsame(valore, range) || (['normale', 'alto', 'basso'].includes(e.stato) ? e.stato : '');
      return { nome: String(e.nome), valore, unita: e.unita ? String(e.unita) : '', range, stato };
    })
  };
}

function salvaReferto(uid, r) {
  const esami = (r.esami || []).filter(e => (e.nome || '').trim() && String(e.valore ?? '').trim());
  if (!esami.length) throw new Error('Aggiungi almeno un esame con nome e valore.');
  const id = inserisci('INSERT INTO referti(utente_id,data,creato) VALUES (?,?,?)', [uid, dataValida(r.data) ? r.data : oggi(), adesso()]);
  esami.forEach(e => run('INSERT INTO esami_lab(referto_id,nome,valore,unita,intervallo,stato) VALUES (?,?,?,?,?,?)',
    [id, e.nome.trim(), String(e.valore).trim(), (e.unita || '').trim(), (e.range || '').trim() || null,
     ['normale', 'alto', 'basso'].includes(e.stato) ? e.stato : statoEsame(e.valore, e.range)]));
  salva(); return id;
}
function eliminaReferto(uid, id) {
  if (!q('SELECT id FROM referti WHERE id=? AND utente_id=?', [id, uid]).length) return;
  run('DELETE FROM esami_lab WHERE referto_id=?', [id]); run('DELETE FROM referti WHERE id=?', [id]); salva();
}
const elencoReferti = uid => q('SELECT * FROM referti WHERE utente_id=? ORDER BY data DESC, id DESC', [uid])
  .map(r => ({ ...r, esami: q('SELECT * FROM esami_lab WHERE referto_id=? ORDER BY id', [r.id]) }));

// Testo da accodare alla domanda dell'AI Assistant: gli ultimi 5 referti (così può rispondere sui valori)
function contestoReferti(uid) {
  const r = elencoReferti(uid).slice(0, 5);
  if (!r.length) return '';
  return '\n\n[Dati aggiuntivi di Sanilyx — referti di laboratorio dell\'utente, dal più recente (JSON): ' + JSON.stringify(r.map(x => ({
    data: x.data, esami: x.esami.map(e => ({ esame: e.nome, valore: e.valore, unita: e.unita, intervallo: e.intervallo, stato: e.stato }))
  }))) + ']';
}


/* ================================================================
   12. INTERFACCIA CONDIVISA — le "viste" (pagine) usate da sito e app.
   Ogni vista è una funzione  vistaXxx(elemento)  che scrive l'HTML
   nell'elemento e collega i pulsanti. La "shell" (sidebar o barra
   in basso) decide solo QUALE vista mostrare, tramite vai('nome').
   Dati sempre letti dal database con le funzioni del nucleo.
   ================================================================ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
// esc(): neutralizza l'HTML nel testo (nomi, risposte AI...) per evitare XSS
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {                                                 // icone SVG inline, nessuna libreria
  home: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
  scan: svg('<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3"/><path d="M4 12h16"/>'),
  pill: svg('<g transform="rotate(-45 12 12)"><rect x="2" y="8" width="20" height="8" rx="4"/><path d="M12 8v8"/></g>'),
  book: svg('<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 21V5M9 8h6M9 12h6"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>'),
  chat: svg('<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  bell: svg('<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 004 0"/>'),
  check: svg('<path d="M5 12l5 5L20 7"/>'),
  heart: svg('<path d="M12 21s-8-5.2-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 5.8-8 11-8 11z"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>'),
  send: svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
  chev: svg('<path d="M6 9l6 6 6-6"/>'),
  out: svg('<path d="M9 21H5a1 1 0 01-1-1V4a1 1 0 011-1h4M16 17l5-5-5-5M21 12H9"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
  cal: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  doc: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>')
};
const ico = n => `<span class="ico">${ICON[n]}</span>`;
let UTENTE = null;                                              // utente collegato (lo imposta la shell)

function toast(msg, tipo = '') {
  const t = document.createElement('div'); t.className = 'toast ' + tipo; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 6500);
}
// Pulsante con spinner mentre aspetta una funzione async (micro-interazione)
async function conSpinner(btn, fn) {
  const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
}
const msg = (el, testo, tipo = 'err') => { el.innerHTML = testo ? `<div class="msg ${tipo}">${esc(testo)}</div>` : ''; };
const iniziali = n => n.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
const nDosi = f => f + (f === 1 ? ' dose' : ' dosi') + '/giorno';
const vuoto = (icona, titolo, testo, bottone = '') => `<div class="empty">${ico(icona)}<b>${titolo}</b><p>${testo}</p>${bottone}</div>`;
const badgeStato = s => `<span class="badge ${s === 'Sano' ? 'ok' : 'warn'}">${esc(s)}</span>`;
// le card espandibili: clic sulla testata apre/chiude i dettagli
const attivaEspansione = el => $$('.exp', el).forEach(c => c.addEventListener('click', e => { if (!e.target.closest('button,a,input')) c.classList.toggle('open'); }));

// Risposte dell'AI: testo sicuro con **grassetto** e a capo
const fmtAI = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
// Finestra modale: restituisce l'elemento; si chiude con Annulla/Chiudi o toccando lo sfondo
function apriModale(html) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
  ($('#shell') || document.body).appendChild(bg);          // nell'app la finestra sta dentro la colonna #shell
  return bg;
}

/* ================= AUTENTICAZIONE: login / registrazione ================= */
function renderAuth(root, quandoLoggato) {
  let modo = 'login', info = '';
  const disegna = () => {
    const forms = {
      login: `<label class="f">Email</label><input id="email" type="email" autocomplete="email" required>
              <label class="f">Password</label><input id="pw" type="password" autocomplete="current-password" required>
              <button class="btn block" style="margin-top:18px">Accedi</button>`,
      registra: `<label class="f">Nome</label><input id="nome" autocomplete="name" required>
              <label class="f">Email</label><input id="email" type="email" autocomplete="email" required>
              <label class="f">Password (min. 8 caratteri)</label><input id="pw" type="password" autocomplete="new-password" required minlength="8">
              <label class="f">Ripeti password</label><input id="pw2" type="password" autocomplete="new-password" required>
              <button class="btn teal block" style="margin-top:18px">Crea account</button>`
    };
    root.innerHTML = `<div class="auth-box view">
      <div class="lang-row"><button class="btn ghost sm btn-install" data-installa style="margin-right:8px">${ico('upload')} Scarica l'app</button>${selettoreLingua()}</div>
      <div style="display:flex;align-items:center;gap:12px"><img src="${LOGO}" width="52" height="52" alt=""><div><h2>Sanilyx</h2><span class="muted small">La tua salute, sempre con te</span></div></div>
      ${modo === 'login' || modo === 'registra' ? `<div class="tabs"><button data-m="login" class="${modo === 'login' ? 'on' : ''}">Accedi</button><button data-m="registra" class="${modo === 'registra' ? 'on' : ''}">Registrati</button></div>` : ''}
      <form id="fa" novalidate>${forms[modo]}<div id="esito-a">${info ? `<div class="msg ok">${esc(info)}</div>` : ''}</div></form></div>`;
    info = '';
    $$('[data-m]', root).forEach(b => b.onclick = () => { modo = b.dataset.m; disegna(); });
    $('#fa', root).onsubmit = async e => {
      e.preventDefault();
      const v = id => ($('#' + id, root) || {}).value || '', esito = $('#esito-a', root), btn = $('.btn', root);
      try {
        await conSpinner(btn, async () => {
          if (modo === 'login') quandoLoggato(await login(v('email'), v('pw')));
          else if (modo === 'registra') {
            if (v('pw') !== v('pw2')) throw new Error('Le due password non coincidono.');
            await registra(v('nome'), v('email'), v('pw')); await login(v('email'), v('pw'));
            quandoLoggato(utenteCorrente());
          }
        });
      } catch (err) { msg(esito, err.message); }
    };
  };
  disegna();
}

/* ================= DASHBOARD / HOME ================= */
function bannerSetup() {
  let h = '';
  if (!notificheSupportate()) h += `<div class="msg info">Questo browser non supporta le notifiche: i promemoria compaiono solo dentro l'app.</div>`;
  else if (Notification.permission === 'default') h += `<div class="card" style="border-color:var(--teal)"><div class="between"><div><b>Attiva le notifiche</b><div class="muted small">Così ti avvisiamo a ogni dose, compresa l'ultima.</div></div><button class="btn teal sm" id="perm">${ico('bell')} Attiva</button></div></div>`;
  else if (Notification.permission === 'denied') h += `<div class="msg err">Le notifiche sono bloccate dal browser: riattivale dalle impostazioni del sito per ricevere i promemoria.</div>`;
  return h ? `<div style="margin-bottom:16px">${h}</div>` : '';
}
function vistaDashboard(el) {
  const uid = UTENTE.id, stato = statoUtente(uid), att = terapieAttive(uid), prox = prossimeDosi(uid, 5), oggiD = dosiOggi(uid);
  const nMal = q('SELECT COUNT(*) AS c FROM malattie WHERE utente_id=?', [uid])[0].c;
  const apps = appuntamentiProssimi(uid, 3);
  el.innerHTML = `<div class="view">
    <div class="hero"><div><span class="muted">Ciao,</span><h1>${esc(UTENTE.nome)}</h1></div>${badgeStato(stato)}</div>
    ${bannerSetup()}
    <div class="row fit" style="margin-bottom:16px;flex-wrap:wrap">
      <button class="btn alert" id="male">${ico('heart')} Mi sento male</button>
    </div>
    ${sintomiAperti(uid) ? `<div class="card" style="border-color:var(--warn);margin-bottom:16px"><div class="between"><div class="muted small" style="flex:1">Hai un episodio di sintomi aperto. Quando ti senti meglio, chiudilo.</div><button class="btn ghost sm" id="meglio">${ico('check')} Sto meglio</button></div></div>` : ''}
    <div class="grid g4">
      <div class="card hover stat">${ico('pill')}<b>${att.length}</b><span>Terapie attive</span></div>
      <div class="card hover stat">${ico('check')}<b>${oggiD.fatte}/${oggiD.tot}</b><span>Dosi di oggi</span></div>
      <div class="card hover stat">${ico('book')}<b>${nMal}</b><span>Malattie nel registro</span></div>
      <div class="card hover stat">${ico('heart')}<b style="font-size:20px;padding-top:6px">${stato}</b><span>Stato attuale</span></div>
    </div>
    <div class="card"><h3>Prossime dosi</h3>${prox.length ? prox.map(d => `<div class="dose"><span class="t">${d.orario.slice(0, 10) === oggi() ? 'Oggi' : fmtData(d.orario.slice(0, 10))} · ${d.orario.slice(11)}</span><span><b>${esc(d.farmaco)}</b> <span class="muted">${esc(d.dosaggio)}</span></span></div>`).join('')
      : vuoto('pill', 'Nessuna dose in programma', stato === 'Sano' ? 'Sei in stato "Sano". Se hai una nuova prescrizione, scansionala.' : 'Nessuna dose futura.', `<button class="btn teal sm" data-vai="scansiona">${ico('scan')} Scansiona un documento</button>`)}</div>
    <div class="card"><div class="between" style="margin-bottom:8px"><h3 style="margin:0">Prossimi appuntamenti</h3><button class="btn ghost sm" data-vai="appuntamenti">${ico('cal')} Gestisci</button></div>${apps.length ? apps.map(a => `<div class="dose"><span class="t">${a.data === oggi() ? 'Oggi' : fmtData(a.data)} · ${esc(a.ora)}</span><span><b>${esc(a.titolo)}</b></span></div>`).join('') : '<div class="muted small">Nessun appuntamento in programma</div>'}</div>
    ${att.length ? `<div class="card"><h3>In corso</h3>${att.map(t => `<div class="sub-f" style="border:0;padding:6px 0"><b>${esc(t.farmaco)}</b> ${esc(t.dosaggio)} <span class="muted">· fino al ${fmtData(t.data_fine)}</span></div>`).join('')}</div>` : ''}
  </div>`;
  collegaVai(el);
  $('#male', el).onclick = apriMiSentoMale;
  const mg = $('#meglio', el); if (mg) mg.onclick = () => { chiudiSintomi(uid).forEach(e => toast(e)); rinfresca(true); };
  const p = $('#perm', el); if (p) p.onclick = async () => { await chiediPermessoNotifiche(); sincronizzaSW(uid); rinfresca(true); };
}
const collegaVai = el => $$('[data-vai]', el).forEach(b => b.onclick = () => vai(b.dataset.vai));

/* ================= "MI SENTO MALE": sintomi → AI → episodio nel registro ================= */
function apriMiSentoMale() {
  const m = apriModale(`<h2>Mi sento male</h2>
    <p class="muted small" style="margin:6px 0 4px">Segnalando i sintomi il tuo stato diventa "In trattamento"; l'AI li confronta con il tuo storico.</p>
    <label class="f" for="sintomi">Descrivi cosa senti</label>
    <textarea id="sintomi" maxlength="1000" placeholder="${esc(tr('es. mal di gola e febbre da ieri sera…'))}"></textarea>
    <div id="esito-s"></div>
    <div class="row" style="margin-top:14px"><button class="btn ghost" data-chiudi>Annulla</button><button class="btn alert" id="invia-s">Analizza sintomi</button></div>`);
  $('[data-chiudi]', m).onclick = () => m.remove();
  setTimeout(() => { const t = $('#sintomi', m); if (t) t.focus(); }, 50);
  $('#invia-s', m).onclick = ev => conSpinner(ev.currentTarget, async () => {
    const sintomi = $('#sintomi', m).value.trim(), esito = $('#esito-s', m), uid = UTENTE.id;
    if (sintomi.length < 3) return msg(esito, 'Descrivi i sintomi prima di continuare.');
    msg(esito, '');
    const ctx = contestoSintomi(uid);                       // storico PRIMA di aggiungere l'episodio
    const episodio = segnalaSintomi(uid, sintomi);          // stato → "In trattamento" e sintomi salvati
    rinfresca();
    try {
      const risposta = await analizzaSintomi(sintomi, ctx);
      run('UPDATE episodi_sintomi SET risposta=? WHERE id=?', [risposta, episodio]); salva();
      if (!m.isConnected) return rinfresca();               // l'utente ha chiuso la finestra: l'analisi resta nel registro
      $('.modal', m).innerHTML = `<h2>Analisi dei sintomi</h2><div class="ai-box">${fmtAI(risposta)}</div>
        <button class="btn teal block" style="margin-top:14px" data-chiudi>Chiudi</button>`;
      $('[data-chiudi]', m).onclick = () => m.remove();
    } catch (e) {
      msg(esito, tr("Sintomi salvati, ma l'analisi non è disponibile:") + ' ' + e.message);
    }
    rinfresca();
  });
}

/* ================= SCANSIONA (foto → AI → conferma → salva) ================= */
function vistaScansiona(el) {
  let base64 = null, mime = 'image/jpeg', modo = 'ricetta';   // modo: 'ricetta' oppure 'referto'
  el.innerHTML = `<div class="view"><h1 class="page-title">Scansiona documento</h1>
    <p class="page-sub">Carica la foto di una ricetta o di un referto: l'AI legge farmaci, dosaggi e durata. Tu controlli e confermi.</p>
    <div class="tabs" id="modi"><button class="on" data-modo="ricetta">Prescrizione / Ricetta</button><button data-modo="referto">Referto di laboratorio</button></div>
    <div class="card"><label class="drop" id="drop">${ico('upload')}<div><b id="drop-t">Scegli o trascina una foto</b></div><span class="small" id="drop-f">JPG o PNG</span><input type="file" id="file" accept="image/*"></label>
      <div id="prev" style="margin-top:14px"></div><div id="esito"></div></div>
    <div id="revisione"></div>
    <div style="text-align:center;margin-top:16px"><button class="btn ghost" id="manuale">${ico('plus')} Inserisci a mano</button></div></div>`;
  const esito = $('#esito', el), rev = $('#revisione', el);

  const carica = async file => {
    if (!file) return;
    try {
      if (modo === 'referto' && file.type === 'application/pdf') { base64 = await pdfToBase64(file); mime = 'application/pdf'; }
      else { base64 = await fileToBase64(file); mime = 'image/jpeg'; }
      $('#prev', el).innerHTML = (mime === 'application/pdf' ? `<div class="msg info" style="margin:0 0 12px">${ico('doc')} ${esc(file.name)}</div>` : `<img class="preview" src="data:image/jpeg;base64,${base64}" alt="Anteprima">`)
        + `<button class="btn teal block" id="analizza">${ico('scan')} Analizza con AI</button>`;
      msg(esito, '');
      $('#analizza', el).onclick = ev => conSpinner(ev.currentTarget, async () => {
        try { msg(esito, ''); if (modo === 'referto') return mostraRevisioneReferto(await analizzaReferto(base64, mime)); const dati = await analizzaDocumento(base64);
          if (!dati.terapie.length) msg(esito, 'Non ho trovato farmaci nel documento. Prova con una foto più nitida o inserisci a mano.', 'info');
          mostraRevisione(dati); } catch (e) { msg(esito, e.message); }
      });
    } catch (e) { msg(esito, e.message); }
  };
  $('#file', el).onchange = e => carica(e.target.files[0]);
  const drop = $('#drop', el);
  ['dragover', 'dragenter'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => carica(e.dataTransfer.files[0]));
  $('#manuale', el).onclick = () => mostraRevisione({ malattia: '', terapie: [{ farmaco: '', dosaggio: '', frequenza: 1, data_inizio: oggi(), data_fine: '' }] });

  // Modalità: ricetta (terapie) oppure referto di laboratorio (valori degli esami)
  $$('[data-modo]', el).forEach(b => b.onclick = () => {
    modo = b.dataset.modo; base64 = null;
    $$('[data-modo]', el).forEach(x => x.classList.toggle('on', x === b));
    $('#file', el).value = ''; $('#file', el).accept = modo === 'referto' ? 'image/*,application/pdf' : 'image/*';
    $('#drop-t', el).textContent = modo === 'referto' ? 'Scegli o trascina una foto o un PDF' : 'Scegli o trascina una foto';
    $('#drop-f', el).textContent = modo === 'referto' ? 'JPG, PNG o PDF' : 'JPG o PNG';
    $('#manuale', el).hidden = modo === 'referto';
    $('#prev', el).innerHTML = ''; rev.innerHTML = ''; msg(esito, '');
  });

  // Modulo di conferma del referto: tutto modificabile, perché l'AI può sbagliare
  function cardEsame(e) {
    const stati = [['', '—'], ['normale', 'Normale'], ['alto', 'Alto'], ['basso', 'Basso']];
    return `<div class="tcard"><div class="between"><b>Esame</b><button type="button" class="btn danger sm" data-del>Rimuovi</button></div>
      <label class="f">Nome</label><input data-k="nome" value="${esc(e.nome)}">
      <div class="row"><div><label class="f">Valore</label><input data-k="valore" value="${esc(e.valore)}"></div><div><label class="f">Unità</label><input data-k="unita" value="${esc(e.unita)}" placeholder="es. g/dL"></div></div>
      <div class="row"><div><label class="f">Intervallo di riferimento</label><input data-k="range" value="${esc(e.range)}" placeholder="es. 13.0 - 17.0"></div>
        <div><label class="f">Stato</label><select data-k="stato">${stati.map(([v, t]) => `<option value="${v}" ${v === (e.stato || '') ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div></div>`;
  }
  function mostraRevisioneReferto(dati) {
    if (!dati.esami.length) msg(esito, 'Non ho trovato valori nel referto. Prova con una foto più nitida o aggiungili a mano.', 'info');
    rev.innerHTML = `<div class="card view"><h3>Controlla e conferma</h3>
      <label class="f">Data del referto</label><input type="date" id="data-ref" value="${esc(dati.data)}">
      <div id="lista">${dati.esami.map(cardEsame).join('')}</div>
      <div class="row" style="margin-top:16px"><button class="btn ghost" id="altro-e">${ico('plus')} Aggiungi esame</button><button class="btn teal" id="salva-r">${ico('check')} Salva referto</button></div><div id="esito2"></div></div>`;
    rev.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const lega = () => $$('[data-del]', rev).forEach(b => b.onclick = () => b.closest('.tcard').remove());
    lega();
    $('#altro-e', rev).onclick = () => { $('#lista', rev).insertAdjacentHTML('beforeend', cardEsame({ nome: '', valore: '', unita: '', range: '', stato: '' })); lega(); };
    $('#salva-r', rev).onclick = e => conSpinner(e.currentTarget, async () => {
      try {
        const esami = $$('.tcard', rev).map(s => { const x = {}; $$('[data-k]', s).forEach(i => x[i.dataset.k] = i.value); return x; });
        salvaReferto(UTENTE.id, { data: $('#data-ref', rev).value, esami });
        toast('Referto salvato.'); vai('referti');
      } catch (err) { msg($('#esito2', rev), err.message); }
    });
  }

  // Modulo di conferma: tutto modificabile, perché l'AI può sbagliare
  function cardTerapia(t) {
    return `<div class="tcard"><div class="between"><b>Farmaco</b><button type="button" class="btn danger sm" data-del>Rimuovi</button></div>
      <div class="row"><div><label class="f">Nome</label><input data-k="farmaco" value="${esc(t.farmaco)}"></div><div><label class="f">Dosaggio</label><input data-k="dosaggio" value="${esc(t.dosaggio)}" placeholder="es. 500 mg"></div></div>
      <label class="f">Dosi al giorno</label><select data-k="frequenza">${[1, 2, 3, 4].map(n => `<option value="${n}" ${n == t.frequenza ? 'selected' : ''}>${n} (${ORARI[n].join(' · ')})</option>`).join('')}</select>
      <div class="row"><div><label class="f">Inizio</label><input type="date" data-k="data_inizio" value="${esc(t.data_inizio)}"></div><div><label class="f">Fine</label><input type="date" data-k="data_fine" value="${esc(t.data_fine)}"></div></div></div>`;
  }
  function mostraRevisione(dati) {
    rev.innerHTML = `<div class="card view"><h3>Controlla e conferma</h3>
      <label class="f">Malattia / motivo della cura</label><input id="malattia" value="${esc(dati.malattia)}" placeholder="es. Influenza, Bronchite…">
      <div id="lista">${dati.terapie.map(cardTerapia).join('')}</div>
      <div class="row" style="margin-top:16px"><button class="btn ghost" id="altro">${ico('plus')} Aggiungi farmaco</button><button class="btn teal" id="salva">${ico('check')} Salva terapie</button></div><div id="esito2"></div></div>`;
    rev.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const lega = () => $$('[data-del]', rev).forEach(b => b.onclick = () => b.closest('.tcard').remove());
    lega();
    $('#altro', rev).onclick = () => { $('#lista', rev).insertAdjacentHTML('beforeend', cardTerapia({ farmaco: '', dosaggio: '', frequenza: 1, data_inizio: oggi(), data_fine: '' })); lega(); };
    $('#salva', rev).onclick = e => conSpinner(e.currentTarget, async () => {
      const esito2 = $('#esito2', rev), schede = $$('.tcard', rev);
      if (!schede.length) return msg(esito2, 'Aggiungi almeno un farmaco.');
      try {
        for (const s of schede) {                    // salva una scheda alla volta
          const t = { malattia: $('#malattia', rev).value };
          $$('[data-k]', s).forEach(i => t[i.dataset.k] = i.value);
          salvaTerapia(UTENTE.id, t); s.remove();
        }
        toast('Terapie salvate: le notifiche sono programmate.'); vai('terapie');
      } catch (err) { msg(esito2, err.message); }
    });
  }
}

/* ================= TERAPIE ATTIVE ================= */
function vistaTerapie(el) {
  const att = terapieAttive(UTENTE.id);
  el.innerHTML = `<div class="view"><div class="between"><h1 class="page-title">Terapie attive</h1><button class="btn teal sm" data-vai="scansiona">${ico('plus')} Nuova</button></div>
    <p class="page-sub">Tocca una terapia per vedere orari e avanzamento.</p>
    ${att.length ? att.map(t => {
      const tot = diffGiorni(t.data_inizio, t.data_fine) + 1, fatti = Math.min(tot, Math.max(0, diffGiorni(t.data_inizio, oggi()) + 1));
      const prossime = q("SELECT orario FROM notifiche WHERE terapia_id=? AND inviata=0 ORDER BY orario LIMIT 1", [t.id])[0];
      return `<div class="card exp hover" style="margin-bottom:14px"><div class="head"><div class="pill">${ico('pill')}</div>
        <div class="tt"><b>${esc(t.farmaco)} <span class="muted" style="font-weight:500">${esc(t.dosaggio)}</span></b><span class="muted small">${nDosi(t.frequenza)} · fino al ${fmtData(t.data_fine)}</span></div><span class="chev">${ico('chev')}</span></div>
        <div class="more"><dl class="kv"><dt>Malattia</dt><dd>${esc(t.malattia || '—')}</dd><dt>Orari</dt><dd>${ORARI[t.frequenza].join(' · ')}</dd>
          <dt>Periodo</dt><dd>${fmtData(t.data_inizio)} → ${fmtData(t.data_fine)}</dd><dt>Prossima dose</dt><dd>${prossime ? fmtData(prossime.orario.slice(0, 10)) + ' ore ' + prossime.orario.slice(11) : '—'}</dd></dl>
          <div class="prog"><i style="width:${Math.round(fatti / tot * 100)}%"></i></div><div class="muted small">Giorno ${fatti} di ${tot}</div>
          <div style="margin-top:12px"><button class="btn danger sm" data-elimina="${t.id}">Elimina terapia</button></div></div></div>`;
    }).join('') : `<div class="card">${vuoto('pill', 'Nessuna terapia attiva', 'Scansiona un documento medico o inserisci una terapia a mano.', `<button class="btn teal sm" data-vai="scansiona">${ico('scan')} Aggiungi terapia</button>`)}</div>`}</div>`;
  collegaVai(el); attivaEspansione(el);
  $$('[data-elimina]', el).forEach(b => b.onclick = () => {
    if (confirm('Eliminare questa terapia e le sue notifiche?')) { eliminaTerapia(UTENTE.id, +b.dataset.elimina); toast('Terapia eliminata.'); rinfresca(); }
  });
}

/* ================= REGISTRO MALATTIE ================= */
function vistaRegistro(el) {
  const tutte = registroMalattie(UTENTE.id);
  el.innerHTML = `<div class="view"><h1 class="page-title">Registro malattie</h1><p class="page-sub">Lo storico completo di malattie, farmaci, dosaggi e date.</p>
    ${tutte.length ? `<input id="cerca" placeholder="Cerca malattia o farmaco…" style="margin-bottom:14px">` : ''}<div id="elenco"></div></div>`;
  const disegna = filtro => {
    const f = filtro.toLowerCase();
    const lista = tutte.filter(m => !f || m.nome.toLowerCase().includes(f) || m.farmaci.some(x => x.nome.toLowerCase().includes(f)));
    $('#elenco', el).innerHTML = lista.length ? lista.map(m => `<div class="card exp hover" style="margin-bottom:14px"><div class="head"><div class="pill">${ico('book')}</div>
      <div class="tt"><b>${esc(m.nome)}</b><span class="muted small">${fmtData(m.data_inizio)} → ${m.data_fine ? fmtData(m.data_fine) : 'in corso'}</span></div>
      <button class="btn ghost sm" data-pdf="${m.id}" title="Esporta PDF">${ico('doc')} PDF</button>
      <span class="badge ${m.data_fine ? 'ok' : 'warn'}">${m.data_fine ? 'Guarita' : 'In corso'}</span><span class="chev">${ico('chev')}</span></div>
      <div class="more">${m.farmaci.map(x => `<div class="sub-f"><b>${esc(x.nome)}</b> ${esc(x.dosaggio)}<br><span class="muted">${nDosi(x.frequenza)} · dal ${fmtData(x.data_inizio)} al ${fmtData(x.data_fine)} · ${x.stato === 'attiva' ? 'in corso' : 'conclusa'}</span></div>`).join('')}${(m.episodi || []).map(ep => `<div class="sub-f"><b>Episodio di sintomi</b> · ${fmtData(ep.data.slice(0, 10))} ${esc(ep.data.slice(11))}<br><span class="muted">${esc(ep.sintomi)}</span>${ep.risposta ? `<div class="ai-box">${fmtAI(ep.risposta)}</div>` : ''}</div>`).join('')}</div></div>`).join('')
      : `<div class="card">${vuoto('book', tutte.length ? 'Nessun risultato' : 'Il registro è vuoto', tutte.length ? 'Prova con un altro termine.' : 'Le malattie compaiono qui quando salvi una terapia.')}</div>`;
    attivaEspansione($('#elenco', el));
    $$('[data-pdf]', el).forEach(b => b.onclick = () => { try { esportaPDF(UTENTE.id, +b.dataset.pdf); toast('PDF esportato.'); } catch (e) { toast(e.message, 'warn'); } });
  };
  disegna('');
  const c = $('#cerca', el); if (c) c.oninput = () => disegna(c.value);
}

/* ================= APPUNTAMENTI ================= */
function vistaAppuntamenti(el) {
  const uid = UTENTE.id, prossimi = appuntamentiProssimi(uid), passati = appuntamentiPassati(uid);
  const scheda = a => `<div class="card" style="margin-bottom:12px"><div class="between"><div style="min-width:0"><b>${esc(a.titolo)}</b>
      <div class="muted small">${fmtData(a.data)} · ore ${esc(a.ora)}</div>${a.note ? `<div class="small" style="margin-top:4px">${esc(a.note)}</div>` : ''}</div>
      <button class="btn danger sm" data-del-app="${a.id}">Elimina</button></div></div>`;
  const avviso = notificheSupportate() && Notification.permission !== 'granted'
    ? `<div class="msg info" style="margin:0 0 14px">Per ricevere i promemoria attiva le notifiche dalla Home o dalle Impostazioni.</div>` : '';
  el.innerHTML = `<div class="view"><h1 class="page-title">Appuntamenti</h1><p class="page-sub">Aggiungi visite ed esami: ti avvisiamo quando arriva il momento.</p>
    ${avviso}
    <div class="card"><h3>Nuovo appuntamento</h3>
      <label class="f">Titolo</label><input id="a-titolo" maxlength="120" placeholder="es. Visita cardiologo">
      <div class="row"><div><label class="f">Data</label><input type="date" id="a-data" value="${oggi()}"></div><div><label class="f">Ora</label><input type="time" id="a-ora" value="09:00"></div></div>
      <label class="f">Note (facoltative)</label><input id="a-note" maxlength="300">
      <button class="btn teal block" id="a-add" style="margin-top:14px">${ico('plus')} Aggiungi appuntamento</button><div id="a-esito"></div></div>
    <div style="margin-top:16px">${prossimi.length ? prossimi.map(scheda).join('') : `<div class="card">${vuoto('cal', 'Nessun appuntamento in programma', 'Aggiungine uno qui sopra per ricevere un promemoria.')}</div>`}</div>
    ${passati.length ? `<div class="sec-t">Passati</div>${passati.map(scheda).join('')}` : ''}</div>`;
  collegaVai(el);
  $('#a-add', el).onclick = () => {
    try {
      aggiungiAppuntamento(uid, { titolo: $('#a-titolo', el).value, data: $('#a-data', el).value, ora: $('#a-ora', el).value, note: $('#a-note', el).value });
      toast('Appuntamento aggiunto.'); vistaAppuntamenti(el);
    } catch (e) { msg($('#a-esito', el), e.message); }
  };
  $$('[data-del-app]', el).forEach(b => b.onclick = () => {
    if (confirm('Eliminare questo appuntamento?')) { eliminaAppuntamento(uid, +b.dataset.delApp); toast('Appuntamento eliminato.'); vistaAppuntamenti(el); }
  });
}

/* ================= REFERTI DI LABORATORIO ================= */
function vistaReferti(el) {
  const tutti = elencoReferti(UTENTE.id), etichetta = { normale: 'Normale', alto: 'Alto', basso: 'Basso' };
  const fuoriRange = e => e.stato === 'alto' || e.stato === 'basso';
  const righe = r => r.esami.map(e => `<tr class="${fuoriRange(e) ? 'fuori' : ''}"><td>${esc(e.nome)}</td><td>${esc(e.valore)} ${esc(e.unita)}</td><td>${esc(e.intervallo || '—')}</td><td>${etichetta[e.stato] || '—'}</td></tr>`).join('');
  el.innerHTML = `<div class="view"><div class="between"><h1 class="page-title">Referti</h1><button class="btn teal sm" data-vai="scansiona">${ico('plus')} Nuovo</button></div>
    <p class="page-sub">I valori dei tuoi esami di laboratorio. In rosso quelli fuori dall'intervallo di riferimento.</p>
    ${tutti.length ? tutti.map(r => { const fuori = r.esami.filter(fuoriRange).length;
      return `<div class="card exp hover" style="margin-bottom:14px"><div class="head"><div class="pill">${ico('doc')}</div>
        <div class="tt"><b>Referto del ${fmtData(r.data)}</b><span class="muted small">${r.esami.length} ${r.esami.length === 1 ? 'esame' : 'esami'}</span></div>
        ${fuori ? `<span class="badge warn">${fuori} fuori range</span>` : `<span class="badge ok">Nella norma</span>`}<span class="chev">${ico('chev')}</span></div>
        <div class="more"><div class="tabella"><table class="lab"><tr><th>Esame</th><th>Valore</th><th>Intervallo</th><th>Stato</th></tr>${righe(r)}</table></div>
          <div style="margin-top:12px"><button class="btn danger sm" data-del-ref="${r.id}">Elimina referto</button></div></div></div>`; }).join('')
      : `<div class="card">${vuoto('doc', 'Nessun referto salvato', 'Scansiona un referto di laboratorio per consultarne i valori qui.', `<button class="btn teal sm" data-vai="scansiona">${ico('scan')} Scansiona un referto</button>`)}</div>`}</div>`;
  collegaVai(el); attivaEspansione(el);
  $$('[data-del-ref]', el).forEach(b => b.onclick = () => {
    if (confirm('Eliminare questo referto?')) { eliminaReferto(UTENTE.id, +b.dataset.delRef); toast('Referto eliminato.'); vistaReferti(el); }
  });
}

/* ================= AI ASSISTANT ================= */
let CHAT = [];                                                   // conversazione (solo in memoria)
function vistaAssistente(el) {
  el.innerHTML = `<div class="view"><h1 class="page-title">AI Assistant</h1><p class="page-sub">Risponde usando i tuoi dati reali: terapie, dosi, registro malattie e referti.</p>
    <div class="card"><div class="chat" id="chat"></div>
    <div class="chips">${['Quali farmaci sto prendendo?', 'Quando finisce la mia terapia?', 'Qual è la prossima dose?', 'Cosa ho avuto in passato?', "Com'era il mio colesterolo nell'ultimo referto?"].map(c => `<button class="chip">${c}</button>`).join('')}</div>
    <form class="row" id="f" style="gap:8px"><input id="dom" placeholder="Scrivi una domanda…" autocomplete="off"><button class="btn teal fit" style="flex:none;padding:11px 14px" aria-label="Invia">${ico('send')}</button></form></div></div>`;
  const chat = $('#chat', el);
  const html = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const disegna = () => { chat.innerHTML = CHAT.length ? CHAT.map(m => `<div class="bub ${m.r === 'u' ? 'u' : 'a'} ${m.err ? 'err' : ''}">${html(m.t)}</div>`).join('') : `<div class="bub a">Ciao ${esc(UTENTE.nome.split(' ')[0])}! Chiedimi pure delle tue terapie o del tuo storico.</div>`; chat.scrollTop = chat.scrollHeight; };
  disegna();
  const invia = async testo => {
    if (!testo.trim()) return;
    const storico = CHAT.filter(m => !m.err).slice(-10).map(m => ({ role: m.r === 'u' ? 'user' : 'model', parts: [{ text: m.t }] }));
    CHAT.push({ r: 'u', t: testo }); disegna();
    chat.insertAdjacentHTML('beforeend', '<div class="bub a dots" id="att"><span></span><span></span><span></span></div>'); chat.scrollTop = chat.scrollHeight;
    try { CHAT.push({ r: 'a', t: await chiediAssistente(UTENTE.id, testo + contestoReferti(UTENTE.id), storico) }); }
    catch (e) { CHAT.push({ r: 'a', t: e.message, err: true }); }
    if ($('#chat')) disegna();
  };
  $('#f', el).onsubmit = e => { e.preventDefault(); const i = $('#dom', el), t = i.value; i.value = ''; invia(t); };
  $$('.chip', el).forEach(c => c.onclick = () => invia(c.textContent));
}

/* ================= IMPOSTAZIONI / PROFILO ================= */
function vistaImpostazioni(el, profilo = false) {
  const perm = notificheSupportate() ? Notification.permission : 'non supportate';
  const statoPerm = { granted: 'Attive', denied: 'Bloccate dal browser', default: 'Non ancora attivate', 'non supportate': 'Non supportate' }[perm];
  el.innerHTML = `<div class="view">
    ${profilo ? `<div class="card" style="text-align:center"><div style="width:72px;height:72px;border-radius:50%;margin:0 auto 10px;display:grid;place-items:center;background:linear-gradient(135deg,var(--blu),var(--teal));color:#fff;font-size:26px;font-weight:700">${esc(iniziali(UTENTE.nome))}</div>
      <h2>${esc(UTENTE.nome)}</h2><div class="muted small" style="margin-bottom:10px">${esc(UTENTE.email)}</div>${badgeStato(statoUtente(UTENTE.id))}</div>`
      : `<h1 class="page-title">Impostazioni</h1><p class="page-sub">Notifiche e account.</p>`}
    <div class="card"><h3>Notifiche</h3><div class="between"><div><b>${statoPerm}</b><div class="muted small">Promemoria per ogni dose, con avviso sull'ultima.</div></div>
      ${perm === 'default' ? `<button class="btn teal sm" id="perm">Attiva</button>` : perm === 'granted' ? `<button class="btn ghost sm" id="prova">Invia prova</button>` : ''}</div></div>
    <div class="card btn-install"><h3>App</h3><div class="between"><div class="muted small">Installa Sanilyx sul telefono o sul computer: si apre in una finestra tutta sua, come una vera app, con la sua icona.</div><button class="btn teal sm" data-installa>${ico('upload')} Scarica l'app</button></div></div>
    <div class="card"><h3>Lingua</h3><div class="between"><div class="muted small">Scegli la lingua dell'interfaccia e dell'assistente AI.</div>${selettoreLingua()}</div></div>
    <div class="card"><h3>Account</h3><div class="muted small" style="margin-bottom:12px">${esc(UTENTE.nome)} · ${esc(UTENTE.email)}</div>
      <div class="row"><button class="btn ghost" id="esci">${ico('out')} Esci</button><button class="btn danger" id="reset">Cancella tutti i dati</button></div></div></div>`;
  const p = $('#perm', el); if (p) p.onclick = async () => { await chiediPermessoNotifiche(); sincronizzaSW(UTENTE.id); rinfresca(true); };
  const pr = $('#prova', el); if (pr) pr.onclick = async () => { await mostraNotifica('Sanilyx · notifica di prova', 'Le notifiche funzionano correttamente.', 'prova'); toast('Notifica di prova inviata.'); };
  $('#esci', el).onclick = () => esci();
  $('#reset', el).onclick = () => {
    if (confirm('Cancellare TUTTI i dati (account, terapie, registro) da questo browser? Non si può annullare.')) {
      localStorage.removeItem(DB_KEY); localStorage.removeItem(SESSION_KEY); location.reload();
    }
  };
}


/* ================================================================
   13. SHELL DEL SITO WEB: navigazione, avvio
   ================================================================ */
const VISTE = {
  dashboard:    { t: 'Dashboard',        i: 'home', f: vistaDashboard },
  scansiona:    { t: 'Scansiona',        i: 'scan', f: vistaScansiona },
  terapie:      { t: 'Terapie attive',   i: 'pill', f: vistaTerapie },
  registro:     { t: 'Registro malattie',i: 'book', f: vistaRegistro },
  referti:      { t: 'Referti',          i: 'doc',  f: vistaReferti },
  appuntamenti: { t: 'Appuntamenti',     i: 'cal',  f: vistaAppuntamenti },
  assistente:   { t: 'AI Assistant',     i: 'chat', f: vistaAssistente },
  impostazioni: { t: 'Impostazioni',     i: 'gear', f: el => vistaImpostazioni(el, false) }
};
let vistaCorrente = 'dashboard';

function vai(nome) {                                   // cambia pagina
  vistaCorrente = nome;
  $$('.nav').forEach(b => b.classList.toggle('on', b.dataset.v === nome));
  VISTE[nome].f($('#contenuto'));
  $('#main').scrollTo(0, 0);
}
function rinfresca(forza) {                            // ridisegna solo le pagine "di dati"
  if (forza || ['dashboard', 'terapie', 'registro'].includes(vistaCorrente)) vai(vistaCorrente);
  aggiornaHeader();
}
function aggiornaHeader() {
  UTENTE = q('SELECT * FROM utenti WHERE id=?', [UTENTE.id])[0];
  $('#h-nome').textContent = UTENTE.nome; $('#h-av').textContent = iniziali(UTENTE.nome); $('#h-stato').innerHTML = badgeStato(UTENTE.stato);
}
function avviaApp(utente) {
  UTENTE = utente; CHAT = [];
  $('#auth').hidden = true; $('#auth-form').innerHTML = ''; $('#app').hidden = false;   // svuota il login: niente campi password rimasti nel DOM
  $('#nav').innerHTML = Object.entries(VISTE).map(([k, v]) => `<button class="nav" data-v="${k}">${ico(v.i)}<span class="lbl">${v.t}</span></button>`).join('') + '<div class="foot">Sanilyx · dati salvati su questo browser</div>';
  $$('.nav').forEach(b => b.onclick = () => vai(b.dataset.v));
  aggiornaStati(UTENTE.id); aggiornaHeader(); vai('dashboard');
  avviaScheduler(UTENTE.id, () => rinfresca());       // controlla le dosi ogni 20 secondi
}
function mostraAuth() {
  fermaScheduler(); $('#app').hidden = true; $('#auth').hidden = false;
  $('#punti').innerHTML = [['scan', 'Scansione documenti con intelligenza artificiale'], ['bell', 'Notifiche per ogni dose, anche l\'ultima'], ['book', 'Registro malattie sempre consultabile']].map(([i, t]) => `<li>${ico(i)}${t}</li>`).join('');
  renderAuth($('#auth-form'), u => avviaApp(u));
}
function esci() { logout(); UTENTE = null; mostraAuth(); }

/* ---------- PWA: installazione come app ----------
   • Il manifest è costruito qui (icone ricavate dal logo) e collegato come Blob.
   • sw.js (file vero, i browser non accettano service worker da blob:) tiene l'app offline
     e mostra le notifiche anche con l'app chiusa.
   • Il tasto "Scarica l'app" (header, accesso, impostazioni) lancia la finestra di installazione
     del browser; dove il browser non la offre (iPhone/Safari, Firefox) mostra le istruzioni.
   • Una volta installata, l'app si apre in una finestra propria (display: standalone) e il tasto sparisce. */
let _promptInstall = null;
const _giaApp = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const segnaApp = () => document.documentElement.classList.toggle('is-app', _giaApp());
segnaApp();
if (window.matchMedia) { try { matchMedia('(display-mode: standalone)').addEventListener('change', segnaApp); } catch (e) {} }
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _promptInstall = e; });
window.addEventListener('appinstalled', () => { _promptInstall = null; document.documentElement.classList.add('is-app'); if (typeof toast === 'function') toast('App installata.'); });
document.addEventListener('click', async e => {
  const b = e.target.closest && e.target.closest('[data-installa]'); if (!b) return;
  if (_promptInstall) {
    const p = _promptInstall; _promptInstall = null;
    try { await p.prompt(); await p.userChoice; } catch (err) {}
    return;
  }
  const m = apriModale(`<h2>Installa Sanilyx</h2>
    <p class="small" style="margin:12px 0">iPhone / iPad (Safari): tocca il pulsante Condividi, poi "Aggiungi alla schermata Home".</p>
    <p class="small" style="margin:12px 0">Android (Chrome): apri il menu ⋮ e scegli "Installa app" (o "Aggiungi a schermata Home").</p>
    <p class="small" style="margin:12px 0">Computer (Chrome / Edge): clicca l'icona di installazione nella barra degli indirizzi, oppure menu ⋮ → "Installa Sanilyx".</p>
    <p class="muted small" style="margin:12px 0">Per installare serve aprire il sito da https (o da localhost).</p>
    <button class="btn teal block" style="margin-top:6px" data-chiudi>Chiudi</button>`);
  $('[data-chiudi]', m).onclick = () => m.remove();
});
function installaManifest() {
  const img = new Image();
  img.onload = () => {
    const icona = (dim, margine = 0.14) => {              // logo su fondo bianco, centrato
      const c = document.createElement('canvas'); c.width = c.height = dim; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, dim, dim); const m = dim * margine; x.drawImage(img, m, m, dim - 2 * m, dim - 2 * m);
      return c.toDataURL('image/png');
    };
    const base = location.href.split('?')[0].split('#')[0];
    const manifest = { name: 'Sanilyx', short_name: 'Sanilyx', lang: 'it', display: 'standalone', background_color: '#ffffff', theme_color: '#1A3A5C',
      start_url: base, scope: base.replace(/[^/]*$/, ''),
      icons: [{ src: icona(192), sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: icona(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
              { src: icona(512, 0.22), sizes: '512x512', type: 'image/png', purpose: 'maskable' }] };
    const l = document.createElement('link'); l.rel = 'manifest';
    l.href = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    document.head.appendChild(l);
    document.head.insertAdjacentHTML('beforeend', `<link rel="apple-touch-icon" href="${icona(180)}">`);
  };
  img.src = LOGO;
}
async function registraServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; if (UTENTE) sincronizzaSW(UTENTE.id); }
  catch (e) { console.warn('Service worker non attivo (serve http://localhost o https e il file sw.js):', e.message); }
}

/* ---------- LOGO ----------
   Incorporato UNA volta sola (PNG in base64) e assegnato a tutte le <img data-logo>. */
const LOGO = 'data:image/png;base64,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';
document.querySelectorAll('img[data-logo]').forEach(i => i.src = LOGO);
document.head.insertAdjacentHTML('beforeend', '<link rel="icon" href="' + LOGO + '">');

/* ---------- AVVIO ----------
   1) inizializza il database; 2) aspetta almeno 2,8 s al primo avvio della sessione
   (così l'animazione si vede); 3) mostra login o app; 4) dissolvenza del caricamento. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async function avvio() {
  installaManifest();
  const primoAvvio = !sessionStorage.getItem('sanilyx_loaded');
  try { await Promise.all([initDB(), primoAvvio ? sleep(2800) : null]); }
  catch (e) { $('#loader').insertAdjacentHTML('beforeend', `<div class="ld-err">Impossibile avviare il database (serve la connessione per caricare sql.js).<br>${esc(e.message)}</div>`); return; }
  sessionStorage.setItem('sanilyx_loaded', '1');
  await registraServiceWorker();
  const u = utenteCorrente();
  if (u) avviaApp(u); else mostraAuth();
  $('#loader').classList.add('out'); setTimeout(() => $('#loader').remove(), 700);
})();
