import { CalculateMetadataFunction, Composition } from "remotion";
import { MusicDanceScene } from "./MusicDanceScene";

type Props = {};

const calculateMetadata: CalculateMetadataFunction<Props> = () => {
  return {};
};

export const MyComposition = () => {
  return (
    <Composition
      id="MusicDance3D"
      component={MusicDanceScene}
      durationInFrames={30 * 30}
      fps={30}
      width={1280}
      height={720}
      calculateMetadata={calculateMetadata}
    />
  );
};

export const MyComponent: React.FC<Props> = () => {
  return <MusicDanceScene />;
};
