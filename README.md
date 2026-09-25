# Compartilhar Tela Desktop 🖥️

Um aplicativo desktop focado em performance para **compartilhamento de tela e áudio do sistema**, construído com Electron, React, Vite e LiveKit.

![Badge Versão](https://img.shields.io/badge/vers%C3%A3o-1.0.0-00d4b8?style=flat-square) ![Badge Electron](https://img.shields.io/badge/Electron-36.9.5-313244?style=flat-square&logo=electron) ![Badge React](https://img.shields.io/badge/React-18.3.1-313244?style=flat-square&logo=react)

## ✨ Características Principais

- 🎥 **Compartilhamento de Alta Qualidade:** Transmita sua tela inteira ou janelas específicas (suporta até 1080p a 60fps).
- 🔊 **Áudio do Sistema Nativo:** Ao contrário dos navegadores comuns, o app desktop captura o som do seu PC/Jogos perfeitamente sincronizado, graças ao `desktopCapturer` do Electron.
- 🔒 **Salas Seguras:** Crie salas temporárias e proteja-as com senha.
- 🔄 **Atualizações Automáticas (Auto-Updater):** O app detecta novas versões publicadas aqui no GitHub, baixa silenciosamente e avisa quando estiver pronto para atualizar.

---

## 🛠️ Tecnologias Utilizadas

- **Interface:** React + TypeScript + Vanilla CSS (Design System próprio estilo Glassmorphism).
- **Empacotamento Desktop:** Electron (com `electron-builder` e `electron-updater`).
- **Comunicação WebRTC:** Infraestrutura do [LiveKit](https://livekit.io/).
- **Bundler:** Vite (modo de desenvolvimento ultrarrápido rodando simultaneamente com o Electron principal).

---

## 🚀 Como Executar e Contribuir

*Atenção: Este aplicativo atua como o cliente (frontend). Para geração de tokens e backend, ele se comunica com a nossa API Web externa.*

### 1. Requisitos
- Node.js versão 20+
- Conta no LiveKit Cloud (ou self-hosted)

### 2. Instalação
```bash
git clone https://github.com/OZalo/compartilharteladesktop.git
cd compartilharteladesktop
npm install
```

### 3. Variáveis de Ambiente
Crie um arquivo `.env.local` na raiz do projeto e configure suas chaves do LiveKit e URL da sua API principal:

```env
VITE_LIVEKIT_URL=wss://sua-instancia-do-livekit.livekit.cloud
VITE_API_URL=https://seu-site-ou-api.vercel.app
```
*(Obs: O arquivo `.env.local` é ignorado pelo git para manter suas credenciais seguras).*

### 4. Modo de Desenvolvimento
Inicia o Vite (Renderer) e o Electron (Main process) ao mesmo tempo:
```bash
npm run dev:all
```

### 5. Compilando o Executável (.exe)
Gera uma versão "Portable" na pasta `release/`:
```bash
npm run dist:win
```

---
**Criado por [Zalo](https://github.com/OZalo)** 🚀
