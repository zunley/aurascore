import { CalculateMetadataFunction, Composition } from "remotion";
import { ANIMATION_CONFIG } from "./AnimationConfig";
import { MusicDanceScene } from "./MusicDanceScene";
import { DEV_ASSET_BASE_URL, SceneProps, assetUrl } from "./SceneProps";
import { parseMidi } from "../shared/midi";

const FPS = 30;

// The composition is exactly as long as the MIDI (plus a short tail for the
// final notes to ring out), so the rendered audio never gets cut off. The
// MIDI is fetched from the per-job asset endpoint, so the duration always
// matches the uploaded file.
const calculateMetadata: CalculateMetadataFunction<SceneProps> = async ({ props }) => {
  const response = await fetch(assetUrl(props, "input.mid"));
  if (!response.ok) throw new Error(`Could not load input.mid (${response.status})`);
  const midi = parseMidi(await response.arrayBuffer());
  const fps = props.fps ?? FPS;
  return {
    durationInFrames: Math.ceil((midi.durationSeconds + ANIMATION_CONFIG.audioTailSeconds) * fps),
    fps,
    width: props.width,
    height: props.height,
  };
};

export const MyComposition = () => {
  return (
    <Composition
      id="MusicDance3D"
      component={MusicDanceScene}
      durationInFrames={30 * FPS}
      fps={FPS}
      width={1280}
      height={720}
      calculateMetadata={calculateMetadata}
      defaultProps={{ assetBaseUrl: DEV_ASSET_BASE_URL, title: "Flower Dance" } satisfies SceneProps}
    />
  );
};
