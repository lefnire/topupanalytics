import { resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ConfigEnv } from "vite"; // Import ConfigEnv
import { viteStaticCopy } from "vite-plugin-static-copy";
import tsconfigPaths from "vite-tsconfig-paths";

// Export a function to access command
export default defineConfig(({ command }: ConfigEnv) => {
  const plugins = [tailwindcss(), reactRouter(), tsconfigPaths()];

  // Conditionally add the static copy plugin only for build
  if (command === "build") {
    plugins.push(
      viteStaticCopy({
        targets: [
          {
            src: "dist-embed/*.min.js", // Source from the temporary build directory
            dest: ".", // Destination is the root of the final 'dist' directory
          },
        ],
      }),
    );
  }

  return {
    plugins,
    build: {
      // Ensure output is minified (Vite default is 'esbuild' which is fast)
      minify: true,
      // The default outDir 'dist' is fine.
      // The static copy plugin handles moving the embed scripts.
    },
  };
});
