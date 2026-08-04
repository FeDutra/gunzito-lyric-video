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

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }

  return prev[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

function isSectionLabel(line) {
  const value = line.trim();
  if (!value) return false;

  if (/^\s*[\[(].{1,40}[\])]\s*$/i.test(value)) return true;

  return /^(intro|verse|verso|chorus|refr[aã]o|pre[-\s]?chorus|pr[eé][ -]?refr[aã]o|bridge|ponte|outro|final)(\s+\d+)?\s*:?[\s]*$/i.test(value);
}

function parseOfficialLines(lyricsText) {
  return lyricsText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !isSectionLabel(line));
}

function localSegmenter(words) {
  const PAUSA_FORTE = 0.50;
  const PAUSA_INTERMEDIARIA = 0.32;
  const MAX_WORDS = 4;
  const ANTECIPACAO = 0.12;
  const PEQUENA_CAUDA = 0.18;

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

      let isMaxReached = currentCount >= MAX_WORDS;
      if (isMaxReached && remainingCount === 1 && gap < PAUSA_FORTE) {
        isMaxReached = false;
      }

      const isStrongPause = gap >= PAUSA_FORTE;
      const isIntermediatePause = gap >= PAUSA_INTERMEDIARIA && currentCount >= 2;
      const hasFinalPunctuation = /[.?!;]/.test(w.word);
      const isPunctuationPause = hasFinalPunctuation && gap >= 0.15 && currentCount >= 2;

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
        text,
      });

      currentSegmentWords = [];
    }
  }

  if (segmentsList.length > 1) {
    for (let i = 0; i < segmentsList.length - 1; i++) {
      const cur = segmentsList[i];
      const nxt = segmentsList[i + 1];
      if (cur.end >= nxt.start) cur.end = parseFloat((nxt.start - 0.05).toFixed(2));
      if (cur.end <= cur.start) cur.end = parseFloat((cur.start + 0.1).toFixed(2));
    }
  }

  return segmentsList;
}

function estimateSyllables(text) {
  const clean = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const matches = clean.match(/[aeiouy]+/g);
  return matches ? matches.length : 1;
}

function calculateLineWeight(text) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const estimatedSyllables = estimateSyllables(text);
  
  const commaCount = (text.match(/,/g) || []).length;
  const periodCount = (text.match(/[.!?]/g) || []).length;
  const semicolonCount = (text.match(/;/g) || []).length;
  
  const punctuationPauseWeight = (commaCount * 0.15) + (periodCount * 0.35) + (semicolonCount * 0.25);
  
  const weight = (estimatedSyllables * 1.0) + (wordCount * 0.35) + punctuationPauseWeight;
  return Math.max(0.5, weight);
}

function matchGroupToSegments(G, S) {
  const gn = G.length;
  const sn = S.length;
  if (gn === 0 || sn === 0) return [];

  const dp = Array.from({ length: gn + 1 }, () => new Float64Array(sn + 1).fill(-10000));
  const choice = Array.from({ length: gn + 1 }, () => new Int32Array(sn + 1).fill(-1));

  for (let j = 0; j <= sn; j++) {
    dp[0][j] = 0;
  }

  for (let i = 1; i <= gn; i++) {
    const lineClean = normWord(G[i - 1].text);
    for (let j = 1; j <= sn; j++) {
      let maxScore = dp[i][j - 1];
      let bestChoice = -1;

      const segClean = normWord(S[j - 1].text);
      const sim = similarity(lineClean, segClean);
      
      const scoreIfMatch = dp[i - 1][j - 1] + sim;
      if (scoreIfMatch > maxScore) {
        maxScore = scoreIfMatch;
        bestChoice = 1;
      }
      dp[i][j] = maxScore;
      choice[i][j] = bestChoice;
    }
  }

  const matches = new Array(gn).fill(null);
  let idxI = gn;
  let idxJ = sn;
  while (idxI > 0 && idxJ > 0) {
    if (choice[idxI][idxJ] === 1) {
      const lineClean = normWord(G[idxI - 1].text);
      const segClean = normWord(S[idxJ - 1].text);
      const sim = similarity(lineClean, segClean);
      if (sim >= 0.35) {
        matches[idxI - 1] = S[idxJ - 1];
      }
      idxI--;
      idxJ--;
    } else {
      idxJ--;
    }
  }

  return matches;
}

function alignLinesToSegments(officialLines, whisperSegments) {
  const n = officialLines.length;
  const m = whisperSegments.length;
  if (!n || !m) return [];

  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const ptr = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  const gapTarget = -0.8;
  const gapSource = -0.5;

  for (let i = 1; i <= n; i++) {
    dp[i][0] = dp[i - 1][0] + gapTarget;
    ptr[i][0] = 2; // UP
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1] + gapSource;
    ptr[0][j] = 3; // LEFT
  }

  for (let i = 1; i <= n; i++) {
    const targetClean = normWord(officialLines[i - 1]);
    for (let j = 1; j <= m; j++) {
      const sourceClean = normWord(whisperSegments[j - 1].text);
      const sim = similarity(targetClean, sourceClean);
      let pairScore = sim >= 0.5 ? sim * 2.0 : -1.5;
      // Tie-breaker penalty to prefer earlier occurrences in the audio for repetitive lyrics
      pairScore -= (j - 1) * 0.006;

      const diag = dp[i - 1][j - 1] + pairScore;
      const up = dp[i - 1][j] + gapTarget;
      const left = dp[i][j - 1] + gapSource;

      if (diag >= up && diag >= left) {
        dp[i][j] = diag;
        ptr[i][j] = 1;
      } else if (up >= left) {
        dp[i][j] = up;
        ptr[i][j] = 2;
      } else {
        dp[i][j] = left;
        ptr[i][j] = 3;
      }
    }
  }

  const lineToSegment = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const direction = ptr[i][j];
    if (direction === 1) {
      const sim = similarity(normWord(officialLines[i - 1]), normWord(whisperSegments[j - 1].text));
      if (sim >= 0.35) {
        lineToSegment[i - 1] = j - 1;
      }
      i--;
      j--;
    } else if (direction === 2) {
      i--;
    } else {
      j--;
    }
  }

  let lastVal = -1;
  for (let k = 0; k < n; k++) {
    if (lineToSegment[k] !== null) {
      if (lineToSegment[k] > lastVal) {
        lastVal = lineToSegment[k];
      } else {
        lineToSegment[k] = null;
      }
    }
  }

  return lineToSegment;
}

function alignLocalWords(targetWords, localWords) {
  const n = targetWords.length;
  const m = localWords.length;
  if (!n || !m) return null;

  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const ptr = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  const gapTarget = -1.5;
  const gapSource = -1.0;

  for (let i = 1; i <= n; i++) {
    dp[i][0] = dp[i - 1][0] + gapTarget;
    ptr[i][0] = 2;
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1] + gapSource;
    ptr[0][j] = 3;
  }

  for (let i = 1; i <= n; i++) {
    const target = normWord(targetWords[i - 1]);
    for (let j = 1; j <= m; j++) {
      const source = normWord(localWords[j - 1].word);
      const sim = similarity(target, source);
      const pairScore = sim >= 0.55 ? sim * 3.0 : -2.0;

      const diag = dp[i - 1][j - 1] + pairScore;
      const up = dp[i - 1][j] + gapTarget;
      const left = dp[i][j - 1] + gapSource;

      if (diag >= up && diag >= left) {
        dp[i][j] = diag;
        ptr[i][j] = 1;
      } else if (up >= left) {
        dp[i][j] = up;
        ptr[i][j] = 2;
      } else {
        dp[i][j] = left;
        ptr[i][j] = 3;
      }
    }
  }

  const targetToSource = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const direction = ptr[i][j];
    if (direction === 1) {
      const sim = similarity(normWord(targetWords[i - 1]), normWord(localWords[j - 1].word));
      if (sim >= 0.35) {
        targetToSource[i - 1] = j - 1;
      }
      i--;
      j--;
    } else if (direction === 2) {
      i--;
    } else {
      j--;
    }
  }

  const matchedIndices = targetToSource.filter(x => x !== null);
  if (matchedIndices.length === 0) return null;

  const firstSourceIdx = Math.min(...matchedIndices);
  const lastSourceIdx = Math.max(...matchedIndices);

  return {
    start: localWords[firstSourceIdx].start,
    end: localWords[lastSourceIdx].end,
    confidence: matchedIndices.length / n,
  };
}

function alignOfficialLyrics(lyricsText, whisperWords, whisperSegments, audioDuration) {
  const officialLines = parseOfficialLines(lyricsText);
  if (!officialLines.length) return null;

  const lineToSegment = alignLinesToSegments(officialLines, whisperSegments);

  const finalSegments = officialLines.map((text, index) => {
    return {
      text,
      index,
      start: null,
      end: null,
      source: null,
      confidence: 0,
    };
  });

  for (let lineIndex = 0; lineIndex < officialLines.length; lineIndex++) {
    const segIdx = lineToSegment[lineIndex];
    if (segIdx === null || segIdx === undefined) continue;

    const matchedSeg = whisperSegments[segIdx];
    const localWords = whisperWords.filter(
      w => w.start >= matchedSeg.start - 0.5 && w.end <= matchedSeg.end + 0.5
    );

    if (localWords.length > 0) {
      const targetWords = officialLines[lineIndex].split(/\s+/).filter(Boolean);
      const alignedTimes = alignLocalWords(targetWords, localWords);
      if (alignedTimes) {
        finalSegments[lineIndex].start = alignedTimes.start;
        finalSegments[lineIndex].end = alignedTimes.end;
        finalSegments[lineIndex].source = "word-alignment";
        finalSegments[lineIndex].confidence = alignedTimes.confidence;
        continue;
      }
    }

    finalSegments[lineIndex].start = matchedSeg.start;
    finalSegments[lineIndex].end = matchedSeg.end;
    finalSegments[lineIndex].source = "whisper-segment";
    finalSegments[lineIndex].confidence = 0.8;
  }

  let i = 0;
  while (i < finalSegments.length) {
    if (finalSegments[i].start !== null) {
      i++;
      continue;
    }

    let startIdx = i;
    while (i < finalSegments.length && finalSegments[i].start === null) {
      i++;
    }
    let endIdx = i - 1;

    let prevAnchor = null;
    let nextAnchor = null;

    for (let k = startIdx - 1; k >= 0; k--) {
      if (finalSegments[k].start !== null) {
        prevAnchor = finalSegments[k];
        break;
      }
    }
    for (let k = endIdx + 1; k < finalSegments.length; k++) {
      if (finalSegments[k].start !== null) {
        nextAnchor = finalSegments[k];
        break;
      }
    }

    const t_prev = prevAnchor ? prevAnchor.end : 0;
    const t_next = nextAnchor ? nextAnchor.start : (audioDuration > 0 ? audioDuration : (whisperWords.length ? whisperWords[whisperWords.length - 1].end : 300));

    let leftBound = t_prev;
    let rightBound = t_next;
    if (rightBound <= leftBound) {
      rightBound = leftBound + 0.2 * (endIdx - startIdx + 2);
    }

    const totalDuration = rightBound - leftBound;
    const subGroup = finalSegments.slice(startIdx, endIdx + 1);
    const totalWeight = subGroup.reduce((sum, line) => sum + calculateLineWeight(line.text), 0);

    let currentCursor = leftBound;
    subGroup.forEach((lineObj, idx) => {
      const w = calculateLineWeight(lineObj.text);
      const rawDur = (w / totalWeight) * totalDuration;

      let lineDur = rawDur;
      let gapAfter = 0;
      if (rawDur > 1.2) {
        gapAfter = Math.min(1.5, rawDur * 0.15);
        lineDur = rawDur - gapAfter;
      }

      const start = currentCursor + (idx === 0 ? 0.05 : 0.02);
      let end = start + lineDur;
      if (end > rightBound - 0.05) {
        end = rightBound - 0.05;
      }
      if (end <= start) {
        end = start + 0.1;
      }

      lineObj.start = parseFloat(start.toFixed(2));
      lineObj.end = parseFloat(end.toFixed(2));
      lineObj.source = "interpolated-between-anchors";
      lineObj.confidence = 0.50;

      currentCursor = end + gapAfter;
    });
  }

  if (finalSegments.length > 0) {
    for (let k = 0; k < finalSegments.length; k++) {
      const cur = finalSegments[k];
      if (cur.end <= cur.start) {
        cur.end = parseFloat((cur.start + 0.1).toFixed(2));
      }
      if (audioDuration > 0 && cur.end > audioDuration) {
        cur.end = audioDuration;
        if (cur.start >= cur.end) {
          cur.start = parseFloat(Math.max(0, cur.end - 0.5).toFixed(2));
        }
      }
    }

    for (let k = 0; k < finalSegments.length - 1; k++) {
      const cur = finalSegments[k];
      const nxt = finalSegments[k + 1];
      if (cur.end >= nxt.start) {
        cur.end = parseFloat((nxt.start - 0.05).toFixed(2));
        if (cur.end <= cur.start) {
          cur.end = parseFloat((cur.start + 0.1).toFixed(2));
        }
      }
    }
  }

  return {
    segments: finalSegments,
    confidence: parseFloat((lineToSegment.filter(x => x !== null).length / officialLines.length).toFixed(3))
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const form = new IncomingForm({ keepExtensions: true, maxFileSize: 50 * 1024 * 1024 });
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, parsedFields, parsedFiles) => {
        if (err) reject(err);
        else resolve([parsedFields, parsedFiles]);
      });
    });

    const fileField = files.audio || files.file;
    const audioFile = Array.isArray(fileField) ? fileField[0] : fileField;
    if (!audioFile) return res.status(400).json({ error: "Nenhum arquivo enviado" });

    if (audioFile.size > 25 * 1024 * 1024) {
      return res.status(400).json({ error: "O arquivo excede o limite de 25MB da IA (Groq). Por favor, converta seu áudio para .mp3 antes de enviar." });
    }

    const rawLyrics = Array.isArray(fields.lyrics) ? fields.lyrics[0] : fields.lyrics;
    const lyricsText = typeof rawLyrics === "string" ? rawLyrics.trim() : "";

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(audioFile.filepath),
      model: "whisper-large-v3",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
      temperature: 0.0,
      language: "pt",
    }, { timeout: 45000 }); // 45 seconds timeout for Groq API

    const audioDuration = Number(transcription.duration || 0);

    const words = (transcription.words || [])
      .map(word => ({
        word: String(word.word || "").trim(),
        start: Number(word.start),
        end: Number(word.end),
      }))
      .filter(word => word.word && Number.isFinite(word.start) && Number.isFinite(word.end))
      .map(word => ({
        ...word,
        start: parseFloat(word.start.toFixed(2)),
        end: parseFloat(word.end.toFixed(2)),
      }));

    const whisperSegments = (transcription.segments || [])
      .map(seg => ({
        text: String(seg.text || "").trim(),
        start: Number(seg.start),
        end: Number(seg.end),
      }))
      .filter(seg => seg.text && Number.isFinite(seg.start) && Number.isFinite(seg.end));

    if (!words.length) {
      return res.status(422).json({ error: "O Whisper não retornou timestamps por palavra." });
    }

    if (lyricsText) {
      const alignment = alignOfficialLyrics(lyricsText, words, whisperSegments, audioDuration);
      if (alignment?.segments?.length) {
        console.log("Alinhamento híbrido determinístico concluído:", alignment.segments.length, "segmentos");
        
        console.table(
          alignment.segments.map((segment, index) => ({
            index,
            text: segment.text,
            start: segment.start,
            end: segment.end,
            duration: parseFloat((segment.end - segment.start).toFixed(2)),
            source: segment.source,
            confidence: segment.confidence
          }))
        );

        return res.status(200).json({
          isAligned: true,
          alignmentMethod: "deterministic-hybrid-sequence-alignment",
          alignmentConfidence: alignment.confidence,
          words,
          segments: alignment.segments,
        });
      }

      console.warn("Não foi possível alinhar a letra oficial; usando segmentação do áudio.");
    }

    return res.status(200).json({
      isAligned: false,
      alignmentMethod: "audio-only-local-segmentation",
      words,
      segments: localSegmenter(words),
    });
  } catch (err) {
    console.error("Erro na transcrição:", err);
    return res.status(500).json({ error: err.message || "Erro interno" });
  }
}
