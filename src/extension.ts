// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import { decodeBmp, encodeBmp, blankImage, BmpImage, Rgb } from './bmp';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	console.log('Extension "simple-bmp" is now active!');
	context.subscriptions.push(BmpEditorProvider.register(context));
}

// This method is called when your extension is deactivated
export function deactivate() {}

/** A serializable snapshot of the editable state, used for undo/redo + save. */
interface BmpSnapshot {
	palette: Rgb[];
	pixels: Uint8Array;
}

/**
 * Provider for the BMP sprite editor.
 *
 * Phase 2: parses the real file on open, tracks edits as a dirty document,
 * and serializes back to BMP on save / save-as. Undo/redo and backups are
 * wired through VS Code's custom-document edit machinery.
 */
class BmpEditorProvider implements vscode.CustomEditorProvider<BmpDocument> {

	private static readonly viewType = 'simple-bmp.editor';

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new BmpEditorProvider(context);
		return vscode.window.registerCustomEditorProvider(
			BmpEditorProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			}
		);
	}

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Track the live webview per document so we can push reverts/undo to it. */
	private readonly webviews = new Map<string, vscode.WebviewPanel>();

	//#region CustomEditorProvider plumbing

	private readonly _onDidChangeCustomDocument =
		new vscode.EventEmitter<vscode.CustomDocumentEditEvent<BmpDocument>>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken
	): Promise<BmpDocument> {
		const source = openContext.backupId
			? vscode.Uri.parse(openContext.backupId)
			: uri;

		let image: BmpImage;
		try {
			const bytes = await vscode.workspace.fs.readFile(source);
			image = bytes.length > 0
				? decodeBmp(bytes)
				: blankImage();
		} catch (err) {
			// Surface parse failures but still open with a blank canvas so the
			// user isn't stuck staring at a dead tab.
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Couldn't open BMP: ${msg}`);
			image = blankImage();
		}

		const document = new BmpDocument(uri, image);

		// When the document makes an edit, propagate it to VS Code's undo stack.
		const listener = document.onDidEdit((edit) => {
			this._onDidChangeCustomDocument.fire({
				document,
				label: edit.label,
				undo: async () => {
					document.applySnapshot(edit.before);
					this.postToWebview(document, {
						type: 'restore',
						palette: document.image.palette,
						pixels: Array.from(document.image.pixels),
					});
				},
				redo: async () => {
					document.applySnapshot(edit.after);
					this.postToWebview(document, {
						type: 'restore',
						palette: document.image.palette,
						pixels: Array.from(document.image.pixels),
					});
				},
			});
		});
		document.onDispose(() => listener.dispose());

		return document;
	}

	async saveCustomDocument(
		document: BmpDocument,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		await this.saveCustomDocumentAs(document, document.uri, cancellation);
	}

	async saveCustomDocumentAs(
		document: BmpDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		const bytes = encodeBmp(document.image);
		if (cancellation.isCancellationRequested) {
			return;
		}
		await vscode.workspace.fs.writeFile(destination, bytes);
		document.markSaved();
	}

	async revertCustomDocument(
		document: BmpDocument,
		_cancellation: vscode.CancellationToken
	): Promise<void> {
		const bytes = await vscode.workspace.fs.readFile(document.uri);
		const image = bytes.length > 0 ? decodeBmp(bytes) : blankImage();
		document.revertTo(image);
		this.postToWebview(document, {
			type: 'init',
			width: image.width,
			height: image.height,
			bpp: image.bpp,
			palette: image.palette,
			pixels: Array.from(image.pixels),
		});
	}

	async backupCustomDocument(
		document: BmpDocument,
		context: vscode.CustomDocumentBackupContext,
		cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		const bytes = encodeBmp(document.image);
		if (!cancellation.isCancellationRequested) {
			await vscode.workspace.fs.writeFile(context.destination, bytes);
		}
		return {
			id: context.destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(context.destination);
				} catch {
					// Already gone; nothing to do.
				}
			},
		};
	}

	//#endregion

	async resolveCustomEditor(
		document: BmpDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		this.webviews.set(document.uri.toString(), webviewPanel);
		webviewPanel.onDidDispose(() => {
			if (this.webviews.get(document.uri.toString()) === webviewPanel) {
				this.webviews.delete(document.uri.toString());
			}
		});

		webviewPanel.webview.options = { enableScripts: true };
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		webviewPanel.webview.onDidReceiveMessage((message) => {
			switch (message.type) {
				case 'ready':
					webviewPanel.webview.postMessage({
						type: 'init',
						width: document.image.width,
						height: document.image.height,
						bpp: document.image.bpp,
						palette: document.image.palette,
						pixels: Array.from(document.image.pixels),
					});
					return;

				case 'edit':
					// The webview committed a change (stroke, fill, palette tweak).
					// message.pixels / message.palette are the new full state.
					document.pushEdit(
						message.label ?? 'Edit',
						{
							palette: message.palette as Rgb[],
							pixels: Uint8Array.from(message.pixels as number[]),
						}
					);
					return;
			}
		});
	}

	private postToWebview(document: BmpDocument, message: unknown): void {
		const panel = this.webviews.get(document.uri.toString());
		panel?.webview.postMessage(message);
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
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
		:root { --gap: 8px; }
		* { box-sizing: border-box; }
		html, body {
			height: 100%; margin: 0; padding: 0;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			overflow: hidden;
		}
		#app { display: flex; height: 100vh; width: 100vw; }

		#tools {
			width: 56px; flex: 0 0 auto;
			border-right: 1px solid var(--vscode-panel-border, #454545);
			padding: var(--gap);
			display: flex; flex-direction: column; gap: 6px; align-items: center;
		}
		.tool-btn {
			width: 40px; height: 40px;
			display: flex; align-items: center; justify-content: center;
			border: 1px solid transparent; border-radius: 4px;
			background: var(--vscode-button-secondaryBackground, #3a3d41);
			color: var(--vscode-button-secondaryForeground, #ccc);
			cursor: pointer; font-size: 18px; user-select: none;
		}
		.tool-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
		.tool-btn.active {
			border-color: var(--vscode-focusBorder, #007fd4);
			background: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #fff);
		}

		#canvas-area {
			flex: 1 1 auto; min-width: 0;
			display: flex; align-items: center; justify-content: center;
			overflow: auto;
			background: repeating-conic-gradient(#808080 0% 25%, #a0a0a0 0% 50%) 50% / 24px 24px;
		}
		#canvas-wrap { box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.4); }
		#sprite {
			image-rendering: pixelated; image-rendering: crisp-edges;
			display: block; cursor: crosshair;
		}

		#side {
			width: 220px; flex: 0 0 auto;
			border-left: 1px solid var(--vscode-panel-border, #454545);
			padding: var(--gap);
			display: flex; flex-direction: column; gap: 12px; overflow-y: auto;
		}
		.panel-title {
			font-weight: 600; text-transform: uppercase;
			font-size: 11px; letter-spacing: 0.5px; opacity: 0.8; margin-bottom: 6px;
		}
		#palette { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; }
		.swatch {
			aspect-ratio: 1 / 1; border: 1px solid rgba(0,0,0,0.4);
			border-radius: 2px; cursor: pointer;
		}
		.swatch.selected {
			outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px;
		}

		.color-editor { display: flex; flex-direction: column; gap: 6px; }
		.row { display: flex; align-items: center; gap: 6px; }
		.row label { width: 16px; opacity: 0.8; }
		.row input[type="range"] { flex: 1; }
		.row .val { width: 28px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.8; }
		#preview { height: 28px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.4); }

		.info { font-size: 12px; opacity: 0.8; line-height: 1.6; }
		.info code {
			background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.08));
			padding: 1px 4px; border-radius: 3px;
		}
	</style>
</head>
<body>
	<div id="app">
		<div id="tools">
			<div class="tool-btn active" data-tool="pencil" title="Pencil">&#9999;&#65039;</div>
			<div class="tool-btn" data-tool="eraser" title="Eraser (paint index 0)">&#129529;</div>
			<div class="tool-btn" data-tool="fill" title="Bucket fill">&#129516;</div>
			<div class="tool-btn" data-tool="picker" title="Eyedropper">&#128137;</div>
		</div>

		<div id="canvas-area">
			<div id="canvas-wrap">
				<canvas id="sprite" width="32" height="32"></canvas>
			</div>
		</div>

		<div id="side">
			<div>
				<div class="panel-title">Palette</div>
				<div id="palette"></div>
			</div>
			<div>
				<div class="panel-title">Color</div>
				<div class="color-editor">
					<div id="preview"></div>
					<div class="row"><label>R</label><input type="range" id="r" min="0" max="255" value="0"><span class="val" id="rv">0</span></div>
					<div class="row"><label>G</label><input type="range" id="g" min="0" max="255" value="0"><span class="val" id="gv">0</span></div>
					<div class="row"><label>B</label><input type="range" id="b" min="0" max="255" value="0"><span class="val" id="bv">0</span></div>
				</div>
			</div>
			<div>
				<div class="panel-title">Sprite</div>
				<div class="info" id="sprite-info">&mdash;</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		const state = {
			width: 32, height: 32, scale: 12,
			bpp: 4,
			palette: [], pixels: null,
			selectedIndex: 1, tool: 'pencil',
		};

		const canvas = document.getElementById('sprite');
		const ctx = canvas.getContext('2d');
		const paletteEl = document.getElementById('palette');
		const previewEl = document.getElementById('preview');
		const infoEl = document.getElementById('sprite-info');
		const sliders = { r: document.getElementById('r'), g: document.getElementById('g'), b: document.getElementById('b') };
		const sliderVals = { r: document.getElementById('rv'), g: document.getElementById('gv'), b: document.getElementById('bv') };

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
				img.data[o] = c.r; img.data[o + 1] = c.g; img.data[o + 2] = c.b;
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

		// Palette edits commit on slider release (so a drag = one undo step).
		function onSliderInput() {
			const c = state.palette[state.selectedIndex];
			c.r = +sliders.r.value; sliderVals.r.textContent = c.r;
			c.g = +sliders.g.value; sliderVals.g.textContent = c.g;
			c.b = +sliders.b.value; sliderVals.b.textContent = c.b;
			previewEl.style.background = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
			renderPalette();
			render();
		}
		function onSliderCommit() { commitEdit('Edit color'); }
		['r', 'g', 'b'].forEach((k) => {
			sliders[k].addEventListener('input', onSliderInput);
			sliders[k].addEventListener('change', onSliderCommit);
		});

		document.querySelectorAll('.tool-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				state.tool = btn.dataset.tool;
			});
		});

		function eventToPixel(e) {
			const rect = canvas.getBoundingClientRect();
			const x = Math.floor((e.clientX - rect.left) / rect.width * state.width);
			const y = Math.floor((e.clientY - rect.top) / rect.height * state.height);
			if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
			return { x, y };
		}

		function applyTool(p) {
			if (!p) return false;
			const i = p.y * state.width + p.x;
			switch (state.tool) {
				case 'pencil': state.pixels[i] = state.selectedIndex; break;
				case 'eraser': state.pixels[i] = 0; break;
				case 'picker': selectIndex(state.pixels[i]); return false;
				case 'fill': floodFill(p.x, p.y, state.pixels[i], state.selectedIndex); break;
			}
			render();
			return true;
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

		// Report a committed change to the extension host so it can mark the
		// document dirty and push it onto the undo stack.
		function commitEdit(label) {
			vscode.postMessage({
				type: 'edit',
				label: label,
				palette: state.palette.map(c => ({ r: c.r, g: c.g, b: c.b })),
				pixels: Array.from(state.pixels),
			});
		}

		let drawing = false;
		let strokeDirty = false;
		canvas.addEventListener('mousedown', (e) => {
			drawing = true;
			strokeDirty = applyTool(eventToPixel(e)) || strokeDirty;
		});
		canvas.addEventListener('mousemove', (e) => {
			if (drawing && (state.tool === 'pencil' || state.tool === 'eraser')) {
				strokeDirty = applyTool(eventToPixel(e)) || strokeDirty;
			}
		});
		window.addEventListener('mouseup', () => {
			if (drawing && strokeDirty) {
				commitEdit(state.tool === 'fill' ? 'Fill' : 'Draw');
			}
			drawing = false;
			strokeDirty = false;
		});

		function loadImage(msg) {
			state.width = msg.width;
			state.height = msg.height;
			state.bpp = msg.bpp || 4;
			state.palette = (msg.palette && msg.palette.length)
				? msg.palette.map(c => ({ r: c.r, g: c.g, b: c.b }))
				: [{ r: 0, g: 0, b: 0 }];
			state.pixels = msg.pixels ? Uint8Array.from(msg.pixels) : new Uint8Array(state.width * state.height);

			infoEl.innerHTML =
				'Size: <code>' + state.width + ' &times; ' + state.height + '</code><br>' +
				'Depth: <code>' + state.bpp + 'bpp</code><br>' +
				'Colors: <code>' + state.palette.length + '</code>';

			renderPalette();
			selectIndex(Math.min(1, state.palette.length - 1));
			render();
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'init') {
				loadImage(msg);
			} else if (msg.type === 'restore') {
				// Undo/redo from the host: replace palette + pixels in place.
				state.palette = msg.palette.map(c => ({ r: c.r, g: c.g, b: c.b }));
				state.pixels = Uint8Array.from(msg.pixels);
				renderPalette();
				syncColorEditor();
				render();
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

interface BmpEdit {
	label: string;
	before: BmpSnapshot;
	after: BmpSnapshot;
}

/**
 * In-memory model for an open BMP. Holds the decoded image plus the
 * machinery to track edits, mark saved/dirty, and revert.
 */
class BmpDocument implements vscode.CustomDocument {
	private _image: BmpImage;

	private readonly _onDidEdit = new vscode.EventEmitter<BmpEdit>();
	public readonly onDidEdit = this._onDidEdit.event;

	private readonly _onDispose = new vscode.EventEmitter<void>();
	public readonly onDispose = this._onDispose.event;

	constructor(public readonly uri: vscode.Uri, image: BmpImage) {
		this._image = image;
	}

	get image(): BmpImage {
		return this._image;
	}

	private snapshot(): BmpSnapshot {
		return {
			palette: this._image.palette.map((c) => ({ ...c })),
			pixels: this._image.pixels.slice(),
		};
	}

	/** Commit new state coming from the webview, recording an undoable edit. */
	pushEdit(label: string, next: BmpSnapshot): void {
		const before = this.snapshot();
		this._image = {
			...this._image,
			palette: next.palette.map((c) => ({ ...c })),
			pixels: next.pixels.slice(),
		};
		const after = this.snapshot();
		this._onDidEdit.fire({ label, before, after });
	}

	/** Replace current pixels/palette without firing an edit (used by undo/redo). */
	applySnapshot(snap: BmpSnapshot): void {
		this._image = {
			...this._image,
			palette: snap.palette.map((c) => ({ ...c })),
			pixels: snap.pixels.slice(),
		};
	}

	/** Replace the whole image after a revert-from-disk. */
	revertTo(image: BmpImage): void {
		this._image = image;
	}

	markSaved(): void {
		// VS Code clears the dirty flag based on the edit stack; nothing extra
		// to persist here in Phase 2.
	}

	dispose(): void {
		this._onDispose.fire();
		this._onDidEdit.dispose();
		this._onDispose.dispose();
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