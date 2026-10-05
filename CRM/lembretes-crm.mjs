// CotaFlow CRM — envia lembretes de follow-up por push (roda no GitHub Actions)
//
// - A cada execução: avisa cada follow-up que venceu desde a última rodada.
// - Uma vez por dia (a partir das 8h): manda o resumo "o que fazer hoje".
//
// Precisa do segredo FIREBASE_SERVICE_ACCOUNT (JSON da conta de serviço do Firebase).
// Os horários do CRM são salvos no horário de Brasília (sem horário de verão).

import admin from 'firebase-admin';

const OFFSET_HORAS = -3;          // Brasília
const HORA_RESUMO = 8;            // resumo diário a partir das 8h
const JANELA_MIN = 180;           // só avisa follow-ups que venceram nas últimas 3h (evita spam de atrasados antigos)
const LINK = 'https://cotaflowapp.com.br/CRM/';

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const messaging = admin.messaging();

// "agora" no formato que o CRM salva: AAAA-MM-DDTHH:mm (horário local)
function localStr(msUtc) { return new Date(msUtc + OFFSET_HORAS * 3600e3).toISOString().slice(0, 16); }
const agoraMs = Date.now();
const agora = localStr(agoraMs);
const inicioJanela = localStr(agoraMs - JANELA_MIN * 60e3);
const hoje = agora.slice(0, 10);
const horaLocal = Number(agora.slice(11, 13));

const tokensCache = new Map();
async function tokensDo(uid) {
  if (tokensCache.has(uid)) return tokensCache.get(uid);
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const t = { tokens: Array.isArray(data.fcmTokens) ? data.fcmTokens : [], resumo: data.crmResumoEnviadoEm || null };
  tokensCache.set(uid, t);
  return t;
}

async function enviar(uid, titulo, corpo, leadId) {
  const { tokens } = await tokensDo(uid);
  if (!tokens.length) return 0;
  const link = leadId ? `${LINK}?lead=${leadId}` : `${LINK}?tab=hoje`;
  const resp = await messaging.sendEachForMulticast({
    tokens,
    webpush: {
      notification: { title: titulo, body: corpo, icon: `${LINK}icon-192.png`, badge: `${LINK}icon-192.png`, tag: leadId ? `lead-${leadId}` : 'resumo' },
      fcmOptions: { link }
    }
  });
  // remove tokens de aparelhos que desinstalaram/bloquearam
  const mortos = [];
  resp.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') mortos.push(tokens[i]);
  });
  if (mortos.length) {
    await db.collection('users').doc(uid).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...mortos) });
    tokensCache.get(uid).tokens = tokens.filter(t => !mortos.includes(t));
  }
  return resp.successCount;
}

function primeiroNome(n) { return String(n || 'cliente').trim().split(/\s+/)[0]; }

// 1) follow-ups que venceram agora
const vencidos = await db.collection('leads')
  .where('proximoContato', '>=', inicioJanela)
  .where('proximoContato', '<=', agora)
  .get();

const porDono = new Map();
vencidos.forEach(doc => {
  const l = doc.data();
  if (!l.ownerId || l.notificadoPara === l.proximoContato) return;
  if (l.estagio === 'perdido' && !l.proximoContato) return;
  if (!porDono.has(l.ownerId)) porDono.set(l.ownerId, []);
  porDono.get(l.ownerId).push({ id: doc.id, ...l });
});

let enviados = 0;
for (const [uid, lista] of porDono) {
  if (lista.length <= 3) {
    for (const l of lista) {
      const extra = l.interesse ? ` · ${l.interesse}` : '';
      enviados += await enviar(uid, `Hora do follow-up: ${primeiroNome(l.nome)}`, `Toque pra ver e mandar a mensagem${extra}`, l.id);
    }
  } else {
    const nomes = lista.slice(0, 3).map(l => primeiroNome(l.nome)).join(', ');
    enviados += await enviar(uid, `${lista.length} follow-ups pra agora`, `${nomes} e mais ${lista.length - 3}. Toque pra abrir sua lista.`);
  }
  const batch = db.batch();
  lista.forEach(l => batch.update(db.collection('leads').doc(l.id), { notificadoPara: l.proximoContato }));
  await batch.commit();
}

// 2) resumo diário
if (horaLocal >= HORA_RESUMO && horaLocal < 21) {
  const usuarios = await db.collection('users').where('fcmTokens', '!=', null).get();
  for (const u of usuarios.docs) {
    const data = u.data();
    if (data.crmResumoEnviadoEm === hoje || !Array.isArray(data.fcmTokens) || !data.fcmTokens.length) continue;
    tokensCache.set(u.id, { tokens: data.fcmTokens, resumo: data.crmResumoEnviadoEm || null });
    const leadsSnap = await db.collection('leads').where('ownerId', '==', u.id).get();
    let atrasados = 0, deHoje = 0;
    leadsSnap.forEach(d => {
      const l = d.data();
      if (!l.proximoContato) return;
      const dia = String(l.proximoContato).slice(0, 10);
      if (dia < hoje) atrasados++;
      else if (dia === hoje) deHoje++;
    });
    if (atrasados + deHoje > 0) {
      const partes = [];
      if (deHoje) partes.push(`${deHoje} follow-up${deHoje > 1 ? 's' : ''} pra hoje`);
      if (atrasados) partes.push(`${atrasados} atrasado${atrasados > 1 ? 's' : ''}`);
      enviados += await enviar(u.id, 'Seu dia no CotaFlow CRM', `Você tem ${partes.join(' e ')}. Bora vender! 💪`);
    }
    await db.collection('users').doc(u.id).set({ crmResumoEnviadoEm: hoje }, { merge: true });
  }
}

console.log(`Agora (Brasília): ${agora} · follow-ups vencidos: ${vencidos.size} · notificações entregues: ${enviados}`);
process.exit(0);
