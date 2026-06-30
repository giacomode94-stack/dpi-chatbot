const express = require("express");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "dpi_chatbot_token";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

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
  const from = message.from; // Numero mittente
  const tipo = message.type;

  console.log(`📩 Messaggio da ${from} (tipo: ${tipo})`);

  if (tipo === "text") {
    const testo = message.text.body.trim().toLowerCase();
    const risposta = generaRisposta(testo, from);
    await inviaMEssaggio(from, risposta);
  } else {
    await inviaMEssaggio(
      from,
      "Ciao! Al momento gestisco solo messaggi di testo. Scrivi *aiuto* per vedere cosa posso fare."
    );
  }
});

// ─── LOGICA RISPOSTE ───────────────────────────────────────────────────────────
function generaRisposta(testo, from) {
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
            `5️⃣ *urgente* - Richiesta intervento urgente\n\n` +
      `Rispondi con il numero o la parola chiave 👆`
    );
  }

  // Preventivo
  if (testo.includes("preventivo") || testo === "1") {
    return (
      `📋 *Richiesta Preventivo*\n\n` +
      `Per preparare un preventivo personalizzato abbiamo bisogno di alcune informazioni.\n\n` +
      `Inviaci:\n` +
            `• Nome e cognome\n` +
            `• Tipo di intervento (es. pompa di calore, fotovoltaico, impianto elettrico...)\n` +
            `• Comune dove si trova l'immobile\n` +
      `• Tipo di immobile (appartamento, villa, capannone...)\n\n` +
      `Puoi scriverci qui su WhatsApp oppure chiamarci al:\n` +
            `📞 *+39 0923 361191*\n\n` +
      `Un nostro tecnico ti ricontatterà entro 24 ore! ✅`
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
    if (
          testo.includes("urgente") ||
          testo.includes("emergenza") ||
          testo === "5"
        ) {
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
async function inviaMEssaggio(to, testo) {
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
    versione: "1.0.0",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 DPI Chatbot in ascolto sulla porta ${PORT}`);
});
