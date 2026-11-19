import { Global, css } from "@emotion/react";
import { colors } from "./theme";

export function GlobalStyles() {
  return (
    <Global
      styles={css`
        :root {
          font-family:
            system-ui,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
          color: ${colors.text};
          background: ${colors.canvas};
          color-scheme: dark;
          font-synthesis: none;
        }
        * {
          box-sizing: border-box;
        }
        body {
          min-height: 100vh;
          margin: 0;
          background: ${colors.canvas};
        }
        a {
          color: inherit;
        }
      `}
    />
  );
}
