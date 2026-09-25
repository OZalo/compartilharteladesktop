// Script para converter PNG -> ICO com múltiplos tamanhos via sharp + png-to-ico
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '../public/icon.png');
const out = join(__dirname, '../public/icon.ico');

const sizes = [16, 32, 48, 64, 128, 256];

const pngBuffers = await Promise.all(
  sizes.map(size => sharp(src).resize(size, size).png().toBuffer())
);

const icoBuffer = await pngToIco(pngBuffers);
writeFileSync(out, icoBuffer);
console.log('icon.ico criado:', out, '| Tamanho:', icoBuffer.length, 'bytes');
