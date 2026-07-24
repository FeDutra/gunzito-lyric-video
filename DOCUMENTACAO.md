# 🎵 Gunzito Lyric Video - Documentação Completa da Plataforma

Este documento descreve detalhadamente a arquitetura, o fluxo de dados, as tecnologias utilizadas e, principalmente, os desafios lógicos enfrentados no sincronismo de legendas. O objetivo é fornecer um contexto profundo e absoluto para consulta ou para que outra IA possa assumir ou auxiliar no projeto.

---

## 1. Visão Geral do Projeto
A plataforma é uma aplicação web focada em gerar "Lyric Videos" automáticos a partir de um arquivo de áudio. Ela transcreve o áudio, sincroniza as palavras com o tempo exato (timestamps), renderiza um layout personalizável em um `<canvas>` HTML5 (com a capa do single e um disco de vinil girando) e exporta o resultado final como um arquivo de vídeo `.mp4`.

## 2. Stack Tecnológico (Infraestrutura)
* **Frontend:** React (Next.js - App Router ou Pages Router, atualmente operando em `pages/index.jsx`).
* **Backend (API):** Next.js API Routes (`pages/api/transcribe.js`).
* **Hospedagem:** Firebase App Hosting (integrado ao GitHub, faz o build e deploy automaticamente).
* **IA de Transcrição e Processamento:** [Groq API](https://console.groq.com/docs/openai). Usamos o Groq tanto para rodar o modelo `whisper-large-v3` (transcrição de áudio super rápida) quanto o modelo `llama-3.3-70b-versatile` (formatação gramatical de texto).
* **Processamento de Vídeo no Cliente:** `@ffmpeg/ffmpeg` (FFmpeg compilado em WebAssembly) rodando no navegador do usuário via `SharedArrayBuffer`.

---

## 3. Arquitetura Funcional e Fluxo Principal

### Passo A: Upload e UI (Frontend)
1. O usuário (Felipe) faz upload de um arquivo de áudio (`.mp3` ou `.wav`).
2. O usuário pode **(opcionalmente)** colar a **Letra Oficial** da música em um campo de texto. A Letra Oficial serve como referência estrutural para pontuação, quebras de verso e ritmo.
3. Ao clicar em "Transcrever", o áudio (e a letra oficial, se houver) são enviados via `FormData` para o backend `/api/transcribe`.

### Passo B: Transcrição (Backend)
1. O endpoint `/api/transcribe.js` recebe o áudio e envia para a API do Groq (endpoint de OpenAI compatível: `audio.transcriptions.create`) usando o modelo Whisper.
2. O Whisper retorna dois arrays importantes:
   - `words`: Array contendo cada palavra dita e seu tempo exato `{ word: "noite", start: 22.10, end: 22.50 }`.
   - `segments`: Array contendo blocos maiores de frases (geralmente longos demais para caber na tela do vídeo).

### Passo C: O Grande Desafio Lógico - O Sincronismo ⚠️
O objetivo principal é que a legenda apareça na tela respeitando o tempo da voz, mas com a formatação poética/estrutural da Letra Oficial. Ao longo do desenvolvimento, enfrentamos os seguintes obstáculos lógicos:

* **Tentativa 1 (Chunking Seco):** Agrupar as palavras do Whisper de 4 em 4 mecanicamente.
  * *Problema:* Destruía as pausas naturais e o ritmo. Uma palavra do próximo verso subia para a linha anterior apenas porque "tinha espaço", ignorando as frases da música.
* **Tentativa 2 (Alinhamento por Busca de Palavras):** Criamos um algoritmo complexo que lia a Letra Oficial e procurava aquelas palavras no array do Whisper para "pescar" os tempos.
  * *Problema ("Os Saltos"):* O Whisper falha em transcrever partes instrumentais ou introduções murmuradas. Se a música começava com 22 segundos de silêncio e o usuário colocasse uma palavra de "Intro" na Letra Oficial, o algoritmo forçava a palavra inicial para o tempo `0.00s`, criando "gaps" bizarros e arruinando o tempo de tudo.
* **Tentativa 3 (Formatação LLM com Mapeamento Sequencial - Atual):**
  * Pegamos o texto bruto que o Whisper transcreveu (sem tempos, só a frase completa corrida).
  * Enviamos para o `Llama-3.3-70b` no Groq, passando a Letra Oficial como "Gabarito de Estrutura".
  * O LLM devolve o texto do Whisper reorganizado em linhas/versos curtos, copiando as quebras de linha e vírgulas da Letra Oficial. NENHUMA palavra pode ser adicionada se o Whisper não tiver ouvido.
  * No final, o código conta quantas palavras tem em cada linha formatada, e vai extraindo a exata quantidade correspondente do array de timestamps (Whisper `words`) em fila indiana. Como é sequencial, é fisicamente impossível gerar saltos de tempo irreais.

### Passo D: A Renderização no Frontend (`pages/index.jsx`)
1. Com o array de legendas alinhado `[ { text: "Noite longa", start: 22.1, end: 24.5 }, ... ]`, o React gera uma lista na tela. O usuário pode editar textos ou tempos manualmente (fine-tuning).
2. Adicionamos um injetor automático que garante que o emoji 🎶 apareça apenas no início da primeira linha da música.
3. Um acelerador matemático deduz `150ms` do tempo de início de cada frase, para que o texto surja na tela um milésimo de segundo *antes* do cantor abrir a boca.

### Passo E: Exportação de Vídeo (O desafio do MP4)
1. Para gerar o vídeo no navegador sem custo de servidor, usamos um loop requestAnimationFrame que desenha a capa do disco, o vinil rotacionando e o texto da legenda no `<canvas>`.
2. Quando o usuário clica em "Exportar", capturamos esse canvas usando `canvas.captureStream(30)`.
3. Gravamos o stream de vídeo temporariamente na memória RAM usando o `MediaRecorder` nativo do navegador.
4. Finalizada a música, o arquivo de vídeo temporário gerado e o áudio original são jogados dentro do **FFmpeg WASM**.
5. O FFmpeg faz a mixagem (muxing) do áudio em cima do vídeo, e cospe um `.mp4` (codec libx264, audio aac).

**Problemas recentes na exportação:** O Safari (macOS e iOS) não suporta gravar vídeos usando o mimeType `video/webm` no `MediaRecorder`. O código precisou ser ajustado com fallbacks rígidos (`try/catch`) para tentar exportar diretamente em `video/mp4` ou notificar o usuário para usar o Chrome/Edge caso o motor nativo trave antes mesmo do FFmpeg iniciar.

---

## 4. Estrutura de Arquivos

* `pages/index.jsx`: O coração visual. Contém 1300+ linhas concentrando 3 áreas:
  1. Estado do app (Variáveis, Uploads, Refs de tempo).
  2. O loop mestre do `<canvas>` que calcula proporções, gradientes e a rotação do vinil.
  3. A lógica de exportação multimídia via `MediaRecorder` e `FFmpeg`.
* `pages/api/transcribe.js`: O worker do backend.
  1. Usa `formidable` para ler o formulário multipart (áudio + letra).
  2. Faz o POST para OpenAI (hosteado no Groq).
  3. Roda a "Tentativa 3" (O mapeamento LLM Sequencial).
* `next.config.js`: Contém regras ABSOLUTAMENTE CRÍTICAS de permissão de cabeçalho (`Cross-Origin-Opener-Policy` e `Cross-Origin-Embedder-Policy`). Sem elas, o FFmpeg webAssembly dispara um erro de segurança (SharedArrayBuffer) e o app trava instantaneamente na exportação.

## 5. Como Iniciar a Análise em Caso de Erro
Se houver falha, analise os seguintes vetores:
* **Se o erro for de compilação ou função ausente:** Provavelmente cache de versão do App Hosting, ou uma quebra de tipos (exemplo recente: o Formidable converte a string `lyrics` num Array, quebrando funções de String como `.trim()`).
* **Se o erro for tempos engolidos/encavalados:** O prompt do `Llama-3.3-70b` em `/api/transcribe.js` pode ter falhado na regra de manter o número exato de palavras do Whisper, causando um desnível na contagem.
* **Se a exportação não começar:** Falha de suporte de `MediaRecorder` do navegador do usuário.
* **Se a exportação congelar no FFmpeg (5% até 90%):** Conflito de CORS com o Firebase ou restrição no WebAssembly de memória RAM da máquina (muito áudio).

---
*Documento gerado como base técnica definitiva para continuidade ou debug de agentes.*
