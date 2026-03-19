const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

// Basit delay (baileys'ten bağımsız)
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const CONFIG_PATH = './config.json';
const AUTH_DIR = 'auth_info';

// In-memory interval kayıtları
const intervals = new Map();

function loadConfig() {
  let config = { admins: [], message: "Merhaba!", interval_minutes: 60 };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error('config.json okunurken hata:', err);
    }
  }
  return config;
}
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('config.json yazılırken hata:', err);
  }
}

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    let config = loadConfig();

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        console.log('\n--- QR KODU TARATIN ---\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        console.log('[!] Bot başarıyla bağlandı!');
      } else if (connection === 'close') {
        console.warn('[!] Bağlantı kapandı. Yeniden bağlanılıyor...');
        if (lastDisconnect) console.warn('lastDisconnect:', lastDisconnect?.error || lastDisconnect);
        // Basit yeniden başlatma
        setTimeout(startBot, 5000);
      } else {
        console.log('connection.update:', connection);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = Array.isArray(m.messages) ? m.messages : [m.messages];
        for (const msg of messages) {
          if (!msg) continue;

          // Bazı mesajlar ephemeral içinde olabilir
          const message = msg.message?.ephemeralMessage?.message || msg.message;
          if (!message || msg.key?.fromMe) continue;

          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) continue;
          const sender = remoteJid.split('@')[0];

          // Mesaj içeriğini güvenilir şekilde al
          let content = "";
          const keys = Object.keys(message);
          const type = keys.length ? keys[0] : null;
          if (type === 'conversation') content = message.conversation;
          else if (type === 'extendedTextMessage') content = message.extendedTextMessage?.text || "";
          else if (type === 'imageMessage') content = message.imageMessage?.caption || "";
          else if (type === 'documentMessage') content = message.documentMessage?.caption || "";
          else content = "";

          content = (content || "").trim();

          // İlk admin ataması
          if (config.admins.length === 0) {
            config.admins.push(sender);
            saveConfig(config);
            await sock.sendMessage(remoteJid, { text: '✅ İlk admin olarak kaydedildiniz!' });
            continue;
          }

          // Sadece adminlerin komut çalıştırmasına izin ver
          if (!config.admins.includes(sender)) continue;

          // Komutlar
          if (content === '!yardım' || content === '!help') {
            await sock.sendMessage(remoteJid, {
              text: '*🤖 Komutlar:*

!adminekle <numara veya @mention>
!adminler
!otogönder [mesaj] [dk]
!otodur'
            });
            continue;
          }

          if (content.startsWith('!adminekle')) {
            const parts = content.split(' ').filter(Boolean);
            const target = parts[1];
            if (!target) {
              await sock.sendMessage(remoteJid, { text: 'Kullanım: !adminekle 905XXXXXXXXX veya !adminekle @905XXXXXXXXX' });
              continue;
            }
            const normalized = target.replace(/^@/, '').replace(/\D/g, '');
            if (!normalized) {
              await sock.sendMessage(remoteJid, { text: 'Geçerli bir numara ekleyin.' });
              continue;
            }
            if (!config.admins.includes(normalized)) {
              config.admins.push(normalized);
              saveConfig(config);
              await sock.sendMessage(remoteJid, { text: `✅ ${normalized} admin olarak eklendi.` });
            } else {
              await sock.sendMessage(remoteJid, { text: `${normalized} zaten admin.` });
            }
            continue;
          }

          if (content === '!adminler') {
            await sock.sendMessage(remoteJid, { text: `👥 Adminler:\n\n${config.admins.join('\n')}` });
            continue;
          }

          if (content.startsWith('!otogönder')) {
            const parts = content.split(' ').filter(Boolean);
            if (parts.length < 3) {
              await sock.sendMessage(remoteJid, { text: 'Kullanım: !otogönder [mesaj] [dk]' });
              continue;
            }
            const minutes = parseInt(parts[parts.length - 1]);
            const message = parts.slice(1, -1).join(' ');
            if (isNaN(minutes) || minutes <= 0) {
              await sock.sendMessage(remoteJid, { text: 'Geçersiz dakika değeri.' });
              continue;
            }
            if (!message) {
              await sock.sendMessage(remoteJid, { text: 'Gönderilecek mesaj boş olamaz.' });
              continue;
            }

            const sendToGroups = async () => {
              try {
                let chats = {};
                if (typeof sock.groupFetchAllParticipating === 'function') {
                  chats = await sock.groupFetchAllParticipating();
                } else if (sock.groupFetchAll) {
                  // fallback (sürüm farklılığı olabilir)
                  chats = await sock.groupFetchAll();
                } else {
                  console.warn('groupFetchAllParticipating fonksiyonu bulunamadı.');
                }
                for (const id of Object.keys(chats)) {
                  try {
                    await sock.sendMessage(id, { text: message });
                    await delay(2000);
                  } catch (err) {
                    console.error('Gönderilemedi gruba:', id, err?.message || err);
                  }
                }
              } catch (err) {
                console.error('groupFetchAllParticipating hatası:', err);
              }
            };

            // Eğer halihazırda bir interval varsa temizle
            if (intervals.has('global')) {
              clearInterval(intervals.get('global'));
              intervals.delete('global');
            }

            await sendToGroups();
            const iv = setInterval(sendToGroups, minutes * 60 * 1000);
            intervals.set('global', iv);
            await sock.sendMessage(remoteJid, { text: `✅ Otomatik gönderim başlatıldı: Her ${minutes} dakika.` });
            continue;
          }

          if (content === '!otodur') {
            if (intervals.has('global')) {
              clearInterval(intervals.get('global'));
              intervals.delete('global');
              await sock.sendMessage(remoteJid, { text: '⏹️ Otomatik gönderim durduruldu.' });
            } else {
              await sock.sendMessage(remoteJid, { text: 'Zaten aktif otomatik gönderim yok.' });
            }
            continue;
          }
        }
      } catch (err) {
        console.error('messages.upsert işlenirken hata:', err);
      }
    });

    console.log('Bot başlatıldı, QR bekleniyor (terminalde görünecek).');
  } catch (err) {
    console.error('startBot hata:', err);
    setTimeout(startBot, 5000);
  }
}

startBot();
