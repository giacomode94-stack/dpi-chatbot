const express = require("express");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "dpi_chatbot_token";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_MITTENTE = process.env.EMAIL_MITTENTE || "info@depasqualeimpianti.com";
const EMAIL_DESTINATARIO = process.env.EMAIL_DESTINATARIO || "info@depasqualeimpianti.com";

// ─── CONFIGURAZIONE EMAIL (SendGrid via API HTTPS) ─────────────────────────────
// Usiamo l'API HTTPS di SendGrid invece di SMTP: Render blocca le porte SMTP
// (25/465/587) sui servizi gratuiti, ma le chiamate HTTPS non sono soggette
// a questa restrizione.
async function inviaEmail({ oggetto, html, attachments }) {
  try {
    const body = {
      personalizations: [{ to: [{ email: EMAIL_DESTINATARIO }] }],
      from: { email: EMAIL_MITTENTE, name: "DPI Chatbot" },
      subject: oggetto,
      content: [{ type: "text/html", value: html }],
    };

    if (attachments && attachments.length > 0) {
      body.attachments = attachments.map((a) => ({
        content: a.content.toString("base64"),
        filename: a.filename,
        type: a.contentType || "application/octet-stream",
        disposition: "attachment",
      }));
    }

    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
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
];

const STEP_GUASTO = [
  { chiave: "nome", domanda: "📝 Qual è il tuo *nome e cognome*?" },
  {
    chiave: "tipo_impianto",
    domanda:
      "🔧 Che tipo di impianto ha il problema?\n(elettrico, idrico, climatizzazione, fotovoltaico, caldaia...)",
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
    domanda:
      "📷 Se vuoi, invia una *foto* del guasto.\nSe non necessaria, scrivi *salta*",
    facoltativo: true,
  },
  {
    chiave: "telefono",
    domanda: "📞 Lasciaci un *numero di telefono* per essere richiamato",
  },
  { chiave: "urgente", domanda: "🚨 È un caso *urgente*? (sì/no)" },
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

function getSteps(flow) {
  return flow === "preventivo" ? STEP_PREVENTIVO : STEP_GUASTO;
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

  console.log(`📩 Messaggio da ${from} (tipo: ${tipo})`);

  try {
    // Se il cliente è dentro un flusso guidato, gestiamo lo step
    if (stato.has(from)) {
      await gestisciStepFlusso(from, message);
      return;
    }

    if (tipo === "text") {
      const testo = message.text.body.trim().toLowerCase();

      // Avvio flusso preventivo
      if (testo.includes("preventivo") || testo === "1") {
        stato.set(from, nuovaSessione("preventivo"));
        await inviaMessaggio(
          from,
          `📋 *Richiesta Preventivo*\n\nTi faccio qualche domanda veloce, un passo alla volta. Scrivi *annulla* in qualsiasi momento per interrompere.\n\n${STEP_PREVENTIVO[0].domanda}`
        );
        return;
      }

      // Avvio flusso guasto/assistenza
      if (
        testo.includes("guasto") ||
        testo.includes("assistenza") ||
        testo === "6"
      ) {
        stato.set(from, nuovaSessione("guasto"));
        await inviaMessaggio(
          from,
          `🛠️ *Richiesta Guasto / Assistenza*\n\nTi faccio qualche domanda veloce, un passo alla volta. Scrivi *annulla* in qualsiasi momento per interrompere.\n\n${STEP_GUASTO[0].domanda}`
        );
        return;
      }

      const risposta = generaRisposta(testo);
      await inviaMessaggio(from, risposta);
    } else {
      await inviaMessaggio(
        from,
        "Ciao! Al momento gestisco solo messaggi di testo. Scrivi *aiuto* per vedere cosa posso fare."
      );
    }
  } catch (err) {
    console.error("❌ Errore gestione messaggio:", err.message);
  }
});

// ─── GESTIONE STEP DEI FLUSSI GUIDATI ──────────────────────────────────────────
async function gestisciStepFlusso(from, message) {
  const sessione = stato.get(from);
  const steps = getSteps(sessione.flow);
  const stepCorrente = steps[sessione.stepIndex];

  const testoGrezzo =
    message.type === "text" ? message.text.body.trim() : null;
  const testoLower = testoGrezzo ? testoGrezzo.toLowerCase() : "";

  // Comando annulla, disponibile in ogni momento
  if (testoLower === "annulla") {
    stato.delete(from);
    await inviaMessaggio(
      from,
      "❌ Richiesta annullata. Scrivi *menu* per ricominciare quando vuoi."
    );
    return;
  }

  // Step foto (facoltativo)
  if (stepCorrente.chiave === "foto") {
    if (message.type === "image") {
      try {
        const mediaId = message.image.id;
        const { buffer, mimeType } = await scaricaMedia(mediaId);
        sessione.dati.foto = { buffer, mimeType };
      } catch (err) {
        console.error("❌ Errore download foto:", err.message);
        sessione.dati.foto = null;
      }
    } else if (testoLower === "salta" || testoLower === "no") {
      sessione.dati.foto = null;
    } else {
      await inviaMessaggio(
        from,
        "📷 Invia una foto oppure scrivi *salta* per continuare senza."
      );
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

async function avanzaStep(from, sessione, steps) {
  sessione.stepIndex++;
  sessione.ultimoAggiornamento = Date.now();

  if (sessione.stepIndex < steps.length) {
    stato.set(from, sessione);
    await inviaMessaggio(from, steps[sessione.stepIndex].domanda);
  } else {
    // Flusso completato: invio email e chiusura
    await completaFlusso(from, sessione);
    stato.delete(from);
  }
}

async function completaFlusso(from, sessione) {
  const isPreventivo = sessione.flow === "preventivo";
  const d = sessione.dati;

  const oggetto = isPreventivo
    ? "Richiesta da chatbot DPI – Preventivo"
    : "Richiesta da chatbot DPI – Guasto/Assistenza";

  let html = `<h2>${
    isPreventivo ? "Nuova richiesta di preventivo" : "Nuova richiesta di assistenza/guasto"
  }</h2>`;
  html += `<p><strong>Numero WhatsApp cliente:</strong> ${from}</p>`;
  html += `<p><strong>Nome e cognome:</strong> ${d.nome || "-"}</p>`;

  if (isPreventivo) {
    html += `<p><strong>Tipo di intervento:</strong> ${d.tipo_intervento || "-"}</p>`;
    html += `<p><strong>Comune:</strong> ${d.comune || "-"}</p>`;
    html += `<p><strong>Tipo di immobile:</strong> ${d.tipo_immobile || "-"}</p>`;
    html += `<p><strong>Telefono:</strong> ${d.telefono || "-"}</p>`;
  } else {
    html += `<p><strong>Tipo di impianto:</strong> ${d.tipo_impianto || "-"}</p>`;
    html += `<p><strong>Descrizione problema:</strong> ${d.descrizione || "-"}</p>`;
    html += `<p><strong>Comune/indirizzo:</strong> ${d.comune || "-"}</p>`;
    html += `<p><strong>Telefono:</strong> ${d.telefono || "-"}</p>`;
    html += `<p><strong>Urgente:</strong> ${d.urgente || "-"}</p>`;
    html += `<p><strong>Foto allegata:</strong> ${d.foto ? "Sì (vedi allegato)" : "No"}</p>`;
  }

  const attachments = [];
  if (!isPreventivo && d.foto) {
    attachments.push({
      filename: "foto_guasto." + (d.foto.mimeType.includes("png") ? "png" : "jpg"),
      content: d.foto.buffer,
      contentType: d.foto.mimeType,
    });
  }

  await inviaEmail({ oggetto, html, attachments });

  await inviaMessaggio(
    from,
    `✅ Grazie ${d.nome || ""}! Abbiamo ricevuto la tua richiesta.\n\nUn nostro tecnico ti ricontatterà al più presto.\n\nPer altre richieste scrivi *menu* 👋`
  );
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

// ─── LOGICA RISPOSTE MENU STATICO ──────────────────────────────────────────────
function generaRisposta(testo) {
  // Menu principale
  if (
    testo === "ciao" ||
    testo === "salve" ||
    testo === "buongiorno" ||
    testo === "buonasera" ||
    testo === "aiuto" ||
    testo === "menu" ||
    testo === "help" ||
    testo === "start"
  ) {
    return (
      `👋 Benvenuto in *De Pasquale Impianti*!\n\n` +
      `Siamo specializzati in:\n` +
      `⚡ Impianti Elettrici, Idrici, Riscaldamento\n` +
      `❄️ Climatizzazione & Pompe di Calore\n` +
      `☀️ Impianti Fotovoltaici\n` +
      `🏠 Efficienza Energetica\n` +
      `📹 TVCC - Automazioni\n` +
      `🔥 Caldaie\n\n` +
      `Scegli un'opzione:\n` +
      `1️⃣ *preventivo* - Richiedi un preventivo\n` +
      `2️⃣ *servizi* - I nostri servizi\n` +
      `3️⃣ *conto termico* - Info incentivi\n` +
      `4️⃣ *contatti* - Parlare con noi\n` +
      `5️⃣ *urgente* - Richiesta intervento urgente\n` +
      `6️⃣ *guasto* - Segnala un guasto / richiedi assistenza\n\n` +
      `Rispondi con il numero o la parola chiave 👆`
    );
  }

  // Servizi
  if (testo.includes("servizi") || testo === "2") {
    return (
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
      `Installazione, manutenzione e assistenza\n\n` +
      `Per info scrivi *preventivo* oppure *contatti* 👇`
    );
  }

  // Conto Termico
  if (
    testo.includes("conto termico") ||
    testo.includes("incentivi") ||
    testo === "3"
  ) {
    return (
      `♻️ *Conto Termico 3.0*\n\n` +
      `Il Conto Termico incentiva la sostituzione di vecchi generatori di calore con:\n\n` +
      `✅ Pompe di calore aria/acqua\n` +
      `✅ Caldaie a biomassa\n` +
      `✅ Solare termico\n\n` +
      `💰 *Incentivo fino al 65%* della spesa!\n` +
      `📅 Erogazione in *2 rate annuali* tramite GSE\n\n` +
      `Gestiamo tutta la pratica per te!\n` +
      `Scrivi *preventivo* per iniziare 👆`
    );
  }

  // Contatti
  if (testo.includes("contatti") || testo.includes("telefono") || testo === "4") {
    return (
      `📍 *De Pasquale Impianti Srl*\n\n` +
      `📞 Telefono: *+39 0923 361191*\n` +
      `📧 Email: info@depasqualeimpianti.com\n` +
      `🌐 Web: www.depasqualeimpianti.com\n\n` +
      `📍 Marsala (TP), Sicilia\n\n` +
      `🕐 Orari ufficio:\n` +
      `Lun-Ven: 9:00 - 18:30\n` +
      `Sab-Dom: chiusi\n\n` +
      `Per un preventivo rapido scrivi *preventivo* 👆`
    );
  }

  // Intervento urgente
  if (testo.includes("urgente") || testo.includes("emergenza") || testo === "5") {
    return (
      `🚨 *Richiesta Intervento Urgente*\n\n` +
      `Per le emergenze ti invitiamo a visitare il nostro sito web:\n` +
      `🌐 www.depasqualeimpianti.com\n\n` +
      `Scrivici tramite la nostra *live chat* presente sul sito: un operatore ti risponderà il prima possibile! ⚡`
    );
  }

  // Fotovoltaico
  if (
    testo.includes("fotovoltaic") ||
    testo.includes("pannelli") ||
    testo.includes("solare")
  ) {
    return (
      `☀️ *Impianti Fotovoltaici*\n\n` +
      `Realizziamo impianti fotovoltaici chiavi in mano:\n\n` +
      `✅ Residenziali (3-20 kW)\n` +
      `✅ Commerciali e industriali (20-3000 kW)\n` +
      `✅ Con sistema di accumulo (batterie)\n` +
      `✅ Con colonnine di ricarica EV\n\n` +
      `📍 Operiamo in tutta la provincia di Trapani\n\n` +
      `Scrivi *preventivo* per una consulenza gratuita! 🌞`
    );
  }

  // Pompa di calore
  if (
    testo.includes("pompa di calore") ||
    testo.includes("climatizzaz") ||
    testo.includes("condizionator")
  ) {
    return (
      `❄️ *Pompe di Calore & Climatizzazione*\n\n` +
      `Installiamo e assistiamo:\n\n` +
      `• Pompe di calore aria/acqua\n` +
      `• Split e multi-split\n` +
      `• Sistemi VRF\n` +
      `• VMC (Ventilazione Meccanica Controllata)\n\n` +
      `💰 Con il *Conto Termico 3.0* puoi ottenere fino al *65%* di incentivo!\n\n` +
      `Scrivi *preventivo* per saperne di più 👆`
    );
  }

  // Risposta default
  return (
    `❓ Non ho capito la tua richiesta.\n\n` +
    `Scrivi *menu* per vedere tutte le opzioni disponibili, oppure chiamaci al:\n` +
    `📞 *+39 0923 361191*\n\n` +
    `Siamo qui per aiutarti! 😊`
  );
}

// ─── INVIO MESSAGGIO VIA API WHATSAPP ─────────────────────────────────────────
async function inviaMessaggio(to, testo) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: testo },
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error("❌ Errore invio:", data.error);
    } else {
      console.log(`✅ Messaggio inviato a ${to}`);
    }
  } catch (err) {
    console.error("❌ Errore fetch:", err.message);
  }
}

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "✅ DPI Chatbot attivo",
    numero: "+39 389 638 4755",
    versione: "2.0.0",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 DPI Chatbot in ascolto sulla porta ${PORT}`);
});
