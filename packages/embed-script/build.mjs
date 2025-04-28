import esbuild from 'esbuild';
import { mkdir, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

const entryPoints = {
  'topup-basic': path.join(srcDir, 'topup-basic.ts'),
  'topup-enhanced': path.join(srcDir, 'topup-enhanced.ts'),
  'topup-full': path.join(srcDir, 'topup-full.ts'),
};

async function build() {
  try {
    // Clean the dist directory
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });

    console.log('Building embed scripts...');

    await esbuild.build({
      entryPoints: Object.values(entryPoints),
      entryNames: '[name].min', // Use entry point keys for names
      outdir: distDir,
      bundle: true,
      minify: true,
      sourcemap: false, // No sourcemaps for production embeds
      format: 'iife', // Immediately Invoked Function Expression, suitable for script tags
      target: 'es2017', // Reasonably modern target
      logLevel: 'info',
      // Define environment variables for the build
      define: {
        'import.meta.env.VITE_PUBLIC_INGEST_URL': JSON.stringify(process.env.VITE_PUBLIC_INGEST_URL)
      }
    });

    console.log('Embed scripts built successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();