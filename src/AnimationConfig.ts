/** Central controls for the minimal, cool-toned 3D music-runner scene. */
export const ANIMATION_CONFIG = {
  perspective: 1000,
  stageRotateX: 58,
  stageRotateZ: -7,
  cameraDamping: 0.12,
  cameraLead: 0.16,
  noteRadius: 15,
  trailLength: 9,
  trailSpacingFrames: 1.5,
  beatFrames: 24,
  worldStep: 142,
  laneSpacing: 112,
  hopHeight: 74,
  spring: {
    damping: 18,
    stiffness: 150,
    mass: 0.7,
  },
  colors: {
    background: "#080d16",
    floor: "#101b2a",
    grid: "rgba(111, 169, 206, 0.11)",
    accent: "#7ce7f2",
    accentBright: "#d4fbff",
    trail: "#63c9e8",
    text: "#adc4d2",
  },
} as const;

export type AnimationConfig = typeof ANIMATION_CONFIG;
