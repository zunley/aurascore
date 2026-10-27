/** Props shared by the composition and the scene. All assets are fetched
 * from an HTTP endpoint identified by `assetBaseUrl`; there is no public/
 * fallback — local development serves the same endpoints (see README). */
export type SceneProps = {
  /** Base URL for job assets, e.g. http://127.0.0.1:9302/assets/<jobId> */
  assetBaseUrl: string;
  /** Displayed score title. */
  title?: string;
  /** Optional output overrides resolved in calculateMetadata. */
  fps?: number;
  width?: number;
  height?: number;
};

export const assetUrl = (props: SceneProps, name: string): string => `${props.assetBaseUrl}/${name}`;

/** Studio default: points at a "dev" job served by the API server. */
export const DEV_ASSET_BASE_URL = "http://127.0.0.1:9302/assets/dev";
