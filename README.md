# Compartilhar Tela Desktop

Aplicativo desktop leve para compartilhar a tela e o áudio do sistema, feito com Electron, React, Vite e LiveKit.

![Badge Versão](https://img.shields.io/badge/vers%C3%A3o-1.0.1-00d4b8?style=flat-square) ![Badge Electron](https://img.shields.io/badge/Electron-36.9.5-313244?style=flat-square&logo=electron) ![Badge React](https://img.shields.io/badge/React-18.3.1-313244?style=flat-square&logo=react)

## O que ele faz
- Compartilha a tela inteira ou uma janela específica em alta qualidade (até 1080p 60fps).
- Captura o áudio nativo do sistema do PC junto com a tela.
- Cria salas temporárias seguras com senha.
- Se atualiza sozinho quando uma versão nova sai aqui no GitHub.

## Tecnologias
React, TypeScript, CSS puro, Electron e LiveKit.

## Como rodar o projeto

Este app é o front-end desktop e precisa se comunicar com uma API web para gerar as credenciais do LiveKit.

1. Clone o repositório e instale tudo:
```bash
npm install
```

2. Crie um arquivo `.env.local` na raiz:
```env
VITE_LIVEKIT_URL=wss://sua-url-do-livekit
VITE_API_URL=https://sua-api.vercel.app
```

3. Rode em ambiente de desenvolvimento (Electron + Vite):
```bash
npm run dev:all
```

4. Para compilar o `.exe` final:
```bash
npm run dist:win
```

Criado por [Zalo](https://github.com/OZalo)
