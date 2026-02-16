// Service Worker para TV Marataízes PWA
// Versão 1.0.0

const CACHE_NAME = 'tv-marataizes-v1';
const RUNTIME_CACHE = 'tv-marataizes-runtime-v1';

// Arquivos para cache offline
const OFFLINE_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/manifest.json',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png'
];

// Install Event - Cache dos assets principais
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Instalando...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Cache aberto');
        return cache.addAll(OFFLINE_ASSETS);
      })
      .then(() => {
        console.log('[Service Worker] Assets em cache');
        return self.skipWaiting();
      })
  );
});

// Activate Event - Limpa caches antigos
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Ativando...');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => {
              return cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE;
            })
            .map((cacheName) => {
              console.log('[Service Worker] Deletando cache antigo:', cacheName);
              return caches.delete(cacheName);
            })
        );
      })
      .then(() => {
        console.log('[Service Worker] Ativado');
        return self.clients.claim();
      })
  );
});

// Fetch Event - Estratégia de cache
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Ignora requests de outros domínios (exceto fonts, CDNs, etc)
  if (url.origin !== location.origin && !url.href.includes('fonts.googleapis.com')) {
    return;
  }
  
  // Estratégia: Network First com Cache Fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          
          caches.open(RUNTIME_CACHE)
            .then((cache) => {
              cache.put(request, responseClone);
            });
        }
        
        return response;
      })
      .catch(() => {
        return caches.match(request)
          .then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            
            if (request.mode === 'navigate') {
              return caches.match('/app/index.html');
            }
            
            return new Response('Offline', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: new Headers({
                'Content-Type': 'text/plain'
              })
            });
          });
      })
  );
});

// Push Notification Event
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push recebido');
  
  let notificationData = {
    title: 'TV Marataízes',
    body: 'Nova notificação da TV Marataízes!',
    icon: '/app/icons/icon-192.png',
    badge: '/app/icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: {
      url: '/app/index.html'
    }
  };
  
  if (event.data) {
    try {
      const data = event.data.json();
      notificationData = {
        ...notificationData,
        ...data
      };
    } catch (e) {
      notificationData.body = event.data.text();
    }
  }
  
  event.waitUntil(
    self.registration.showNotification(notificationData.title, {
      body: notificationData.body,
      icon: notificationData.icon,
      badge: notificationData.badge,
      vibrate: notificationData.vibrate,
      data: notificationData.data,
      actions: [
        {
          action: 'open',
          title: 'Abrir',
          icon: '/app/icons/icon-192.png'
        },
        {
          action: 'close',
          title: 'Fechar'
        }
      ],
      tag: 'tv-marataizes-notification',
      renotify: true,
      requireInteraction: false
    })
  );
});

// Notification Click Event
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notificação clicada');
  
  event.notification.close();
  
  if (event.action === 'open' || !event.action) {
    const urlToOpen = event.notification.data?.url || '/app/index.html';
    
    event.waitUntil(
      clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      })
      .then((clientList) => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
    );
  }
});

// Background Sync Event
self.addEventListener('sync', (event) => {
  console.log('[Service Worker] Background sync:', event.tag);
  
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  try {
    console.log('[Service Worker] Sincronizando dados...');
    return Promise.resolve();
  } catch (error) {
    console.error('[Service Worker] Erro na sincronização:', error);
    return Promise.reject(error);
  }
}

// Message Event
self.addEventListener('message', (event) => {
  console.log('[Service Worker] Mensagem recebida:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CACHE_URLS') {
    event.waitUntil(
      caches.open(RUNTIME_CACHE)
        .then((cache) => {
          return cache.addAll(event.data.urls);
        })
    );
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys()
        .then((cacheNames) => {
          return Promise.all(
            cacheNames.map((cacheName) => {
              return caches.delete(cacheName);
            })
          );
        })
        .then(() => {
          console.log('[Service Worker] Cache limpo');
        })
    );
  }
});

// Periodic Background Sync
self.addEventListener('periodicsync', (event) => {
  console.log('[Service Worker] Periodic sync:', event.tag);
  
  if (event.tag === 'content-sync') {
    event.waitUntil(syncContent());
  }
});

async function syncContent() {
  try {
    console.log('[Service Worker] Sincronizando conteúdo...');
    return Promise.resolve();
  } catch (error) {
    console.error('[Service Worker] Erro ao sincronizar conteúdo:', error);
    return Promise.reject(error);
  }
}

console.log('[Service Worker] Carregado e pronto!');
