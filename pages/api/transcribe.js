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


    let finalSegments = segments;
    let isAligned = false;

    if (fields.lyrics && fields.lyrics.trim().length > 0 && words.length > 0) {
      try {
        const rawTranscript = words.map(w => w.word).join(" ");
        const prompt = `Você é um assistente de legendagem musical. 
Aqui está a transcrição bruta do áudio (exatamente as palavras que a IA ouviu, sem pontuação):
"${rawTranscript}"

Aqui está a Letra Oficial (sua referência ESTRUTURAL de pontuação, ritmo e quebras de verso):
"${fields.lyrics.trim()}"

Sua tarefa:
Reescreva a transcrição bruta formatando-a como a Letra Oficial. Retorne um Array JSON de strings (versos).

Regras Absolutas:
1. NÃO INVENTE palavras. A transcrição bruta pode ter "pulado" partes da música (ex: introdução). Se não está na transcrição bruta, NÃO coloque no resultado.
2. Quebre as frases seguindo a estrutura da Letra Oficial.
3. Aplique as vírgulas, maiúsculas e pontuações exatas da Letra Oficial.
4. MÁXIMO ABSOLUTO de 4 palavras por string/verso. Se a frase tiver 5 palavras, quebre em duas strings (ex: 3 e 2).
5. O resultado não pode ter palavras a mais e nem a menos do que a transcrição bruta. Apenas a mesma sequência com pontuação e quebras de linha adicionadas.

Retorne APENAS o JSON puro. Exemplo: ["noite longa, ansiedade", "Respira fundo,", "lembra disso,", "nada dura de verdade."]`;

        const comp = await openai.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        });

        let jsonStr = comp.choices[0].message.content.trim();
        if (jsonStr.startsWith("```json")) jsonStr = jsonStr.replace(/^```json/, "").replace(/```$/, "").trim();
        else if (jsonStr.startsWith("```")) jsonStr = jsonStr.replace(/^```/, "").replace(/```$/, "").trim();

        const formattedLines = JSON.parse(jsonStr);

        if (Array.isArray(formattedLines) && formattedLines.length > 0) {
          // Sequential word mapping: mathematically impossible to jump!
          const newSegs = [];
          let wordIndex = 0;
          
          for (const line of formattedLines) {
            const lineWordCount = line.split(/\\s+/).filter(Boolean).length;
            if (lineWordCount === 0) continue;
            
            // Map the next N words from Whisper
            const chunkWords = words.slice(wordIndex, wordIndex + lineWordCount);
            if (chunkWords.length > 0) {
              newSegs.push({
                start: chunkWords[0].start,
                end: chunkWords[chunkWords.length - 1].end,
                text: line,
              });
              wordIndex += lineWordCount;
            }
          }
          finalSegments = newSegs;
          isAligned = true;
        }
      } catch (err) {
        console.error("LLM alignment failed, falling back to simple Whisper:", err);
      }
    }

    return res.status(200).json({ isAligned, words, segments: finalSegments });
  } catch (err) {
    console.error("Transcription error:", err);
    return res.status(500).json({ error: err.message || "Erro interno" });
  }
}
