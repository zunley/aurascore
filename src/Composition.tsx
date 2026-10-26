import { CalculateMetadataFunction, Composition, staticFile } from "remotion";
import { ANIMATION_CONFIG } from "./AnimationConfig";
import { MusicDanceScene } from "./MusicDanceScene";
import { parseMidi } from "./midi";

type Props = {};

const FPS = 30;

// The composition is exactly as long as the MIDI (plus a short tail for the
// final notes to ring out), so the rendered audio never gets cut off.
const calculateMetadata: CalculateMetadataFunction<Props> = async () => {
  const response = await fetch(staticFile("input.mid"));
  if (!response.ok) throw new Error(`Could not load public/input.mid (${response.status})`);
  const midi = parseMidi(await response.arrayBuffer());
  return { durationInFrames: Math.ceil((midi.durationSeconds + ANIMATION_CONFIG.audioTailSeconds) * FPS) };
};

export const MyComposition = () => {
  return (
    <Composition
      id="MusicDance3D"
      component={MusicDanceScene}
      durationInFrames={30 * 30}
      fps={FPS}
      width={1280}
      height={720}
      calculateMetadata={calculateMetadata}
    />
  );
};

export const MyComponent: React.FC<Props> = () => {
  return <MusicDanceScene />;
};
