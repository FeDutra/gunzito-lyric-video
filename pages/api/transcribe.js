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



    return res.status(200).json({ isAligned: false, words, segments });
  } catch (err) {
    console.error("Transcription error:", err);
    return res.status(500).json({ error: err.message || "Erro interno" });
  }
}
