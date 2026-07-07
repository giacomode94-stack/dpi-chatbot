// ENDPOINT DI TEST - invio manuale template WhatsApp
// Usa le variabili d'ambiente gia' configurate su Render.
// IMPORTANTE: rimuovi o proteggi questo endpoint dopo i test.

function registraTestInvio(app) {
      app.get('/test-invio', async (req, res) => {
              try {
                        const secret = req.query.secret;
                        if (!process.env.TEST_SECRET || secret !== process.env.TEST_SECRET) {
                                    return res.status(403).send('Non autorizzato.');
                        }

                const numero = req.query.numero || '393519072997';
                        const template = req.query.template || 'conferma_appuntamento_v2';

                const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

                const payload = {
                            messaging_product: 'whatsapp',
                            to: numero,
                            type: 'template',
                            template: {
                                          name: template,
                                          language: { code: 'it' },
                                          components: [
                                              {
                                                                type: 'body',
                                                                parameters: [
                                                                    { type: 'text', text: 'Giacomo' },
                                                                    { type: 'text', text: '15/07/2026' },
                                                                    { type: 'text', text: '09:30' }
                                                                                  ]
                                              }
                                                        ]
                            }
                };

                const response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                                          'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(payload)
                });

                const data = await response.json();

                if (data.error) {
                            console.error('Errore test invio:', data.error);
                            return res.status(500).json({ ok: false, errore: data.error });
                }

                console.log('Test invio riuscito:', data);
                        res.status(200).json({ ok: true, risultato: data });
              } catch (err) {
                        console.error('Errore test invio:', err.message);
                        res.status(500).json({ ok: false, errore: err.message });
              }
      });
}

module.exports = { registraTestInvio };
