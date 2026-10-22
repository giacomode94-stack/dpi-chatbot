const express = require("express");
const multer = require("multer");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const urgenze = require("./urgenze");
const app = express();
app.use(express.json());
const { registraTestInvio } = require('./test-invio');
registraTestInvio(app);
const { registraPaginaChat } = require("./chat-page");
registraPaginaChat(app);
// Link aperto dal pulsante "Apri chat" (live chat Yeastar/Linkus).
// Per usare il link diretto generato dal centralino Yeastar basta impostare
// CHAT_URL su Render. Nota: il widget Yeastar si carica solo sul dominio
// configurato nel centralino, per questo la pagina /chat del bot resta vuota.
const CHAT_URL = process.env.CHAT_URL || "https://www.depasqualeimpianti.com";

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "dpi_chatbot_token";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ─── CONFIGURAZIONE EMAIL (Brevo via API HTTPS) ─────────────────────────────────
// Usiamo l'API HTTPS di Brevo (ex Sendinblue, piano gratuito: 300 email/giorno
// per sempre, nessuna carta richiesta) al posto di SendGrid. Come con SendGrid,
// usiamo l'API HTTPS e non l'SMTP: le porte SMTP (25/465/587) sono bloccate sui
// servizi web gratuiti di Render, mentre le chiamate HTTPS non lo sono.
// La casella appuntamenti@ resta usata SOLO in ricezione (polling IMAP) per le
// conferme appuntamento del gestionale — le due caselle non si mescolano.
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_MITTENTE = process.env.EMAIL_MITTENTE || "info@depasqualeimpianti.com";
const EMAIL_DESTINATARIO = process.env.EMAIL_DESTINATARIO || "info@depasqualeimpianti.com";

// Token segreto opzionale per proteggere il webhook di inbound email.
// Se impostato, l'URL configurato su SendGrid Inbound Parse deve includere
// ?secret=IL_TUO_TOKEN, altrimenti la richiesta viene rifiutata.
const INBOUND_SECRET = process.env.INBOUND_SECRET;

// Nome del template WhatsApp usato per la conferma appuntamento.
// Parametri del body nell'ordine: Nome cliente, Data, Ora.
const TEMPLATE_CONFERMA_APPUNTAMENTO = process.env.TEMPLATE_CONFERMA_APPUNTAMENTO || "conferma_appuntamento_v2";

// Nome del template WhatsApp usato quando il gestionale invia un "Cambio
// pianificazione" (appuntamento spostato/pianificato). Stessi parametri:
// Nome cliente, Data, Ora.
const TEMPLATE_CAMBIO_APPUNTAMENTO = process.env.TEMPLATE_CAMBIO_APPUNTAMENTO || "cambio_appuntamento_v1";

// ─── PROMEMORIA IL GIORNO PRIMA DELL'APPUNTAMENTO ───────────────────────────────
// Template WhatsApp del promemoria (parametri: Nome, Data, Ora) con due pulsanti
// di risposta rapida: [0] "Confermo", [1] "Devo annullare/spostare".
const TEMPLATE_PROMEMORIA = process.env.TEMPLATE_PROMEMORIA || "promemoria_appuntamento_v1";
// Orario (ora italiana, HH:MM) a partire dal quale si inviano i promemoria per
// gli appuntamenti del giorno dopo.
const PROMEMORIA_ORARIO = process.env.PROMEMORIA_ORARIO || "10:30";
// Oltre questo orario non si inviano più promemoria (es. se il bot è rimasto
// spento tutta la mattina, non vogliamo mandarli a tarda sera).
const PROMEMORIA_ORARIO_LIMITE = process.env.PROMEMORIA_ORARIO_LIMITE || "19:00";
// Quanti giorni indietro guardare nella casella per trovare gli appuntamenti.
const PROMEMORIA_GIORNI_STORICO = Number(process.env.PROMEMORIA_GIORNI_STORICO || 60);
// Flag IMAP che marca l'email dell'appuntamento per cui il promemoria è già
// partito: così un riavvio del bot non manda promemoria doppi.
const IMAP_PROMEMORIA_FLAG = "DPIPromemoriaInviato";
// Oggetto delle email inviate dall'ufficio a appuntamenti@ per bloccare il
// promemoria di un appuntamento annullato (nel testo: il numero del cliente).
const IMAP_SUBJECT_ANNULLA = process.env.IMAP_SUBJECT_ANNULLA || "annulla";

// ─── LETTURA CASELLA APPUNTAMENTI VIA IMAP (in alternativa/attesa del webhook) ──
// La casella appuntamenti@depasqualeimpianti.com (Migadu) è dedicata SOLO alle
// notifiche di conferma appuntamento inviate dal gestionale. Il bot la controlla
// periodicamente via IMAP, invece di ricevere un webhook, per non dipendere
// dalla configurazione DNS/SendGrid Inbound Parse (che richiede accesso al
// pannello DNS del dominio, non sempre disponibile).
const IMAP_HOST = process.env.IMAP_HOST || "imap.migadu.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER; // es. appuntamenti@depasqualeimpianti.com
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;
const IMAP_POLL_MS = Number(process.env.IMAP_POLL_MS || 3 * 60 * 1000); // ogni 3 minuti
// Le email del gestionale hanno sempre questo oggetto: usarlo come primo filtro
// (oltre all'estrazione nome/data/ora/telefono dal testo) evita di processare
// per errore email non pertinenti finite in questa casella.
const IMAP_SUBJECT_FILTER = process.env.IMAP_SUBJECT_FILTER || "notifica di inserimento richiesta";
// Oggetto delle email di cambio pianificazione del gestionale. Nota: il
// gestionale scrive "pianficazione" (senza la "i"), quindi cerchiamo la parte
// comune "cambio pian" che copre sia la versione con refuso che quella corretta.
const IMAP_SUBJECT_CAMBIO = process.env.IMAP_SUBJECT_CAMBIO || "cambio pian";
// Flag IMAP personalizzato usato per marcare le email già elaborate dal bot,
// senza toccare lo stato letto/non letto visibile in webmail.
const IMAP_PROCESSED_FLAG = "DPIBotProcessed";
// Data di avvio del processo: non elaboriamo email precedenti a questo momento,
// per evitare che alla primissima attivazione (o dopo un riavvio) il bot mandi
// conferme WhatsApp per vecchie email già presenti nella casella. Le email già
// elaborate restano comunque marcate per sempre (il flag è sul server IMAP),
// quindi un riavvio successivo non le rielabora.
const IMAP_AVVIO = new Date();

async function inviaEmail({ oggetto, html, attachments }) {
  try {
    const body = {
      sender: { email: EMAIL_MITTENTE, name: "DPI Chatbot" },
      to: [{ email: EMAIL_DESTINATARIO }],
      subject: oggetto,
      htmlContent: html,
    };

    if (attachments && attachments.length > 0) {
      body.attachment = attachments.map((a) => ({
        content: a.content.toString("base64"),
        name: a.filename,
      }));
    }

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status >= 200 && res.status < 300) {
      console.log(`✅ Email inviata: ${oggetto}`);
      return true;
    } else {
      const errText = await res.text();
      console.error(`❌ Errore invio email (${res.status}):`, errText);
      return false;
    }
  } catch (err) {
    console.error("❌ Errore invio email:", err.message);
    return false;
  }
}

// ─── STATO CONVERSAZIONI (in memoria) ───────────────────────────────────────────
// Map: numero_cliente -> { flow, stepIndex, dati, ultimoAggiornamento, followUpInviato }
const stato = new Map();

// ─── CODA DI ELABORAZIONE PER-CLIENTE ──────────────────────────────────────────
// Garantisce che i messaggi dello stesso numero vengano elaborati uno alla
// volta, nell'ordine di arrivo, anche se ne arrivano più ravvicinati.
const codaPerCliente = new Map(); // from -> Promise (ultima elaborazione in corso)

function accodaElaborazione(from, taskFn) {
  const precedente = codaPerCliente.get(from) || Promise.resolve();
  const nuova = precedente
    .then(() => taskFn())
    .catch((err) => console.error("❌ Errore in coda elaborazione:", err.message));
  codaPerCliente.set(from, nuova);
  return nuova;
}

// Map: message_id -> timestamp, per ignorare webhook duplicati da Meta
const messaggiProcessati = new Map();
setInterval(() => {
  const ora = Date.now();
  const DIECI_MINUTI = 10 * 60 * 1000;
  for (const [id, ts] of messaggiProcessati.entries()) {
    if (ora - ts > DIECI_MINUTI) messaggiProcessati.delete(id);
  }
}, 5 * 60 * 1000);

const STEP_PREVENTIVO = [
  { chiave: "nome", domanda: "📝 Qual è il tuo *nome e cognome*?" },
  {
    chiave: "tipo_intervento",
    domanda:
      "🔧 Che tipo di intervento ti serve?\n(es. pompa di calore, fotovoltaico, impianto elettrico, caldaia, TVCC...)",
  },
  { chiave: "comune", domanda: "📍 In che *comune* si trova l'immobile?" },
  {
    chiave: "tipo_immobile",
    domanda: "🏠 Che tipo di immobile è? (appartamento, villa, capannone...)",
  },
  {
    chiave: "telefono",
    domanda: "📞 Lasciaci un *numero di telefono* per essere ricontattato",
  },
  {
    chiave: "email",
    domanda: "📧 Qual è la tua *email*? (ci serve per inviarti il preventivo)",
  },
];

const STEP_GUASTO = [
  { chiave: "nome", domanda: "📝 Qual è il tuo *nome e cognome*?" },
  {
    chiave: "tipo_impianto",
    domanda: "🔧 Che tipo di impianto ha il problema?",
  },
  {
    chiave: "descrizione",
    domanda: "📋 Descrivi brevemente il problema riscontrato",
  },
  {
    chiave: "comune",
    domanda: "📍 Indicami *comune e indirizzo* dell'immobile",
  },
  {
    chiave: "foto",
    domanda: "📷 Se vuoi, invia una *foto* o un *video* del guasto, oppure premi *Salta foto*",
    facoltativo: true,
  },
  {
    chiave: "telefono",
    domanda: "📞 Lasciaci un *numero di telefono* per essere richiamato",
  },
  {
    chiave: "email",
    domanda: "📧 Qual è la tua *email*? (utile per aggiornamenti sulla richiesta)",
  },
  { chiave: "urgente", domanda: "🚨 È un caso urgente?" },
];

const MAX_FOTO = 10;

const OPZIONI_TIPO_IMPIANTO = [
  { id: "imp_elettrico", title: "⚡ Elettrico", label: "Elettrico" },
  { id: "imp_idrico", title: "💧 Idrico", label: "Idrico" },
  { id: "imp_riscaldamento", title: "🔥 Riscaldamento", label: "Riscaldamento" },
  { id: "imp_clima", title: "❄️ Climatizzazione", label: "Climatizzazione / Pompa di calore" },
  { id: "imp_fotovoltaico", title: "☀️ Fotovoltaico", label: "Fotovoltaico" },
  { id: "imp_caldaia", title: "🔥 Caldaia", label: "Caldaia" },
  { id: "imp_tvcc", title: "📹 TVCC/Automazioni", label: "TVCC / Automazioni" },
  { id: "imp_altro", title: "❓ Altro", label: "Altro" },
];

function nuovaSessione(flow) {
  return {
    flow: flow,
    stepIndex: 0,
    dati: {},
    ultimoAggiornamento: Date.now(),
    followUpInviato: false,
  };
}

// Flusso "urgenza" (intervento entro 4 ore dal menu Urgente): stesse domande
// del guasto, senza "È urgente?" perché il cliente l'ha già scelto.
const STEP_URGENZA = STEP_GUASTO.filter((s) => s.chiave !== "urgente");

function getSteps(flow) {
  if (flow === "preventivo") return STEP_PREVENTIVO;
  if (flow === "urgenza") return STEP_URGENZA;
  return STEP_GUASTO;
}

// ─── WEBHOOK VERIFICA (Meta lo chiama per verificare l'endpoint) ───────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificato con successo!");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Verifica webhook fallita");
    res.sendStatus(403);
  }
});

// ─── WEBHOOK RICEZIONE MESSAGGI ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Rispondi subito a Meta

  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const messages = value?.messages;

  if (!messages || messages.length === 0) return;

  const message = messages[0];
  const from = message.from;
  const tipo = message.type;

  // ─── DEDUPLICAZIONE MESSAGGI ──────────────────────────────────────────────
  // WhatsApp può recapitare lo stesso webhook più di una volta (retry di rete).
  // Teniamo traccia degli ID già processati per evitare doppie elaborazioni
  // (es. email di preventivo/guasto inviate due volte).
  if (message.id && messaggiProcessati.has(message.id)) {
    console.log(`⏭️ Messaggio duplicato ignorato: ${message.id}`);
    return;
  }
  if (message.id) {
    messaggiProcessati.set(message.id, Date.now());
  }

  console.log(`📩 Messaggio da ${from} (tipo: ${tipo})`);

  // Mettiamo in coda l'elaborazione per questo cliente: se arrivano più
  // messaggi ravvicinati (es. più foto inviate insieme), vengono gestiti
  // uno alla volta nell'ordine di arrivo, mai in parallelo. Questo evita
  // che due elaborazioni concorrenti leggano/scrivano lo stesso stato di
  // sessione contemporaneamente e "saltino" dei passaggi del flusso.
  accodaElaborazione(from, () => elaboraMessaggio(from, message));
});

// ─── WEBHOOK INBOUND EMAIL (SendGrid Inbound Parse) ────────────────────────
// Riceve via email le conferme appuntamento generate dal gestionale e invia
// automaticamente al cliente la notifica WhatsApp corrispondente, usando il
// template "conferma_appuntamento_v2".
//
// SendGrid Inbound Parse invia il payload come multipart/form-data (non
// JSON), quindi usiamo multer per leggerne i campi testuali (upload.none()
// = nessun file, solo i campi "to", "from", "subject", "text", "html", ...).
const uploadParser = multer();

app.post("/inbound-email", uploadParser.none(), async (req, res) => {
  // Rispondiamo subito 200 in ogni caso: SendGrid ritenta in caso di errore
  // HTTP, e un retry qui produrrebbe invii WhatsApp duplicati al cliente.
  res.status(200).send("ok");

  try {
    if (INBOUND_SECRET && req.query.secret !== INBOUND_SECRET) {
      console.error("❌ Inbound email: secret mancante o errato, richiesta ignorata.");
      return;
    }

    const oggetto = req.body.subject || "(senza oggetto)";
    const testoEmail = req.body.text || "";

    console.log(`📧 Email in arrivo: "${oggetto}"`);

    const appuntamento = estraiDatiAppuntamento(testoEmail);

    if (!appuntamento) {
      console.error("⚠️ Inbound email: impossibile estrarre i dati dell'appuntamento (nome/data/ora/telefono).");
      await inviaEmail({
        oggetto: `⚠️ Notifica WhatsApp NON inviata — verifica manuale richiesta`,
        html:
          `<p>Non sono riuscito a estrarre automaticamente nome, data, ora o telefono da questa email:</p>` +
          `<p><strong>Oggetto:</strong> ${oggetto}</p>` +
          `<pre>${(testoEmail || "(corpo vuoto)").replace(/</g, "&lt;")}</pre>` +
          `<p>Invia manualmente la conferma al cliente.</p>`,
      });
      return;
    }

    await inviaConfermaAppuntamento(appuntamento);
  } catch (err) {
    console.error("❌ Errore elaborazione inbound email:", err.message);
  }
});

// Estrae nome cliente, data, ora e numero di telefono dal corpo dell'email
// di conferma appuntamento generata dal gestionale. Pensata per il formato:
//
//   Buongiorno Sig. NOME COGNOME
//   La presente è per confermare l'appuntamento 15/09/2026 alle ore 17:30, ...
//   ... che la contatteranno al n° +393519072997 .
//
// Tollera varianti di titolo (Sig./Sig.ra/Gent.mo/Gent.ma/Dott./Spett.le) e
// numeri scritti con o senza "+", spazi o prefisso 0.
function estraiDatiAppuntamento(testo) {
  if (!testo) return null;

  const primaRiga = (testo.split(/\r?\n/)[0] || "").trim();
  const matchNome = primaRiga.match(/Buongiorno\s+(.+)/i);
  let nome = matchNome ? matchNome[1].trim() : null;
  if (nome) {
    nome = nome
      .replace(/^(Gent\.?\s?(mo|ma)\.?\s+)?(Sig\.?\s?(ra)?\.?|Dott\.?(ssa)?\.?|Spett\.?le\.?)\s*/i, "")
      .replace(/[.,]\s*$/, "")
      .trim();
  }

  const matchData = testo.match(/(\d{2}\/\d{2}\/\d{4})/);
  const data = matchData ? matchData[1] : null;

  const matchOra = testo.match(/ore\s+(\d{1,2}[:.]\d{2})/i);
  const ora = matchOra ? matchOra[1].replace(".", ":") : null;

  const matchTelefono = testo.match(/n[°º]?\s*(\+?\d[\d\s]{7,13}\d)/);
  const telefonoGrezzo = matchTelefono ? matchTelefono[1] : null;
  const telefono = telefonoGrezzo ? telefonoGrezzo.replace(/[^\d]/g, "") : null;

  if (!nome || !data || !ora || !telefono) return null;

  const numero = normalizzaNumero(telefono);

  return { nome, data, ora, numero };
}

// Porta un numero italiano nel formato usato da WhatsApp (39XXXXXXXXXX).
// Gestisce +39/0039, cellulari scritti senza prefisso (3XX XXXXXXX, anche
// quelli che iniziano per 39) e fissi con lo 0 iniziale.
function normalizzaNumero(grezzo) {
  let n = String(grezzo || "").replace(/[^\d]/g, "");
  if (n.startsWith("00")) n = n.slice(2);
  if (n.length === 10 && n.startsWith("3")) return `39${n}`; // cellulare senza prefisso
  if (n.startsWith("39")) return n;
  return `39${n.replace(/^0/, "")}`;
}

// Invia la notifica WhatsApp di conferma appuntamento tramite template Meta.
async function inviaConfermaAppuntamento({ nome, data, ora, numero }, tipo = "conferma") {
  const nomeTemplate = tipo === "cambio" ? TEMPLATE_CAMBIO_APPUNTAMENTO : TEMPLATE_CONFERMA_APPUNTAMENTO;
  const etichetta = tipo === "cambio" ? "Cambio appuntamento" : "Conferma appuntamento";

  // WhatsApp funziona solo su numeri di cellulare (in Italia iniziano con 3,
  // quindi 393...). Se il gestionale riporta un numero fisso (es. 0923...)
  // non tentiamo l'invio e avvisiamo via email.
  if (!/^393\d{8,10}$/.test(numero)) {
    console.error(`⚠️ ${etichetta}: numero ${numero} non è un cellulare, WhatsApp non inviato.`);
    await inviaEmail({
      oggetto: `⚠️ Notifica WhatsApp NON inviata a ${nome} (${numero}) — numero non cellulare`,
      html:
        `<p>${etichetta} del <strong>${data} alle ore ${ora}</strong> per <strong>${nome}</strong>.</p>` +
        `<p>Il numero <strong>+${numero}</strong> non sembra un cellulare, quindi non posso inviare il WhatsApp.</p>` +
        `<p>Contatta il cliente manualmente.</p>`,
    });
    return null;
  }

  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: numero,
    type: "template",
    template: {
      name: nomeTemplate,
      language: { code: "it" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: nome },
            { type: "text", text: data },
            { type: "text", text: ora },
          ],
        },
      ],
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (result.error) {
      console.error(`❌ Errore invio ${etichetta.toLowerCase()} a ${numero}:`, result.error);
      await inviaEmail({
        oggetto: `⚠️ Notifica WhatsApp NON inviata a ${nome} (${numero})`,
        html: `<p>Errore API WhatsApp:</p><pre>${JSON.stringify(result.error, null, 2)}</pre>`,
      });
    } else {
      console.log(`✅ ${etichetta} inviato a ${nome} (${numero}) — ${data} ${ora}`);
    }

    return result;
  } catch (err) {
    console.error(`❌ Errore rete invio conferma appuntamento a ${numero}:`, err.message);
    await inviaEmail({
      oggetto: `⚠️ Notifica WhatsApp NON inviata a ${nome} (${numero})`,
      html: `<p>Errore di rete durante l'invio:</p><pre>${err.message}</pre>`,
    });
  }
}

// ─── CONTROLLO PERIODICO CASELLA APPUNTAMENTI (IMAP) ───────────────────────────
// Si collega alla casella dedicata, cerca le email con l'oggetto del gestionale
// non ancora elaborate (senza il flag IMAP_PROCESSED_FLAG), estrae i dati con
// la stessa logica del webhook /inbound-email e invia la conferma WhatsApp.
// Ogni email controllata viene marcata con un flag IMAP personalizzato, per non
// rielaborarla ai controlli successivi e senza alterare lo stato letto/non letto
// che vedi tu in webmail.
let controlloImapInCorso = false;

async function controllaEmailAppuntamenti() {
  if (!IMAP_USER || !IMAP_PASSWORD) return; // funzione non configurata, si salta
  if (controlloImapInCorso) return; // evita sovrapposizioni se un ciclo impiega troppo
  controlloImapInCorso = true;

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Cerchiamo solo le email col soggetto del gestionale: IMAP filtra lato
      // server, così scarichiamo/analizziamo solo ciò che ci interessa.
      const uids = await client.search(
        {
          since: IMAP_AVVIO,
          or: [{ subject: IMAP_SUBJECT_FILTER }, { subject: IMAP_SUBJECT_CAMBIO }],
        },
        { uid: true }
      );

      for (const uid of uids || []) {
        const msg = await client.fetchOne(
          uid,
          { uid: true, flags: true, source: true, internalDate: true },
          { uid: true }
        );
        if (!msg) continue;

        const flags = msg.flags ? Array.from(msg.flags) : [];
        if (flags.includes(IMAP_PROCESSED_FLAG)) continue; // già elaborata

        // Il filtro IMAP "since" lavora solo per giorno (non per ora): senza
        // questo controllo, dopo un riavvio il bot rielaborerebbe tutte le
        // email arrivate oggi prima dell'avvio, mandando WhatsApp doppi o
        // vecchi ai clienti. Le marchiamo come elaborate e le saltiamo.
        if (msg.internalDate && new Date(msg.internalDate) < IMAP_AVVIO) {
          try {
            await client.messageFlagsAdd({ uid: uid.toString() }, [IMAP_PROCESSED_FLAG], { uid: true });
          } catch (_) {}
          continue;
        }

        try {
          const parsed = await simpleParser(msg.source);
          const testoEmail = parsed.text || "";
          const oggetto = parsed.subject || "(senza oggetto)";

          const tipo = /cambio\s+pian/i.test(oggetto) ? "cambio" : "conferma";
          console.log(`📧 [IMAP] Email in arrivo (${tipo}): "${oggetto}"`);

          const appuntamento = estraiDatiAppuntamento(testoEmail);

          if (!appuntamento) {
            console.error(
              "⚠️ [IMAP] Impossibile estrarre i dati dell'appuntamento (nome/data/ora/telefono)."
            );
            await inviaEmail({
              oggetto: `⚠️ Notifica WhatsApp NON inviata — verifica manuale richiesta`,
              html:
                `<p>Non sono riuscito a estrarre automaticamente nome, data, ora o telefono da questa email:</p>` +
                `<p><strong>Oggetto:</strong> ${oggetto}</p>` +
                `<pre>${(testoEmail || "(corpo vuoto)").replace(/</g, "&lt;")}</pre>` +
                `<p>Invia manualmente la conferma al cliente.</p>`,
            });
          } else {
            await inviaConfermaAppuntamento(appuntamento, tipo);
          }
        } catch (errSingola) {
          console.error("❌ [IMAP] Errore elaborazione singola email:", errSingola.message);
        }

        // Marchiamo come elaborata in ogni caso (successo, dato mancante o
        // errore), per non ritentare all'infinito la stessa email.
        try {
          await client.messageFlagsAdd({ uid: uid.toString() }, [IMAP_PROCESSED_FLAG], { uid: true });
        } catch (errFlag) {
          console.error("❌ [IMAP] Errore impostazione flag elaborato:", errFlag.message);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error("❌ [IMAP] Errore controllo casella appuntamenti:", err.message);
    try {
      await client.logout();
    } catch (_) {}
  } finally {
    controlloImapInCorso = false;
  }
}

// ─── PROMEMORIA WHATSAPP IL GIORNO PRIMA DELL'APPUNTAMENTO ─────────────────────
// Ogni giorno, dopo PROMEMORIA_ORARIO (ora italiana), il bot rilegge dalla
// casella appuntamenti@ le email del gestionale degli ultimi giorni e manda il
// promemoria ai clienti che hanno l'appuntamento DOMANI. Non serve un database:
// la casella è già l'archivio di tutti gli appuntamenti.
//
// Regole:
//  - un "Cambio pianificazione" più recente per lo stesso numero sostituisce
//    gli appuntamenti precedenti di quel cliente;
//  - un'email con oggetto "ANNULLA" (mandata dall'ufficio a appuntamenti@, con
//    il numero del cliente nel testo) blocca il promemoria degli appuntamenti
//    di quel numero ricevuti PRIMA dell'email di annullamento;
//  - se l'appuntamento è stato inserito oggi, il cliente ha appena ricevuto la
//    conferma e il promemoria non viene mandato;
//  - l'email dell'appuntamento viene marcata con IMAP_PROMEMORIA_FLAG, quindi
//    ogni promemoria parte una volta sola anche dopo un riavvio.

const FUSO_ORARIO = "Europe/Rome";

// Restituisce { data: "GG/MM/AAAA", minuti: minuti dalla mezzanotte } in ora italiana.
function oraItaliana(d = new Date()) {
  const parti = Object.fromEntries(
    new Intl.DateTimeFormat("it-IT", {
      timeZone: FUSO_ORARIO,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return {
    data: `${parti.day}/${parti.month}/${parti.year}`,
    minuti: Number(parti.hour) * 60 + Number(parti.minute),
  };
}

function dataDiDomani() {
  const oggi = oraItaliana().data.split("/").map(Number); // [gg, mm, aaaa]
  const domani = new Date(Date.UTC(oggi[2], oggi[1] - 1, oggi[0] + 1, 12));
  const gg = String(domani.getUTCDate()).padStart(2, "0");
  const mm = String(domani.getUTCMonth() + 1).padStart(2, "0");
  return `${gg}/${mm}/${domani.getUTCFullYear()}`;
}

function orarioInMinuti(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
}

// Estrae i numeri di telefono scritti nel testo di un'email di annullamento.
function estraiNumeriAnnullamento(testo) {
  const trovati = String(testo || "").match(/\+?\d[\d\s.\-\/]{7,16}\d/g) || [];
  return trovati
    .map(normalizzaNumero)
    .filter((n) => /^39\d{8,11}$/.test(n));
}

async function inviaPromemoriaAppuntamento({ nome, data, ora, numero }) {
  if (!/^393\d{8,10}$/.test(numero)) {
    console.log(`⏭️ Promemoria: numero ${numero} non è un cellulare, saltato.`);
    return false;
  }

  const payloadPulsante = (indice, azione) => ({
    type: "button",
    sub_type: "quick_reply",
    index: String(indice),
    parameters: [{ type: "payload", payload: `PROMEMORIA_${azione}|${data}|${ora}|${String(nome).slice(0, 60)}` }],
  });

  const payload = {
    messaging_product: "whatsapp",
    to: numero,
    type: "template",
    template: {
      name: TEMPLATE_PROMEMORIA,
      language: { code: "it" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: nome },
            { type: "text", text: data },
            { type: "text", text: ora },
          ],
        },
        payloadPulsante(0, "OK"),
        payloadPulsante(1, "KO"),
      ],
    },
  };

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (result.error) {
      console.error(`❌ Errore invio promemoria a ${numero}:`, result.error);
      await inviaEmail({
        oggetto: `⚠️ Promemoria WhatsApp NON inviato a ${nome} (${numero})`,
        html:
          `<p>Appuntamento del <strong>${data} alle ore ${ora}</strong>.</p>` +
          `<p>Errore API WhatsApp:</p><pre>${JSON.stringify(result.error, null, 2)}</pre>`,
      });
      return false;
    }
    console.log(`✅ Promemoria inviato a ${nome} (${numero}) — ${data} ${ora}`);
    return true;
  } catch (err) {
    console.error(`❌ Errore rete invio promemoria a ${numero}:`, err.message);
    return false;
  }
}

let promemoriaInCorso = false;
let ultimoGiornoPromemoria = null; // "GG/MM/AAAA" dell'ultimo giro completato

async function controllaPromemoria() {
  if (!IMAP_USER || !IMAP_PASSWORD) return;
  const adesso = oraItaliana();
  if (adesso.minuti < orarioInMinuti(PROMEMORIA_ORARIO)) return;
  if (adesso.minuti >= orarioInMinuti(PROMEMORIA_ORARIO_LIMITE)) return;
  if (ultimoGiornoPromemoria === adesso.data) return; // già fatto oggi
  if (promemoriaInCorso) return;
  promemoriaInCorso = true;

  const domani = dataDiDomani();
  console.log(`⏰ Promemoria: cerco gli appuntamenti di domani ${domani}...`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const dal = new Date(Date.now() - PROMEMORIA_GIORNI_STORICO * 24 * 60 * 60 * 1000);
      const uids = await client.search(
        {
          since: dal,
          or: [
            { subject: IMAP_SUBJECT_FILTER },
            { subject: IMAP_SUBJECT_CAMBIO },
            { subject: IMAP_SUBJECT_ANNULLA },
          ],
        },
        { uid: true }
      );

      const appuntamenti = []; // { uid, quando, tipo, giaInviato, nome, data, ora, numero }
      const annullamenti = []; // { quando, numero }

      for (const uid of uids || []) {
        const msg = await client.fetchOne(
          uid,
          { uid: true, flags: true, source: true, internalDate: true },
          { uid: true }
        );
        if (!msg) continue;
        try {
          const parsed = await simpleParser(msg.source);
          const oggetto = parsed.subject || "";
          const testo = parsed.text || "";
          const quando = new Date(msg.internalDate || parsed.date || Date.now());

          if (/cambio\s+pian/i.test(oggetto) || new RegExp(IMAP_SUBJECT_FILTER, "i").test(oggetto)) {
            const dati = estraiDatiAppuntamento(testo);
            if (!dati) continue;
            const flags = msg.flags ? Array.from(msg.flags) : [];
            appuntamenti.push({
              ...dati,
              uid,
              quando,
              tipo: /cambio\s+pian/i.test(oggetto) ? "cambio" : "conferma",
              giaInviato: flags.includes(IMAP_PROMEMORIA_FLAG),
            });
          } else if (new RegExp(`\\b${IMAP_SUBJECT_ANNULLA}`, "i").test(oggetto)) {
            for (const numero of estraiNumeriAnnullamento(`${oggetto}\n${testo}`)) {
              annullamenti.push({ quando, numero });
            }
          }
        } catch (errSingola) {
          console.error("❌ [Promemoria] Errore lettura email:", errSingola.message);
        }
      }

      const giaInviatiOggi = new Set(); // numero|data|ora, evita doppioni nello stesso giro

      for (const app of appuntamenti) {
        if (app.data !== domani) continue;
        if (app.giaInviato) continue;

        const chiave = `${app.numero}|${app.data}|${app.ora}`;
        if (giaInviatiOggi.has(chiave)) continue;

        // Inserito oggi: il cliente ha appena ricevuto la conferma.
        if (oraItaliana(app.quando).data === adesso.data) {
          console.log(`⏭️ Promemoria: ${app.nome} ha ricevuto la conferma oggi, salto.`);
          continue;
        }

        // Sostituito da un cambio pianificazione più recente?
        const sostituito = appuntamenti.some(
          (altro) =>
            altro.numero === app.numero &&
            altro.tipo === "cambio" &&
            altro.quando > app.quando &&
            (altro.data !== app.data || altro.ora !== app.ora)
        );
        if (sostituito) {
          console.log(`⏭️ Promemoria: appuntamento di ${app.nome} spostato in seguito, salto.`);
          continue;
        }

        // Annullato dall'ufficio?
        const annullato = annullamenti.some((a) => a.numero === app.numero && a.quando > app.quando);
        if (annullato) {
          console.log(`⏭️ Promemoria: appuntamento di ${app.nome} annullato, salto.`);
          continue;
        }

        const inviato = await inviaPromemoriaAppuntamento(app);
        if (inviato) {
          giaInviatiOggi.add(chiave);
          // Marchiamo tutte le email di questo appuntamento (stesso numero,
          // data e ora), così nessuna fa ripartire il promemoria.
          for (const stesso of appuntamenti) {
            if (`${stesso.numero}|${stesso.data}|${stesso.ora}` !== chiave) continue;
            try {
              await client.messageFlagsAdd({ uid: stesso.uid.toString() }, [IMAP_PROMEMORIA_FLAG], { uid: true });
              stesso.giaInviato = true;
            } catch (errFlag) {
              console.error("❌ [Promemoria] Errore impostazione flag:", errFlag.message);
            }
          }
        }
      }

      ultimoGiornoPromemoria = adesso.data;
      console.log(`⏰ Promemoria del ${adesso.data} completati (${giaInviatiOggi.size} inviati).`);
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error("❌ [Promemoria] Errore controllo casella:", err.message);
    try {
      await client.logout();
    } catch (_) {}
  } finally {
    promemoriaInCorso = false;
  }
}

// Risposta del cliente ai pulsanti del promemoria (payload "PROMEMORIA_OK|data|ora|nome"
// o "PROMEMORIA_KO|data|ora|nome", impostato al momento dell'invio).
async function gestisciRispostaPromemoria(from, payload) {
  const [azione, data, ora, nomeProfilo] = String(payload).split("|");
  const quando = data && ora ? ` del ${data} alle ore ${ora}` : "";

  if (azione === "PROMEMORIA_OK") {
    await inviaMessaggio(from, `✅ Grazie per la conferma! La aspettiamo per l'appuntamento${quando}.`);
    console.log(`✅ ${from} ha confermato l'appuntamento${quando}`);
    return;
  }

  await inviaMessaggio(
    from,
    `Ricevuto, grazie per averci avvisato. 📞 La ricontatteremo al più presto per riprogrammare l'appuntamento${quando}.`
  );
  await inviaEmail({
    oggetto: `❌ Cliente non disponibile per l'appuntamento${quando} — ${nomeProfilo || from}`,
    html:
      `<p>Il cliente <strong>${nomeProfilo || "(nome non disponibile)"}</strong> ` +
      `(<strong>+${from}</strong>) ha risposto al promemoria WhatsApp che <strong>deve annullare o spostare</strong> ` +
      `l'appuntamento${quando}.</p>` +
      `<p>Ricontattalo e aggiorna il gestionale.</p>`,
  });
}

async function elaboraMessaggio(from, message) {
  const tipo = message.type;

  try {
    // Risposta ai pulsanti del promemoria (template con risposte rapide):
    // va gestita prima di tutto, anche se il cliente è dentro un flusso.
    if (tipo === "button" && /^PROMEMORIA_/.test(message.button?.payload || "")) {
      await gestisciRispostaPromemoria(from, message.button.payload);
      return;
    }

    // Se il cliente è dentro un flusso guidato, gestiamo lo step
    if (stato.has(from)) {
      await gestisciStepFlusso(from, message);
      return;
    }

    let comando = null;
    if (tipo === "text") {
      comando = message.text.body.trim().toLowerCase();
    } else if (tipo === "interactive") {
      const interattivo = message.interactive;
      if (interattivo.type === "button_reply") {
        comando = interattivo.button_reply.id;
      } else if (interattivo.type === "list_reply") {
        comando = interattivo.list_reply.id;
      }
    }

    if (comando === null) {
      await inviaMessaggio(
        from,
        "Ciao! Al momento gestisco solo testo e i pulsanti del menu. Scrivi *menu* per vedere le opzioni."
      );
      return;
    }

    // Avvio flusso preventivo
    if (comando.includes("preventivo") || comando === "1") {
      stato.set(from, nuovaSessione("preventivo"));
      await inviaMessaggio(
        from,
        `📋 *Richiesta Preventivo*\n\nTi faccio qualche domanda veloce, un passo alla volta. Scrivi *annulla* in qualsiasi momento per interrompere.\n\n${STEP_PREVENTIVO[0].domanda}`
      );
      return;
    }

    // Avvio flusso guasto/assistenza
    if (
      comando.includes("guasto") ||
      comando.includes("assistenza") ||
      comando === "6"
    ) {
      stato.set(from, nuovaSessione("guasto"));
      await inviaMessaggio(
        from,
        `🛠️ *Richiesta Guasto / Assistenza*\n\nTi faccio qualche domanda veloce, un passo alla volta. Scrivi *annulla* in qualsiasi momento per interrompere.\n\n${STEP_GUASTO[0].domanda}`
      );
      return;
    }

    await gestisciComando(from, comando);
  } catch (err) {
    console.error("❌ Errore gestione messaggio:", err.message);
  }
}

// ─── GESTIONE STEP DEI FLUSSI GUIDATI ──────────────────────────────────────────
async function gestisciStepFlusso(from, message) {
  const sessione = stato.get(from);
  const steps = getSteps(sessione.flow);
  const stepCorrente = steps[sessione.stepIndex];

  const testoGrezzo =
    message.type === "text" ? message.text.body.trim() : null;
  const testoLower = testoGrezzo ? testoGrezzo.toLowerCase() : "";

  let idBottone = null;
  if (message.type === "interactive" && message.interactive.type === "button_reply") {
    idBottone = message.interactive.button_reply.id;
  }

  // Comando annulla, disponibile in ogni momento (testo o eventuale bottone)
  if (testoLower === "annulla" || idBottone === "annulla") {
    stato.delete(from);
    await inviaMessaggio(
      from,
      "❌ Richiesta annullata. Scrivi *menu* per ricominciare quando vuoi."
    );
    return;
  }

  // Step foto/video (facoltativo, con pulsante per terminare, fino a MAX_FOTO file)
  // I file possono arrivare come tipo "image" (foto standard/compressa),
  // "video", oppure "document" (quando il cliente invia un file non
  // compresso, es. dall'icona "documento" o da un file manager).
  if (stepCorrente.chiave === "foto") {
    const eImmagine = message.type === "image";
    const eVideo = message.type === "video";
    const eDocumentoMedia =
      message.type === "document" &&
      (message.document?.mime_type?.startsWith("image/") ||
        message.document?.mime_type?.startsWith("video/"));

    if (!Array.isArray(sessione.dati.foto)) sessione.dati.foto = [];

    if (eImmagine || eVideo || eDocumentoMedia) {
      try {
        const mediaId = eImmagine
          ? message.image.id
          : eVideo
          ? message.video.id
          : message.document.id;
        const { buffer, mimeType } = await scaricaMedia(mediaId);
        sessione.dati.foto.push({ buffer, mimeType });
      } catch (err) {
        console.error("❌ Errore download foto/video:", err.message);
      }

      if (sessione.dati.foto.length >= MAX_FOTO) {
        // Limite raggiunto: passiamo automaticamente alla domanda successiva
        sessione.ultimoAggiornamento = Date.now();
        avanzaStep(from, sessione, steps, `📷 Ho già ricevuto ${MAX_FOTO} file, grazie!`);
      } else {
        await inviaBottoni(
          from,
          `📷 File ricevuto (${sessione.dati.foto.length}/${MAX_FOTO}). Puoi inviarne altri oppure premere il pulsante per continuare.`,
          [{ id: "foto_salta", title: "Fine foto" }]
        );
      }
      return;
    } else if (idBottone === "foto_salta" || testoLower === "salta" || testoLower === "no") {
      avanzaStep(from, sessione, steps);
      return;
    } else {
      await inviaBottoni(from, "📷 Invia una foto/video oppure premi il pulsante per continuare senza.", [
        { id: "foto_salta", title: "Salta foto" },
      ]);
      return;
    }
  }

  // Foto/video ricevuti dopo che il limite (o lo step foto) è già stato
  // superato: avvisiamo il cliente ed evitiamo il messaggio generico "serve testo".
  if (
    (message.type === "image" ||
      message.type === "video" ||
      (message.type === "document" &&
        (message.document?.mime_type?.startsWith("image/") ||
          message.document?.mime_type?.startsWith("video/")))) &&
    stepCorrente.chiave !== "foto"
  ) {
    await inviaMessaggio(
      from,
      `📷 Ho già ricevuto le foto necessarie, grazie! ${stepCorrente.domanda}`
    );
    return;
  }

  // Step tipo impianto (lista a scelta, con fallback a testo libero)
  if (stepCorrente.chiave === "tipo_impianto") {
    let idLista = null;
    if (message.type === "interactive" && message.interactive.type === "list_reply") {
      idLista = message.interactive.list_reply.id;
    }

    const opzione = OPZIONI_TIPO_IMPIANTO.find((o) => o.id === idLista);
    if (opzione) {
      sessione.dati.tipo_impianto = opzione.label;
      avanzaStep(from, sessione, steps);
      return;
    }

    if (testoGrezzo) {
      // Risposta testuale libera, accettata comunque
      sessione.dati.tipo_impianto = testoGrezzo;
      avanzaStep(from, sessione, steps);
      return;
    }

    await inviaListaTipoImpianto(from, stepCorrente.domanda);
    return;
  }

  // Step urgente (pulsanti Sì/No)
  if (stepCorrente.chiave === "urgente") {
    if (idBottone === "urgente_si") {
      sessione.dati.urgente = "Sì";
    } else if (idBottone === "urgente_no") {
      sessione.dati.urgente = "No";
    } else if (testoLower === "si" || testoLower === "sì") {
      sessione.dati.urgente = "Sì";
    } else if (testoLower === "no") {
      sessione.dati.urgente = "No";
    } else {
      await inviaDomandaUrgenza(from);
      return;
    }
    avanzaStep(from, sessione, steps);
    return;
  }

  // Step testuali normali
  if (message.type !== "text") {
    await inviaMessaggio(
      from,
      "Per questa domanda mi serve una risposta testuale 🙂"
    );
    return;
  }

  sessione.dati[stepCorrente.chiave] = testoGrezzo;
  avanzaStep(from, sessione, steps);
}

async function avanzaStep(from, sessione, steps, prefisso) {
  sessione.stepIndex++;
  sessione.ultimoAggiornamento = Date.now();

  if (sessione.stepIndex < steps.length) {
    stato.set(from, sessione);
    const prossimo = steps[sessione.stepIndex];
    const testoDomanda = prefisso ? `${prefisso}\n\n${prossimo.domanda}` : prossimo.domanda;

    if (prossimo.chiave === "foto") {
      await inviaBottoni(from, testoDomanda, [
        { id: "foto_salta", title: "Salta foto" },
      ]);
    } else if (prossimo.chiave === "urgente") {
      await inviaDomandaUrgenza(from, prefisso);
    } else if (prossimo.chiave === "tipo_impianto") {
      await inviaListaTipoImpianto(from, testoDomanda);
    } else {
      await inviaMessaggio(from, testoDomanda);
    }
  } else {
    // Flusso completato: invio email e chiusura
    await completaFlusso(from, sessione);
    stato.delete(from);
  }
}

// Domanda "urgente" del flusso guasto (semplice Sì/No)
async function inviaDomandaUrgenza(from, prefisso) {
  const testo = "🚨 È un caso urgente?";
  await inviaBottoni(from, prefisso ? `${prefisso}\n\n${testo}` : testo, [
    { id: "urgente_si", title: "Sì" },
    { id: "urgente_no", title: "No" },
  ]);
}

// Avvia la raccolta dati per l'intervento urgente entro 4 ore
async function avviaFlussoUrgenza(from, fuoriOrario) {
  const sessione = nuovaSessione("urgenza");
  sessione.fuoriOrario = fuoriOrario;
  stato.set(from, sessione);
  await inviaMessaggio(
    from,
    `🚨 *Intervento urgente entro 4 ore*\n\nTi faccio qualche domanda veloce, un passo alla volta. Scrivi *annulla* in qualsiasi momento per interrompere.\n\n${STEP_URGENZA[0].domanda}`
  );
}

function estensioneDaMime(mimeType) {
  if (!mimeType) return "bin";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("3gpp") || mimeType.includes("3gp")) return "3gp";
  if (mimeType.includes("quicktime")) return "mov";
  return "bin";
}

async function completaFlusso(from, sessione) {
  const isPreventivo = sessione.flow === "preventivo";
  const d = sessione.dati;

  const isUrgenza = sessione.flow === "urgenza";
  const oggetto = isPreventivo
    ? "Richiesta da chatbot DPI – Preventivo"
    : isUrgenza
    ? "Richiesta da chatbot DPI – INTERVENTO URGENTE (entro 4 ore)"
    : "Richiesta da chatbot DPI – Guasto/Assistenza";

  let html = `<h2>${
    isPreventivo
      ? "Nuova richiesta di preventivo"
      : isUrgenza
      ? "🚨 Richiesta di INTERVENTO URGENTE entro 4 ore"
      : "Nuova richiesta di assistenza/guasto"
  }</h2>`;
  html += `<p><strong>Numero WhatsApp cliente:</strong> ${from}</p>`;
  html += `<p><strong>Nome e cognome:</strong> ${d.nome || "-"}</p>`;

  if (isPreventivo) {
    html += `<p><strong>Tipo di intervento:</strong> ${d.tipo_intervento || "-"}</p>`;
    html += `<p><strong>Comune:</strong> ${d.comune || "-"}</p>`;
    html += `<p><strong>Tipo di immobile:</strong> ${d.tipo_immobile || "-"}</p>`;
    html += `<p><strong>Telefono:</strong> ${d.telefono || "-"}</p>`;
    html += `<p><strong>Email cliente:</strong> ${d.email || "-"}</p>`;
  } else {
    html += `<p><strong>Tipo di impianto:</strong> ${d.tipo_impianto || "-"}</p>`;
    html += `<p><strong>Descrizione problema:</strong> ${d.descrizione || "-"}</p>`;
    html += `<p><strong>Comune/indirizzo:</strong> ${d.comune || "-"}</p>`;
    html += `<p><strong>Telefono:</strong> ${d.telefono || "-"}</p>`;
    html += `<p><strong>Email cliente:</strong> ${d.email || "-"}</p>`;
    if (isUrgenza) {
      html += `<p><strong>Intervento richiesto:</strong> entro 4 ore</p>`;
      html += `<p><strong>Ricevuta fuori orario:</strong> ${sessione.fuoriOrario ? "Sì – il cliente ha accettato diritto di chiamata notturno/festivo e costo chilometrico" : "No"}</p>`;
    } else {
      html += `<p><strong>Urgente:</strong> ${d.urgente || "-"}</p>`;
    }
    const numFoto = Array.isArray(d.foto) ? d.foto.length : 0;
    html += `<p><strong>Foto/video allegati:</strong> ${numFoto > 0 ? `${numFoto} (vedi allegati)` : "No"}</p>`;
  }

  const attachments = [];
  if (!isPreventivo && Array.isArray(d.foto)) {
    d.foto.forEach((f, i) => {
      attachments.push({
        filename: `allegato_guasto_${i + 1}.${estensioneDaMime(f.mimeType)}`,
        content: f.buffer,
        contentType: f.mimeType,
      });
    });
  }

  const urgenzaFuoriOrario = isUrgenza && sessione.fuoriOrario;

  // Prima la notifica urgente (è la cosa più importante), poi l'email completa
  if (urgenzaFuoriOrario) {
    await urgenze.notificaUrgenza(
      {
        nome: d.nome,
        telefono: d.telefono || from,
        indirizzo: d.comune,
        problema: [d.tipo_impianto, d.descrizione].filter(Boolean).join(" – "),
      },
      { chiamaApiWhatsapp, inviaEmail }
    );
  }

  await inviaEmail({
    oggetto: urgenzaFuoriOrario ? `🚨 FUORI ORARIO – ${oggetto}` : oggetto,
    html,
    attachments,
  });

  let risposta;
  if (isUrgenza) {
    risposta = sessione.fuoriOrario
      ? urgenze.TESTO_URGENZA_SI
      : "✅ Richiesta di intervento urgente ricevuta. Un nostro tecnico ti ricontatterà al più presto per organizzare l'intervento.";
  } else {
    risposta = `✅ Grazie ${d.nome || ""}! Abbiamo ricevuto la tua richiesta.\n\nUn nostro tecnico ti ricontatterà al più presto.`;
    if (!isPreventivo && d.urgente === "Sì" && urgenze.isFuoriOrario()) {
      risposta +=
        `\n\n🌙 I nostri uffici ora sono chiusi. Se ti serve un intervento *entro 4 ore*, scrivi *urgente*.`;
    }
  }
  await inviaMessaggio(from, `${risposta}\n\nPer altre richieste scrivi *menu* 👋`);
}

// ─── SCARICA MEDIA DA WHATSAPP (per le foto) ───────────────────────────────────
async function scaricaMedia(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const metaData = await metaRes.json();

  const fileRes = await fetch(metaData.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const arrayBuffer = await fileRes.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: metaData.mime_type || "image/jpeg",
  };
}

// ─── FOLLOW-UP AUTOMATICO SU FLUSSI ABBANDONATI ────────────────────────────────
const SOGLIA_FOLLOWUP_MS = 24 * 60 * 60 * 1000; // 24 ore

setInterval(() => {
  const ora = Date.now();
  for (const [from, sessione] of stato.entries()) {
    if (
      !sessione.followUpInviato &&
      ora - sessione.ultimoAggiornamento > SOGLIA_FOLLOWUP_MS
    ) {
      sessione.followUpInviato = true;
      stato.set(from, sessione);
      inviaMessaggio(
        from,
        "👋 Ciao! Hai ancora bisogno del preventivo/assistenza? Siamo qui per aiutarti, basta rispondere a questo messaggio per continuare 😊"
      ).catch((err) => console.error("❌ Errore follow-up:", err.message));
    }
  }
}, 60 * 60 * 1000); // controllo ogni ora

// ─── GESTIONE COMANDI MENU (testo o pulsante) ──────────────────────────────────
async function gestisciComando(from, comando) {
  // Menu principale → lista interattiva
  if (
    comando === "ciao" ||
    comando === "salve" ||
    comando === "buongiorno" ||
    comando === "buonasera" ||
    comando === "aiuto" ||
    comando === "menu" ||
    comando === "help" ||
    comando === "start"
  ) {
    await inviaListaMenu(from);
    return;
  }

  // Servizi
  if (comando.includes("servizi") || comando === "2") {
    await inviaBottoni(
      from,
      `🔧 *I Nostri Servizi*\n\n` +
        `⚡ *Impianti Elettrici, Idrici, Riscaldamento*\n` +
        `Civili, industriali, CCTV, allarmi, cancelli\n\n` +
        `❄️ *Climatizzazione & Pompe di Calore*\n` +
        `Pompe di calore, split, VMC, riscaldamento a pavimento\n\n` +
        `☀️ *Impianti Fotovoltaici*\n` +
        `Residenziale e industriale, con accumulo e colonnine EV\n\n` +
        `🏠 *Efficienza Energetica*\n` +
        `Diagnosi energetica, Conto Termico 3.0, Superbonus\n\n` +
        `📹 *TVCC - Automazioni*\n` +
        `Videosorveglianza, automazioni cancelli e accessi\n\n` +
        `🔥 *Caldaie*\n` +
        `Installazione, manutenzione e assistenza`,
      [
        { id: "preventivo", title: "📋 Preventivo" },
        { id: "menu", title: "🏠 Menu" },
      ]
    );
    return;
  }

  // Conto Termico
  if (
    comando.includes("conto_termico") ||
    comando.includes("conto termico") ||
    comando.includes("incentivi") ||
    comando === "3"
  ) {
    await inviaBottoni(
      from,
      `♻️ *Conto Termico 3.0*\n\n` +
        `Il Conto Termico incentiva la sostituzione di vecchi generatori di calore con:\n\n` +
        `✅ Pompe di calore aria/acqua\n` +
        `✅ Caldaie a biomassa\n` +
        `✅ Solare termico\n\n` +
        `💰 *Incentivo fino al 65%* della spesa!\n` +
        `📅 Erogazione in *2 rate annuali* tramite GSE\n\n` +
        `Gestiamo tutta la pratica per te!`,
      [
        { id: "preventivo", title: "📋 Preventivo" },
        { id: "menu", title: "🏠 Menu" },
      ]
    );
    return;
  }

  // Contatti
  if (comando.includes("contatti") || comando.includes("telefono") || comando === "4") {
    await inviaBottoni(
      from,
      `📍 *De Pasquale Impianti Srl*\n\n` +
        `📞 Telefono: *+39 0923 361191*\n` +
        `📧 Email: info@depasqualeimpianti.com\n` +
        `🌐 Web: www.depasqualeimpianti.com\n\n` +
        `📍 Marsala (TP), Sicilia\n\n` +
        `🕐 Orari ufficio:\n` +
        `Lun-Ven: 9:00 - 18:30\n` +
        `Sab-Dom: chiusi`,
      [
        { id: "preventivo", title: "📋 Preventivo" },
        { id: "menu", title: "🏠 Menu" },
      ]
    );
    return;
  }

  // ── Urgente: scelta tra operatore (live chat sul sito) e intervento entro 4 ore
  if (comando === "emerg_operatore") {
    const ok = await chiamaApiWhatsapp({
      messaging_product: "whatsapp",
      to: from,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: {
          text:
            `💬 *Parla con un operatore*\n\n` +
            `Tocca il pulsante qui sotto per aprire la nostra *live chat*: un operatore ti risponderà il prima possibile! ⚡` +
            (CHAT_URL.includes("depasqualeimpianti.com")
              ? `\n\nSi aprirà il nostro sito: tocca il *pulsante verde* in basso a destra per iniziare la chat.`
              : ""),
        },
        footer: { text: "Per tornare al menu scrivi menu" },
        action: {
          name: "cta_url",
          parameters: { display_text: "💬 Apri chat", url: CHAT_URL },
        },
      },
    });
    if (!ok) {
      // Riserva: link in chiaro se il pulsante non viene accettato
      await inviaMessaggio(
        from,
        `💬 *Parla con un operatore*\n\nApri la nostra live chat da qui:\n${CHAT_URL}\n\nPer tornare al menu scrivi *menu*`
      );
    }
    return;
  }

  if (comando === "emerg_4ore") {
    if (urgenze.isFuoriOrario()) {
      // Fuori orario: prima l'avviso del supplemento, poi i dati
      await inviaBottoni(
        from,
        urgenze.DOMANDA_URGENZA_FUORI_ORARIO,
        [
          { id: "emerg_accetto", title: "Sì, accetto" },
          { id: "menu", title: "🏠 Menu" },
        ]
      );
    } else {
      await avviaFlussoUrgenza(from, false);
    }
    return;
  }

  if (comando === "emerg_accetto") {
    await avviaFlussoUrgenza(from, true);
    return;
  }

  if (comando.includes("urgente") || comando.includes("emergenza") || comando === "5") {
    await inviaBottoni(
      from,
      `🚨 *Richiesta Intervento Urgente*\n\nCome possiamo aiutarti?\n\n` +
        `💬 *Operatore*: chatta subito con un nostro operatore\n` +
        `🛠️ *Entro 4 ore*: richiedi un intervento urgente entro 4 ore`,
      [
        { id: "emerg_operatore", title: "💬 Operatore" },
        { id: "emerg_4ore", title: "🛠️ Entro 4 ore" },
        { id: "menu", title: "🏠 Menu" },
      ]
    );
    return;
  }

  // Fotovoltaico
  if (
    comando.includes("fotovoltaic") ||
    comando.includes("pannelli") ||
    comando.includes("solare")
  ) {
    await inviaBottoni(
      from,
      `☀️ *Impianti Fotovoltaici*\n\n` +
        `Realizziamo impianti fotovoltaici chiavi in mano:\n\n` +
        `✅ Residenziali (3-20 kW)\n` +
        `✅ Commerciali e industriali (20-3000 kW)\n` +
        `✅ Con sistema di accumulo (batterie)\n` +
        `✅ Con colonnine di ricarica EV\n\n` +
        `📍 Operiamo in tutta la provincia di Trapani`,
      [
        { id: "preventivo", title: "📋 Preventivo" },
        { id: "menu", title: "🏠 Menu" },
      ]
    );
    return;
  }

  // Pompa di calore
  if (
    comando.includes("pompa di calore") ||
    comando.includes("climatizzaz") ||
    comando.includes("condizionator")
  ) {
    await inviaBottoni(
      from,
      `❄️ *Pompe di Calore & Climatizzazione*\n\n` +
        `Installiamo e assistiamo:\n\n` +
        `• Pompe di calore aria/acqua\n` +
        `• Split e multi-split\n` +
        `• Sistemi VRF\n` +
        `• VMC (Ventilazione Meccanica Controllata)\n\n` +
        `💰 Con il *Conto Termico 3.0* puoi ottenere fino al *65%* di incentivo!`,
      [
        { id: "preventivo", title: "📋 Preventivo" },
        { id: "menu", title: "🏠 Menu" },
      ]
    );
    return;
  }

  // Risposta default
  await inviaBottoni(
    from,
    `❓ Non ho capito la tua richiesta.\n\nPuoi scegliere dal menu, oppure chiamaci al:\n📞 *+39 0923 361191*`,
    [{ id: "menu", title: "🏠 Menu" }]
  );
}

// ─── INVIO MESSAGGIO DI TESTO SEMPLICE ─────────────────────────────────────────
async function inviaMessaggio(to, testo) {
  await chiamaApiWhatsapp({
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: { body: testo },
  });
}

// ─── INVIO MESSAGGIO CON PULSANTI DI RISPOSTA RAPIDA (max 3) ──────────────────
async function inviaBottoni(to, corpo, bottoni) {
  await chiamaApiWhatsapp({
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: corpo },
      action: {
        buttons: bottoni.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

// ─── INVIO MENU PRINCIPALE COME LISTA INTERATTIVA ──────────────────────────────
async function inviaListaMenu(to) {
  await chiamaApiWhatsapp({
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "De Pasquale Impianti" },
      body: {
        text:
          `👋 Benvenuto! Siamo specializzati in impianti elettrici, idrici, climatizzazione, fotovoltaico, TVCC e caldaie.\n\n` +
          `Scegli un'opzione dal menu qui sotto 👇`,
      },
      footer: { text: "De Pasquale Impianti Srl" },
      action: {
        button: "Vedi opzioni",
        sections: [
          {
            title: "Cosa ti serve?",
            rows: [
              { id: "preventivo", title: "📋 Preventivo", description: "Richiedi un preventivo" },
              { id: "servizi", title: "🔧 Servizi", description: "Scopri i nostri servizi" },
              { id: "conto_termico", title: "♻️ Conto Termico", description: "Incentivi fino al 65%" },
              { id: "contatti", title: "📍 Contatti", description: "Parla direttamente con noi" },
              { id: "urgente", title: "🚨 Urgente", description: "Richiesta intervento urgente" },
              { id: "guasto", title: "🛠️ Guasto/Assistenza", description: "Segnala un guasto" },
            ],
          },
        ],
      },
    },
  });
}

// ─── INVIO LISTA "TIPO DI IMPIANTO" (flusso guasto) ────────────────────────────
async function inviaListaTipoImpianto(to, corpo) {
  await chiamaApiWhatsapp({
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: corpo },
      action: {
        button: "Scegli opzione",
        sections: [
          {
            title: "Tipo di impianto",
            rows: OPZIONI_TIPO_IMPIANTO.map((o) => ({ id: o.id, title: o.title })),
          },
        ],
      },
    },
  });
}

// ─── CHIAMATA GENERICA ALL'API WHATSAPP ────────────────────────────────────────
async function chiamaApiWhatsapp(payload) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.error) {
      console.error("❌ Errore invio:", data.error);
      return false;
    }
    console.log(`✅ Messaggio inviato a ${payload.to}`);
    return true;
  } catch (err) {
    console.error("❌ Errore fetch:", err.message);
    return false;
  }
}

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "✅ DPI Chatbot attivo",
    numero: "+39 389 638 4755",
    versione: "3.4.0",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 DPI Chatbot in ascolto sulla porta ${PORT}`);
});

// ─── AVVIO CONTROLLO PERIODICO CASELLA APPUNTAMENTI ────────────────────────────
if (IMAP_USER && IMAP_PASSWORD) {
  console.log(
    `📬 Controllo periodico casella ${IMAP_USER} attivo (ogni ${Math.round(IMAP_POLL_MS / 1000)}s)`
  );
  controllaEmailAppuntamenti(); // primo controllo subito all'avvio
  setInterval(controllaEmailAppuntamenti, IMAP_POLL_MS);

  // Promemoria del giorno prima: controlliamo ogni 5 minuti se è arrivato
  // l'orario (PROMEMORIA_ORARIO, ora italiana) e se il giro di oggi è già fatto.
  console.log(
    `⏰ Promemoria appuntamenti attivi: ogni giorno dalle ${PROMEMORIA_ORARIO} (ora italiana), template ${TEMPLATE_PROMEMORIA}`
  );
  setTimeout(controllaPromemoria, 30 * 1000);
  setInterval(controllaPromemoria, 5 * 60 * 1000);
} else {
  console.log("📬 Controllo IMAP casella appuntamenti disattivato (IMAP_USER/IMAP_PASSWORD non impostate).");
}
