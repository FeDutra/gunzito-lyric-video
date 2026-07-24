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

function normWord(w) {
  if (!w) return "";
  return w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"'`«»…\.,!\?:\;\(\)\[\]\{\}\-–—]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function localSegmenter(words) {
  const PAUSA_FORTE = 0.50;         // ~0.45 a 0.60 segundo
  const PAUSA_INTERMEDIARIA = 0.32;  // ~0.28 a 0.40 segundo
  const MAX_WORDS = 4;              // ~4 ou 5 palavras
  const ANTECIPACAO = 0.12;         // ~100 a 150 ms
  const PEQUENA_CAUDA = 0.18;       // ~100 a 250 ms

  const segmentsList = [];
  let currentSegmentWords = [];
  
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    currentSegmentWords.push(w);
    
    let shouldEnd = false;
    if (i === words.length - 1) {
      shouldEnd = true;
    } else {
      const nextW = words[i + 1];
      const gap = nextW.start - w.end;
      const currentCount = currentSegmentWords.length;
      const remainingCount = words.length - 1 - i;
      
      let isMaxReached = (currentCount >= MAX_WORDS);
      if (isMaxReached && remainingCount === 1 && gap < PAUSA_FORTE) {
        isMaxReached = false;
      }
      
      const isStrongPause = (gap >= PAUSA_FORTE);
      const isIntermediatePause = (gap >= PAUSA_INTERMEDIARIA && currentCount >= 2);
      const hasFinalPunctuation = /[.?!;]/.test(w.word);
      const isPunctuationPause = (hasFinalPunctuation && gap >= 0.15 && currentCount >= 2);
      
      if (isMaxReached || isStrongPause || isIntermediatePause || isPunctuationPause) {
        shouldEnd = true;
      }
    }
    
    if (shouldEnd) {
      const text = currentSegmentWords.map(sw => sw.word).join(" ");
      const firstW = currentSegmentWords[0];
      const lastW = currentSegmentWords[currentSegmentWords.length - 1];
      
      let startVal = Math.max(0, firstW.start - ANTECIPACAO);
      let endVal = lastW.end + PEQUENA_CAUDA;
      
      if (i < words.length - 1) {
        const nextWordStart = words[i + 1].start;
        endVal = Math.min(nextWordStart - 0.05, endVal);
      }
      
      segmentsList.push({
        start: parseFloat(startVal.toFixed(2)),
        end: parseFloat(Math.max(startVal + 0.1, endVal).toFixed(2)),
        text: text
      });
      
      currentSegmentWords = [];
    }
  }
  
  // Post-processing pass to avoid overlaps
  if (segmentsList.length > 1) {
    for (let i = 0; i < segmentsList.length - 1; i++) {
      const cur = segmentsList[i];
      const nxt = segmentsList[i + 1];
      if (cur.end >= nxt.start) {
        cur.end = parseFloat((nxt.start - 0.05).toFixed(2));
      }
      if (cur.end <= cur.start) {
        cur.end = parseFloat((cur.start + 0.1).toFixed(2));
      }
    }
  }
  
  return segmentsList;
}

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

    // Safely process lyrics input
    let lyricsText = "";
    if (fields.lyrics) {
      if (Array.isArray(fields.lyrics)) {
        lyricsText = fields.lyrics[0];
      } else {
        lyricsText = fields.lyrics;
      }
    }
    lyricsText = typeof lyricsText === "string" ? lyricsText.trim() : "";

    // Call Whisper on Groq with word-level timestamps, pt language, temperature zero, and lyrics context
    const whisperParams = {
      file: createReadStream(audioFile.filepath),
      model: "whisper-large-v3",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
      temperature: 0.0,
      language: "pt",
    };
    if (lyricsText) {
      whisperParams.prompt = lyricsText;
    }

    const transcription = await openai.audio.transcriptions.create(whisperParams);

    const words = (transcription.words || []).map(w => ({
      word: w.word.trim(),
      start: parseFloat(w.start.toFixed(2)),
      end:   parseFloat(w.end.toFixed(2)),
    }));

    let finalSegments = [];
    let isAligned = false;

    if (lyricsText && lyricsText.length > 0 && words.length > 0) {
      try {
        const rawTranscript = words.map(w => w.word).join(" ");
        const prompt = `Você é um assistente de inteligência artificial especializado em formatação de legendas musicais.

Aqui está a transcrição de áudio exata (na ordem em que as palavras foram cantadas/ditas):
"${rawTranscript}"

Aqui está a Letra Oficial (referência de quebra de versos e pontuação):
"${lyricsText}"

Sua única tarefa é reorganizar as palavras da transcrição de áudio em versos (linhas de texto), retornando um array JSON contendo as linhas formatadas.

REGRAS CRÍTICAS E OBRIGATÓRIAS:
1. Você deve preservar exatamente as palavras da transcrição do áudio.
2. É PROIBIDO adicionar palavras, omitir palavras, substituir palavras ou alterar a ordem de qualquer palavra da transcrição. O texto resultante deve conter exatamente as mesmas palavras da transcrição bruta, na mesma sequência.
3. Use a Letra Oficial para guiar onde quebrar as linhas e como aplicar a pontuação (maiúsculas, vírgulas, pontos).
4. Cada verso (linha) no array JSON final deve conter no máximo 4 palavras. Se um verso na Letra Oficial for mais longo, você DEVE dividi-lo em mais de uma linha para respeitar o limite máximo de 4 palavras por verso.
5. Retorne APENAS um array JSON de strings, sem qualquer explicação, sem blocos de código Markdown, sem aspas externas e sem texto adicional.

Exemplo de formato de resposta:
["Primeiro verso aqui,", "segundo verso agora,", "terceiro verso."]`;

        const comp = await openai.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        });

        let jsonStr = comp.choices[0].message.content.trim();
        if (jsonStr.startsWith("```")) {
          const match = jsonStr.match(/^(?:```(?:json)?\s*)([\s\S]*?)(?:\s*```)$/);
          if (match) {
            jsonStr = match[1].trim();
          }
        }
        
        const arrayMatch = jsonStr.match(/\[\s*[\s\S]*?\s*\]/);
        if (arrayMatch) {
          jsonStr = arrayMatch[0];
        }

        let formattedLines = null;
        try {
          formattedLines = JSON.parse(jsonStr);
        } catch (e) {
          console.error("Erro ao parsear JSON do LLM:", e);
        }

        // Validate programmatically that words align perfectly
        const whisperNormWords = words.map(w => normWord(w.word)).filter(Boolean);
        const llmNormWords = [];
        if (Array.isArray(formattedLines)) {
          for (const line of formattedLines) {
            if (typeof line === "string") {
              const lineWords = line.split(/\s+/).map(w => normWord(w)).filter(Boolean);
              llmNormWords.push(...lineWords);
            }
          }
        }

        let isValid = true;
        if (!Array.isArray(formattedLines) || formattedLines.length === 0) {
          isValid = false;
        } else if (whisperNormWords.length !== llmNormWords.length) {
          isValid = false;
          console.log(`Validação do LLM falhou: tamanho diferente (${whisperNormWords.length} vs ${llmNormWords.length})`);
        } else {
          for (let idx = 0; idx < whisperNormWords.length; idx++) {
            if (whisperNormWords[idx] !== llmNormWords[idx]) {
              isValid = false;
              console.log(`Validação do LLM falhou no índice ${idx}: whisper="${whisperNormWords[idx]}", llm="${llmNormWords[idx]}"`);
              break;
            }
          }
        }

        if (isValid) {
          const newSegs = [];
          let wordIndex = 0;
          const ANTECIPACAO = 0.12;
          const PEQUENA_CAUDA = 0.18;
          
          for (const line of formattedLines) {
            const lineWordsClean = line.split(/\s+/).filter(Boolean);
            const lineWordCount = lineWordsClean.length;
            if (lineWordCount === 0) continue;
            
            const chunkWords = words.slice(wordIndex, wordIndex + lineWordCount);
            if (chunkWords.length > 0) {
              const startVal = Math.max(0, chunkWords[0].start - ANTECIPACAO);
              const endVal = chunkWords[chunkWords.length - 1].end + PEQUENA_CAUDA;
              
              newSegs.push({
                start: parseFloat(startVal.toFixed(2)),
                end: parseFloat(endVal.toFixed(2)),
                text: line,
              });
              wordIndex += lineWordCount;
            }
          }
          
          if (newSegs.length > 1) {
            for (let i = 0; i < newSegs.length - 1; i++) {
              const currentSeg = newSegs[i];
              const nextSeg = newSegs[i + 1];
              if (currentSeg.end >= nextSeg.start) {
                currentSeg.end = parseFloat((nextSeg.start - 0.05).toFixed(2));
              }
              if (currentSeg.end <= currentSeg.start) {
                currentSeg.end = parseFloat((currentSeg.start + 0.1).toFixed(2));
              }
            }
          }
          
          finalSegments = newSegs;
          isAligned = true;
          console.log("Alinhamento do LLM bem-sucedido e validado.");
        } else {
          console.log("Alinhamento do LLM inválido. Usando segmentador local.");
          finalSegments = localSegmenter(words);
        }
      } catch (err) {
        console.error("Erro no alinhamento do LLM, usando segmentador local:", err);
        finalSegments = localSegmenter(words);
      }
    } else if (words.length > 0) {
      console.log("Usando segmentador local diretamente.");
      finalSegments = localSegmenter(words);
    }

    return res.status(200).json({ isAligned, words, segments: finalSegments });
  } catch (err) {
    console.error("Erro na transcrição:", err);
    return res.status(500).json({ error: err.message || "Erro interno" });
  }
}
