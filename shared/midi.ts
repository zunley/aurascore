export type MidiNote = {
  pitch: number;
  velocity: number;
  startTick: number;
  endTick: number;
  startSeconds: number;
  endSeconds: number;
  channel: number;
};

export type ParsedMidi = {
  ppq: number;
  durationSeconds: number;
  notes: MidiNote[];
};

/** Small Standard MIDI File parser for note events and tempo changes. */
export const parseMidi = (buffer: ArrayBuffer): ParsedMidi => {
  const bytes = new Uint8Array(buffer);
  let cursor = 0;
  const readU16 = () => { const value = (bytes[cursor] << 8) | bytes[cursor + 1]; cursor += 2; return value; };
  const readU32 = () => { const value = bytes[cursor] * 0x1000000 + (bytes[cursor + 1] << 16) + (bytes[cursor + 2] << 8) + bytes[cursor + 3]; cursor += 4; return value; };
  const readVar = (end: number) => {
    let value = 0;
    while (cursor < end) {
      const byte = bytes[cursor++];
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const readAscii = (length: number) => { let value = ""; for (let i = 0; i < length; i++) value += String.fromCharCode(bytes[cursor++]); return value; };

  if (readAscii(4) !== "MThd") throw new Error("input.mid is not a Standard MIDI File");
  const headerLength = readU32();
  readU16();
  const trackCount = readU16();
  const division = readU16();
  cursor += Math.max(0, headerLength - 6);
  if (division & 0x8000) throw new Error("SMPTE time division is not supported; use a PPQ MIDI file");
  const ppq = division;
  const notes: MidiNote[] = [];
  const tempos: Array<{tick: number; micros: number}> = [{tick: 0, micros: 500_000}];
  let maxTick = 0;

  for (let track = 0; track < trackCount; track++) {
    if (readAscii(4) !== "MTrk") throw new Error("Malformed MIDI track header");
    const trackLength = readU32();
    const trackEnd = cursor + trackLength;
    let tick = 0;
    let runningStatus = 0;
    const active = new Map<string, Array<{tick: number; velocity: number}>>();
    while (cursor < trackEnd) {
      tick += readVar(trackEnd);
      if (cursor >= trackEnd) break;
      let status = bytes[cursor];
      if (status & 0x80) { cursor++; runningStatus = status; }
      else status = runningStatus;
      if (status === 0xff) {
        const type = bytes[cursor++];
        const length = readVar(trackEnd);
        if (type === 0x51 && length === 3) {
          tempos.push({tick, micros: (bytes[cursor] << 16) | (bytes[cursor + 1] << 8) | bytes[cursor + 2]});
        }
        cursor += length;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { cursor += readVar(trackEnd); continue; }
      const command = status & 0xf0;
      const channel = status & 0x0f;
      const pitch = bytes[cursor++];
      const velocity = command === 0xc0 || command === 0xd0 ? 0 : bytes[cursor++];
      const key = `${channel}:${pitch}`;
      if (command === 0x90 && velocity > 0) {
        const queue = active.get(key) ?? [];
        queue.push({tick, velocity}); active.set(key, queue);
      } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
        const queue = active.get(key);
        const onset = queue?.shift();
        if (onset) notes.push({pitch, velocity: onset.velocity, startTick: onset.tick, endTick: tick, startSeconds: 0, endSeconds: 0, channel});
      }
    }
    maxTick = Math.max(maxTick, tick);
    cursor = trackEnd;
  }

  tempos.sort((a, b) => a.tick - b.tick);
  const toSeconds = (targetTick: number) => {
    let seconds = 0;
    let lastTick = 0;
    let micros = tempos[0]?.micros ?? 500_000;
    for (const tempo of tempos) {
      if (tempo.tick > targetTick) break;
      seconds += ((tempo.tick - lastTick) / ppq) * (micros / 1_000_000);
      lastTick = tempo.tick;
      micros = tempo.micros;
    }
    return seconds + ((targetTick - lastTick) / ppq) * (micros / 1_000_000);
  };
  for (const note of notes) {
    note.startSeconds = toSeconds(note.startTick);
    note.endSeconds = toSeconds(note.endTick);
  }
  notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  return {ppq, notes, durationSeconds: toSeconds(maxTick)};
};
