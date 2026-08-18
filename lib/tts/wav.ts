/**
 * Minimal RIFF/WAVE reading and joining, in pure TypeScript.
 *
 * Concatenating audio normally means shelling out to ffmpeg, which is another
 * binary to install and another thing to be missing on a fresh machine. For
 * uncompressed PCM the job is small enough to do directly, and doing it here
 * buys something the external tool would not: the exact duration of every
 * segment, computed from its sample count rather than probed. Those durations
 * become the per-turn timestamps the player needs to highlight the current line.
 *
 * Chunks are walked rather than assumed to sit at fixed offsets — macOS `say`
 * emits a JUNK chunk before `fmt `, and a parser that hard-codes offset 12
 * silently misreads it.
 */

export interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export interface ParsedWav {
  format: WavFormat;
  /** Raw PCM payload, excluding headers. */
  data: Buffer;
  durationMs: number;
}

const PCM_FORMAT = 1;

function readChunks(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF file.");
  }
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("RIFF file is not WAVE.");
  }

  const chunks = new Map<string, Buffer>();
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buf.length);
    if (!chunks.has(id)) chunks.set(id, buf.subarray(start, end));
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = start + size + (size % 2);
  }
  return chunks;
}

export function parseWav(buf: Buffer): ParsedWav {
  const chunks = readChunks(buf);
  const fmt = chunks.get("fmt ");
  const data = chunks.get("data");
  if (!fmt) throw new Error("WAVE file has no fmt chunk.");
  if (!data) throw new Error("WAVE file has no data chunk.");
  if (fmt.length < 16) throw new Error("WAVE fmt chunk is truncated.");

  const format: WavFormat = {
    audioFormat: fmt.readUInt16LE(0),
    channels: fmt.readUInt16LE(2),
    sampleRate: fmt.readUInt32LE(4),
    bitsPerSample: fmt.readUInt16LE(14),
  };

  if (format.audioFormat !== PCM_FORMAT) {
    throw new Error(
      `Only uncompressed PCM is supported for joining (got format ${format.audioFormat}).`,
    );
  }

  return { format, data, durationMs: durationMs(format, data.length) };
}

/** Exact duration from byte count — no probing, no estimation. */
export function durationMs(format: WavFormat, dataBytes: number): number {
  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  if (bytesPerFrame <= 0 || format.sampleRate <= 0) return 0;
  return (dataBytes / bytesPerFrame / format.sampleRate) * 1000;
}

export function sameFormat(a: WavFormat, b: WavFormat): boolean {
  return (
    a.channels === b.channels &&
    a.sampleRate === b.sampleRate &&
    a.bitsPerSample === b.bitsPerSample &&
    a.audioFormat === b.audioFormat
  );
}

/** Build a canonical 44-byte-header WAV around a PCM payload. */
export function buildWav(format: WavFormat, data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  const blockAlign = format.channels * (format.bitsPerSample / 8);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(format.audioFormat, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/**
 * Extract the audio between two points on the timeline.
 *
 * Used to verify one turn at a time. Recognizers are markedly more accurate on
 * a short clip than on a long recording, so having exact per-turn boundaries
 * turns transcription from an approximation into a reliable check.
 */
export function sliceWav(buf: Buffer, startMs: number, endMs: number): Buffer {
  const { format, data } = parseWav(buf);
  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  const clamp = (ms: number) =>
    Math.min(
      data.length,
      Math.max(0, Math.floor((ms / 1000) * format.sampleRate) * bytesPerFrame),
    );
  const start = clamp(startMs);
  const end = Math.max(start, clamp(endMs));
  return buildWav(format, data.subarray(start, end));
}

export interface JoinedSegment {
  startMs: number;
  endMs: number;
}

export interface JoinResult {
  wav: Buffer;
  segments: JoinedSegment[];
  totalMs: number;
}

/**
 * Join WAV buffers into one, returning where each landed on the timeline.
 * Mismatched formats are rejected rather than silently producing noise, which
 * is what naively concatenating differing sample rates sounds like.
 */
export function joinWavs(buffers: Buffer[], gapMs = 0): JoinResult {
  if (buffers.length === 0) throw new Error("No audio to join.");

  const parsed = buffers.map(parseWav);
  const format = parsed[0]!.format;
  for (let i = 1; i < parsed.length; i++) {
    if (!sameFormat(format, parsed[i]!.format)) {
      throw new Error(
        `Segment ${i} has a different audio format (${parsed[i]!.format.sampleRate}Hz/${parsed[i]!.format.channels}ch) than the first (${format.sampleRate}Hz/${format.channels}ch).`,
      );
    }
  }

  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  const gapBytes =
    gapMs > 0 ? Math.round((gapMs / 1000) * format.sampleRate) * bytesPerFrame : 0;
  const silence = gapBytes > 0 ? Buffer.alloc(gapBytes) : undefined;

  const pieces: Buffer[] = [];
  const segments: JoinedSegment[] = [];
  let cursorMs = 0;

  parsed.forEach((p, i) => {
    if (i > 0 && silence) {
      pieces.push(silence);
      cursorMs += durationMs(format, gapBytes);
    }
    const startMs = cursorMs;
    pieces.push(p.data);
    cursorMs += p.durationMs;
    segments.push({ startMs, endMs: cursorMs });
  });

  const data = Buffer.concat(pieces);
  return { wav: buildWav(format, data), segments, totalMs: cursorMs };
}
