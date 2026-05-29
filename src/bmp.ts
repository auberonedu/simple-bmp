// Indexed BMP (Windows DIB) reading and writing.
//
// Scope: 4bpp and 8bpp uncompressed indexed bitmaps with a BITMAPINFOHEADER
// (40-byte) DIB header. These are the formats relevant to GBA sprite work
// (4bpp = 16-color, 8bpp = 256-color). Other depths/compressions are rejected
// with a clear error rather than silently mangled.
//
// Format notes that drive the code below:
//   - Multi-byte integers are little-endian.
//   - Palette entries are stored B, G, R, reserved (4 bytes each).
//   - Pixel rows are stored bottom-up (last row in file = top row of image)
//     UNLESS height is negative, in which case rows are top-down.
//   - Each row is padded to a 4-byte boundary.
//   - 4bpp packs two pixels per byte; the high nibble is the left pixel.

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

export interface BmpImage {
	width: number;
	height: number;
	/** Bits per pixel as stored: 4 or 8. */
	bpp: 4 | 8;
	/** Palette colors. Length is up to 16 (4bpp) or 256 (8bpp). */
	palette: Rgb[];
	/** Palette indices, row-major, top-to-bottom, length = width * height. */
	pixels: Uint8Array;
}

const FILE_HEADER_SIZE = 14;
const INFO_HEADER_SIZE = 40;

/** Row stride in bytes for a given width/bpp, padded to a 4-byte boundary. */
function rowStride(width: number, bpp: number): number {
	const bits = width * bpp;
	const bytes = Math.ceil(bits / 8);
	return (bytes + 3) & ~3; // round up to multiple of 4
}

/**
 * Parse an indexed BMP from raw bytes. Throws a descriptive Error if the file
 * isn't a supported indexed format.
 */
export function decodeBmp(data: Uint8Array): BmpImage {
	if (data.length < FILE_HEADER_SIZE + INFO_HEADER_SIZE) {
		throw new Error('File is too small to be a valid BMP.');
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	// --- BITMAPFILEHEADER ---
	if (view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x4d) {
		throw new Error('Not a BMP file (missing "BM" signature).');
	}
	const pixelDataOffset = view.getUint32(10, true);

	// --- BITMAPINFOHEADER ---
	const dibSize = view.getUint32(14, true);
	if (dibSize < INFO_HEADER_SIZE) {
		throw new Error(
			`Unsupported DIB header size ${dibSize}. Only BITMAPINFOHEADER ` +
			`(40 bytes) or later is supported.`
		);
	}

	const width = view.getInt32(18, true);
	const rawHeight = view.getInt32(22, true);
	const topDown = rawHeight < 0;
	const height = Math.abs(rawHeight);

	const bppRaw = view.getUint16(28, true);
	if (bppRaw !== 4 && bppRaw !== 8) {
		throw new Error(
			`Only 4bpp and 8bpp indexed BMPs are supported (got ${bppRaw}bpp). ` +
			`Re-export the image as a 16- or 256-color indexed bitmap.`
		);
	}
	const bpp = bppRaw as 4 | 8;

	const compression = view.getUint32(30, true);
	if (compression !== 0) {
		throw new Error(
			`Compressed BMPs are not supported (compression=${compression}). ` +
			`Re-export without RLE compression.`
		);
	}

	// Number of palette entries. 0 means "use the max for this bit depth".
	let paletteCount = view.getUint32(46, true);
	const maxColors = 1 << bpp; // 16 or 256
	if (paletteCount === 0 || paletteCount > maxColors) {
		paletteCount = maxColors;
	}

	// --- Palette (immediately after the DIB header) ---
	const paletteOffset = FILE_HEADER_SIZE + dibSize;
	const palette: Rgb[] = [];
	for (let i = 0; i < paletteCount; i++) {
		const o = paletteOffset + i * 4;
		// Stored as B, G, R, reserved.
		palette.push({
			b: view.getUint8(o),
			g: view.getUint8(o + 1),
			r: view.getUint8(o + 2),
		});
	}

	// --- Pixel data ---
	const stride = rowStride(width, bpp);
	const pixels = new Uint8Array(width * height);

	for (let row = 0; row < height; row++) {
		// File row 0 is the bottom of the image unless top-down.
		const srcRow = topDown ? row : height - 1 - row;
		const rowStart = pixelDataOffset + srcRow * stride;

		for (let x = 0; x < width; x++) {
			let index: number;
			if (bpp === 8) {
				index = view.getUint8(rowStart + x);
			} else {
				// 4bpp: two pixels per byte, high nibble first.
				const byte = view.getUint8(rowStart + (x >> 1));
				index = (x & 1) === 0 ? byte >> 4 : byte & 0x0f;
			}
			pixels[row * width + x] = index;
		}
	}

	return { width, height, bpp, palette, pixels };
}

/**
 * Serialize an indexed image to BMP bytes. The palette is padded out to the
 * full color count for the chosen bit depth so the file is always valid.
 */
export function encodeBmp(image: BmpImage): Uint8Array {
	const { width, height, bpp, pixels } = image;
	const maxColors = 1 << bpp;

	// Pad the palette to the full table size; fill extras with black.
	const palette: Rgb[] = image.palette.slice(0, maxColors);
	while (palette.length < maxColors) {
		palette.push({ r: 0, g: 0, b: 0 });
	}

	const stride = rowStride(width, bpp);
	const paletteSize = maxColors * 4;
	const pixelDataOffset = FILE_HEADER_SIZE + INFO_HEADER_SIZE + paletteSize;
	const pixelDataSize = stride * height;
	const fileSize = pixelDataOffset + pixelDataSize;

	const out = new Uint8Array(fileSize);
	const view = new DataView(out.buffer);

	// --- BITMAPFILEHEADER ---
	view.setUint8(0, 0x42); // 'B'
	view.setUint8(1, 0x4d); // 'M'
	view.setUint32(2, fileSize, true);
	view.setUint32(6, 0, true); // reserved
	view.setUint32(10, pixelDataOffset, true);

	// --- BITMAPINFOHEADER ---
	view.setUint32(14, INFO_HEADER_SIZE, true);
	view.setInt32(18, width, true);
	// Positive height => bottom-up storage (the conventional default).
	view.setInt32(22, height, true);
	view.setUint16(26, 1, true);   // color planes
	view.setUint16(28, bpp, true); // bits per pixel
	view.setUint32(30, 0, true);   // compression = BI_RGB (none)
	view.setUint32(34, pixelDataSize, true);
	view.setInt32(38, 2835, true); // ~72 DPI horizontal (pixels/meter)
	view.setInt32(42, 2835, true); // ~72 DPI vertical
	view.setUint32(46, maxColors, true); // colors used
	view.setUint32(50, 0, true);   // important colors (0 = all)

	// --- Palette (B, G, R, reserved) ---
	const paletteOffset = FILE_HEADER_SIZE + INFO_HEADER_SIZE;
	for (let i = 0; i < maxColors; i++) {
		const o = paletteOffset + i * 4;
		const c = palette[i];
		view.setUint8(o, c.b);
		view.setUint8(o + 1, c.g);
		view.setUint8(o + 2, c.r);
		view.setUint8(o + 3, 0); // reserved
	}

	// --- Pixel data (bottom-up, row-padded) ---
	for (let row = 0; row < height; row++) {
		// Top image row goes last in the file.
		const dstRow = height - 1 - row;
		const rowStart = pixelDataOffset + dstRow * stride;

		if (bpp === 8) {
			for (let x = 0; x < width; x++) {
				view.setUint8(rowStart + x, pixels[row * width + x] & 0xff);
			}
		} else {
			// 4bpp: pack two indices per byte, high nibble = left pixel.
			for (let x = 0; x < width; x += 2) {
				const hi = pixels[row * width + x] & 0x0f;
				const lo = (x + 1 < width ? pixels[row * width + x + 1] : 0) & 0x0f;
				view.setUint8(rowStart + (x >> 1), (hi << 4) | lo);
			}
		}
	}

	return out;
}

/**
 * Build a blank indexed image: all pixels index 0, with a small default
 * palette. Used for brand-new files and as a fallback.
 */
export function blankImage(width = 32, height = 32, bpp: 4 | 8 = 4): BmpImage {
	const palette: Rgb[] = [
		{ r: 0, g: 0, b: 0 },
		{ r: 255, g: 255, b: 255 },
		{ r: 200, g: 40, b: 40 },
		{ r: 40, g: 200, b: 40 },
		{ r: 40, g: 80, b: 220 },
		{ r: 230, g: 220, b: 60 },
		{ r: 230, g: 130, b: 40 },
		{ r: 150, g: 60, b: 200 },
		{ r: 100, g: 100, b: 100 },
		{ r: 60, g: 60, b: 60 },
		{ r: 250, g: 180, b: 180 },
		{ r: 180, g: 250, b: 180 },
		{ r: 180, g: 200, b: 250 },
		{ r: 120, g: 80, b: 40 },
		{ r: 200, g: 200, b: 200 },
		{ r: 30, g: 30, b: 30 },
	];
	return {
		width,
		height,
		bpp,
		palette,
		pixels: new Uint8Array(width * height),
	};
}