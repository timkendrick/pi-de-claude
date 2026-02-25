/**
 * pi-de-claude: IDE Integration Extension
 *
 * Bridges pi and Claude Code IDE extensions (VS Code, IntelliJ, Neovim via claudecode.nvim, etc.)
 * by connecting over the WebSocket-based MCP protocol they expose. This makes IDE
 * capabilities (open files, show diffs, read selections, get diagnostics, etc.)
 * available to the LLM and provides a smooth IDE-connected workflow.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {BeforeAgentStartEventResult} from "@mariozechner/pi-coding-agent/dist/core/extensions";

// ── Types ──────────────────────────────────────────────────────────────────

interface IdeLockFile {
	pid: number;
	workspaceFolders: string[];
	ideName: string;
	transport: string;
	authToken: string;
}

interface IdeSelection {
	text: string;
	filePath: string;
	fileUrl: string;
	selection: {
		start: { line: number; character: number };
		end: { line: number; character: number };
		isEmpty: boolean;
	};
}

interface AtMention {
	filePath: string;
	lineStart: number;
	lineEnd: number;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface DiscoveredIde {
	port: number;
	lock: IdeLockFile;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface McpToolResponse {
	content: Array<{ type: string; text: string }>;
}

interface IdeToolDetails {
	tool: string;
	params: Record<string, unknown>;
	rawResult: unknown;
}

interface IdeAgentToolResult<T = IdeToolDetails> extends AgentToolResult<T> {
	isError?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const IDE_LOCK_DIR = join(homedir(), ".claude", "ide");
const STATUS_KEY = "pi-de-claude";
const WIDGET_KEY = "ide-selection";

// ── Tool Descriptors ───────────────────────────────────────────────────────

interface ToolDescriptor {
	piName: string;
	mcpName: string;
	label: string;
	description: string;
	parameters: ReturnType<typeof Type.Object>;
	blocking?: boolean;
}

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
	{
		piName: "ide_openFile",
		mcpName: "openFile",
		label: "IDE: Open File",
		description: "Open a file in the connected IDE and optionally select a range of text.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Absolute path to the file to open" }),
			preview: Type.Optional(Type.Boolean({ description: "Open as preview tab (default: false)" })),
			startText: Type.Optional(Type.String({ description: "Text pattern to find selection start" })),
			endText: Type.Optional(Type.String({ description: "Text pattern to find selection end" })),
			selectToEndOfLine: Type.Optional(Type.Boolean({ description: "Extend selection to end of line (default: false)" })),
			makeFrontmost: Type.Optional(Type.Boolean({ description: "Make the file the active editor tab (default: true)" })),
		}),
	},
	{
		piName: "ide_openDiff",
		mcpName: "openDiff",
		label: "IDE: Open Diff",
		description:
			"Show a diff in the IDE for the user to review. The user can accept or reject the changes. " +
			"This tool blocks until the user responds. Returns FILE_SAVED if accepted, DIFF_REJECTED if rejected.",
		parameters: Type.Object({
			old_file_path: Type.String({ description: "Path to the original file" }),
			new_file_path: Type.String({ description: "Path to the new file" }),
			new_file_contents: Type.String({ description: "The proposed new contents of the file" }),
			tab_name: Type.String({ description: "Display name for the diff tab" }),
		}),
		blocking: true,
	},
	{
		piName: "ide_getCurrentSelection",
		mcpName: "getCurrentSelection",
		label: "IDE: Get Current Selection",
		description: "Get the currently selected text in the IDE editor.",
		parameters: Type.Object({}),
	},
	{
		piName: "ide_getLatestSelection",
		mcpName: "getLatestSelection",
		label: "IDE: Get Latest Selection",
		description: "Get the most recent text selection in the IDE editor.",
		parameters: Type.Object({}),
	},
	{
		piName: "ide_getOpenEditors",
		mcpName: "getOpenEditors",
		label: "IDE: Get Open Editors",
		description: "List all currently open editor tabs in the IDE.",
		parameters: Type.Object({}),
	},
	{
		piName: "ide_getWorkspaceFolders",
		mcpName: "getWorkspaceFolders",
		label: "IDE: Get Workspace Folders",
		description: "Get the workspace folders open in the IDE.",
		parameters: Type.Object({}),
	},
	{
		piName: "ide_getDiagnostics",
		mcpName: "getDiagnostics",
		label: "IDE: Get Diagnostics",
		description: "Get diagnostics (errors, warnings) from the IDE. Optionally filter by file URI.",
		parameters: Type.Object({
			uri: Type.Optional(Type.String({ description: "File URI to filter diagnostics for" })),
		}),
	},
	{
		piName: "ide_checkDocumentDirty",
		mcpName: "checkDocumentDirty",
		label: "IDE: Check Document Dirty",
		description: "Check if a file has unsaved changes in the IDE.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Absolute path to the file to check" }),
		}),
	},
	{
		piName: "ide_saveDocument",
		mcpName: "saveDocument",
		label: "IDE: Save Document",
		description: "Save a file in the IDE.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Absolute path to the file to save" }),
		}),
	},
	{
		piName: "ide_closeTab",
		mcpName: "close_tab",
		label: "IDE: Close Tab",
		description: "Close a tab in the IDE by its tab name.",
		parameters: Type.Object({
			tab_name: Type.String({ description: "Name of the tab to close" }),
		}),
	},
	{
		piName: "ide_closeAllDiffTabs",
		mcpName: "closeAllDiffTabs",
		label: "IDE: Close All Diff Tabs",
		description: "Close all diff tabs in the IDE.",
		parameters: Type.Object({}),
	},
	{
		piName: "ide_executeCode",
		mcpName: "executeCode",
		label: "IDE: Execute Code",
		description: "Execute Python code in the IDE (Jupyter-specific). Runs code in the active notebook kernel.",
		parameters: Type.Object({
			code: Type.String({ description: "The code to be executed on the kernel" }),
		}),
	},
];

// ── Extension ──────────────────────────────────────────────────────────────

// noinspection JSUnusedGlobalSymbols
export default function (pi: ExtensionAPI) {
	// ── State ────────────────────────────────────────────────────────────

	let ws: WebSocket | null = null;
	let connectedIde: IdeLockFile | null = null;
	let currentSelection: IdeSelection | null = null;
	let currentCtx: ExtensionContext | null = null;
	let nextRequestId = 1;
	const pendingRequests = new Map<number, PendingRequest>();

	const IDE_TOOL_NAMES = new Set(TOOL_DESCRIPTORS.map((d) => d.piName));

	function activateIdeTools(): void {
		const current = new Set(pi.getActiveTools());
		for (const name of IDE_TOOL_NAMES) current.add(name);
		pi.setActiveTools(Array.from(current));
	}

	function deactivateIdeTools(): void {
		const current = pi.getActiveTools().filter((name) => !IDE_TOOL_NAMES.has(name));
		pi.setActiveTools(current);
	}

	// ── IDE Discovery ────────────────────────────────────────────────────

	async function discoverIdes(): Promise<DiscoveredIde[]> {
		const ides: DiscoveredIde[] = [];
		let files: string[];
		try {
			files = await readdir(IDE_LOCK_DIR);
		} catch {
			return ides;
		}

		for (const file of files) {
			if (!file.endsWith(".lock")) continue;
			try {
				const content = await readFile(join(IDE_LOCK_DIR, file), "utf-8");
				const lock = JSON.parse(content) as IdeLockFile;
				if (lock.transport !== "ws") continue;
				// Validate PID is alive
				process.kill(lock.pid, 0);
				// Extract port from filename (format: port.lock)
				const port = parseInt(file.replace(".lock", ""), 10);
				if (isNaN(port)) continue;
				ides.push({ port, lock });
			} catch {
				// Stale/malformed lock file, skip
			}
		}
		return ides;
	}

	// ── WebSocket Client ─────────────────────────────────────────────────

	function sendRequest(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				reject(new Error("Not connected to IDE"));
				return;
			}
			const id = nextRequestId++;
			const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

			const timer = setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			pendingRequests.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify(msg));
		});
	}

	function sendBlockingRequest(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				reject(new Error("Not connected to IDE"));
				return;
			}
			const id = nextRequestId++;
			const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

			const pending: PendingRequest = { resolve, reject };
			pendingRequests.set(id, pending);

			if (signal) {
				const onAbort = () => {
					pendingRequests.delete(id);
					reject(new Error("Request aborted"));
				};
				if (signal.aborted) {
					pendingRequests.delete(id);
					reject(new Error("Request aborted"));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				// Clean up abort listener when request completes
				const origResolve = pending.resolve;
				const origReject = pending.reject;
				pending.resolve = (v) => {
					signal.removeEventListener("abort", onAbort);
					origResolve(v);
				};
				pending.reject = (e) => {
					signal.removeEventListener("abort", onAbort);
					origReject(e);
				};
			}

			ws.send(JSON.stringify(msg));
		});
	}

	function sendNotification(method: string, params?: unknown): void {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		ws.send(JSON.stringify(msg));
	}

	function handleMessage(data: string): void {
		let msg: JsonRpcResponse | JsonRpcNotification;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}

		// Response to a pending request (must have result or error, not method)
		// Note: the IDE can send server-initiated requests with an id (e.g. ping) —
		// those have a "method" field and must NOT be treated as responses.
		if ("id" in msg && msg.id != null && !("method" in msg)) {
			const resp = msg as JsonRpcResponse;
			const pending = pendingRequests.get(resp.id);
			if (pending) {
				pendingRequests.delete(resp.id);
				if (pending.timer) clearTimeout(pending.timer);
				if (resp.error) {
					pending.reject(new Error(resp.error.message));
				} else {
					pending.resolve(resp.result);
				}
			}
			return;
		}

		// Notification
		const notif = msg as JsonRpcNotification;
		handleNotification(notif);
	}

	function handleNotification(notif: JsonRpcNotification): void {
		const params = notif.params as Record<string, unknown> | undefined;

		// Re-emit all notifications on the event bus for other extensions
		pi.events.emit(`ide:${notif.method}`, params);

		if (notif.method === "selection_changed") {
			const sel = params as unknown as IdeSelection | undefined;
			if (sel && sel.filePath && !sel.selection?.isEmpty && sel.text != null) {
				currentSelection = sel;
			} else {
				currentSelection = null;
			}
			updateSelectionWidget();
		} else if (notif.method === "at_mentioned") {
			const mention = params as unknown as AtMention | undefined;
			if (mention && mention.filePath) {
				// Insert @path:lines into editor
				const lineRange =
					mention.lineStart === mention.lineEnd
						? `L${mention.lineStart}`
						: `L${mention.lineStart}-L${mention.lineEnd}`;
				const ref = `@${mention.filePath}#${lineRange}`;
				const existing = currentCtx?.ui.getEditorText() ?? "";
				const newText = existing ? `${existing} ${ref}` : ref;
				currentCtx?.ui.setEditorText(newText);
			}
		}
	}

	async function connect(ide: DiscoveredIde): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const settle = (fn: typeof resolve | typeof reject, value?: unknown) => {
				if (settled) return;
				settled = true;
				(fn as Function)(value);
			};

			const socket = new WebSocket(`ws://127.0.0.1:${ide.port}`, {
				protocols: ["mcp"],
				headers: { "x-claude-code-ide-authorization": ide.lock.authToken },
			} as any);

			const connectTimeout = setTimeout(() => {
				socket.close();
				settle(reject, new Error("Connection timed out"));
			}, 10000);

			socket.addEventListener("open", async () => {
				clearTimeout(connectTimeout);
				ws = socket;

				try {
					// MCP handshake — use protocol version from the spec
					await sendRequest("initialize", {
						protocolVersion: "2025-03-26",
						capabilities: {},
						clientInfo: { name: "pi-de-claude", version: "1.0.0" },
					});
					sendNotification("notifications/initialized");

					connectedIde = ide.lock;
					activateIdeTools();
					updateStatus();
					pi.events.emit("ide:connected", {
						ideName: ide.lock.ideName,
						workspaceFolders: ide.lock.workspaceFolders,
					});
					currentCtx?.ui.notify(`Connected to ${ide.lock.ideName}`, "info");
					settle(resolve);
				} catch (err) {
					ws = null;
					socket.close();
					settle(reject, err instanceof Error ? err : new Error(String(err)));
				}
			});

			socket.addEventListener("message", (event) => {
				handleMessage(typeof event.data === "string" ? event.data : String(event.data));
			});

			socket.addEventListener("close", () => {
				clearTimeout(connectTimeout);
				settle(reject, new Error("Connection closed"));
				handleDisconnect("Connection closed");
			});

			socket.addEventListener("error", () => {
				clearTimeout(connectTimeout);
				settle(reject, new Error("Connection failed"));
				handleDisconnect("Connection error");
			});
		});
	}

	function disconnect(): void {
		if (ws) {
			ws.close();
			// handleDisconnect will be called by the close event
		}
	}

	function handleDisconnect(reason?: string): void {
		const wasConnected = connectedIde !== null;
		ws = null;
		connectedIde = null;
		currentSelection = null;

		// Reject all pending requests
		for (const [_, pending] of pendingRequests) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error("Disconnected from IDE"));
		}
		pendingRequests.clear();

		// Deactivate IDE tools, clear widget, update status
		deactivateIdeTools();
		currentCtx?.ui.setWidget(WIDGET_KEY, undefined);
		updateStatus();

		if (wasConnected) {
			pi.events.emit("ide:disconnected", { reason });
		}
	}

	// ── Status Line ──────────────────────────────────────────────────────

	function updateStatus(): void {
		if (!currentCtx) return;
		const theme = currentCtx.ui.theme;
		if (connectedIde) {
			const dot = theme.fg("success", "●");
			const text = theme.fg("success", " IDE: ") + theme.fg("text", connectedIde.ideName);
			currentCtx.ui.setStatus(STATUS_KEY, dot + text);
		} else {
			const dot = theme.fg("error", "○");
			const text = theme.fg("error", " IDE: disconnected");
			currentCtx.ui.setStatus(STATUS_KEY, dot + text);
		}
	}

	// ── Selection Widget ─────────────────────────────────────────────────

	function updateSelectionWidget(): void {
		if (!currentCtx) return;

		if (!currentSelection) {
			currentCtx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const sel = currentSelection;
		const startLine = sel.selection.start.line + 1;
		const endLine = sel.selection.end.line + 1;
		const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
		const trimmedText = sel.text.replace(/^[\t ]+/gm, "").trim();
		const preview = trimmedText.length > 60 ? trimmedText.slice(0, 57) + "..." : trimmedText;
		const previewClean = preview.replace(/\n/g, "↵");
		const displayPath = sel.filePath.startsWith(currentCtx.cwd + "/")
			? "./" + sel.filePath.slice(currentCtx.cwd.length + 1)
			: sel.filePath;

		const th = currentCtx.ui.theme;
		const line =
			th.fg("accent", "IDE Selection: ") +
			th.fg("text", displayPath) +
			th.fg("dim", "#") +
			th.fg("text", lineRange) +
			" " +
			th.fg("dim", `"${previewClean}"`);
		currentCtx.ui.setWidget(WIDGET_KEY, [line]);
	}

	// ── /ide Command ─────────────────────────────────────────────────────

	pi.registerCommand("ide", {
		description: "Connect to or disconnect from an IDE with Claude Code extension",
		handler: async (_args, ctx) => {
			// If already connected, offer options
			if (connectedIde) {
				const choice = await ctx.ui.select(`Connected to ${connectedIde.ideName}`, [
					"Disconnect",
					"Reconnect",
					"List tools",
					"Cancel",
				]);

				if (choice === "Cancel" || !choice) {
					return;
				}

				if (choice === "Disconnect") {
					disconnect();
					ctx.ui.notify("Disconnected from IDE", "info");
					return;
				}

				if (choice === "List tools") {
					const activeTools = pi.getActiveTools();
					const ideTools = TOOL_DESCRIPTORS.filter((d) => activeTools.includes(d.piName));
					const lines = ideTools.map((d) => `• ${d.piName}`).join("\n");
					ctx.ui.notify(`Active IDE tools:\n${lines}`, "info");
					return;
				}

				if (choice === "Reconnect") {
					disconnect();
					// Fall through to discovery
				}
			}

			// Discover IDEs
			const ides = await discoverIdes();

			if (ides.length === 0) {
				ctx.ui.notify(
					"No IDEs found. Make sure an IDE with Claude Code extension is running and has created a lock file in ~/.claude/ide/",
					"warning",
				);
				return;
			}

			let selected: DiscoveredIde;

			if (ides.length === 1) {
				selected = ides[0];
			} else {
				// Show selector
				const options = ides.map(
					(ide) =>
						`${ide.lock.ideName} (port ${ide.port}) - ${ide.lock.workspaceFolders.join(", ")}`,
				);
				const choice = await ctx.ui.select("Select IDE", options);
				if (!choice) return;

				const idx = options.indexOf(choice);
				if (idx < 0) return;
				selected = ides[idx];
			}

			try {
				await connect(selected);
			} catch (err) {
				ctx.ui.notify(
					`Failed to connect to ${selected.lock.ideName}: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// ── Context Injection (before_agent_start) ───────────────────────────

	pi.on("before_agent_start", async (event): Promise<BeforeAgentStartEventResult | void> => {
		const result: BeforeAgentStartEventResult = {};

		// a) Selection context injection
		if (currentSelection) {
			const sel = currentSelection;
			const startLine = sel.selection.start.line + 1;
			const endLine = sel.selection.end.line + 1;
			const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
			result.message = {
				customType: "ide-selection-context",
				content: `[IDE Selection Context]\nThe user has the following text selected in ${sel.filePath}#${lineRange}:\n\`\`\`\n${sel.text}\n\`\`\``,
				display: false,
			};
		}

		// b) IDE-connected system prompt addition
		if (connectedIde) {
			const addition = `\n\nYou are connected to the user's IDE (${connectedIde.ideName}). When making file edits, prefer using the ide_openDiff tool instead of the built-in edit/write tools. This lets the user review your proposed changes as a diff in their IDE before accepting. The tool blocks until the user accepts or rejects. If they reject, ask what they'd like changed.`;
			result.systemPrompt = event.systemPrompt + addition;
		}

		if (result.message || result.systemPrompt) {
			return result;
		}
	});

	// ── Lifecycle ────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		// IDE tools start deactivated; they activate on /ide connect
		if (!connectedIde) deactivateIdeTools();
		updateStatus();
	});

	pi.on("session_switch", async (_event, ctx) => {
		currentCtx = ctx;
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		disconnect();
	});

	// ── Tool Registration ────────────────────────────────────────────────

	for (const desc of TOOL_DESCRIPTORS) {
		pi.registerTool({
			name: desc.piName,
			label: desc.label,
			description: desc.description,
			parameters: desc.parameters,

			async execute(
				_toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback<IdeToolDetails> | undefined,
				_ctx: ExtensionContext,
			): Promise<IdeAgentToolResult<IdeToolDetails>> {
				if (!ws || ws.readyState !== WebSocket.OPEN) {
					return {
						content: [{ type: "text", text: "Error: Not connected to IDE. Use /ide to connect first." }],
						isError: true,
						details: { tool: desc.piName, params, rawResult: null },
					};
				}

				try {
					const toolCallParams = { name: desc.mcpName, arguments: params };

					let rawResult: unknown;
					if (desc.blocking) {
						// Show progress for blocking tools
						onUpdate?.({
							content: [{ type: "text", text: "Waiting for diff review in IDE..." }],
							details: { tool: desc.piName, params, rawResult: null },
						});
						rawResult = await sendBlockingRequest("tools/call", toolCallParams, signal);
					} else {
						rawResult = await sendRequest("tools/call", toolCallParams);
					}

					// openDiff special handling: write to disk on accept, close diff tab
					if (desc.mcpName === "openDiff") {
						const mcpResult = rawResult as McpToolResponse;
						const entries = mcpResult?.content;
						const status = entries?.[0]?.text;
						const tabName = params.tab_name as string;

						// Close the diff tab regardless of accept/reject
						try {
							await sendRequest("tools/call", { name: "close_tab", arguments: { tab_name: tabName } });
						} catch {
							// Best-effort close
						}

						if (status === "DIFF_REJECTED") {
							return {
								content: [{ type: "text", text: "Changes rejected by user in IDE diff view." }],
								isError: true,
								details: { tool: desc.piName, params, rawResult },
							};
						}

						// FILE_SAVED: write the proposed contents to disk
						const filePath = params.old_file_path as string;
						const finalContent = params.new_file_contents as string;
						await writeFile(filePath, finalContent, "utf-8");

						return {
							content: [{ type: "text", text: "Changes accepted and written to disk." }],
							details: { tool: desc.piName, params, rawResult },
						};
					}

					// Generic MCP response handling
					const mcpResult = rawResult as McpToolResponse;
					const content =
						mcpResult?.content?.map((c) => ({
							type: "text" as const,
							text: c.text,
						})) ?? [{ type: "text" as const, text: JSON.stringify(rawResult) }];

					return {
						content,
						details: { tool: desc.piName, params, rawResult },
					};
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Error: ${errorMsg}` }],
						isError: true,
						details: { tool: desc.piName, params, rawResult: null },
					};
				}
			},

			renderCall(args: Record<string, unknown>, theme: Theme) {
				let text = theme.fg("toolTitle", theme.bold(desc.piName));

				// Show key params based on tool type
				if (args.filePath) {
					text += " " + theme.fg("muted", String(args.filePath));
				} else if (args.old_file_path) {
					text += " " + theme.fg("muted", String(args.old_file_path));
				} else if (args.uri) {
					text += " " + theme.fg("muted", String(args.uri));
				} else if (args.tab_name) {
					text += " " + theme.fg("muted", String(args.tab_name));
				} else if (args.code) {
					const code = String(args.code);
					const preview = code.length > 50 ? code.slice(0, 47) + "..." : code;
					text += " " + theme.fg("dim", `"${preview}"`);
				}

				return new Text(text, 0, 0);
			},

			renderResult(result: IdeAgentToolResult<IdeToolDetails>, { expanded }, theme) {
				if (result.isError) {
					const errText = result.content[0];
					return new Text(
						theme.fg("error", errText?.type === "text" ? errText.text : "Error"),
						0,
						0,
					);
				}

				const details = result.details as IdeToolDetails | undefined;
				const firstContent = result.content[0];
				const text = firstContent?.type === "text" ? firstContent.text : "";

				if (!expanded) {
					// Compact view: truncate
					const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
					return new Text(
						theme.fg("success", "✓ ") + theme.fg("muted", preview.replace(/\n/g, "↵")),
						0,
						0,
					);
				}

				// Expanded view: full result
				let output = theme.fg("success", "✓ ") + theme.fg("muted", desc.piName);
				if (details?.params && Object.keys(details.params).length > 0) {
					output += "\n" + theme.fg("dim", JSON.stringify(details.params, null, 2));
				}
				output += "\n" + text;
				return new Text(output, 0, 0);
			},
		});
	}
}
