'use strict';

const wppconnect = require('@wppconnect-team/wppconnect');

const sessions = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function digitsOnly(s) {
  return String(s || '').replace(/\D+/g, '');
}

function jidToDigits(jid) {
  return digitsOnly(String(jid || '').split('@')[0]);
}

function waToWppId(remoteJid) {
  const to0 = String(remoteJid || '').trim();
  if (!to0) return '';

  // если вдруг прилетает с префиксом "accId:"
  const to = to0.replace(/^(\d+):/, '');

  // если просто цифры
  if (/^\d{8,15}$/.test(to)) return to + '@c.us';

  // стандартный WA jid
  if (to.endsWith('@s.whatsapp.net')) return to.replace('@s.whatsapp.net', '@c.us');

  // ✅ FIX: lid -> c.us (иначе WPP не отправит)
  if (to.endsWith('@lid')) return to.replace('@lid', '@c.us');

  return to;
}

function toDataUrlMaybe(base64OrDataUrl) {
  const s = String(base64OrDataUrl || '');
  if (!s) return '';
  if (s.startsWith('data:')) return s;
  return `data:image/png;base64,${s}`;
}

function bufToDataUri(buf, mime) {
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

async function resolveMeJid(client) {
  // Способ 1: через getWAWebInfo (САМЫЙ НАДЕЖНЫЙ для WPP)
  try {
    if (typeof client.getConnectionState === 'function') {
      const state = await client.getConnectionState();
      if (state?.me?.user) {
        const d = digitsOnly(state.me.user);
        if (d && d !== '1') return `${d}@s.whatsapp.net`;
      }
    }
  } catch (_) {}

  // Способ 2: через sessionToken
  try {
    const session = await client.getSessionTokenBrowser();
    if (session?.me) {
      const d = digitsOnly(String(session.me));
      if (d && d !== '1') return `${d}@s.whatsapp.net`;
    }
  } catch (_) {}

  // Способ 3: getHostDevice
  try {
    if (typeof client.getHostDevice === 'function') {
      const hd = await client.getHostDevice();
      const wid = hd?.wid || hd?.id?._serialized || hd?.id?.user || hd?.id;
      const d = jidToDigits(wid);
      if (d && d !== '1') return `${d}@s.whatsapp.net`;
    }
  } catch (_) {}

  // Способ 4: через info.wid
  try {
    const wid = client?.info?.wid || client?.info?.me || client?.info?.me?._serialized;
    const d = jidToDigits(wid);
    if (d && d !== '1') return `${d}@s.whatsapp.net`;
  } catch (_) {}

  // Способ 5: getWid
  try {
    if (typeof client.getWid === 'function') {
      const wid = await client.getWid();
      const d = jidToDigits(wid);
      if (d && d !== '1') return `${d}@s.whatsapp.net`;
    }
  } catch (_) {}

  // Способ 6: ПРЯМОЙ ДОСТУП к WA Web (ПОСЛЕДНЯЯ НАДЕЖДА!)
  try {
    const page = client?.page;
    if (page) {
      const result = await page.evaluate(() => {
        try {
          // @ts-ignore
          const me = window.WWebJS?.conn?.me || window.Store?.Conn?.me;
          return me?.user || me?._serialized || me;
        } catch {
          return null;
        }
      });
      if (result) {
        const d = digitsOnly(String(result));
        if (d && d !== '1') return `${d}@s.whatsapp.net`;
      }
    }
  } catch (_) {}

  return '';
}

function makeSockLike(client, accId, meJid) {
  return {
    __isWpp: true,
    ws: { readyState: 0 },
    user: { id: meJid || `wpp:${accId}` },

    sendMessage: async (remoteJid, content) => {
      const toWpp = waToWppId(remoteJid);
      if (!toWpp) throw new Error('sendMessage: empty jid');

      const txt = (content && (content.text ?? content.caption ?? content.body)) ?? '';

      if (
        typeof txt === 'string' &&
        txt.length &&
        !content?.image &&
        !content?.video &&
        !content?.audio &&
        !content?.document
      ) {
        return client.sendText(toWpp, txt);
      }

      if (content?.image) {
        const mime = content.mimetype || 'image/jpeg';
        const dataUri = Buffer.isBuffer(content.image)
          ? bufToDataUri(content.image, mime)
          : String(content.image || '');
        return client.sendImageFromBase64(toWpp, dataUri, 'image.jpg', content.caption || '');
      }

      if (content?.video || content?.document) {
        const fileBuf = content.video || content.document;
        const mime = content.mimetype || (content.video ? 'video/mp4' : 'application/octet-stream');
        const dataUri = Buffer.isBuffer(fileBuf) ? bufToDataUri(fileBuf, mime) : String(fileBuf || '');
        return client.sendFile(toWpp, dataUri, { caption: content.caption || '' });
      }

      if (content?.audio) {
        const mime = content.mimetype || 'audio/ogg';
        const dataUri = Buffer.isBuffer(content.audio)
          ? bufToDataUri(content.audio, mime)
          : String(content.audio || '');

        if (content.ptt && typeof client.sendPttFromBase64 === 'function') {
          return client.sendPttFromBase64(toWpp, dataUri, 'voice.ogg', content.caption || '');
        }
        return client.sendFile(toWpp, dataUri, { caption: content.caption || '' });
      }

      if (typeof txt === 'string' && txt.length) {
        return client.sendText(toWpp, txt);
      }

      throw new Error('sendMessage: unsupported payload for WPPConnect adapter');
    },

    sendPresenceUpdate: async () => {},
    profilePictureUrl: async (remoteJid) => {
      try {
        const id1 = waToWppId(remoteJid);

        let url = '';

        if (typeof client.getProfilePicFromServer === 'function') {
          const r = await client.getProfilePicFromServer(id1);
          if (typeof r === 'string') url = r;
          else url = (r && (r.eurl || r.imgFull || r.img)) ? (r.eurl || r.imgFull || r.img) : '';
        } else if (typeof client.getProfilePicUrl === 'function') {
          const r = await client.getProfilePicUrl(id1);
          url = (typeof r === 'string') ? r : '';
        }

        // fallback: thumb base64 -> data url
        if (!url && typeof client.getProfilePicThumbToBase64 === 'function') {
          const b64 = await client.getProfilePicThumbToBase64(id1);
          url = toDataUrlMaybe(b64);
        }

        // extra fallback for @lid (если библиотека принимает как есть)
        if (!url && remoteJid && /@lid$/i.test(String(remoteJid)) && typeof client.getProfilePicFromServer === 'function') {
          try {
            const r2 = await client.getProfilePicFromServer(String(remoteJid));
            if (typeof r2 === 'string') url = r2;
            else url = (r2 && (r2.eurl || r2.imgFull || r2.img)) ? (r2.eurl || r2.imgFull || r2.img) : '';
          } catch (_) {}
        }

        return url || null;
      } catch (_) {
        return null;
      }
    },

    end: async () => { try { await client.close(); } catch (_) {} },
    logout: async () => { try { await client.logout(); } catch (_) {} },
  };
}

async function startSession(accIdOrOpts, maybeOpts = {}) {
  let accId;
  let opts;

  if (accIdOrOpts && typeof accIdOrOpts === 'object') {
    accId = accIdOrOpts.accId;
    opts = accIdOrOpts;
  } else {
    accId = accIdOrOpts;
    opts = maybeOpts || {};
  }

  if (!accId) throw new Error('startSession: accId is required');

  if (sessions.has(accId)) {
    const s = sessions.get(accId);
    return { client: s.client, sockLike: s.sockLike, meJid: s.meJid };
  }

  const sessionName = opts.sessionName || `acc-${accId}`;
  const sessionDir  = opts.sessionDir || './tokens';

  let onlineEmitted = false;
  
  let meJid = '';
  let sockLike = {
    __isWpp: true,
    ws: { readyState: 0 },
    user: { id: `wpp:${accId}` }
  };

  console.log(`[WPP] Creating session ${sessionName}...`);

  const client = await wppconnect.create({
    session: sessionName,
    headless: true,
    autoClose: 0,
    qrTimeout: 0,
    folderNameToken: sessionDir,

    catchQR: (base64Qr, _asciiQR, attempts, _urlCode) => {
      const s = sessions.get(accId);
      if (s?.loggedIn) return;

      const qrDataUrl = toDataUrlMaybe(base64Qr);
      console.log(`[WPP] acc ${accId} QR attempt ${attempts}`);
      try { opts.onQR?.(qrDataUrl, { attempts }); } catch (_) {}
    },

    statusFind: async (statusSession) => {
      const st = String(statusSession || '').toLowerCase();
      console.log(`[WPP] acc ${accId} statusFind: ${st}`);

    if (st === 'inchat' && !onlineEmitted) {
      onlineEmitted = true;
      const s = sessions.get(accId);
      if (s) s.loggedIn = true;

      sockLike.ws.readyState = 1;

      // ✅ ИСПРАВЛЕНИЕ: Подтягиваем номер несколькими способами
      try {
        await sleep(500);
        
        // Способ 1: resolveMeJid
        if (!meJid || meJid === `wpp:${accId}`) {
          meJid = await resolveMeJid(client);
        }
        
        // Способ 2: через client.getHostDevice
        if (!meJid || meJid === `wpp:${accId}`) {
          try {
            const info = await client.getHostDevice();
            const wid = info?.wid?.user || info?.me?.user;
            if (wid) meJid = `${wid}@s.whatsapp.net`;
          } catch (_) {}
        }
        
        // Способ 3: через client.getWid
        if (!meJid || meJid === `wpp:${accId}`) {
          try {
            if (typeof client.getWid === 'function') {
              const wid = await client.getWid();
              const digits = String(wid || '').replace(/\D+/g, '');
              if (digits) meJid = `${digits}@s.whatsapp.net`;
            }
          } catch (_) {}
        }
        
        console.log(`[WPP] acc ${accId} resolved meJid: ${meJid}`);
        
        if (meJid && meJid !== `wpp:${accId}`) {
          sockLike.user.id = meJid;
          const rec = sessions.get(accId);
          if (rec) rec.meJid = meJid;
        }
      } catch (err) {
        console.error(`[WPP] acc ${accId} resolveMeJid error:`, err);
      }

      // ✅ ВЫЗЫВАЕМ ONLINE
      console.log(`[WPP] acc ${accId} calling onOnline with meJid: ${meJid}`);
      try { 
        await opts.onOnline?.(meJid || null); 
      } catch (err) {
        console.error(`[WPP] acc ${accId} onOnline error:`, err);
      }
      return;
    }

      const looksOffline =
        st.includes('notlogged') ||
        st.includes('disconnected') ||
        st.includes('unpaired') ||
        st.includes('close');

      if (looksOffline) {
        const s = sessions.get(accId);
        if (s?.sockLike?.ws) s.sockLike.ws.readyState = 0;
        try { await opts.onOffline?.(st); } catch (_) {}
      }
    },

    puppeteerOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  console.log(`[WPP] acc ${accId} client created`);

  meJid = await resolveMeJid(client);
  const sockLikeWithMethods = makeSockLike(client, accId, meJid);
  Object.assign(sockLike, sockLikeWithMethods);

  sessions.set(accId, { client, sockLike, meJid, loggedIn: false });

  try {
    if (typeof opts.onMessage === 'function') {
      client.onMessage((m) => opts.onMessage(m));
    }
  } catch (_) {}

    try {
    client.onStateChange(async (state) => {
      const st = String(state || '').toLowerCase();
      console.log(`[WPP] acc ${accId} state change: ${st}`);

      // ✅ Только OFFLINE через onStateChange, ONLINE через statusFind
      const looksOffline =
        st.includes('notlogged') || 
        st.includes('disconnected') || 
        st.includes('close') || 
        st.includes('unpaired');

      if (looksOffline) {
        sockLike.ws.readyState = 0;
        onlineEmitted = false;
        const s = sessions.get(accId);
        if (s) s.loggedIn = false;
        
        console.log(`[WPP] acc ${accId} calling onOffline`);
        try { 
          await opts.onOffline?.(st); 
        } catch (_) {}
      }
    });
  } catch (err) {
    console.error(`[WPP] acc ${accId} onStateChange error:`, err);
  }

// try {
//     client.onStateChange(async (state) => {
//       const st = String(state || '').toLowerCase();
//       console.log(`[WPP] acc ${accId} state change: ${st}`);

//       // ✅ Проверяем по состоянию MAIN/NORMAL — это гарантия что залогинен
//       const isMainState = st.includes('main') || st.includes('normal');
      
//       const looksOnline =
//         isMainState ||
//         st === 'connected';

//       const looksOffline =
//         st.includes('notlogged') || 
//         st.includes('disconnected') || 
//         st.includes('close') || 
//         st.includes('unpaired');

//       if (looksOnline) {
//         sockLike.ws.readyState = 1;

//         // ✅ ИСПРАВЛЕНИЕ: если состояние MAIN — сразу вызываем onOnline
//         // Не проверяем isLoggedIn() т.к. он багованный
//         if (isMainState && !onlineEmitted) {
//           onlineEmitted = true;
//           const s = sessions.get(accId);
//           if (s) s.loggedIn = true;

//           // Подтягиваем номер
//           try {
//             meJid = await resolveMeJid(client);
//             console.log(`[WPP] acc ${accId} resolved meJid: ${meJid}`);
//             if (meJid) {
//               sockLike.user.id = meJid;
//               const rec = sessions.get(accId);
//               if (rec) rec.meJid = meJid;
//             }
//           } catch (err) {
//             console.error(`[WPP] acc ${accId} resolveMeJid error:`, err);
//           }

//           // ✅ ВЫЗЫВАЕМ ОНЛАЙН
//           console.log(`[WPP] acc ${accId} calling onOnline with meJid: ${meJid}`);
//           try { 
//             await opts.onOnline?.(meJid || null); 
//           } catch (err) {
//             console.error(`[WPP] acc ${accId} onOnline error:`, err);
//           }
//         }
//         return;
//       }

//       if (looksOffline) {
//         sockLike.ws.readyState = 0;
//         onlineEmitted = false;
//         const s = sessions.get(accId);
//         if (s) s.loggedIn = false;
        
//         console.log(`[WPP] acc ${accId} calling onOffline`);
//         try { 
//           await opts.onOffline?.(st); 
//         } catch (_) {}
//       }
//     });
//   } catch (err) {
//     console.error(`[WPP] acc ${accId} onStateChange error:`, err);
//   }
  
  try {
    await sleep(400);
    if (!meJid) {
      const maybe = await resolveMeJid(client);
      if (maybe) {
        meJid = maybe;
        sockLike.user.id = meJid;
        const rec = sessions.get(accId);
        if (rec) rec.meJid = meJid;
      }
    }
  } catch (_) {}

  return { client, sockLike, meJid };
}

async function closeSession(accId) {
  const s = sessions.get(accId);
  if (!s) return;
  sessions.delete(accId);
  try { s.sockLike.ws.readyState = 0; } catch (_) {}
  try { await s.client.close(); } catch (_) {}
}

module.exports = { startSession, closeSession, sessions };