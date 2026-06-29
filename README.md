# DPI Chatbot WhatsApp 🤖

Chatbot WhatsApp per **De Pasquale Impianti Srl** — gestisce automaticamente
preventivi, info servizi, Conto Termico e contatti.

---

## 🚀 Deploy su Render.com

### 1. Carica su GitHub
```bash
git init
git add .
git commit -m "DPI Chatbot v1.0"
git remote add origin https://github.com/TUO_UTENTE/dpi-chatbot.git
git push -u origin main
```

### 2. Crea Web Service su Render
- Vai su https://render.com → **New → Web Service**
- Collega il tuo repository GitHub
- Impostazioni:
  - **Name**: dpi-chatbot
  - **Runtime**: Node
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
  - **Plan**: Free

### 3. Aggiungi le Environment Variables su Render
| Variabile | Valore |
|-----------|--------|
| `WHATSAPP_TOKEN` | Token da Meta Developer Portal |
| `PHONE_NUMBER_ID` | `122425334097820` |
| `VERIFY_TOKEN` | `dpi_chatbot_token` |

### 4. Configura il Webhook su Meta
Dopo il deploy, l'URL di Render sarà tipo:
`https://dpi-chatbot.onrender.com`

- Vai su **Meta Developer Portal → DPI Chatbot → Configurazione API → Configurazione**
- **Webhook URL**: `https://dpi-chatbot.onrender.com/webhook`
- **Verify Token**: `dpi_chatbot_token`
- **Campi**: spunta `messages`

---

## 💬 Comandi del Bot

| Parola chiave | Risposta |
|---------------|----------|
| ciao / salve / menu / aiuto | Menu principale |
| preventivo / 1 | Info per richiedere preventivo |
| servizi / 2 | Elenco servizi DPI |
| conto termico / 3 | Info incentivi Conto Termico 3.0 |
| contatti / 4 | Recapiti azienda |
| fotovoltaico / pannelli | Info impianti FV |
| pompa di calore | Info climatizzazione |

---

## 📁 Struttura
```
dpi-chatbot/
├── src/
│   └── index.js       # Server principale
├── package.json
├── .env.example       # Variabili da configurare
├── .gitignore
└── README.md
```
