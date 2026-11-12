import type { ComponentType } from "react";
import type { Scene } from "skills-core";

export type Reply = { status: number; text: string };

export type ViewProps = {
  scene: Scene;
  params: readonly string[];
  link: (path: string) => string;
  read: (path: string) => Promise<Reply>;
};

export type View = {
  name: string;
  path: `/${string}`;
  empty: string;
  detail?: true;
  Component?: ComponentType<ViewProps>;
};
