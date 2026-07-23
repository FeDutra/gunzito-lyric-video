import { IncomingForm } from "formidable";
import { createReadStream } from "fs";
import OpenAI from "openai";

export const config = {
  api: { bodyParser: false },
};

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    // Parse multipart form
    const form = new IncomingForm({ keepExtensions: true, maxFileSize: 50 * 1024 * 1024 });
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve([fields, files]);
      });
    });

    const fileField = files.audio || files.file;
    const audioFile = Array.isArray(fileField) ? fileField[0] : fileField;
    if (!audioFile) return res.status(400).json({ error: "Nenhum arquivo enviado" });

    // Call Whisper on Groq with word-level timestamps
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(audioFile.filepath),
      model: "whisper-large-v3",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
    });

    const words = (transcription.words || []).map(w => ({
      word: w.word.trim(),
      start: parseFloat(w.start.toFixed(2)),
      end:   parseFloat(w.end.toFixed(2)),
    }));

    const segments = (transcription.segments || []).map(s => ({
      start: parseFloat(s.start.toFixed(2)),
      end:   parseFloat(s.end.toFixed(2)),
      text:  s.text.trim(),
    }));

    const officialLyricsStr = Array.isArray(fields.lyrics) ? fields.lyrics[0] : (fields.lyrics || "");

    if (officialLyricsStr && officialLyricsStr.trim().length > 0) {
      try {
        // Remove section headers like [Verse 1], [Chorus], [pre-chorus]
        const cleanLines = officialLyricsStr
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.length > 0 && !l.startsWith("[") && !l.startsWith("(") && !l.endsWith("]"));

        const cleanOfficialText = cleanLines.join("\n");

        const alignCompletion = await openai.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Você é um especialista em alinhamento de letras de música para videoclipes.
Sua missão é pegar as LINHAS DA LETRA OFICIAL enviada pelo usuário e alinhar cada linha aos timestamps do áudio.

Regras Críticas e Obrigatórias:
1. Respeite as quebras de linha enviadas na LETRA OFICIAL. JAMAIS junte duas linhas da letra oficial em uma única frase longa (ex: se o usuário enviou "Vai passar essa euforia" e "Vai passar esse verão", CRIE 2 FRASES SEPARADAS!).
2. CADA FRASE no JSON final deve ter no máximo 4 PALAVRAS. Se um verso oficial tiver mais de 4 palavras, divida-o em frases curtas de 3 a 4 palavras.
3. Não altere as palavras, acentos ou pontuações da letra oficial.
4. Para cada frase curta, calcule 'start' (timestamp inicial no áudio) e 'end' (timestamp final no áudio).
5. Retorne estritamente um JSON no formato:
{ "segments": [ { "start": 22.36, "end": 24.80, "text": "Vai passar essa euforia" }, { "start": 24.81, "end": 27.10, "text": "Vai passar esse verão" } ] }`
            },
            {
              role: "user",
              content: `LETRA OFICIAL:\n${cleanOfficialText}\n\nTIMESTAMPS DO ÁUDIO (PALAVRAS E TEMPOS):\n${JSON.stringify(words.length > 0 ? words : segments)}`
            }
          ]
        });

        const alignedContent = JSON.parse(alignCompletion.choices[0].message.content);
        if (alignedContent && Array.isArray(alignedContent.segments) && alignedContent.segments.length > 0) {
          let wIdx = 0;
          const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
          
          const alignedSegs = alignedContent.segments.map(s => {
            const segWords = s.text.split(/\s+/).filter(Boolean);
            if (!segWords.length) return null;
            
            let firstStart = null;
            let lastEnd = null;
            
            for (const wordText of segWords) {
               const cw = norm(wordText);
               if (!cw) continue;
               
               for (let i = wIdx; i < Math.min(words.length, wIdx + 10); i++) {
                 const ww = norm(words[i].word);
                 if (ww === cw || (ww.length >= 3 && (ww.includes(cw) || cw.includes(ww)))) {
                    if (firstStart === null) firstStart = words[i].start;
                    lastEnd = words[i].end;
                    wIdx = i + 1;
                    break;
                 }
               }
            }
            
            // Use exact Whisper timing if found, else fallback to LLM's hallucination
            let finalStart = firstStart !== null ? firstStart : s.start;
            let finalEnd = lastEnd !== null ? lastEnd : s.end;
            
            // Accelerator: show lyrics 150ms earlier for better reading sync
            finalStart = Math.max(0, finalStart - 0.15);
            
            return {
              start: parseFloat(finalStart.toFixed(2)),
              end: parseFloat(finalEnd.toFixed(2)),
              text: s.text.trim(),
            };
          }).filter(Boolean);

          return res.status(200).json({ isAligned: true, words, segments: alignedSegs });
        }
      } catch (alignErr) {
        console.warn("Groq LLM lyrics alignment fallback:", alignErr);
      }
    }

    return res.status(200).json({ isAligned: false, words, segments });
  } catch (err) {
    console.error("Transcription error:", err);
    return res.status(500).json({ error: err.message || "Erro interno" });
  }
}
