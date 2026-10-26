import React from "react";
import {interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {ANIMATION_CONFIG as config} from "./AnimationConfig";

const clamp = {extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const};

const getNoteX = (index: number) => index * config.worldStep;
const getNoteY = (index: number) => (index % 2 === 0 ? -config.laneSpacing / 2 : config.laneSpacing / 2);

const getDotPosition = (frame: number) => {
  const step = Math.floor(Math.max(0, frame) / config.beatFrames);
  const progress = (Math.max(0, frame) - step * config.beatFrames) / config.beatFrames;
  const fromX = getNoteX(step);
  const toX = getNoteX(step + 1);
  const fromY = getNoteY(step);
  const toY = getNoteY(step + 1);
  const travel = interpolate(progress, [0, 1], [0, 1], clamp);
  return {
    x: interpolate(travel, [0, 1], [fromX, toX]),
    y: interpolate(travel, [0, 1], [fromY, toY]) - Math.sin(progress * Math.PI) * config.hopHeight,
    step,
    progress,
  };
};

const Trail = ({frame}: {frame: number}) => (
  <>
    {Array.from({length: config.trailLength}, (_, index) => {
      const sampleFrame = Math.max(0, frame - (index + 1) * config.trailSpacingFrames);
      const sample = getDotPosition(sampleFrame);
      const opacity = (1 - index / config.trailLength) * 0.46;
      const size = config.noteRadius * (1.22 - index / config.trailLength * 0.72);
      return (
        <span
          key={index}
          style={{
            position: "absolute",
            left: sample.x,
            top: sample.y,
            width: size * 2,
            height: size * 2,
            borderRadius: "50%",
            transform: "translate(-50%, -50%)",
            background: `radial-gradient(circle, rgba(124,231,242,${opacity}) 0%, rgba(99,201,232,${opacity * 0.4}) 48%, transparent 76%)`,
            filter: `blur(${1 + index * 0.45}px)`,
            pointerEvents: "none",
          }}
        />
      );
    })}
  </>
);

export const MusicDanceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {width, height, fps} = useVideoConfig();
  const position = getDotPosition(frame);
  const hitFrame = position.step * config.beatFrames;
  const hitAge = Math.max(0, frame - hitFrame);
  const bounce = spring({frame: hitAge, fps, config: config.spring});
  const popScale = interpolate(bounce, [0, 1], [0.94, 1.035], clamp);
  const hitGlow = interpolate(hitAge, [0, 5, 14], [0.9, 0.28, 0], clamp);

  // Frame-by-frame damping is deterministic in Remotion and keeps the camera
  // following without depending on browser animation state.
  let cameraX = 0;
  const lastFrame = Math.max(0, Math.floor(frame));
  for (let f = 0; f <= lastFrame; f++) {
    const target = getDotPosition(f).x - width * config.cameraLead;
    cameraX += (target - cameraX) * config.cameraDamping;
  }

  const stageWidth = Math.max(width * 1.8, 2100);
  const stageHeight = Math.max(height * 1.5, 1100);
  const centerY = height * 0.49;
  const notes = Array.from({length: 19}, (_, i) => i - 2).filter((i) => i >= 0);

  return (
    <div style={{
      position: "absolute", inset: 0, overflow: "hidden", background: config.colors.background,
      color: config.colors.text, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      perspective: `${config.perspective}px`, perspectiveOrigin: "50% 44%",
    }}>
      <div style={{position: "absolute", inset: 0, background: "radial-gradient(ellipse at 52% 38%, #142638 0%, #0a111d 54%, #070b12 100%)"}} />
      <div style={{position: "absolute", left: "8%", top: "10%", letterSpacing: "0.22em", fontSize: 12, fontWeight: 500, opacity: 0.78}}>
        A U R A <span style={{marginLeft: 14, opacity: 0.56}}>MOTION STUDY / 01</span>
      </div>
      <div style={{position: "absolute", right: "8%", top: "10%", fontSize: 11, letterSpacing: "0.18em", opacity: 0.58}}>LIVE · 120 BPM</div>

      <div style={{position: "absolute", left: "50%", top: centerY, width: stageWidth, height: stageHeight, transform: `translate(-50%, -50%) rotateX(${config.stageRotateX}deg) rotateZ(${config.stageRotateZ}deg)`, transformStyle: "preserve-3d"}}>
        <div style={{position: "absolute", inset: 0, transform: `translateX(${-cameraX}px)`, transformStyle: "preserve-3d"}}>
          <div style={{position: "absolute", left: -stageWidth, top: "50%", width: stageWidth * 3, height: stageHeight, transform: "translateY(-50%)", backgroundColor: config.colors.floor, backgroundImage: `linear-gradient(${config.colors.grid} 1px, transparent 1px), linear-gradient(90deg, ${config.colors.grid} 1px, transparent 1px), linear-gradient(90deg, transparent 49.9%, rgba(124,231,242,.13) 50%, transparent 50.1%)`, backgroundSize: "72px 72px, 72px 72px, 100% 100%", boxShadow: "0 0 120px rgba(68,168,201,.08) inset"}} />
          {notes.map((index) => {
            const x = getNoteX(index);
            const y = getNoteY(index);
            const active = index === position.step;
            return <div key={index} style={{position: "absolute", left: x, top: y, width: config.noteRadius * 2.4, height: config.noteRadius * 2.4, borderRadius: "50%", transform: "translate(-50%, -50%) translateZ(5px)", border: `1px solid ${active ? "rgba(124,231,242,.78)" : "rgba(152,190,208,.32)"}`, background: active ? "radial-gradient(circle, rgba(190,249,255,.34), rgba(85,179,207,.08) 65%, transparent)" : "rgba(124,170,193,.06)", boxShadow: active ? `0 0 24px rgba(99,201,232,${0.25 + hitGlow * 0.45})` : "0 0 12px rgba(92,159,185,.08)"}} />;
          })}
          <Trail frame={frame} />
          <div style={{position: "absolute", left: position.x, top: position.y, width: config.noteRadius * 2, height: config.noteRadius * 2, borderRadius: "50%", transform: `translate(-50%, -50%) translateZ(17px) scale(${popScale})`, background: `radial-gradient(circle at 35% 30%, ${config.colors.accentBright}, ${config.colors.accent} 42%, #3a9fbd 100%)`, boxShadow: `0 0 ${18 + hitGlow * 24}px rgba(124,231,242,${0.48 + hitGlow * 0.35}), 0 0 64px rgba(65,174,207,.28)`, border: "1px solid rgba(227,255,255,.82)"}} />
        </div>
      </div>
      <div style={{position: "absolute", left: "8%", bottom: "10%", fontSize: 12, letterSpacing: "0.12em", opacity: 0.68}}>SYNCHRONIZED IN LIGHT</div>
      <div style={{position: "absolute", right: "8%", bottom: "10%", width: 112, height: 2, background: "rgba(168,208,222,.22)"}}>
        <div style={{height: "100%", width: `${interpolate((frame % config.beatFrames) / config.beatFrames, [0, 1], [8, 100])}%`, background: config.colors.accent, boxShadow: "0 0 10px rgba(124,231,242,.7)"}} />
      </div>
    </div>
  );
};
