import { describe, it, expect } from "vitest";
import {
  buildWav,
  durationMs,
  joinWavs,
  parseWav,
  sameFormat,
  type WavFormat,
} from "./wav.js";

const FMT: WavFormat = {
  audioFormat: 1,
  channels: 1,
  sampleRate: 22050,
  bitsPerSample: 16,
};

/** A WAV of exactly `ms` milliseconds of (silent) PCM. */
function wavOf(ms: number, format: WavFormat = FMT): Buffer {
  const frames = Math.round((ms / 1000) * format.sampleRate);
  const bytes = frames * format.channels * (format.bitsPerSample / 8);
  return buildWav(format, Buffer.alloc(bytes));
}

/** Mimic macOS `say`, which writes a JUNK chunk before `fmt `. */
function wavWithJunkChunk(ms: number): Buffer {
  const plain = parseWav(wavOf(ms));
  const junk = Buffer.alloc(8 + 28);
  junk.write("JUNK", 0, "ascii");
  junk.writeUInt32LE(28, 4);

  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(FMT.audioFormat, 8);
  fmt.writeUInt16LE(FMT.channels, 10);
  fmt.writeUInt32LE(FMT.sampleRate, 12);
  fmt.writeUInt32LE(FMT.sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(FMT.bitsPerSample, 22);

  const data = Buffer.alloc(8 + plain.data.length);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(plain.data.length, 4);
  plain.data.copy(data, 8);

  const body = Buffer.concat([junk, fmt, data]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

describe("parseWav", () => {
  it("round-trips a file it built", () => {
    const parsed = parseWav(wavOf(1000));
    expect(parsed.format).toEqual(FMT);
    expect(parsed.durationMs).toBeCloseTo(1000, 0);
  });

  it("walks past a JUNK chunk to find fmt and data", () => {
    // macOS `say` emits exactly this layout; a parser assuming fmt sits at
    // offset 12 reads the JUNK chunk as format and misinterprets everything.
    const parsed = parseWav(wavWithJunkChunk(500));
    expect(parsed.format.sampleRate).toBe(22050);
    expect(parsed.durationMs).toBeCloseTo(500, 0);
  });

  it("rejects a non-RIFF buffer", () => {
    expect(() => parseWav(Buffer.from("not audio at all"))).toThrow(/RIFF/);
  });

  it("rejects compressed audio, which cannot be joined by concatenation", () => {
    const compressed = buildWav({ ...FMT, audioFormat: 85 }, Buffer.alloc(100));
    expect(() => parseWav(compressed)).toThrow(/PCM/);
  });
});

describe("durationMs", () => {
  it("computes duration from the frame count", () => {
    // 22050 frames of 16-bit mono = 44100 bytes = exactly one second.
    expect(durationMs(FMT, 44100)).toBeCloseTo(1000, 6);
  });

  it("accounts for channel count", () => {
    const stereo = { ...FMT, channels: 2 };
    expect(durationMs(stereo, 44100)).toBeCloseTo(500, 6);
  });

  it("returns zero rather than dividing by zero on a degenerate format", () => {
    expect(durationMs({ ...FMT, sampleRate: 0 }, 1000)).toBe(0);
  });
});

describe("joinWavs", () => {
  it("concatenates and reports where each segment lands", () => {
    const r = joinWavs([wavOf(1000), wavOf(500), wavOf(250)]);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.startMs).toBeCloseTo(0, 0);
    expect(r.segments[0]!.endMs).toBeCloseTo(1000, 0);
    expect(r.segments[1]!.startMs).toBeCloseTo(1000, 0);
    expect(r.segments[2]!.endMs).toBeCloseTo(1750, 0);
    expect(r.totalMs).toBeCloseTo(1750, 0);
  });

  it("produces a file that parses back to the summed duration", () => {
    const r = joinWavs([wavOf(300), wavOf(700)]);
    expect(parseWav(r.wav).durationMs).toBeCloseTo(1000, 0);
  });

  it("inserts a gap between segments and reflects it in the timeline", () => {
    const r = joinWavs([wavOf(1000), wavOf(1000)], 200);
    expect(r.segments[1]!.startMs).toBeCloseTo(1200, 0);
    expect(r.totalMs).toBeCloseTo(2200, 0);
  });

  it("does not prepend a gap before the first segment", () => {
    const r = joinWavs([wavOf(1000), wavOf(1000)], 500);
    expect(r.segments[0]!.startMs).toBe(0);
  });

  it("refuses to join mismatched sample rates", () => {
    // Concatenating differing rates produces audio that plays at the wrong
    // speed, which is worse than a clear failure.
    const other = wavOf(1000, { ...FMT, sampleRate: 44100 });
    expect(() => joinWavs([wavOf(1000), other])).toThrow(/different audio format/);
  });

  it("refuses to join mismatched channel counts", () => {
    const stereo = wavOf(1000, { ...FMT, channels: 2 });
    expect(() => joinWavs([wavOf(1000), stereo])).toThrow(/different audio format/);
  });

  it("throws on an empty input rather than emitting a headerless file", () => {
    expect(() => joinWavs([])).toThrow(/No audio/);
  });

  it("handles a single segment", () => {
    const r = joinWavs([wavOf(400)]);
    expect(r.segments).toHaveLength(1);
    expect(r.totalMs).toBeCloseTo(400, 0);
  });
});

describe("sameFormat", () => {
  it("distinguishes formats that cannot be concatenated", () => {
    expect(sameFormat(FMT, { ...FMT })).toBe(true);
    expect(sameFormat(FMT, { ...FMT, sampleRate: 44100 })).toBe(false);
    expect(sameFormat(FMT, { ...FMT, bitsPerSample: 8 })).toBe(false);
  });
});
