# Comando único de instalação — TV Sul Capixaba

## Passo 1 — sobe o `index.js` pro GitHub

Cria um repositório novo (ex: `tvsulcapixaba-painel`) e sobe só o arquivo
`index.js`. Não precisa de mais nenhum arquivo.

## Passo 2 — conecta na VPS (a última vez que vai precisar do terminal)

```bash
ssh root@216.128.169.106
```

## Passo 3 — cola este bloco inteiro de uma vez

Troca **SEU-USUARIO** e **SUA_SENHA_AQUI** antes de colar:

```bash
apt update && apt install -y ffmpeg nodejs git && \
cd /root && \
git clone https://github.com/SEU-USUARIO/tvsulcapixaba-painel.git painel && \
cd painel && \
echo "PAINEL_PASSWORD=SUA_SENHA_AQUI" > .env && \
echo "PORT=3000" >> .env && \
cat > /etc/systemd/system/painel.service << 'EOF'
[Unit]
Description=Painel TV Sul Capixaba
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/painel
EnvironmentFile=/root/painel/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && \
systemctl enable painel && \
systemctl start painel && \
echo "PRONTO — abra http://216.128.169.106:3000 no navegador"
```

## Passo 4 — abre no navegador

```
http://216.128.169.106:3000
```

Login: qualquer usuário (ex: `admin`) + a senha que você escolheu no
comando acima.

## Se quiser confirmar que está tudo certo

```bash
systemctl status painel
```

Deve aparecer **"active (running)"** em verde.

## Se um dia quiser atualizar o `index.js`

Edita no GitHub, depois na VPS:

```bash
cd /root/painel
git pull
systemctl restart painel
```

## Sobre a transmissão cair e voltar sozinha

O painel já lembra se estava transmitindo. Se o FFmpeg cair (perda de
conexão, por exemplo), ele tenta reconectar automaticamente em 10
segundos. Se o servidor inteiro reiniciar (queda de energia, reboot da
VPS), a transmissão volta sozinha assim que o painel subir de novo —
sem precisar clicar em nada. Só não volta sozinha se você mesmo clicou
em "Parar" antes.
