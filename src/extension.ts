// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	console.log('Extension "simple-bmp" is now active!');

	// Register our custom editor provider for BMP files
	context.subscriptions.push(BmpEditorProvider.register(context));
}

// This method is called when your extension is deactivated
export function deactivate() {}

/**
 * Provider for the BMP sprite editor.
 *
 * Phase 1: Opens a custom editor with the full editing UI (canvas + palette
 * editor + tool panel) whenever a .bmp file is clicked. The document starts
 * empty; actual BMP parsing/serialization is wired up in a later phase.
 */
class BmpEditorProvider implements vscode.CustomEditorProvider<BmpDocument> {

	private static readonly viewType = 'simple-bmp.editor';

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new BmpEditorProvider(context);
		return vscode.window.registerCustomEditorProvider(
			BmpEditorProvider.viewType,
			provider,
			{
				// Keep the webview alive when the tab is hidden so we don't
				// lose in-progress edits when the user switches tabs.
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			}
		);
	}

	constructor(private readonly context: vscode.ExtensionContext) {}

	//#region CustomEditorProvider plumbing

	// Phase 1: documents are not persisted yet, so these are stubs that
	// satisfy the interface and let us flesh out save/load later.

	private readonly _onDidChangeCustomDocument =
		new vscode.EventEmitter<vscode.CustomDocumentEditEvent<BmpDocument>>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	async openCustomDocument(
		uri: vscode.Uri,
		_openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken
	): Promise<BmpDocument> {
		// Phase 1: ignore file contents, start from a blank sprite.
		return new BmpDocument(uri);
	}

	async saveCustomDocument(
		_document: BmpDocument,
		_cancellation: vscode.CancellationToken
	): Promise<void> {
		// Phase 1: no-op. BMP serialization comes later.
	}

	async saveCustomDocumentAs(
		_document: BmpDocument,
		_destination: vscode.Uri,
		_cancellation: vscode.CancellationToken
	): Promise<void> {
		// Phase 1: no-op.
	}

	async revertCustomDocument(
		_document: BmpDocument,
		_cancellation: vscode.CancellationToken
	): Promise<void> {
		// Phase 1: no-op.
	}

	async backupCustomDocument(
		_document: BmpDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		// Phase 1: nothing to back up yet.
		return { id: context.destination.toString(), delete: () => {} };
	}

	//#endregion

	/**
	 * Called once per editor instance. Sets up the webview that renders the UI.
	 */
	async resolveCustomEditor(
		document: BmpDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		// Handle messages coming back from the webview.
		webviewPanel.webview.onDidReceiveMessage((message) => {
			switch (message.type) {
				case 'ready':
					// Webview finished loading; hand it the initial blank sprite.
					webviewPanel.webview.postMessage({
						type: 'init',
						width: document.width,
						height: document.height,
						palette: document.palette,
						pixels: document.pixels,
					});
					return;
			}
		});
	}

	/**
	 * Builds the HTML/CSS/JS for the editor UI.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// A nonce locks down which inline scripts are allowed to run.
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>BMP Sprite Editor</title>
	<style>
		:root {
			--gap: 8px;
		}
		* { box-sizing: border-box; }
		html, body {
			height: 100%;
			margin: 0;
			padding: 0;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			overflow: hidden;
		}
		#app {
			display: flex;
			height: 100vh;
			width: 100vw;
		}

		/* ---- Left: tool panel ---- */
		#tools {
			width: 56px;
			flex: 0 0 auto;
			border-right: 1px solid var(--vscode-panel-border, #454545);
			padding: var(--gap);
			display: flex;
			flex-direction: column;
			gap: 6px;
			align-items: center;
		}
		.tool-btn {
			width: 40px;
			height: 40px;
			display: flex;
			align-items: center;
			justify-content: center;
			border: 1px solid transparent;
			border-radius: 4px;
			background: var(--vscode-button-secondaryBackground, #3a3d41);
			color: var(--vscode-button-secondaryForeground, #ccc);
			cursor: pointer;
			font-size: 18px;
			user-select: none;
		}
		.tool-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground, #45494e);
		}
		.tool-btn.active {
			border-color: var(--vscode-focusBorder, #007fd4);
			background: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #fff);
		}

		/* ---- Center: canvas ---- */
		#canvas-area {
			flex: 1 1 auto;
			min-width: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			overflow: auto;
			background:
				repeating-conic-gradient(#808080 0% 25%, #a0a0a0 0% 50%)
				50% / 24px 24px;
		}
		#canvas-wrap {
			box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.4);
		}
		#sprite {
			image-rendering: pixelated;
			image-rendering: crisp-edges;
			display: block;
			cursor: crosshair;
		}

		/* ---- Right: palette + info ---- */
		#side {
			width: 220px;
			flex: 0 0 auto;
			border-left: 1px solid var(--vscode-panel-border, #454545);
			padding: var(--gap);
			display: flex;
			flex-direction: column;
			gap: 12px;
			overflow-y: auto;
		}
		.panel-title {
			font-weight: 600;
			text-transform: uppercase;
			font-size: 11px;
			letter-spacing: 0.5px;
			opacity: 0.8;
			margin-bottom: 6px;
		}
		#palette {
			display: grid;
			grid-template-columns: repeat(8, 1fr);
			gap: 3px;
		}
		.swatch {
			aspect-ratio: 1 / 1;
			border: 1px solid rgba(0,0,0,0.4);
			border-radius: 2px;
			cursor: pointer;
		}
		.swatch.selected {
			outline: 2px solid var(--vscode-focusBorder, #007fd4);
			outline-offset: 1px;
		}

		.color-editor {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}
		.row {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.row label {
			width: 16px;
			opacity: 0.8;
		}
		.row input[type="range"] {
			flex: 1;
		}
		.row .val {
			width: 28px;
			text-align: right;
			font-variant-numeric: tabular-nums;
			opacity: 0.8;
		}
		#preview {
			height: 28px;
			border-radius: 3px;
			border: 1px solid rgba(0,0,0,0.4);
		}

		.info {
			font-size: 12px;
			opacity: 0.8;
			line-height: 1.6;
		}
		.info code {
			background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.08));
			padding: 1px 4px;
			border-radius: 3px;
		}
	</style>
</head>
<body>
	<div id="app">
		<!-- Tools -->
		<div id="tools">
			<div class="tool-btn active" data-tool="pencil" title="Pencil">✏️</div>
			<div class="tool-btn" data-tool="eraser" title="Eraser (paint index 0)">🧽</div>
			<div class="tool-btn" data-tool="fill" title="Bucket fill">🪣</div>
			<div class="tool-btn" data-tool="picker" title="Eyedropper">💉</div>
		</div>

		<!-- Canvas -->
		<div id="canvas-area">
			<div id="canvas-wrap">
				<canvas id="sprite" width="32" height="32"></canvas>
			</div>
		</div>

		<!-- Side panel -->
		<div id="side">
			<div>
				<div class="panel-title">Palette</div>
				<div id="palette"></div>
			</div>

			<div>
				<div class="panel-title">Color</div>
				<div class="color-editor">
					<div id="preview"></div>
					<div class="row">
						<label>R</label>
						<input type="range" id="r" min="0" max="255" value="0">
						<span class="val" id="rv">0</span>
					</div>
					<div class="row">
						<label>G</label>
						<input type="range" id="g" min="0" max="255" value="0">
						<span class="val" id="gv">0</span>
					</div>
					<div class="row">
						<label>B</label>
						<input type="range" id="b" min="0" max="255" value="0">
						<span class="val" id="bv">0</span>
					</div>
				</div>
			</div>

			<div>
				<div class="panel-title">Sprite</div>
				<div class="info" id="sprite-info">—</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		// ---- Editor state ----
		const state = {
			width: 32,
			height: 32,
			scale: 12,           // pixels per source pixel on screen
			palette: [],         // array of {r,g,b}
			pixels: null,        // Uint8Array of palette indices, length w*h
			selectedIndex: 1,
			tool: 'pencil',
		};

		const canvas = document.getElementById('sprite');
		const ctx = canvas.getContext('2d');
		const paletteEl = document.getElementById('palette');
		const previewEl = document.getElementById('preview');
		const infoEl = document.getElementById('sprite-info');
		const sliders = {
			r: document.getElementById('r'),
			g: document.getElementById('g'),
			b: document.getElementById('b'),
		};
		const sliderVals = {
			r: document.getElementById('rv'),
			g: document.getElementById('gv'),
			b: document.getElementById('bv'),
		};

		// ---- Default 16-color palette (GBA uses up to 256; 16 is a common
		//      4bpp sprite palette). Index 0 is treated as transparent. ----
		function defaultPalette() {
			const pal = [
				{ r: 0,   g: 0,   b: 0   }, // 0 - transparent / black
				{ r: 255, g: 255, b: 255 },
				{ r: 200, g: 40,  b: 40  },
				{ r: 40,  g: 200, b: 40  },
				{ r: 40,  g: 80,  b: 220 },
				{ r: 230, g: 220, b: 60  },
				{ r: 230, g: 130, b: 40  },
				{ r: 150, g: 60,  b: 200 },
				{ r: 100, g: 100, b: 100 },
				{ r: 60,  g: 60,  b: 60  },
				{ r: 250, g: 180, b: 180 },
				{ r: 180, g: 250, b: 180 },
				{ r: 180, g: 200, b: 250 },
				{ r: 120, g: 80,  b: 40  },
				{ r: 200, g: 200, b: 200 },
				{ r: 30,  g: 30,  b: 30  },
			];
			return pal;
		}

		// ---- Rendering ----
		function render() {
			canvas.width = state.width;
			canvas.height = state.height;
			canvas.style.width = (state.width * state.scale) + 'px';
			canvas.style.height = (state.height * state.scale) + 'px';

			const img = ctx.createImageData(state.width, state.height);
			for (let i = 0; i < state.pixels.length; i++) {
				const idx = state.pixels[i];
				const c = state.palette[idx] || { r: 0, g: 0, b: 0 };
				const o = i * 4;
				img.data[o]     = c.r;
				img.data[o + 1] = c.g;
				img.data[o + 2] = c.b;
				// Index 0 renders transparent so the checkerboard shows through.
				img.data[o + 3] = idx === 0 ? 0 : 255;
			}
			ctx.putImageData(img, 0, 0);
		}

		function renderPalette() {
			paletteEl.innerHTML = '';
			state.palette.forEach((c, i) => {
				const sw = document.createElement('div');
				sw.className = 'swatch' + (i === state.selectedIndex ? ' selected' : '');
				sw.style.background = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
				sw.title = 'Index ' + i;
				sw.addEventListener('click', () => selectIndex(i));
				paletteEl.appendChild(sw);
			});
		}

		function selectIndex(i) {
			state.selectedIndex = i;
			renderPalette();
			syncColorEditor();
		}

		function syncColorEditor() {
			const c = state.palette[state.selectedIndex];
			sliders.r.value = c.r; sliderVals.r.textContent = c.r;
			sliders.g.value = c.g; sliderVals.g.textContent = c.g;
			sliders.b.value = c.b; sliderVals.b.textContent = c.b;
			previewEl.style.background = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
		}

		function onSlider() {
			const c = state.palette[state.selectedIndex];
			c.r = +sliders.r.value; sliderVals.r.textContent = c.r;
			c.g = +sliders.g.value; sliderVals.g.textContent = c.g;
			c.b = +sliders.b.value; sliderVals.b.textContent = c.b;
			previewEl.style.background = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
			renderPalette();
			render();
		}
		sliders.r.addEventListener('input', onSlider);
		sliders.g.addEventListener('input', onSlider);
		sliders.b.addEventListener('input', onSlider);

		// ---- Tools ----
		document.querySelectorAll('.tool-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				state.tool = btn.dataset.tool;
			});
		});

		// Translate a mouse event into a sprite pixel coordinate.
		function eventToPixel(e) {
			const rect = canvas.getBoundingClientRect();
			const x = Math.floor((e.clientX - rect.left) / rect.width * state.width);
			const y = Math.floor((e.clientY - rect.top) / rect.height * state.height);
			if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
			return { x, y };
		}

		function applyTool(p) {
			if (!p) return;
			const i = p.y * state.width + p.x;
			switch (state.tool) {
				case 'pencil':
					state.pixels[i] = state.selectedIndex;
					break;
				case 'eraser':
					state.pixels[i] = 0;
					break;
				case 'picker':
					selectIndex(state.pixels[i]);
					break;
				case 'fill':
					floodFill(p.x, p.y, state.pixels[i], state.selectedIndex);
					break;
			}
			render();
		}

		function floodFill(x, y, target, replacement) {
			if (target === replacement) return;
			const stack = [[x, y]];
			while (stack.length) {
				const [cx, cy] = stack.pop();
				if (cx < 0 || cy < 0 || cx >= state.width || cy >= state.height) continue;
				const i = cy * state.width + cx;
				if (state.pixels[i] !== target) continue;
				state.pixels[i] = replacement;
				stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
			}
		}

		let drawing = false;
		canvas.addEventListener('mousedown', (e) => {
			drawing = true;
			applyTool(eventToPixel(e));
		});
		canvas.addEventListener('mousemove', (e) => {
			if (drawing && (state.tool === 'pencil' || state.tool === 'eraser')) {
				applyTool(eventToPixel(e));
			}
		});
		window.addEventListener('mouseup', () => { drawing = false; });

		// ---- Init handshake with the extension host ----
		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'init') {
				state.width = msg.width;
				state.height = msg.height;
				state.palette = (msg.palette && msg.palette.length)
					? msg.palette
					: defaultPalette();
				state.pixels = msg.pixels
					? Uint8Array.from(msg.pixels)
					: new Uint8Array(state.width * state.height);

				infoEl.innerHTML =
					'Size: <code>' + state.width + ' × ' + state.height + '</code><br>' +
					'Colors: <code>' + state.palette.length + '</code><br>' +
					'Format: <code>indexed BMP</code>';

				renderPalette();
				selectIndex(Math.min(1, state.palette.length - 1));
				render();
			}
		});

		// Tell the host we're ready to receive the document.
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

/**
 * In-memory model for an open BMP. Phase 1 holds a blank indexed sprite.
 * Later phases will populate width/height/palette/pixels from the real file.
 */
class BmpDocument implements vscode.CustomDocument {
	public readonly width = 32;
	public readonly height = 32;
	public readonly palette: { r: number; g: number; b: number }[] = [];
	public readonly pixels: number[] = new Array(32 * 32).fill(0);

	constructor(public readonly uri: vscode.Uri) {}

	dispose(): void {
		// Phase 1: nothing to clean up.
	}
}

/** Generates a random nonce for the webview CSP. */
function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}