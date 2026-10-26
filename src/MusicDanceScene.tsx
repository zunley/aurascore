import React, {useEffect, useState} from "react";
import {Audio, cancelRender, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {ANIMATION_CONFIG as config} from "./AnimationConfig";
import {MidiNote, ParsedMidi, parseMidi} from "./midi";

const clamp = {extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const};
const FIRST_NOTE_X = 470;
const BASS_STAFF_TOP = 292;
const TREBLE_STAFF_TOP = 104;
const NATURAL_PITCHES = [0, 2, 4, 5, 7, 9, 11];

const pitchY = (pitch: number, treble: boolean) => {
  const octave = Math.floor(pitch / 12) - 1;
  const pitchClass = pitch % 12;
  let naturalIndex = NATURAL_PITCHES.reduce((best, item, index) =>
    Math.abs(item - pitchClass) < Math.abs(NATURAL_PITCHES[best] - pitchClass) ? index : best, 0);
  // Sharps and flats sit on the same staff position as their natural neighbor.
  if (pitchClass === 1) naturalIndex = 0;
  if (pitchClass === 3) naturalIndex = 1;
  if (pitchClass === 6) naturalIndex = 3;
  if (pitchClass === 8) naturalIndex = 4;
  if (pitchClass === 10) naturalIndex = 5;
  const diatonic = octave * 7 + naturalIndex;
  const base = treble ? 4 * 7 + 2 : 2 * 7 + 4; // E4 and G2, the bottom staff lines.
  const bottom = (treble ? TREBLE_STAFF_TOP : BASS_STAFF_TOP) + config.staffLineGap * 4;
  return bottom - (diatonic - base) * config.noteSpacing;
};

const noteX = (note: MidiNote, midi: ParsedMidi) => FIRST_NOTE_X + (note.startTick / midi.ppq) * config.worldStep;
const pitchLabel = (pitch: number) => `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const findCurrentIndex = (notes: MidiNote[], seconds: number) => {
  let index = 0;
  while (index < notes.length - 1 && notes[index + 1].startSeconds <= seconds) index++;
  return index;
};

type CursorPose = {index: number; x: number; y: number; z: number; progress: number; current: MidiNote};

const getCursorPosition = (notes: MidiNote[], midi: ParsedMidi, seconds: number): CursorPose => {
  const index = findCurrentIndex(notes, seconds);
  const current = notes[index] ?? notes[0];
  const next = notes[Math.min(index + 1, notes.length - 1)] ?? current;
  const progress = index === notes.length - 1
    ? 0
    : interpolate(seconds, [current.startSeconds, Math.max(current.startSeconds + 0.001, next.startSeconds)], [0, 1], clamp);
  const currentTreble = current.pitch >= config.registerSplitPitch;
  const nextTreble = next.pitch >= config.registerSplitPitch;
  const flightSeconds = Math.max(1 / 240, next.startSeconds - current.startSeconds);
  const pitchDistance = Math.abs(next.pitch - current.pitch);
  const jumpHeight = Math.min(config.maximumJumpHeight, config.hopHeight + pitchDistance * config.jumpHeightPerSemitone);
  // z(t) = 1/2*g*t*(T-t), with g chosen to reach the pitch-dependent apex.
  // This yields a true constant-gravity parabola and returns to the score plane at both ends.
  const gravity = (8 * jumpHeight) / (flightSeconds * flightSeconds);
  const elapsed = progress * flightSeconds;
  return {
    index,
    progress,
    x: interpolate(progress, [0, 1], [noteX(current, midi), noteX(next, midi)]),
    y: interpolate(progress, [0, 1], [pitchY(current.pitch, currentTreble), pitchY(next.pitch, nextTreble)]),
    z: Math.max(0, 0.5 * gravity * elapsed * (flightSeconds - elapsed)),
    current,
  };
};

const LightCursor: React.FC<{x: number; y: number; z: number; squashX: number; squashY: number; glow: number; color: string}> = ({x, y, z, squashX, squashY, glow, color}) => (
  <>
    <span style={{position: "absolute", left: x, top: y, width: config.cursorRadius * 2.2, height: config.cursorRadius * 0.7, borderRadius: "50%", transform: `translate(-50%, -50%) scale(${1 + z * 0.008}, ${1 + z * 0.004})`, background: `radial-gradient(ellipse, rgba(31,42,52,${0.2 - Math.min(0.12, z * 0.0008)}), transparent 72%)`, filter: "blur(2px)", zIndex: 3, pointerEvents: "none"}} />
    <span style={{position: "absolute", left: x, top: y, width: 28, height: 28, borderRadius: "50%", transform: `translate(-50%, -50%) translateZ(1px) scale(${interpolate(glow, [0, 1], [0.65, 1.65], clamp)})`, opacity: interpolate(glow, [0, 1], [0, 0.68], clamp), border: `1px solid ${color}`, boxShadow: `0 0 12px ${color}`, zIndex: 5, pointerEvents: "none"}} />
    <span style={{position: "absolute", left: x, top: y, width: config.cursorRadius * 2, height: config.cursorRadius * 2, borderRadius: "50%", transform: `translate(-50%, -50%) translateZ(${z}px) scale(${squashX}, ${squashY})`, background: `radial-gradient(circle at 38% 32%, #ffffff 0%, #f9fdff 45%, ${color} 100%)`, boxShadow: `0 0 ${13 + glow * 18}px ${color}, 0 0 ${30 + glow * 34}px ${color}88`, border: "1px solid rgba(255,255,255,.98)", zIndex: 8, pointerEvents: "none"}} />
  </>
);

const VoiceCursor: React.FC<{notes: MidiNote[]; midi: ParsedMidi; frame: number; fps: number; color: string; trailLength: number}> = ({notes, midi, frame, fps, color, trailLength}) => {
  if (notes.length === 0) return null;
  const pose = getCursorPosition(notes, midi, frame / fps);
  const age = Math.max(0, frame - pose.current.startSeconds * fps);
  const pulse = spring({frame: age, fps, config: config.spring});
  const impactSpring = spring({frame: age, fps, config: config.impactSpring});
  const impact = Math.max(0, 1 - impactSpring);
  const glow = interpolate(age, [0, 4, 16], [1, 0.35, 0], clamp);
  const squashX = interpolate(pulse, [0, 1], [0.88, 1]) * (1 + impact * config.landingCompressionX);
  const squashY = interpolate(pulse, [0, 1], [1.16, 1]) * (1 - impact * config.landingCompressionY);

  return <>
    {Array.from({length: trailLength}, (_, i) => {
      const sampleFrame = Math.max(0, frame - (i + 1) * config.trailSpacingFrames);
      const historical = getCursorPosition(notes, midi, sampleFrame / fps);
      const opacity = (1 - (i + 1) / (trailLength + 1)) * 0.7;
      const size = config.cursorRadius * 2 * (1 - (i + 1) / (trailLength + 2) * 0.62);
      return <span key={`${color}-trail-${i}`} style={{position: "absolute", left: historical.x, top: historical.y, width: size, height: size, borderRadius: "50%", transform: `translate(-50%, -50%) translateZ(${historical.z}px)`, background: `radial-gradient(circle, rgba(255,255,255,${opacity * 0.6}) 0%, ${color}${Math.round(opacity * 255).toString(16).padStart(2, "0")} 40%, transparent 78%)`, boxShadow: `0 0 ${5 + (1 - i / trailLength) * 8}px ${color}${Math.round(opacity * 170).toString(16).padStart(2, "0")}`, filter: `blur(${i * 0.22}px)`, pointerEvents: "none", zIndex: 6 - i * 0.1}} />;
    })}
    <span style={{position: "absolute", left: pose.x, top: pose.y, width: 34, height: 34, borderRadius: "50%", transform: `translate(-50%, -50%) translateZ(2px) scale(${interpolate(age, [0, 18], [0.28, 2.7], clamp)})`, opacity: interpolate(age, [0, 2, 16], [0.75, 0.46, 0], clamp), border: `1px solid ${color}`, boxShadow: `0 0 12px ${color}`, zIndex: 5, pointerEvents: "none"}} />
    <LightCursor x={pose.x} y={pose.y} z={pose.z} squashX={squashX} squashY={squashY} glow={glow} color={color} />
  </>;
};

const loadMidi = async (): Promise<ParsedMidi> => {
  const response = await fetch(staticFile("input.mid"));
  if (!response.ok) throw new Error(`Could not load public/input.mid (${response.status})`);
  return parseMidi(await response.arrayBuffer());
};

/** Optional public/metadata.json; a missing or invalid file just falls back to a placeholder title. */
const loadMetadata = async (): Promise<{title?: string} | null> => {
  try {
    const response = await fetch(staticFile("metadata.json"));
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (typeof data === "object" && data !== null && "title" in data && typeof (data as {title: unknown}).title === "string") {
      return data as {title: string};
    }
    return {};
  } catch {
    return null;
  }
};

const MidiScore: React.FC<{midi: ParsedMidi; title: string}> = ({midi, title}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const seconds = frame / fps;
  const trebleNotes = midi.notes.filter((note) => note.pitch >= config.registerSplitPitch);
  const bassNotes = midi.notes.filter((note) => note.pitch < config.registerSplitPitch);
  const treblePose = trebleNotes.length > 0 ? getCursorPosition(trebleNotes, midi, seconds) : null;
  const bassPose = bassNotes.length > 0 ? getCursorPosition(bassNotes, midi, seconds) : null;
  const activeNotes = [treblePose?.current, bassPose?.current].filter((note): note is MidiNote => Boolean(note));
  const focusNotes = trebleNotes.length > 0 ? trebleNotes : bassNotes;
  // Stable frame-based damping keeps the printed score moving smoothly in renders.
  let cameraX = 0;
    let noteIndex = 0;
  for (let f = 0; f <= Math.floor(frame); f++) {
    const time = f / fps;
    while (noteIndex < focusNotes.length - 1 && focusNotes[noteIndex + 1].startSeconds <= time) noteIndex++;
    const target = getCursorPosition(focusNotes, midi, time).x - width * config.cameraLead;
    cameraX += (target - cameraX) * config.cameraDamping;
  }
  const scoreWidth = FIRST_NOTE_X + (midi.notes[midi.notes.length - 1]?.startTick ?? 0) / midi.ppq * config.worldStep + width;
  const gridLines = (top: number) => Array.from({length: 5}, (_, i) => top + i * config.staffLineGap);
  const renderStaff = (top: number, label: string, clef: string, clefSize: number) => (
    <>
      {gridLines(top).map((y) => <div key={`${label}-${y}`} style={{position: "absolute", left: 128, top: y, width: scoreWidth, height: 1, background: "rgba(42,54,72,.54)"}} />)}
      <div style={{position: "absolute", left: 74, top: top - 21, color: config.colors.inkSoft, font: "500 10px Georgia, serif", letterSpacing: "0.2em"}}>{label}</div>
      <div style={{position: "absolute", left: 72, top: top + 3, height: 112, color: config.colors.ink, font: `${clefSize}px Georgia, 'Times New Roman', serif`, lineHeight: 1}}>{clef}</div>
    </>
  );

  return (
    <div style={{position: "absolute", inset: 0, overflow: "hidden", background: "radial-gradient(ellipse at 50% 48%, #e9e2d2 0%, #d5ccba 100%)", color: config.colors.text, fontFamily: "Georgia, 'Times New Roman', serif", perspective: `${config.perspective}px`, perspectiveOrigin: "50% 48%", transformStyle: "preserve-3d"}}>
      <div style={{position: "absolute", inset: 0, opacity: 0.24, backgroundImage: "repeating-linear-gradient(0deg, rgba(86,72,48,.08) 0px, transparent 1px, transparent 4px), radial-gradient(ellipse, transparent 58%, rgba(76,65,47,.22) 100%)"}} />
      <div style={{position: "absolute", left: "8%", top: "8%", font: "italic 24px Georgia, serif", color: "#39465a"}}>{title}</div>
      <div style={{position: "absolute", right: "8%", top: "9%", font: "10px ui-sans-serif, system-ui", letterSpacing: ".2em", color: "#6e7781"}}>SOURCE  /  INPUT.MID</div>
      <div style={{position: "absolute", left: 0, top: "51%", width: Math.max(scoreWidth, width * 2), height: 570, transform: `translateY(-50%) rotateX(${config.stageRotateX}deg) rotateZ(${config.stageRotateZ}deg)`, transformStyle: "preserve-3d", transformOrigin: "0 50%"}}>
        <div style={{position: "absolute", inset: 0, backgroundColor: config.colors.paper, backgroundImage: "linear-gradient(90deg, rgba(107,80,47,.035), transparent 12%, transparent 88%, rgba(107,80,47,.04)), repeating-linear-gradient(0deg, rgba(108,90,62,.018), rgba(108,90,62,.018) 1px, transparent 1px, transparent 5px)", boxShadow: "0 22px 70px rgba(48,42,31,.24), 0 2px 7px rgba(50,45,34,.18)", border: "1px solid rgba(94,77,52,.16)"}} />
        <div style={{position: "absolute", inset: 0, transform: `translateX(${-cameraX}px)`, transformStyle: "preserve-3d", willChange: "transform"}}>
          {renderStaff(TREBLE_STAFF_TOP, "TREBLE  /  HIGH REGISTER", "𝄞", 82)}
          {renderStaff(BASS_STAFF_TOP, "BASS  /  LOW REGISTER", "𝄢", 70)}
          <div style={{position: "absolute", left: 126, top: 38, font: "italic 30px Georgia, serif", color: config.colors.ink}}>Nocturne in light</div>
          <div style={{position: "absolute", left: 126, top: 75, font: "11px ui-sans-serif, system-ui", color: config.colors.inkSoft, letterSpacing: ".08em"}}>Generated from {midi.notes.length} MIDI notes</div>
          {midi.notes.map((note, index) => {
            const upper = note.pitch >= config.registerSplitPitch;
            const x = noteX(note, midi);
            const y = pitchY(note.pitch, upper);
            const isCurrent = activeNotes.some((activeNote) => activeNote.startTick === note.startTick && activeNote.pitch === note.pitch && activeNote.channel === note.channel);
            const accidental = [1, 3, 6, 8, 10].includes(note.pitch % 12);
            const stemDown = upper ? y < TREBLE_STAFF_TOP + config.staffLineGap * 2 : y < BASS_STAFF_TOP + config.staffLineGap * 2;
            const stemTop = stemDown ? y : y - 45;
            return <React.Fragment key={`${note.channel}-${note.startTick}-${note.pitch}-${index}`}>
              {accidental && <span style={{position: "absolute", left: x - 21, top: y - 12, color: config.colors.ink, font: "18px Georgia, serif"}}>♯</span>}
              <span title={`${pitchLabel(note.pitch)} · ${note.startSeconds.toFixed(2)}s`} style={{position: "absolute", left: x, top: y, width: 19, height: 13, borderRadius: "50%", background: isCurrent ? (upper ? config.colors.cursor : config.colors.bassCursor) : config.colors.ink, transform: "translate(-50%, -50%) rotate(-22deg)", boxShadow: isCurrent ? `0 0 16px ${upper ? config.colors.cursor : config.colors.bassCursor}` : "none", zIndex: isCurrent ? 3 : 1}} />
              <span style={{position: "absolute", left: x + (stemDown ? -8 : 7), top: stemTop, width: 1.4, height: 47, background: isCurrent ? (upper ? config.colors.cursor : config.colors.bassCursor) : "#394559", transform: "translateY(0)", transformOrigin: stemDown ? "top" : "bottom", zIndex: 1}} />
            </React.Fragment>;
          })}
          {midi.notes.map((note, index) => {
            if (index === 0 || note.startTick === midi.notes[index - 1].startTick) return null;
            const beat = Math.round(note.startTick / midi.ppq);
            if (beat % 4 !== 0) return null;
            const x = noteX(note, midi) - config.worldStep * 2;
            return <div key={`bar-${index}`} style={{position: "absolute", left: x, top: TREBLE_STAFF_TOP, height: BASS_STAFF_TOP + config.staffLineGap * 4 - TREBLE_STAFF_TOP, borderLeft: "1px solid rgba(42,54,72,.18)"}} />;
          })}
          <VoiceCursor notes={trebleNotes} midi={midi} frame={frame} fps={fps} color={config.colors.cursor} trailLength={config.trailLength} />
          <VoiceCursor notes={bassNotes} midi={midi} frame={frame} fps={fps} color={config.colors.bassCursor} trailLength={config.trailLength} />
        </div>
      </div>
      <div style={{position: "absolute", left: "8%", bottom: "8%", font: "italic 14px Georgia, serif", color: "#667183"}}>Andante · {midi.durationSeconds.toFixed(1)} sec</div>
      <div style={{position: "absolute", right: "8%", bottom: "8%", font: "10px ui-sans-serif, system-ui", letterSpacing: ".18em", color: "#78818a"}}>HIGH {trebleNotes.length}  ·  LOW {bassNotes.length}  /  {midi.notes.length} NOTES</div>
    </div>
  );
};

export const MusicDanceScene: React.FC = () => {
  const [midi, setMidi] = useState<ParsedMidi | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handle] = useState(() => delayRender("Loading public/input.mid"));

  useEffect(() => {
    Promise.all([loadMidi(), loadMetadata()]).then(([parsed, metadata]) => {
      if (parsed.notes.length === 0) throw new Error("input.mid contains no note events");
      setMidi(parsed);
      setTitle(metadata?.title ?? "Untitled nocturne");
      continueRender(handle);
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      cancelRender(new Error(message));
    });
  }, [handle]);

  if (error) return <div style={{padding: 40, color: "#5d3030", background: "#f4eedf", fontFamily: "Georgia, serif"}}>Unable to read public/input.mid: {error}</div>;
  if (!midi) return null;
  return <><Audio src={staticFile("input.mp3")} /><MidiScore midi={midi} title={title ?? "Untitled nocturne"} /></>;
};
