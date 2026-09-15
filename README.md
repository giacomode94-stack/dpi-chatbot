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

## 📅 Invio automatico conferma appuntamento via WhatsApp

Quando il gestionale invia l'email di conferma appuntamento, questa viene
inoltrata dal server via SendGrid Inbound Parse all'endpoint `/inbound-email`,
che estrae nome cliente, data, ora e numero di telefono dal testo e invia
automaticamente il template WhatsApp `conferma_appuntamento_v2` al cliente.

**Formato email atteso** (quello attuale del gestionale va bene così):
```
Buongiorno Sig. NOME COGNOME
La presente è per confermare l'appuntamento 15/09/2026 alle ore 17:30, ...
... che la contatteranno al n° +393519072997 .
```

### Configurazione SendGrid Inbound Parse (una tantum)
1. Scegli un sottodominio dedicato, es. `notifiche.depasqualeimpianti.com`.
2. Nel pannello DNS del dominio, aggiungi un record **MX** per quel sottodominio
   che punta a `mx.sendgrid.net` (priorità 10).
3. Su SendGrid → **Settings → Inbound Parse → Add Host & URL**:
   - **Domain**: `notifiche.depasqualeimpianti.com`
   - **Destination URL**: `https://dpi-chatbot.onrender.com/inbound-email?secret=IL_TUO_INBOUND_SECRET`
4. Imposta il gestionale in modo che invii (anche in CC/inoltro automatico)
   l'email di conferma appuntamento a un indirizzo su quel sottodominio,
   es. `appuntamenti@notifiche.depasqualeimpianti.com`.
5. Aggiungi su Render la variabile `INBOUND_SECRET` con lo stesso valore
   usato nell'URL al punto 3.

Se l'estrazione automatica fallisce (email in un formato inatteso), il
sistema NON invia nulla su WhatsApp e ti manda invece una email di avviso
con il testo originale, così puoi contattare il cliente manualmente.

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
