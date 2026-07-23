import { useState, useRef, useEffect, useCallback } from "react";
import Head from "next/head";

// ── Constants ─────────────────────────────────────────────────────────────────
const FORMATS = [
  { id:"9x16", label:"9:16 · Reels/Stories", w:1080, h:1920 },
  { id:"16x9", label:"16:9 · YouTube",        w:1920, h:1080 },
];
const FONTS = [
  { label:"HELVETICA CAPS LOCK", v:"HELVETICA_CAPS" },
  { label:"REGULAR",             v:"HELVETICA_REGULAR" },
];
const ANIMS = [
  { id:"fade",  label:"✨ Fade" },
  { id:"pop",   label:"💥 Pop" },
  { id:"slide", label:"⬆ Slide Up" },
  { id:"none",  label:"— Nenhuma" },
];
const BG_COLORS  = ["#000000", "#eb008b", "#fff200", "#13ff00"];
const TXT_COLORS = ["#ffffff", "#000000"];
const HL_COLORS  = ["#eb008b", "#fff200", "#13ff00"];
const VINYL_COLORS = [
  { id: "rosa",    label: "Rosa",    color: "#eb008b", src: "/vinil-rosa.png" },
  { id: "preto",   label: "Preto",   color: "#000000", src: "/vinil-preto.png" },
  { id: "verde",   label: "Verde",   color: "#13ff00", src: "/vinil-verde.png" },
  { id: "amarelo", label: "Amarelo", color: "#fff200", src: "/vinil-amarelo.png" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const easeOut = t => 1 - Math.pow(1 - Math.min(t, 1), 3);

const STOPWORDS = new Set(["de","do","da","dos","das","a","o","e","é","em","no","na","nos","nas","um","uma","que","se","por","pra","para","com","eu","tu","ele","ela","mas","não","nem","ou","ao","às","isso","esse","essa","este","esta","seu","sua","meu","minha","foi","ser","ter","tem","vai","vou","já","mais","como","quando","onde","quem","qual","tudo","nada","só","até","então","assim","porque","me","te","lhe","nos","vos","se","é","era"]);
function keyWord(text) {
  const words = text.split(/\s+/);
  let best = words[0] || "";
  for (const w of words) {
    const c = w.replace(/[^a-záéíóúãõâêôûàç]/gi,"").toLowerCase();
    if (!STOPWORDS.has(c) && c.length > best.replace(/[^a-z]/gi,"").length) best = w;
  }
  return best;
}

function dominantColor(img) {
  try {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0, 16, 16);
    const d = x.getImageData(0,0,16,16).data;
    let r=0,g=0,b=0,n=0;
    for (let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];n++;}
    return `rgb(${Math.round(r/n*0.35)},${Math.round(g/n*0.35)},${Math.round(b/n*0.35)})`;
  } catch { return "#111"; }
}

function normWord(w) {
  if (!w) return "";
  return w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"'`«»…\.,!\?:\;\(\)\[\]\{\}\-–—]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Universal robust alignment: matches official lyrics lines 1-to-1 to Whisper word timestamps
function alignOfficialLyricsWithWords(officialText, whisperWords) {
  if (!officialText || !officialText.trim()) return null;
  if (!whisperWords || !whisperWords.length) return null;

  // 1. Respect user's exact line breaks (strip section headers like [Verso 1])
  const userLines = officialText
    .split("\n")
    .map(l => l.trim().replace(/^\[.*?\]/g, "").replace(/^\(.*?\)/g, "").trim())
    .filter(Boolean);

  if (!userLines.length) return null;

  // Clean Whisper words array with exact timestamps intact
  const normWhisper = whisperWords
    .map(w => ({ start: w.start, end: w.end, clean: normWord(w.word) }))
    .filter(w => w.clean.length > 0);

  if (!normWhisper.length) return null;

  const result = [];
  let wIdx = 0; // Monotonic pointer: ONLY moves forward through the audio

  for (let li = 0; li < userLines.length; li++) {
    const lineText = userLines[li];
    const lineWords = lineText.split(/\s+/).filter(Boolean);
    const cleanLineWords = lineWords.map(normWord).filter(Boolean);

    if (!cleanLineWords.length) continue;

    let bestStartIdx = -1;
    let bestEndIdx = -1;
    let bestScore = -1;

    // Search window: look ahead in normWhisper starting from current wIdx
    // Search window is dynamically scaled based on line length + safety buffer
    const maxLookahead = Math.min(normWhisper.length, wIdx + cleanLineWords.length + 15);

    for (let i = wIdx; i < maxLookahead; i++) {
      let score = 0;
      let matched = 0;
      for (let j = 0; j < cleanLineWords.length && (i + j) < normWhisper.length; j++) {
        const target = cleanLineWords[j];
        const spoken = normWhisper[i + j].clean;
        if (target === spoken) {
          score += 2;
          matched++;
        } else if (target.length >= 3 && spoken.length >= 3 && (target.includes(spoken) || spoken.includes(target))) {
          score += 1;
          matched++;
        }
      }
      if (score > bestScore && matched > 0) {
        bestScore = score;
        bestStartIdx = i;
        bestEndIdx = Math.min(normWhisper.length - 1, i + cleanLineWords.length - 1);
      }
    }

    if (bestStartIdx !== -1 && bestEndIdx !== -1) {
      const matchStart = normWhisper[bestStartIdx].start;
      const matchEnd = normWhisper[bestEndIdx].end;
      const prevEnd = result.length > 0 ? result[result.length - 1].end : 0;
      const finalStart = Math.max(matchStart, prevEnd + 0.05);

      result.push({
        start: parseFloat(finalStart.toFixed(2)),
        end: parseFloat(Math.max(matchEnd, finalStart + 0.5).toFixed(2)),
        text: lineText,
        key: keyWord(lineText)
      });
      // Move pointer forward to the word AFTER this match
      wIdx = bestEndIdx + 1;
    } else {
      // Fallback if line was skipped/not recognized by Whisper
      const lastEnd = result.length > 0 ? result[result.length - 1].end : (normWhisper[wIdx] ? normWhisper[wIdx].start : 0);
      const fallbackStart = parseFloat((lastEnd + 0.1).toFixed(2));
      const fallbackEnd = parseFloat((fallbackStart + 2.0).toFixed(2));
      result.push({
        start: fallbackStart,
        end: fallbackEnd,
        text: lineText,
        key: keyWord(lineText)
      });
    }
  }

  return result.length > 0 ? result : null;
}

// Split word-level timestamps directly into 4-word chunks for 100% vocal sync
function splitSegmentsFromWords(wordsList) {
  if (!wordsList || wordsList.length === 0) return null;
  const result = [];
  const chunkSize = 4;
  const total = Math.ceil(wordsList.length / chunkSize);

  for (let i = 0; i < total; i++) {
    const chunk = wordsList.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!chunk.length) continue;
    const text = chunk.map(w => w.word).join(" ");
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    result.push({
      start: parseFloat(start.toFixed(2)),
      end: parseFloat(Math.max(end, start + 0.6).toFixed(2)),
      text: text,
      key: keyWord(text),
    });
  }
  return result;
}

function enforceMax4Words(segs, duration) {
  const result = [];
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const origEnd = s.end || s.start + 4;
    const nextOrigStart = segs[si + 1] ? segs[si + 1].start : (duration || origEnd + 4);
    const safeEnd = Math.min(origEnd, nextOrigStart - 0.05);

    const words = s.text.split(/\s+/).filter(Boolean);
    if (words.length > 4) {
      const chunksCount = Math.ceil(words.length / 4);
      const totalDur = Math.max(0.8, safeEnd - s.start);
      const timePerWord = totalDur / words.length;

      for (let i = 0; i < chunksCount; i++) {
        const chunkWords = words.slice(i * 4, (i + 1) * 4);
        if (chunkWords.length === 0) continue;
        const chunkText = chunkWords.join(" ");
        const chunkStart = s.start + i * 4 * timePerWord;
        const chunkEnd = Math.min(safeEnd, chunkStart + chunkWords.length * timePerWord);
        result.push({
          start: parseFloat(chunkStart.toFixed(2)),
          end: parseFloat(chunkEnd.toFixed(2)),
          text: chunkText,
          key: keyWord(chunkText)
        });
      }
    } else {
      result.push({
        ...s,
        end: Math.min(safeEnd, s.end || s.start + words.length * 0.45 + 0.8)
      });
    }
  }
  return result;
}
function splitSegments(segs, duration) {
  const result = [];
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    // The true end of this segment = the original end, capped so it never
    // runs into the NEXT segment's start (preserves silence gaps).
    const origEnd = s.end || s.start + 4;
    const nextOrigStart = segs[si + 1] ? segs[si + 1].start : (duration || origEnd + 4);
    // Cap the end so there is always at least a tiny gap before the next block
    const safeEnd = Math.min(origEnd, nextOrigStart - 0.05);

    const words = s.text.split(/\s+/).filter(Boolean);
    if (words.length > 4) {
      const chunksCount = Math.ceil(words.length / 4);
      const totalDur = safeEnd - s.start;
      const timePerWord = totalDur / words.length;

      for (let i = 0; i < chunksCount; i++) {
        const chunkWords = words.slice(i * 4, (i + 1) * 4);
        if (chunkWords.length === 0) continue;
        const chunkText = chunkWords.join(" ");
        const chunkStart = s.start + i * 4 * timePerWord;
        // Each chunk ends when its words are done (no bleed into next chunk)
        const chunkEnd = Math.min(safeEnd, chunkStart + chunkWords.length * timePerWord);
        result.push({
          start: parseFloat(chunkStart.toFixed(2)),
          end: parseFloat(chunkEnd.toFixed(2)),
          text: chunkText,
          key: keyWord(chunkText)
        });
      }
    } else {
      const wordCount = words.length;
      // Duration capped to the safe end — never bleeds into silence
      const estEnd = Math.min(s.start + wordCount * 0.45 + 0.8, safeEnd);
      result.push({
        ...s,
        end: estEnd
      });
    }
  }
  return result;
}

function drawVinyl(ctx, cx, cy, radius, angle, vinylImg) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  if (vinylImg) {
    // Draw PNG as-is — it already has its own transparent background
    ctx.drawImage(vinylImg, -radius, -radius, radius * 2, radius * 2);
  } else {
    // Disc body placeholder (hot pink)
    ctx.beginPath(); ctx.arc(0,0,radius,0,Math.PI*2);
    ctx.fillStyle = "#eb008b"; ctx.fill();

    // Groves placeholder
    for (let r = radius*0.25; r < radius-2; r += 6) {
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
      ctx.strokeStyle = `rgba(255,255,255,${0.03 + (r/radius)*0.04})`;
      ctx.lineWidth = 1.8; ctx.stroke();
    }
  }

  ctx.restore();
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function App() {
  const [coverImg,   setCoverImg]   = useState(null);
  const [coverURL,   setCoverURL]   = useState(null);
  const [audioFile,  setAudioFile]  = useState(null);
  const [audioURL,   setAudioURL]   = useState(null);
  const [transcribing, setTranscribing] = useState(false);

  const [vinylColor, setVinylColor] = useState("rosa");
  const [vinylImgs, setVinylImgs]   = useState({});
  const [logoImg, setLogoImg]       = useState(null);

  useEffect(() => {
    const loaded = {};
    VINYL_COLORS.forEach(v => {
      const img = new Image();
      img.onload = () => {
        loaded[v.id] = img;
        setVinylImgs(prev => ({ ...prev, [v.id]: img }));
      };
      img.src = v.src;
    });

    const lImg = new Image();
    lImg.onload = () => setLogoImg(lImg);
    lImg.src = "/logo-gunzito.png";
  }, []);
  const [transcribeMsg, setTranscribeMsg] = useState("");
  const [transcribeErr, setTranscribeErr] = useState("");
  const [officialLyrics, setOfficialLyrics] = useState("");
  const [segments,   setSegments]   = useState([]);
  const [editText,   setEditText]   = useState("");

  const [bgColor,  setBgColor]  = useState("#000000");
  const [txtColor, setTxtColor] = useState("#ffffff");
  const [hlColor,  setHlColor]  = useState("#13ff00");
  const [font,     setFont]     = useState("HELVETICA_CAPS");
  const [anim,     setAnim]     = useState("fade");
  const [showLogo, setShowLogo] = useState(true);
  const [autoBg,   setAutoBg]   = useState(false);
  const [fmt,      setFmt]      = useState(FORMATS[0]);
  const [step,     setStep]     = useState(1);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [playing,     setPlaying]     = useState(false);

  const [exporting, setExporting] = useState(false);
  const [transcoding, setTranscoding] = useState(false);
  const [expPct,    setExpPct]    = useState(0);
  const [expURL,    setExpURL]    = useState(null);

  const audioRef      = useRef(null);
  const canvasRef     = useRef(null);
  const rafRef        = useRef(null);
  const vinylAngle    = useRef(0);
  const enterT        = useRef({});
  const lastSeg       = useRef(-1);
  const chunks        = useRef([]);
  const analyserRef   = useRef(null);
  const audioCtxRef   = useRef(null);
  const freqRef       = useRef(null);
  const domColor      = useRef("#111");
  const audioInputRef = useRef(null);
  const coverInputRef = useRef(null);

  const changeBg = (color) => {
    setBgColor(color);
    if (color === "#fff200" || color === "#13ff00") {
      setTxtColor("#000000");
      setHlColor("#eb008b");
    } else if (color === "#eb008b") {
      setTxtColor("#ffffff");
      setHlColor("#fff200");
    } else {
      setTxtColor("#ffffff");
      setHlColor("#13ff00");
    }
  };

  // ── File handlers ─────────────────────────────────────────────────────────
  const onCover = e => {
    const f = e.target.files[0]; if (!f) return;
    const u = URL.createObjectURL(f); setCoverURL(u);
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => {
      setCoverImg(img);
      domColor.current = dominantColor(img);
      if (autoBg) setBgColor(domColor.current);
    };
    img.src = u;
  };

  const onAudio = e => {
    const f = e.target.files[0]; if (!f) return;
    setAudioFile(f); setAudioURL(URL.createObjectURL(f));
  };

  // ── Transcription via /api/transcribe (server-side Whisper, sem CORS) ──────
  const transcribe = async () => {
    if (!audioFile) return;
    setTranscribing(true);
    setTranscribeErr("");
    setTranscribeMsg("📤 Enviando áudio...");
    try {
      const fd = new FormData();
      fd.append("audio", audioFile);
      if (officialLyrics && officialLyrics.trim()) {
        fd.append("lyrics", officialLyrics.trim());
      }
      setTranscribeMsg(officialLyrics.trim() ? "⏳ Transcrevendo áudio e alinhando letra oficial com Groq LLM..." : "⏳ Transcrevendo com Whisper...");
      const r = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Erro " + r.status);

      let segs = null;
      if (officialLyrics && officialLyrics.trim()) {
        segs = alignOfficialLyricsWithWords(officialLyrics.trim(), data.words);
      }
      if (!segs && data.isAligned && data.segments && data.segments.length > 0) {
        segs = enforceMax4Words(data.segments, duration);
      } else if (!segs && data.words && data.words.length > 0) {
        segs = splitSegmentsFromWords(data.words);
      } else if (!segs) {
        const rawSegs = (data.segments || []).map(s => ({
          start: s.start,
          end:   s.end,
          text:  s.text,
          key:   keyWord(s.text),
        }));
        segs = splitSegments(rawSegs, duration);
      }

      // Fix segment ends: extend each verse to cover right up to the next verse's start.
      // This prevents artificial gaps (from short word timestamps) from falsely triggering
      // the musical note emoji mid-song.
      if (segs && segs.length > 1) {
        for (let i = 0; i < segs.length - 1; i++) {
          const gapToNext = segs[i + 1].start - segs[i].end;
          // If the natural gap to the next start is less than 15s, extend end to fill it
          if (gapToNext < 15.0) {
            segs[i].end = segs[i + 1].start - 0.05;
          }
        }
      }

      setSegments(segs);
      setEditText(segs.map(s => `[${s.start.toFixed(2)}] ${s.text}`).join("\n"));
      setTranscribeMsg("✅ " + segs.length + " linhas transcritas com sincronia perfeita!");
      setTimeout(() => setTranscribeMsg(""), 3000);
    } catch(e) {
      setTranscribeMsg("");
      setTranscribeErr("❌ " + e.message);
    }
    setTranscribing(false);
  };

  const applyEdits = () => {
    const lines = editText.split("\n").filter(Boolean);
    const p = lines.map(l => {
      const m = l.match(/^\[(\d+\.?\d*)\]\s*(.*)/);
      return m ? { start:parseFloat(m[1]), text:m[2], key:keyWord(m[2]), end:null }
               : { start:0, text:l, key:keyWord(l), end:null };
    });
    p.sort((a,b) => a.start - b.start);
    for (let i=0;i<p.length;i++) {
      const nextStart = p[i+1] ? p[i+1].start : (duration || p[i].start+4);
      const wordCount = p[i].text.split(/\s+/).filter(Boolean).length;
      // Use a tighter heuristic: 0.38s per word + 0.6s. Cap well before next start
      // so silence gaps are fully respected.
      const durationEst = Math.min(nextStart - p[i].start - 0.05, wordCount * 0.38 + 0.6);
      p[i].end = p[i].start + Math.max(0.3, durationEst);
    }
    const splitP = splitSegments(p, duration);
    setSegments(splitP);
  };

  const curIdx = segments.findIndex(s => currentTime >= s.start && currentTime < s.end);
  useEffect(() => {
    if (curIdx !== lastSeg.current && curIdx >= 0) {
      enterT.current[curIdx] = performance.now();
      lastSeg.current = curIdx;
    }
  }, [curIdx]);

  // ── Web Audio analyser ────────────────────────────────────────────────────
  const setupAnalyser = useCallback(() => {
    if (analyserRef.current || !audioRef.current) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(audioRef.current);
      const an  = ctx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.80;
      src.connect(an); an.connect(ctx.destination);
      audioCtxRef.current = ctx; analyserRef.current = an;
      freqRef.current = new Uint8Array(an.frequencyBinCount);
    } catch(e) { console.warn("analyser:", e); }
  }, []);

  // ── Canvas draw ───────────────────────────────────────────────────────────
  const draw = useCallback((t, now) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const { w, h } = fmt;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const isWide = w > h;

    // ── Background ──────────────────────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0,   bgColor);
    bg.addColorStop(0.6, bgColor);
    bg.addColorStop(1,   "#000");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    // ── Layout: define zones ────────────────────────────────────────────
    // 9x16: art in top ~46%, lyrics below
    // 16x9: art on left ~44%, lyrics right
    // 1x1:  art top 48%, lyrics below
    const artZoneW = isWide ? w * 0.44 : w;
    const artZoneH = isWide ? h        : h * 0.46;
    const artZoneX = 0;
    const artZoneY = 0;

    const lyricZoneX = isWide ? w * 0.46 : w * 0.05;
    const lyricZoneY = isWide ? h * 0.06 : h * 0.47;
    const lyricZoneW = isWide ? w * 0.50 : w * 0.90;
    const lyricZoneH = isWide ? h * 0.88 : h * 0.49;

    // ── Art zone: cover + vinyl ─────────────────────────────────────────
    // Cover square: centered in art zone, slight tilt
    const coverSz  = isWide
      ? Math.min(artZoneW * 0.72, artZoneH * 0.68)
      : Math.min(artZoneW * 0.58, artZoneH * 0.88);
    const coverCX  = isWide ? artZoneW * 0.42 : artZoneW * 0.38;
    const coverCY  = isWide ? artZoneH * 0.50 : artZoneH * 0.50;
    const coverX   = coverCX - coverSz / 2;
    const coverY   = coverCY - coverSz / 2;
    const tilt     = -0.04; // slight CCW tilt in radians

    // Vinyl: positioned behind cover, offset right (+18px larger radius)
    const vR   = coverSz * 0.48 + 18;
    const vCX  = coverCX + coverSz * 0.52;
    const vCY  = coverCY - coverSz * 0.01; // a few pixels higher

    // Draw vinyl (PNG has transparent background — draw directly, no shadow circle)
    const activeVinylImg = vinylImgs[vinylColor] || vinylImgs.rosa;
    drawVinyl(ctx, vCX, vCY, vR, vinylAngle.current, activeVinylImg);

    // Cover shadow
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.80)"; ctx.shadowBlur = 40;
    ctx.shadowOffsetX = 8; ctx.shadowOffsetY = 20;
    ctx.translate(coverCX, coverCY); ctx.rotate(tilt);
    if (coverImg) {
      ctx.drawImage(coverImg, -coverSz/2, -coverSz/2, coverSz, coverSz);
    } else {
      ctx.fillStyle = "#222"; ctx.fillRect(-coverSz/2, -coverSz/2, coverSz, coverSz);
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.font = `bold ${coverSz*0.10}px Impact`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("CAPA AQUI", 0, 0);
    }
    ctx.restore();

    // Cover border (subtle)
    ctx.save();
    ctx.translate(coverCX, coverCY); ctx.rotate(tilt);
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 3;
    ctx.strokeRect(-coverSz/2, -coverSz/2, coverSz, coverSz);
    ctx.restore();

    // ── Real-Time Audio Frequency Waveform Visualizer ────────────────────
    if (analyserRef.current && freqRef.current && playing) {
      analyserRef.current.getByteFrequencyData(freqRef.current);
    }

    const waveY = (isWide
      ? coverCY + coverSz * 0.5 + h * 0.04
      : artZoneH - h * 0.045) + 20;
    const waveH  = isWide ? h * 0.030 : h * 0.026;
    const waveW  = isWide ? artZoneW * 0.84 : w * 0.88;
    const waveX  = isWide ? artZoneW * 0.08 : w * 0.06;
    const bars   = 52;
    const bw     = (waveW / bars) * 0.54;
    const bg2    = (waveW / bars) * 0.46;
    const prog   = duration ? t / duration : 0;
    const curT   = t || 0;

    const hasRealAudio = analyserRef.current && freqRef.current && freqRef.current.some(v => v > 0);

    for (let i = 0; i < bars; i++) {
      let bh = 3;

      if (playing && hasRealAudio) {
        // Logarithmic frequency bin distribution (bass -> mids -> treble)
        const freqLen = freqRef.current.length;
        const normIndex = i / bars;
        const binIndex = Math.min(freqLen - 1, Math.floor(Math.pow(normIndex, 1.4) * (freqLen * 0.70) + 1));
        const rawVal = freqRef.current[binIndex] || 0;
        
        // Boosted audio response curve for punchy beat reaction
        const normalized = rawVal / 255;
        const boosted = Math.pow(normalized, 0.82) * 1.5;
        bh = Math.max(3, boosted * waveH);
      } else if (playing || curT > 0) {
        // Fallback beat-synced wave
        const bass = Math.sin(curT * 14 + i * 0.35) * 0.4 + 0.4;
        const mid  = Math.cos(curT * 20 - i * 0.55) * 0.3 + 0.3;
        const treb = Math.sin(curT * 24 + i * 0.85) * 0.2 + 0.2;
        const combo = (bass + mid + treb) / 3;
        bh = Math.max(3, combo * waveH * 1.4);
      } else {
        // Idle state wave
        bh = Math.max(3, (Math.sin(i * 0.4) * 0.15 + 0.25) * waveH);
      }

      const bx   = waveX + i * (bw + bg2);
      const by   = waveY + waveH / 2 - bh / 2;
      const done = bx <= waveX + waveW * prog;

      ctx.fillStyle = done ? hlColor : "rgba(255,255,255,0.22)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, bw / 2);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
    }

    // ── GUNZITO logo ────────────────────────────────────────────────────
    if (showLogo) {
      if (logoImg) {
        const logoW = isWide ? h * 0.20 : w * 0.35;
        const logoH = logoImg.width ? logoW * (logoImg.height / logoImg.width) : logoW * 0.31;
        const logoX = lyricZoneX + (lyricZoneW - logoW) / 2;
        const logoY = lyricZoneY + 20;
        ctx.save();
        ctx.drawImage(logoImg, logoX, logoY, logoW, logoH);
        ctx.restore();
      } else {
        const lsz = isWide ? h * 0.048 : w * 0.058;
        ctx.save();
        ctx.font = `900 ${lsz}px sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillStyle = "#fff";
        ctx.fillText("GUNZITO", lyricZoneX + lyricZoneW / 2, lyricZoneY + 20);
        ctx.restore();
      }
    }

    // ── Lyrics & Instrumental Note ──────────────────────────────────────
    const logoH  = showLogo ? (isWide ? h*0.072 : h*0.082) : 0;
    const lyrY   = lyricZoneY + logoH;
    const lyrH   = lyricZoneH - logoH;
    const fsize  = isWide ? h * 0.032 : w * 0.049;
    const lh     = fsize * 2.45;
    const centerY = lyrY + lyrH / 2 - 80;

    // Find active verse segment
    let activeIdx = -1;
    if (segments.length > 0) {
      for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i];
        const nextS = segments[i + 1];
        if (t >= s.start) {
          // If the next segment is more than 4.5s away and current time is past s.end + 3.0s,
          // we enter an instrumental solo gap (clear activeIdx so text doesn't freeze on screen)
          if (nextS && nextS.start - s.start > 6.0 && t > s.end + 3.0 && t < nextS.start - 1.5) {
            activeIdx = -1;
          } else {
            activeIdx = i;
          }
          break;
        }
      }
    }

    let gapAlpha = 1.0;
    let showMusicNote = false;
    let noteAlpha = 0;

    if (segments.length > 0) {
      const firstStart = segments[0].start;
      const lastEnd = segments[segments.length - 1].end;

      if (t < firstStart - 1.5) {
        // Intro instrumental: show musical note 🎵
        showMusicNote = true;
        const tt = firstStart - 1.5 - t;
        noteAlpha = t < 1.0 ? t / 1.0 : Math.min(1.0, tt / 1.0);
      } else if (t > lastEnd + 1.0) {
        // Outro instrumental: show musical note 🎵
        showMusicNote = true;
        noteAlpha = Math.min(1.0, (t - (lastEnd + 1.0)) / 1.0);
      } else if (activeIdx < 0) {
        // Show musical note 🎵 during instrumental solos (when activeIdx is cleared)
        let prevIdx = -1;
        for (let i = segments.length - 1; i >= 0; i--) {
          if (t >= segments[i].end) { prevIdx = i; break; }
        }
        if (prevIdx >= 0 && prevIdx + 1 < segments.length) {
          const curSeg = segments[prevIdx];
          const nextSeg = segments[prevIdx + 1];
          const timeInGap = t - curSeg.end;
          const fadeInT = timeInGap - 2.0;
          const fadeOutT = (nextSeg.start - 1.5) - t;
          showMusicNote = true;
          noteAlpha = Math.min(1.0, Math.min(fadeInT / 1.0, fadeOutT / 1.0));
        }
      }
    }

    // Render high-contrast 🎵 musical note icon for instrumental sections
    if (showMusicNote && noteAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, noteAlpha));
      
      const cx = lyricZoneX + lyricZoneW / 2;
      const cy = centerY;
      const r = isWide ? h * 0.045 : w * 0.075;
      const pulse = 1.0 + Math.sin(now * 0.004) * 0.06;

      ctx.beginPath();
      ctx.arc(cx, cy, r * pulse, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fill();
      ctx.strokeStyle = txtColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      const noteSize = r * 1.1 * pulse;
      ctx.font = `bold ${noteSize}px sans-serif`;
      ctx.fillStyle = txtColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 12;
      ctx.fillText("🎵", cx, cy);
      ctx.restore();
    }

    if (activeIdx >= 0 && segments.length > 0) {
      const isCaps   = font === "HELVETICA_CAPS";
      const fontName = "'Helvetica Neue', Helvetica, Arial, sans-serif";

      const drawLine = (segIndex, yPos, alpha) => {
        if (segIndex < 0 || segIndex >= segments.length) return;
        const seg = segments[segIndex];
        const drawText = isCaps ? seg.text.toUpperCase() : seg.text;

        ctx.save();
        ctx.globalAlpha = Math.min(1, Math.max(0, alpha * gapAlpha));
        ctx.font = isCaps ? `900 ${fsize}px ${fontName}` : `500 ${fsize}px ${fontName}`;
        ctx.fillStyle = txtColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 7;
        ctx.shadowOffsetY = 2;
        ctx.fillText(drawText, lyricZoneX + lyricZoneW / 2, yPos);
        ctx.restore();
      };

      // Static 3-line layout: no scroll animation, instant swap, neighbors dimmed to 35%
      drawLine(activeIdx - 1, centerY - lh, 0.35);
      drawLine(activeIdx,     centerY,      1.00);
      drawLine(activeIdx + 1, centerY + lh, 0.35);
    }

  }, [bgColor, txtColor, hlColor, font, anim, showLogo, fmt, coverImg, segments, curIdx, duration, playing, vinylColor, vinylImgs]);

  // ── RAF loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let last = 0;
    const loop = ts => {
      const dt = Math.min((ts - last) / 1000, 0.1); last = ts;
      if (playing) vinylAngle.current += dt * 0.25;
      const t = audioRef.current ? audioRef.current.currentTime : currentTime;
      draw(t, ts);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, draw, currentTime]);

  // ── Audio events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onT = () => setCurrentTime(a.currentTime);
    const onM = () => setDuration(a.duration);
    const onE = () => setPlaying(false);
    a.addEventListener("timeupdate", onT);
    a.addEventListener("loadedmetadata", onM);
    a.addEventListener("ended", onE);
    return () => {
      a.removeEventListener("timeupdate", onT);
      a.removeEventListener("loadedmetadata", onM);
      a.removeEventListener("ended", onE);
    };
  });

  const togglePlay = () => {
    const a = audioRef.current; if (!a) return;
    if (!analyserRef.current) setupAnalyser();
    if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play(); setPlaying(true); }
  };

  // ── Export ────────────────────────────────────────────────────────────────
  const startExport = async () => {
    const canvas = canvasRef.current; if (!canvas) return;
    if (!audioFile) { alert("❌ Selecione um áudio antes de exportar!"); return; }

    setExporting(true); setExpPct(0); setExpURL(null); chunks.current = [];

    // Init analyser so waveform is live during export recording
    if (!analyserRef.current) setupAnalyser();
    if (audioCtxRef.current?.state === "suspended") await audioCtxRef.current.resume();

    // 1. Capture canvas video stream ONLY — original audio muxed in FFmpeg step
    const vs = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";

    const rec = new MediaRecorder(vs, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };

    rec.onstop = async () => {
      setTranscoding(true);
      setExpPct(5);
      try {
        const webmBlob = new Blob(chunks.current, { type: mime });

        const { FFmpeg } = await import("@ffmpeg/ffmpeg");
        const { toBlobURL, fetchFile } = await import("@ffmpeg/util");

        const ffmpeg = new FFmpeg();

        ffmpeg.on("progress", ({ progress }) => {
          setExpPct(Math.round(5 + progress * 90));
        });

        // Load FFmpeg WASM via toBlobURL from CDN (works in both dev and production hosting)
        const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
        });

        // Write canvas video + original audio to FFmpeg virtual FS
        await ffmpeg.writeFile("video.webm", await fetchFile(webmBlob));
        await ffmpeg.writeFile("audio.dat",  await fetchFile(audioFile));

        // Mux: canvas video + original audio → MP4 (H.264 + AAC)
        await ffmpeg.exec([
          "-i", "video.webm",
          "-i", "audio.dat",
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "192k",
          "-shortest",
          "-movflags", "+faststart",
          "output.mp4"
        ]);

        const data = await ffmpeg.readFile("output.mp4");
        const mp4Blob = new Blob([data.buffer], { type: "video/mp4" });
        setExpURL(URL.createObjectURL(mp4Blob));
        setExpPct(100);
      } catch (err) {
        console.error("Transcode error:", err);
        alert("❌ Conversão MP4 falhou.\n" + (err?.message || String(err)));
        setExpURL(URL.createObjectURL(new Blob(chunks.current, { type: mime })));
      } finally {
        setTranscoding(false);
        setExporting(false);
      }
    };

    rec.start(100);

    // Play audio from beginning for the recording
    const a = audioRef.current;
    if (a) { a.currentTime = 0; a.play(); setPlaying(true); }

    const dur = duration || 180;
    const startTs = Date.now();
    const iv = setInterval(() => {
      const elapsed = (Date.now() - startTs) / 1000;
      setExpPct(Math.min(95, Math.round((elapsed / dur) * 95)));
    }, 500);

    setTimeout(() => {
      clearInterval(iv);
      rec.stop();
      if (a) { a.pause(); a.currentTime = 0; }
      setPlaying(false);
    }, (dur + 1.0) * 1000);
  };

  // ── UI ────────────────────────────────────────────────────────────────────
  const P="#FF1493", G="#00FF41", Y="#FFD700";

  const Sw = ({ color, cur, set }) => (
    <div onClick={() => set(color)} style={{
      width:24, height:24, borderRadius:5, background:color, cursor:"pointer", flexShrink:0,
      border: cur===color ? "3px solid #fff" : "3px solid #1a1a1a",
      boxShadow: cur===color ? `0 0 0 2px ${Y}` : "none",
    }}/>
  );

  const Sec = ({ label, children }) => (
    <div style={{ marginBottom:13 }}>
      <div style={{ fontSize:9, letterSpacing:3, color:"#333", marginBottom:5, fontFamily:"Impact" }}>{label}</div>
      {children}
    </div>
  );

  const Btn = ({ onClick, disabled, style={}, children }) => (
    <button onClick={onClick} disabled={disabled} style={{
      padding:"10px 0", borderRadius:999, border:"2px solid #000",
      cursor: disabled ? "not-allowed" : "pointer",
      fontFamily:"Impact", fontWeight:900, fontSize:13, letterSpacing:1,
      opacity: disabled ? 0.4 : 1, transition:"transform 0.08s", ...style,
    }}
    onMouseDown={e => { if (!disabled) e.currentTarget.style.transform="scale(0.96)"; }}
    onMouseUp={e => { e.currentTarget.style.transform="scale(1)"; }}>
      {children}
    </button>
  );

  const StepDot = (n, lbl) => {
    const done=step>n, act=step===n;
    return (
      <div key={n} onClick={() => setStep(n)} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
        <div style={{
          width:22, height:22, borderRadius:"50%",
          background: done?G : act?P : "#1a1a1a",
          color:"#000", fontWeight:900, fontSize:10,
          display:"flex", alignItems:"center", justifyContent:"center",
          fontFamily:"Impact", border: act?"2px solid #fff":"none", flexShrink:0,
        }}>{done?"✓":n}</div>
        <span style={{ fontSize:9, fontFamily:"Impact", letterSpacing:2, color:act?"#fff":"#333" }}>{lbl}</span>
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <Head>
        <title>Gunzito · Lyric Video Generator</title>
        <link rel="preconnect" href="https://fonts.googleapis.com"/>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
        <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Bangers&family=Oswald:wght@700&family=Righteous&family=Permanent+Marker&display=swap" rel="stylesheet"/>
      </Head>
      <div style={{ height:"100vh", display:"flex", flexDirection:"column", background:"#080808", color:"#fff", fontFamily:"Impact", overflow:"hidden" }}>

      {/* Header */}
      <div style={{ background:P, padding:"8px 18px", display:"flex", alignItems:"center", gap:12, borderBottom:"4px solid #000", flexShrink:0 }}>
        <img src="/logo-gunzito.png" alt="GUNZITO" style={{ height:28, width:"auto" }} />
        <span style={{ fontSize:11, color:"rgba(255,255,255,0.65)", fontFamily:"Arial", fontWeight:700, marginLeft:4 }}>Lyric Video Generator</span>
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:9, color:"rgba(255,255,255,0.25)", fontFamily:"monospace" }}>v4</span>
      </div>

      {/* Steps */}
      <div style={{ display:"flex", gap:10, padding:"8px 16px", background:"#0d0d0d", borderBottom:"1px solid #141414", flexShrink:0, overflowX:"auto" }}>
        {StepDot(1,"UPLOAD")}
        <div style={{ height:1, background:"#1a1a1a", alignSelf:"center", flex:1, minWidth:8 }}/>
        {StepDot(2,"ESTILO")}
        <div style={{ height:1, background:"#1a1a1a", alignSelf:"center", flex:1, minWidth:8 }}/>
        {StepDot(3,"PREVIEW")}
        <div style={{ height:1, background:"#1a1a1a", alignSelf:"center", flex:1, minWidth:8 }}/>
        {StepDot(4,"EXPORTAR")}
      </div>

      {/* Body */}
      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* ── Panel ── */}
        <div style={{ width:275, minWidth:240, background:"#0d0d0d", borderRight:"1px solid #141414", padding:14, overflowY:"auto", display:"flex", flexDirection:"column" }}>

          {/* STEP 1 */}
          {step===1 && <>
            <Sec label="CAPA DO ÁLBUM">
              <input ref={coverInputRef} type="file" accept="image/*" style={{display:"none"}} onChange={onCover}/>
              <div onClick={() => coverInputRef.current?.click()} style={{
                border:`2px dashed ${coverURL?"#252525":"#1a1a1a"}`, borderRadius:10,
                padding: coverURL?0:16, textAlign:"center", cursor:"pointer",
                background:"#111", overflow:"hidden",
              }}>
                {coverURL
                  ? <img src={coverURL} style={{ width:"100%", display:"block", borderRadius:8 }}/>
                  : <div style={{color:"#2a2a2a",fontSize:11,lineHeight:2.4}}>📁 Enviar capa<br/><span style={{fontSize:9,color:"#222"}}>JPG · PNG · WEBP</span></div>}
              </div>
              {coverImg && (
                <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", marginTop:7, fontFamily:"Arial", fontSize:10, color:"#444" }}>
                  <input type="checkbox" checked={autoBg} onChange={e=>{ setAutoBg(e.target.checked); if(e.target.checked) setBgColor(domColor.current); }}/>
                  Extrair cor de fundo da capa
                </label>
              )}
            </Sec>

            <Sec label="ÁUDIO">
              <input ref={audioInputRef} type="file" accept=".mp3,.wav,.m4a,.ogg,.aac,.flac,audio/mpeg,audio/wav,audio/mp4,audio/*" style={{display:"none"}} onChange={onAudio}/>
              <div onClick={() => audioInputRef.current?.click()} style={{
                border:`2px dashed ${audioURL?"#1a2e1a":"#1a1a1a"}`, borderRadius:10,
                padding:14, textAlign:"center", cursor:"pointer", background:"#111",
              }}>
                {audioFile
                  ? <div style={{color:G,fontSize:10,fontFamily:"Arial",wordBreak:"break-all"}}>🎵 {audioFile.name}</div>
                  : <div style={{color:"#2a2a2a",fontSize:11,lineHeight:2.4}}>📁 Enviar áudio<br/><span style={{fontSize:9,color:"#222"}}>MP3 · WAV · M4A · OGG</span></div>}
              </div>
            </Sec>

            <Sec label="LETRA OFICIAL (OPCIONAL)">
              <div style={{ fontSize:8, color:"#555", fontFamily:"Arial", marginBottom:4 }}>
                Cole a letra oficial aqui. O Groq alinhará os versos exatos aos tempos do áudio!
              </div>
              <textarea
                value={officialLyrics}
                onChange={e => setOfficialLyrics(e.target.value)}
                placeholder="Cole a letra oficial da música aqui..."
                rows={4}
                style={{ width:"100%", background:"#111", color:"#ccc", border:"1px solid #1a1a1a", borderRadius:8, padding:8, fontSize:10, fontFamily:"Arial", boxSizing:"border-box", resize:"vertical" }}
              />
            </Sec>

            <Btn onClick={transcribe} disabled={!audioFile||transcribing}
              style={{ background:transcribing?"#1a2a1a":(!audioFile?"#1a1a1a":G), color:transcribing?"#555":(!audioFile?"#444":"#000"), width:"100%", marginBottom:8 }}>
              {transcribing ? "⏳ TRANSCREVENDO..." : "🎤 TRANSCREVER ÁUDIO"}
            </Btn>

            {/* Status de transcrição — sempre visível enquanto roda ou com erro */}
            {(transcribing || transcribeMsg || transcribeErr) && (
              <div style={{ marginBottom:10, padding:"10px 12px", borderRadius:10, background:"#111", border:`1px solid ${transcribeErr?"#ff4444":transcribeMsg.startsWith("✅")?"#00FF41":"#1a2a1a"}` }}>
                <div style={{ fontSize:11, color: transcribeErr?"#ff6666": transcribeMsg.startsWith("✅")?G:"#00cc33", fontFamily:"Arial", marginBottom: transcribing?6:0, lineHeight:1.5 }}>
                  {transcribeErr || transcribeMsg}
                </div>
                {transcribing && (
                  <>
                    <div style={{ height:5, background:"#1a1a1a", borderRadius:99, overflow:"hidden" }}>
                      <div style={{ height:"100%", background:G, borderRadius:99, animation:"pulse-bar 2s ease-in-out infinite" }}/>
                    </div>
                    <style>{`@keyframes pulse-bar{0%{width:4%}60%{width:80%}100%{width:94%}}`}</style>
                  </>
                )}
                {transcribeErr && (
                  <button onClick={()=>setTranscribeErr("")} style={{ marginTop:8, fontSize:10, color:"#ff6666", background:"none", border:"1px solid #ff4444", borderRadius:6, padding:"3px 10px", cursor:"pointer", fontFamily:"Arial" }}>
                    Fechar
                  </button>
                )}
              </div>
            )}

            {segments.length > 0 && <>
              <Sec label={`LETRA · ${segments.length} LINHAS`}>
                <div style={{ fontSize:8, color:"#2a2a2a", fontFamily:"Arial", marginBottom:4 }}>
                  Ajuste os timestamps [seg] e clique em Aplicar
                </div>
                <textarea value={editText} onChange={e=>setEditText(e.target.value)} rows={9}
                  style={{ width:"100%", background:"#111", color:"#888", border:"1px solid #1a1a1a", borderRadius:8, padding:9, fontSize:10, fontFamily:"monospace", boxSizing:"border-box", resize:"vertical" }}/>
                <Btn onClick={applyEdits} style={{ background:Y, color:"#000", width:"100%", marginTop:5, fontSize:11 }}>✅ APLICAR EDIÇÕES</Btn>
              </Sec>
            </>}

            <div style={{ flex:1 }}/>
            <Btn onClick={()=>setStep(2)} disabled={segments.length===0}
              style={{ background:P, color:"#fff", width:"100%", fontSize:14, marginTop:6 }}>
              PRÓXIMO →
            </Btn>
          </>}

          {/* STEP 2 */}
          {step===2 && <>
            <Sec label="COR DO VINIL">
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {VINYL_COLORS.map(v => (
                  <div key={v.id} onClick={() => setVinylColor(v.id)} style={{
                    display:"flex", alignItems:"center", gap:6,
                    padding:"5px 12px", borderRadius:999, cursor:"pointer",
                    background: vinylColor===v.id ? v.color : "#111",
                    border: vinylColor===v.id ? "2px solid #fff" : "2px solid #1a1a1a",
                    color: vinylColor===v.id ? (v.id==="amarelo"||v.id==="verde"?"#000":"#fff") : "#666",
                    fontSize:11, fontWeight:700, fontFamily:"Arial",
                  }}>
                    <span style={{
                      width:10, height:10, borderRadius:"50%",
                      background:v.color, border: v.id==="preto"?"1px solid #444":"none"
                    }} />
                    {v.label}
                  </div>
                ))}
              </div>
            </Sec>

            <Sec label="COR DE FUNDO">
              <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:4 }}>
                {BG_COLORS.map(c=><Sw key={c} color={c} cur={bgColor} set={v=>{changeBg(v);setAutoBg(false);}}/>)}
              </div>
            </Sec>
            <Sec label="TEXTO INATIVO">
              <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                {TXT_COLORS.map(c=><Sw key={c} color={c} cur={txtColor} set={setTxtColor}/>)}
              </div>
            </Sec>

            <Sec label="FONTE">
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {FONTS.map(f=>(
                  <div key={f.v} onClick={()=>setFont(f.v)} style={{
                    padding:"6px 11px", borderRadius:7, cursor:"pointer",
                    background:font===f.v?P:"#111", border:font===f.v?"2px solid #000":"2px solid #1a1a1a",
                    fontFamily:f.v, fontSize:15, color:font===f.v?"#fff":"#555",
                  }}>{f.label}</div>
                ))}
              </div>
            </Sec>
            <Sec label="ANIMAÇÃO">
              <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                {ANIMS.map(a=>(
                  <div key={a.id} onClick={()=>setAnim(a.id)} style={{
                    padding:"4px 10px", borderRadius:999, cursor:"pointer",
                    background:anim===a.id?Y:"#111", border:anim===a.id?"2px solid #000":"2px solid #1a1a1a",
                    color:anim===a.id?"#000":"#444", fontSize:10, fontWeight:700, fontFamily:"Arial",
                  }}>{a.label}</div>
                ))}
              </div>
            </Sec>
            <Sec label="FORMATO">
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {FORMATS.map(f=>(
                  <div key={f.id} onClick={()=>setFmt(f)} style={{
                    padding:"6px 11px", borderRadius:7, cursor:"pointer",
                    background:fmt.id===f.id?Y:"#111", border:fmt.id===f.id?"2px solid #000":"2px solid #1a1a1a",
                    color:fmt.id===f.id?"#000":"#444", fontSize:10, fontFamily:"Arial", fontWeight:700,
                  }}>{f.label} <span style={{opacity:0.4}}>· {f.w}×{f.h}</span></div>
                ))}
              </div>
            </Sec>
            <Sec label="OPÇÕES">
              <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", fontFamily:"Arial", fontSize:11, color:"#555" }}>
                <input type="checkbox" checked={showLogo} onChange={e=>setShowLogo(e.target.checked)}/> Logo GUNZITO no vídeo
              </label>
            </Sec>
            <div style={{ display:"flex", gap:7, marginTop:4 }}>
              <Btn onClick={()=>setStep(1)} style={{flex:1,background:"#111",color:"#fff",border:"2px solid #1a1a1a"}}>← VOLTAR</Btn>
              <Btn onClick={()=>setStep(3)} style={{flex:2,background:P,color:"#fff"}}>PREVIEW →</Btn>
            </div>
          </>}

          {/* STEP 3 */}
          {step===3 && <>
            <audio ref={audioRef} src={audioURL||""} style={{display:"none"}}/>
            <div style={{color:"#333",fontSize:9,fontFamily:"Arial",lineHeight:1.7,marginBottom:10}}>
              Preview ao vivo. Clique na barra para seekar.
            </div>
            <Btn onClick={togglePlay} style={{ background:playing?"#1a1a1a":G, color:"#000", width:"100%", fontSize:18, padding:"14px 0" }}>
              {playing?"⏸ PAUSAR":"▶ PLAY"}
            </Btn>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:8, fontSize:9, fontFamily:"monospace", color:"#333" }}>
              <span>{Math.floor(currentTime/60)}:{String(Math.floor(currentTime%60)).padStart(2,"0")}</span>
              <span>{Math.floor(duration/60)}:{String(Math.floor(duration%60)).padStart(2,"0")}</span>
            </div>
            <div style={{ height:6, background:"#111", borderRadius:99, overflow:"hidden", cursor:"pointer", marginTop:4, border:"1px solid #1a1a1a" }}
              onClick={e=>{ const r=e.currentTarget.getBoundingClientRect(); if(audioRef.current) audioRef.current.currentTime=((e.clientX-r.left)/r.width)*duration; }}>
              <div style={{ height:"100%", width:`${duration?(currentTime/duration)*100:0}%`, background:Y, borderRadius:99 }}/>
            </div>
            {curIdx>=0 && (
              <div style={{ marginTop:11, padding:10, borderRadius:9, background:"#111", border:`1px solid ${Y}` }}>
                <div style={{ fontSize:7, color:"#333", fontFamily:"Arial", letterSpacing:2, marginBottom:3 }}>LINHA {curIdx+1}/{segments.length}</div>
                <div style={{ fontSize:13, fontFamily:font, lineHeight:1.35 }}>
                  {segments[curIdx]?.text.split(/(\s+)/).map((w,i)=>(
                    <span key={i} style={{color:w.trim()===segments[curIdx]?.key?hlColor:"#fff"}}>{w}</span>
                  ))}
                </div>
                <div style={{ fontSize:8, color:"#2a2a2a", fontFamily:"monospace", marginTop:3 }}>
                  destaque: <span style={{color:hlColor}}>"{segments[curIdx]?.key}"</span>
                </div>
              </div>
            )}
            <div style={{flex:1}}/>
            <div style={{ display:"flex", gap:7, marginTop:14 }}>
              <Btn onClick={()=>setStep(2)} style={{flex:1,background:"#111",color:"#fff",border:"2px solid #1a1a1a"}}>← ESTILO</Btn>
              <Btn onClick={()=>setStep(4)} style={{flex:2,background:P,color:"#fff"}}>EXPORTAR →</Btn>
            </div>
          </>}

          {/* STEP 4 */}
          {step===4 && <>
            <audio ref={audioRef} src={audioURL||""} style={{display:"none"}}/>
            <div style={{ padding:11, borderRadius:9, background:"#111", border:"1px solid #1a1a1a", fontSize:10, fontFamily:"Arial", color:"#777", lineHeight:1.9, marginBottom:11 }}>
              <div><span style={{color:Y,fontWeight:700}}>Formato:</span> {fmt.label}</div>
              <div><span style={{color:Y,fontWeight:700}}>Resolução:</span> {fmt.w}×{fmt.h}</div>
              <div><span style={{color:Y,fontWeight:700}}>Segmentos:</span> {segments.length}</div>
              <div><span style={{color:Y,fontWeight:700}}>Duração:</span> ~{Math.round(duration)}s</div>
              <div><span style={{color:G,fontWeight:700}}>Áudio:</span> incluído ✓</div>
            </div>
            {!exporting && !expURL && (
              <Btn onClick={startExport} style={{ background:P, color:"#fff", width:"100%", fontSize:15, padding:"14px 0" }}>
                🎬 GRAVAR VÍDEO + ÁUDIO
              </Btn>
            )}
            {exporting && (
              <div>
                <div style={{textAlign:"center",color:G,fontFamily:"Arial",fontSize:11,marginBottom:6}}>
                  {transcoding ? "🎬 Convertendo para MP4..." : `Gravando... ${Math.round(expPct)}%`}
                </div>
                <div style={{height:9,background:"#111",borderRadius:99,overflow:"hidden"}}>
                  <div style={{
                    height:"100%",
                    width:`${expPct}%`,
                    background:G,
                    borderRadius:99,
                    transition: transcoding ? "none" : "width 0.4s"
                  }}/>
                </div>
                <div style={{fontSize:8,color:"#2a2a2a",fontFamily:"Arial",marginTop:5,textAlign:"center"}}>
                  {transcoding ? "Isso pode levar alguns segundos..." : "Não feche a aba durante a gravação"}
                </div>
              </div>
            )}
            {expURL && (
              <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                <div style={{textAlign:"center",color:G,fontSize:16,letterSpacing:2}}>✅ PRONTO!</div>
                <a href={expURL} download={`gunzito-${fmt.id}.mp4`} style={{
                  display:"block", textAlign:"center", padding:"12px 0", borderRadius:999,
                  background:G, color:"#000", fontWeight:900, fontSize:13,
                  textDecoration:"none", border:"2px solid #000", fontFamily:"Impact", letterSpacing:2,
                }}>⬇ BAIXAR .MP4</a>
                <Btn onClick={()=>{setExpURL(null);setExpPct(0);}} style={{background:"#111",color:"#fff",border:"2px solid #1a1a1a",width:"100%",fontSize:11}}>🔄 GRAVAR NOVAMENTE</Btn>
              </div>
            )}
            <div style={{flex:1}}/>
            <Btn onClick={()=>setStep(3)} style={{background:"#111",color:"#fff",border:"2px solid #1a1a1a",width:"100%",marginTop:10,fontSize:11}}>← PREVIEW</Btn>
          </>}
        </div>

        {/* ── Canvas ── */}
        <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", background:"#050505", overflow:"auto", padding:16 }}>
          <div style={{ position:"relative", boxShadow:"0 0 80px rgba(0,0,0,0.9)" }}>
            <canvas ref={canvasRef} style={{
              display:"block",
              maxWidth:"min(100%, 500px)",
              maxHeight:"calc(100vh - 170px)",
              objectFit:"contain",
            }}/>
            <div style={{ position:"absolute", bottom:8, right:8, background:"rgba(0,0,0,0.7)", color:"#fff", fontSize:8, fontFamily:"monospace", padding:"2px 6px", borderRadius:3, pointerEvents:"none" }}>
              {fmt.w}×{fmt.h}
            </div>
          </div>
        </div>

      </div>
    </div>
    </>
  );
}