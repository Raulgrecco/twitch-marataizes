# 📺 TV MARATAÍZES - PWA (Progressive Web App)

**App de Streaming Profissional - Assista ao Vivo 24h**

---

## 🎯 O QUE É ESTE PWA

PWA completo e profissional para a TV Marataízes com:
- ✅ Player ao vivo integrado (Castr)
- ✅ Design Netflix/Globoplay (tema escuro)
- ✅ Instalável no celular (Add to Home Screen)
- ✅ Funciona offline (cache inteligente)
- ✅ Notificações push (estrutura pronta)
- ✅ Ações rápidas e atalhos

---

## 📁 ESTRUTURA DOS ARQUIVOS

```
/app
├── index.html           # Página principal do PWA
├── manifest.json        # Configuração PWA
├── service-worker.js    # Service Worker (offline + push)
├── /icons              # Ícones do app (você precisa adicionar)
│   ├── icon-72.png
│   ├── icon-96.png
│   ├── icon-128.png
│   ├── icon-144.png
│   ├── icon-152.png
│   ├── icon-192.png
│   ├── icon-384.png
│   └── icon-512.png
```

---

## 🚀 INSTALAÇÃO NO SEU SITE

### PASSO 1 - Upload dos Arquivos

1. Crie uma pasta `/app` na raiz do seu site
2. Faça upload dos 3 arquivos:
   - `index.html`
   - `manifest.json`
   - `service-worker.js`

### PASSO 2 - Criar Ícones

Você precisa criar ícones PNG nos tamanhos:
- 72x72, 96x96, 128x128, 144x144, 152x152
- 192x192 (obrigatório)
- 384x384
- 512x512 (obrigatório)

**Ferramenta recomendada:** https://realfavicongenerator.net/

Salve todos na pasta `/app/icons/`

### PASSO 3 - Configurar HTTPS

⚠️ **IMPORTANTE:** PWAs só funcionam com HTTPS!

Se seu site é `http://`, você precisa ativar SSL/HTTPS.

---

## 🔧 CONFIGURAÇÕES NECESSÁRIAS

### 1. Ajustar URLs no manifest.json

Se sua pasta `/app` não estiver na raiz, ajuste:

```json
"start_url": "/SEU_CAMINHO/app/index.html",
"scope": "/SEU_CAMINHO/app/",
```

### 2. Ajustar Service Worker

No arquivo `service-worker.js`, linha 7-12, ajuste os caminhos:

```javascript
const OFFLINE_ASSETS = [
  '/SEU_CAMINHO/app/',
  '/SEU_CAMINHO/app/index.html',
  // ... etc
];
```

### 3. Player Configurado

O player já está configurado com o link:
```
https://player.castr.com/live_809e4d1087af11f092f8f727f1f0bfd4
```

Se precisar trocar, edite no `index.html` linha 415.

---

## 📱 COMO INSTALAR NO CELULAR

### Android (Chrome):
1. Acesse `seusite.com/app`
2. Aparecerá banner "Adicionar à tela inicial"
3. OU: Menu (⋮) → "Instalar app"
4. Confirme

### iPhone (Safari):
1. Acesse `seusite.com/app`
2. Toque no botão compartilhar
3. "Adicionar à Tela de Início"
4. Confirme

---

## 🔔 NOTIFICAÇÕES PUSH

### Como Funciona

A estrutura de notificações push está **pronta no código**, mas precisa de backend.

### O que já está implementado:

✅ Solicitação de permissão  
✅ Registro de push subscription  
✅ Recebimento de notificações  
✅ Clique em notificações  
✅ Ações nas notificações

### O que você precisa fazer:

1. **Gerar VAPID Keys:**
```bash
npm install web-push -g
web-push generate-vapid-keys
```

2. **Adicionar a Public Key no código:**
No `index.html`, linha 393, substitua:
```javascript
applicationServerKey: urlBase64ToUint8Array('SUA_VAPID_PUBLIC_KEY_AQUI')
```

3. **Criar Backend para enviar push:**

```javascript
// Exemplo Node.js
const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:seu@email.com',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY'
);

// Quando quiser enviar notificação:
webpush.sendNotification(subscription, JSON.stringify({
  title: 'TV Marataízes',
  body: 'Programa X começa em 5 minutos!',
  icon: '/app/icons/icon-192.png',
  data: { url: '/app/index.html' }
}));
```

---

## 🎨 PERSONALIZAÇÃO

### Cores

No `index.html`, CSS root (linha 27-32):

```css
:root {
    --bg-primary: #0F0F0F;        /* Fundo principal */
    --bg-secondary: #1A1A1A;      /* Fundo secundário */
    --bg-card: #252525;           /* Cards */
    --accent-primary: #E50914;    /* Vermelho Netflix */
    --accent-secondary: #FF6B35;  /* Laranja */
}
```

### Programas

Para adicionar/editar programas, no `index.html` (linha 465-541):

```html
<div class="program-card">
    <div class="program-thumbnail">
        <span>🎬</span>
    </div>
    <div class="program-info">
        <h4>Nome do Programa</h4>
        <p>Descrição</p>
    </div>
</div>
```

---

## 🧪 TESTAR LOCALMENTE

### Opção 1 - Python Simple Server:
```bash
cd seu-projeto
python3 -m http.server 8000
# Acesse: http://localhost:8000/app
```

### Opção 2 - Node.js http-server:
```bash
npm install -g http-server
http-server -p 8000
# Acesse: http://localhost:8000/app
```

⚠️ **Nota:** Algumas features PWA só funcionam com HTTPS em produção.

---

## 📊 ANALYTICS E MONITORAMENTO

### Google Analytics

Adicione antes do `</head>` no `index.html`:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

---

## 🐛 TROUBLESHOOTING

### PWA não instala:
- ✅ Verifique se está em HTTPS
- ✅ Confirme que `manifest.json` está acessível
- ✅ Confirme que ícones 192x192 e 512x512 existem
- ✅ Abra DevTools → Application → Manifest

### Service Worker não registra:
- ✅ Verifique console do navegador (F12)
- ✅ Confirme que `service-worker.js` está na pasta `/app`
- ✅ Limpe cache: DevTools → Application → Clear storage

### Player não carrega:
- ✅ Verifique se o link do Castr está correto
- ✅ Teste o link diretamente no navegador
- ✅ Verifique console para erros de CORS

### Notificações não funcionam:
- ✅ Confirme que está em HTTPS
- ✅ Verifique se o usuário deu permissão
- ✅ Adicione VAPID keys no código
- ✅ Teste com: DevTools → Application → Service Workers → Push

---

## 📈 MÉTRICAS DE SUCESSO

Após 1 semana no ar, verifique:
- 📊 Quantos usuários instalaram o app
- 📊 Taxa de engajamento (tempo médio)
- 📊 Quantos aceitaram notificações
- 📊 Retenção (usuários que voltam)

**DevTools → Application → Storage:** Veja service worker stats

---

## 🔒 SEGURANÇA

✅ HTTPS obrigatório  
✅ Content Security Policy recomendada  
✅ Sanitização de dados de notificações  
✅ CORS configurado para player

---

## 📞 SUPORTE

**Problemas técnicos?**
1. Verifique console do navegador (F12)
2. Inspecione Application → Service Workers
3. Teste em modo anônimo (sem cache)

**Dúvidas sobre o código?**
- Todos os arquivos têm comentários explicativos
- Service Worker tem logs detalhados no console

---

## ✅ CHECKLIST FINAL

Antes de colocar no ar:

- [ ] HTTPS ativado
- [ ] Arquivos uploadados em `/app`
- [ ] Ícones criados (192x192 e 512x512 mínimo)
- [ ] manifest.json com URLs corretos
- [ ] service-worker.js com caminhos corretos
- [ ] Player funcionando
- [ ] Testado em mobile
- [ ] Google Analytics instalado (opcional)
- [ ] VAPID keys configuradas (para push)

---

## 🎉 PRONTO PARA USAR!

Acesse: `https://seusite.com/app`

O PWA está **100% funcional** e pronto para produção!

---

**Desenvolvido para TV Marataízes** 📺  
*Emissora do Sul do Espírito Santo • Canal 300 Soul TV*

© 2026 - Todos os direitos reservados
