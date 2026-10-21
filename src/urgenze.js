// urgenze.js — Richieste di intervento urgenti fuori orario
// De Pasquale Impianti — dpi-chatbot
//
// Orari di chiusura (fuso Europe/Rome, ora legale gestita in automatico):
//   - lun-ven: chiuso dalle 18:30 alle 8:00
//   - sabato e domenica: chiuso tutto il giorno
//   - festività nazionali: chiuso tutto il giorno
//
// Variabili d'ambiente (Render):
//   NUMERO_URGENZE   numero che riceve la notifica (default 393519072997)
//   FESTIVITA_EXTRA  date extra di chiusura, formato "MM-DD" separate da virgola
//                    (es. "08-07" per il santo patrono)

const FUSO = 'Europe/Rome';
const APERTURA_MIN = 8 * 60;        // 08:00
const CHIUSURA_MIN = 18 * 60 + 30;  // 18:30
const NUMERO_URGENZE = process.env.NUMERO_URGENZE || '393519072997';
const TEMPLATE_URGENZA = 'richiesta_urgente_v1';

// ---------- Orari ----------

function partiDataRoma(data = new Date()) {
  const parti = new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(data);
  const p = Object.fromEntries(parti.map(x => [x.type, x.value]));
  return {
    anno: Number(p.year),
    mese: Number(p.month),
    giorno: Number(p.day),
    ora: Number(p.hour) % 24,
    minuto: Number(p.minute),
    giornoSettimana: p.weekday, // Mon, Tue, ... Sun
  };
}

// Domenica di Pasqua (algoritmo di Meeus/Jones/Butcher)
function pasqua(anno) {
  const a = anno % 19, b = Math.floor(anno / 100), c = anno % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mese = Math.floor((h + l - 7 * m + 114) / 31);
  const giorno = ((h + l - 7 * m + 114) % 31) + 1;
  return { mese, giorno };
}

const pad = n => String(n).padStart(2, '0');

function festivita(anno) {
  const fisse = [
    '01-01', // Capodanno
    '01-06', // Epifania
    '04-25', // Liberazione
    '05-01', // Festa del Lavoro
    '06-02', // Festa della Repubblica
    '08-15', // Ferragosto
    '10-04', // San Francesco (festa nazionale dal 2026)
    '11-01', // Ognissanti
    '12-08', // Immacolata
    '12-25', // Natale
    '12-26', // Santo Stefano
  ];
  // Pasquetta = giorno dopo Pasqua
  const p = pasqua(anno);
  const lunedi = new Date(Date.UTC(anno, p.mese - 1, p.giorno + 1));
  const pasquetta = `${pad(lunedi.getUTCMonth() + 1)}-${pad(lunedi.getUTCDate())}`;

  const extra = (process.env.FESTIVITA_EXTRA || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  return new Set([...fisse, pasquetta, ...extra]);
}

function isFuoriOrario(data = new Date()) {
  const d = partiDataRoma(data);
  if (d.giornoSettimana === 'Sat' || d.giornoSettimana === 'Sun') return true;
  if (festivita(d.anno).has(`${pad(d.mese)}-${pad(d.giorno)}`)) return true;
  const minuti = d.ora * 60 + d.minuto;
  return minuti < APERTURA_MIN || minuti >= CHIUSURA_MIN;
}

function dataOraRoma(data = new Date()) {
  const d = partiDataRoma(data);
  return `${pad(d.giorno)}/${pad(d.mese)}/${d.anno} ${pad(d.ora)}:${pad(d.minuto)}`;
}

// ---------- Messaggi al cliente ----------

const DOMANDA_URGENZA_FUORI_ORARIO =
  '🌙 I nostri uffici sono chiusi in questo momento.\n\n' +
  '⚠️ Per un intervento *entro 4 ore* fuori orario è previsto un costo aggiuntivo composto da:\n' +
  '• *diritto di chiamata notturno/festivo*\n' +
  '• *costo chilometrico* per lo spostamento del tecnico\n\n' +
  'Accetti e vuoi procedere con la richiesta?';

const TESTO_URGENZA_SI =
  '✅ Richiesta urgente inoltrata. Un nostro tecnico ti ricontatterà al più presto ' +
  "per confermare l'intervento e il supplemento.";

// ---------- Notifica a Giacomo (template) ----------

// I parametri dei template non accettano a capo, tab o più di 4 spazi di fila
function pulisci(testo, max = 900) {
  return String(testo ?? '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max) || '-';
}

function payloadNotificaUrgenza({ nome, telefono, indirizzo, problema, ricevutaIl }) {
  const valori = [nome, telefono, indirizzo, problema, ricevutaIl || dataOraRoma()];
  return {
    messaging_product: 'whatsapp',
    to: NUMERO_URGENZE,
    type: 'template',
    template: {
      name: TEMPLATE_URGENZA,
      language: { code: 'it' },
      components: [{
        type: 'body',
        parameters: valori.map(v => ({ type: 'text', text: pulisci(v) })),
      }],
    },
  };
}

// chiamaApiWhatsapp(payload) -> true/false; inviaEmail({ oggetto, html })
// Se la notifica WhatsApp non parte, arriva comunque un'email di riserva.
async function notificaUrgenza(dati, { chiamaApiWhatsapp, inviaEmail }) {
  const ok = await chiamaApiWhatsapp(payloadNotificaUrgenza(dati));
  if (ok) {
    console.log('🚨 Notifica urgenza inviata a', NUMERO_URGENZE);
    return;
  }
  console.error('❌ Notifica urgenza WhatsApp non riuscita, invio email di riserva');
  await inviaEmail({
    oggetto: '🚨 URGENTE fuori orario – ' + pulisci(dati.nome, 80),
    html:
      '<h2>🚨 Richiesta URGENTE fuori orario</h2>' +
      '<p><em>La notifica WhatsApp non è partita.</em></p>' +
      `<p><strong>Cliente:</strong> ${pulisci(dati.nome)}<br>` +
      `<strong>Telefono:</strong> ${pulisci(dati.telefono)}<br>` +
      `<strong>Indirizzo:</strong> ${pulisci(dati.indirizzo)}<br>` +
      `<strong>Problema:</strong> ${pulisci(dati.problema)}<br>` +
      `<strong>Ricevuta il:</strong> ${pulisci(dati.ricevutaIl || dataOraRoma())}</p>` +
      '<p>Il cliente ha accettato il diritto di chiamata notturno/festivo e il costo chilometrico.</p>',
  });
}

module.exports = {
  isFuoriOrario,
  dataOraRoma,
  festivita,
  DOMANDA_URGENZA_FUORI_ORARIO,
  TESTO_URGENZA_SI,
  payloadNotificaUrgenza,
  notificaUrgenza,
};
