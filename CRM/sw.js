/* CotaFlow CRM — service worker
   Só cuida de notificações (push com o app fechado e cliques nos avisos).
   Não guarda cache de propósito: assim toda atualização do index.html
   aparece na hora, sem ficar presa numa versão antiga. */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCyVWVGe0vvqLFowtCLGvKWBBh7Z6tzCNU",
  authDomain: "cotaflow-3b4ea.firebaseapp.com",
  projectId: "cotaflow-3b4ea",
  storageBucket: "cotaflow-3b4ea.firebasestorage.app",
  messagingSenderId: "712940576985",
  appId: "1:712940576985:web:6887f3f5d19541be2f9ec8"
});

// mensagens com "notification" no payload são exibidas automaticamente pelo Firebase
firebase.messaging();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// toque numa notificação criada pelo próprio app (com ele aberto)
self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  if (data.FCM_MSG) return; // o Firebase cuida do clique das notificações de push
  event.notification.close();
  const url = new URL(data.url || './', self.registration.scope).href;
  const leadId = new URL(url).searchParams.get('lead');
  event.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of janelas) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        if (leadId) c.postMessage({ tipo: 'abrir-lead', leadId });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
