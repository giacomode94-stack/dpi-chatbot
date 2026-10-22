// chat-page.js — Pagina /chat con la sola live chat Yeastar (Linkus)
// Aperta dal pulsante "Apri chat" che il bot invia su WhatsApp.

const YEASTAR_SCRIPT =
  process.env.YEASTAR_CHAT_SCRIPT ||
  "https://dpi.ras.yeastar.com/live_chat.v1.0.0.js?channelNumber=LC00000";

const PAGINA = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Chat con un operatore – De Pasquale Impianti</title>
<style>
  :root { --verde: #14c8a0; --scuro: #0f2a3a; --testo: #3b4a55; --sfondo: #f4f7f8; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--sfondo); color: var(--testo);
    display: flex; flex-direction: column; min-height: 100dvh;
  }
  header { background: var(--scuro); color: #fff; padding: 18px 16px; }
  header strong { display: block; font-size: 18px; letter-spacing: .2px; }
  header span { font-size: 13px; opacity: .8; }
  main { flex: 1; padding: 28px 16px 140px; max-width: 520px; margin: 0 auto; width: 100%; }
  h1 { font-size: 22px; color: var(--scuro); margin: 0 0 10px; }
  p { font-size: 16px; line-height: 1.5; margin: 0 0 14px; }
  .passi { background: #fff; border-radius: 14px; padding: 16px 16px 8px 36px; margin: 0; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .passi li { margin: 0 0 8px; font-size: 15px; }
  .freccia { margin-top: 22px; text-align: right; font-size: 15px; font-weight: 600; color: var(--verde); }
  footer { text-align: center; font-size: 12px; color: #8a979f; padding: 0 16px 20px; }
  footer a { color: inherit; }
</style>
</head>
<body>
  <header>
    <strong>De Pasquale Impianti</strong>
    <span>Assistenza clienti</span>
  </header>
  <main>
    <h1>💬 Chatta con un operatore</h1>
    <p>Scrivici qui: un nostro operatore ti risponderà il prima possibile.</p>
    <ol class="passi">
      <li>Tocca il <b>pulsante verde</b> in basso a destra</li>
      <li>Inserisci nome, cognome, email e telefono</li>
      <li>Premi <b>Inizia chat</b> e scrivi il tuo messaggio</li>
    </ol>
    <div class="freccia">Apri la chat ↘</div>
  </main>
  <footer>De Pasquale Impianti Srl · Marsala (TP) · <a href="https://www.depasqualeimpianti.com">depasqualeimpianti.com</a></footer>
  <script id="yeastar-chat-script" src="${YEASTAR_SCRIPT}" async></script>
</body>
</html>`;

function registraPaginaChat(app) {
  app.get("/chat", (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.type("html").send(PAGINA);
  });
}

module.exports = { registraPaginaChat };
