import type { ComponentType } from "react";
import type { Scene } from "skills-core";

export type ViewProps = {
  scene: Scene;
  params: readonly string[];
  link: (path: string) => string;
  blob: (sha256: string) => Promise<string | undefined>;
};

export type View = {
  name: string;
  path: `/${string}`;
  empty: string;
  detail?: true;
  Component?: ComponentType<ViewProps>;
};
