import type { ThinkingOrbProps } from "thinking-orbs";

/** vitest aliases `thinking-orbs` to this: jsdom has no canvas 2D context, and the tests only need to see what the orb was asked to do. */
export const ThinkingOrb = ({ state, size, theme, paused, ...rest }: ThinkingOrbProps) =>
  <canvas data-orb={state} data-size={size} data-theme={theme} data-paused={paused} {...(rest as object)} />;
