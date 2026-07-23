# Gunzito · Lyric Video Generator

Gerador de vídeos líricos com vinil animado, waveform e destaque de palavras.

## Deploy na Vercel (5 minutos)

### 1. Suba o projeto pro GitHub
```bash
git init
git add .
git commit -m "first commit"
gh repo create gunzito-lyric-video --public --push --source=.
```

### 2. Conecte na Vercel
- Acesse [vercel.com](https://vercel.com)
- "Add New Project" → importe o repositório
- Em **Environment Variables** adicione:
  ```
  OPENAI_API_KEY = sua_key_aqui
  ```
- Clique em **Deploy**

### 3. Pronto
A URL gerada pela Vercel já funciona — compartilhe com o time.

---

## Rodar local
```bash
npm install
cp .env.example .env.local
# edite .env.local com sua OPENAI_API_KEY
npm run dev
# acesse http://localhost:3000
```

## Estrutura
```
pages/
  index.jsx          # App principal (canvas + UI)
  api/
    transcribe.js    # Server-side Whisper (sem CORS)
styles/
  globals.css
```

## Fluxo
1. Upload capa (JPG/PNG) + áudio (MP3/WAV/M4A)
2. Clica "Transcrever" → Whisper retorna segmentos com timestamps reais
3. Ajusta letra no editor se precisar
4. Escolhe estilo (cores, fonte, animação, formato)
5. Preview ao vivo com vinil girando + waveform
6. Exporta .webm com áudio embutido
