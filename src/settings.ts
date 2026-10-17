import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { PROVIDERS, providerConfig, type ClientSettings, type ProviderConfig, type ProviderId } from "./llm/client";
import { claudeCodeStatus } from "./llm/claudeCodeNode";
import { ENTITY_TYPES, type EntityType } from "./codex/types";
import type StoryloomPlugin from "./main";
import type { SyncedLine } from "./codex/write";
import type { ChapterNotes } from "./notes/model";

export interface StoryloomSettings extends ClientSettings {
	temperature: number;
	maxTokens: number;
	continueWords: number;
	contextBudget: number;
	manuscriptFolder: string;
	codexFolder: string;
	templatesFolder: string;
	bookPath: string;
	highlightEntities: boolean;
	highlightOutsideManuscript: boolean;
	entityColors: Record<EntityType, string>;
	debug: boolean;
	showContextBeforeSending: boolean;
	stream: boolean;
	hideCodexFolder: boolean;
	remindStateUpdate: boolean;
	inlineEditKey: string;
	askAiButton: boolean;
	quickChips: string[];
	instructionHistory: string[];
	saveChats: boolean;
	/** Chapter path -> prose hash at the last "Sync chapter", to flag chapters edited since. */
	stateSynced: Record<string, string>;
	/** Chapter path -> what its last sync wrote to the codex (undone and replaced on the next sync). */
	syncedLines: Record<string, SyncedLine[]>;
	/** The setup wizard has been shown. */
	onboarded: boolean;
	/** One Storyloom ribbon button with a menu, or a button per view. */
	separateRibbonButtons: boolean;
	statusBar: boolean;
	/** Show the proposed codex changes for approval before a chapter sync writes them. */
	reviewStateChanges: boolean;
	/** Proofread the chapter (spelling, grammar, word choice, run-ons) when it's synced. */
	writingNotes: boolean;
	/** Chapter path -> the notes from its last proofread. */
	chapterNotes: Record<string, ChapterNotes>;
}

export const DEFAULT_SETTINGS: StoryloomSettings = {
	provider: "anthropic",
	providers: {},
	effort: "medium",
	refusalFallback: true,
	temperature: 0.8,
	maxTokens: 8000,
	continueWords: 300,
	contextBudget: 60000,
	manuscriptFolder: "Manuscript",
	codexFolder: "Codex",
	templatesFolder: "Templates",
	bookPath: "Book.md",
	highlightEntities: true,
	highlightOutsideManuscript: false,
	entityColors: {
		character: "#d9822b",
		location: "#2f9e8f",
		lore: "#8a63d2",
		item: "#c4a000",
		faction: "#d0466b",
	},
	debug: false,
	showContextBeforeSending: false,
	stream: true,
	hideCodexFolder: true,
	remindStateUpdate: true,
	inlineEditKey: "Mod-k",
	askAiButton: true,
	quickChips: ["Tighter", "More vivid", "More tension", "Show, don't tell", "Fix grammar", "Continue"],
	instructionHistory: [],
	saveChats: false,
	stateSynced: {},
	syncedLines: {},
	onboarded: false,
	separateRibbonButtons: false,
	statusBar: true,
	reviewStateChanges: false,
	writingNotes: true,
	chapterNotes: {},
};

export class StoryloomSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: StoryloomPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Setup guide")
			.setDesc("Walks through connecting an AI and creating your book's folders and templates.")
			.addButton((b) => b.setButtonText("Open setup").onClick(() => this.plugin.openSetup()));

		new Setting(containerEl).setName("AI provider").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Your Claude subscription through Claude Code, an Anthropic API key, or any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio).")
			.addDropdown((d) => {
				for (const [id, p] of Object.entries(PROVIDERS)) d.addOption(id, p.name);
				d.setValue(s.provider).onChange(async (v) => {
					s.provider = v as ProviderId;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		const cfg = providerConfig(s);
		const update = async (patch: Partial<ProviderConfig>) => {
			s.providers[s.provider] = { ...providerConfig(s), ...patch };
			await this.plugin.saveSettings();
		};

		if (s.provider === "claudecode") this.claudeCodeSettings(containerEl, cfg, update);
		else {
			const keyDesc = document.createDocumentFragment();
			keyDesc.appendText(PROVIDERS[s.provider].needsKey ? "Required. " : "Optional for local servers. ");
			keyDesc.appendText("Stored locally and unencrypted in this vault's .obsidian/plugins/storyloom/data.json. Don't sync or commit that file.");
			new Setting(containerEl)
				.setName("API key")
				.setDesc(keyDesc)
				.addText((t) => {
					t.inputEl.type = "password";
					t.setPlaceholder(PROVIDERS[s.provider].needsKey ? "sk-..." : "(none)")
						.setValue(cfg.apiKey)
						.onChange((v) => update({ apiKey: v.trim() }));
				});
			if (s.provider !== "anthropic") {
				new Setting(containerEl)
					.setName("Base URL")
					.setDesc("The /v1 endpoint. Requests go to {base}/chat/completions.")
					.addText((t) => t.setPlaceholder(PROVIDERS[s.provider].defaults.baseUrl).setValue(cfg.baseUrl).onChange((v) => update({ baseUrl: v.trim() })));
			}
			new Setting(containerEl)
				.setName("Model")
				.addText((t) => t.setPlaceholder(PROVIDERS[s.provider].defaults.model).setValue(cfg.model).onChange((v) => update({ model: v.trim() || PROVIDERS[s.provider].defaults.model })));
		}

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Sends a tiny request with the settings above.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true).setButtonText("Testing…");
					try {
						const out = await this.plugin.testConnection();
						new Notice(`Storyloom: connected. The model replied “${out}”.`);
					} catch (e) {
						this.plugin.errorNotice(e);
					} finally {
						b.setDisabled(false).setButtonText("Test");
					}
				}),
			);

		if (s.provider === "anthropic" || s.provider === "claudecode") {
			new Setting(containerEl)
				.setName("Effort")
				.setDesc("How hard Claude 5.x thinks before writing. Lower is faster and cheaper. Ignored by older models.")
				.addDropdown((d) =>
					d
						.addOptions({ "": "Model default", low: "Low", medium: "Medium", high: "High" })
						.setValue(s.effort)
						.onChange(async (v) => {
							s.effort = v;
							await this.plugin.saveSettings();
						}),
				);
		}
		if (s.provider === "anthropic") {
			new Setting(containerEl)
				.setName("Refusal fallback")
				.setDesc("If Claude declines a passage (e.g. dark fiction), let the API retry on a fallback model automatically.")
				.addToggle((t) =>
					t.setValue(s.refusalFallback).onChange(async (v) => {
						s.refusalFallback = v;
						await this.plugin.saveSettings();
					}),
				);
		}

		this.numberSetting("Temperature", "0–1. Higher is more surprising. Newer Claude models ignore this.", "temperature", 0, 2, true);
		this.numberSetting("Max output tokens", "Upper bound per response. Thinking models need headroom.", "maxTokens", 256, 64000);
		this.numberSetting("Continue length (words)", "Target length for Continue writing.", "continueWords", 50, 3000);
		this.numberSetting("Context budget (characters)", "How much book context is sent with each request.", "contextBudget", 4000, 2000000);

		new Setting(containerEl).setName("Book").setHeading();
		this.textSetting("Manuscript folder", "Chapter notes live here.", "manuscriptFolder");
		this.textSetting("Codex folder", "Characters, locations and lore live under here.", "codexFolder");
		this.toggleSetting("Hide the Codex folder in the file explorer", "Browse it with the Codex button in the ribbon instead. The notes stay in your vault as plain Markdown.", "hideCodexFolder");
		this.textSetting("Templates folder", "Chapter, Character, Location and Lore templates.", "templatesFolder");
		this.textSetting("Book note", "Premise, style guide and ## Voice sample.", "bookPath");

		new Setting(containerEl).setName("Editor").setHeading();
		this.toggleSetting("Highlight entities", "Underline character, location and lore names in chapters.", "highlightEntities");
		this.toggleSetting("Highlight outside the manuscript", "Also highlight in non-chapter notes.", "highlightOutsideManuscript");
		this.toggleSetting("Show “Ask AI” button", "A small button near selections of three or more words.", "askAiButton");
		this.textSetting("Inline edit key", "Opens inline edit while you are in a note, e.g. Mod-k or Mod-Shift-e (Mod is Cmd on macOS, Ctrl elsewhere). Takes priority over Obsidian's own Mod-k (insert link) inside the editor. Leave empty to turn off. Reload the plugin after changing.", "inlineEditKey");

		new Setting(containerEl)
			.setName("Quick actions")
			.setDesc("Chips shown in the inline edit box, one per line.")
			.addTextArea((t) => {
				t.setValue(s.quickChips.join("\n")).onChange(async (v) => {
					s.quickChips = v
						.split("\n")
						.map((x) => x.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 6;
			});

		for (const type of ENTITY_TYPES) {
			new Setting(containerEl).setName(`Color: ${type}`).addColorPicker((c) =>
				c.setValue(s.entityColors[type]).onChange(async (v) => {
					s.entityColors[type] = v;
					await this.plugin.saveSettings();
				}),
			);
		}

		new Setting(containerEl).setName("Interface").setHeading();
		this.toggleSetting("Separate ribbon buttons", "Show a ribbon button for each view instead of one Storyloom button with a menu. Reload the plugin after changing.", "separateRibbonButtons");
		this.toggleSetting("Status bar", "Show the current chapter, its word count and whether its story state is up to date. Click it for chapter actions.", "statusBar");

		new Setting(containerEl).setName("Advanced").setHeading();
		this.toggleSetting("Remind me to sync", "When you leave a chapter you've edited since it was last synced, offer to sync it.", "remindStateUpdate");
		this.toggleSetting("AI review", "When you sync a chapter, also proofread it: spelling, grammar, words used with the wrong meaning, run-on sentences, repetition. Notes are underlined in the chapter; hover one to fix or dismiss it.", "writingNotes");
		this.toggleSetting("Review changes before syncing", "Off: Sync chapter writes what it finds straight to the codex (the chapters are the source of truth). On: approve each change first.", "reviewStateChanges");
		this.toggleSetting("Stream responses", "Show text as it's written. Turns itself off for the session if a provider blocks it (e.g. a local server without CORS enabled).", "stream");
		this.toggleSetting("Save chats", "Keep Story Assistant conversations in .storyloom/chats/.", "saveChats");
		this.toggleSetting("Show context before sending", "Preview the full prompt in a modal before each request.", "showContextBeforeSending");
		this.toggleSetting("Debug mode", "Log context sizes and requests to the developer console.", "debug");
	}

	private claudeCodeSettings(containerEl: HTMLElement, cfg: ProviderConfig, update: (p: Partial<ProviderConfig>) => Promise<void>) {
		const info = containerEl.createDiv({ cls: "storyloom-provider-note" });
		info.createEl("p", {
			text: "Storyloom runs the Claude Code app installed on this computer, so requests use whatever Claude Code is signed in with, such as your Pro or Max subscription. Storyloom never sees or stores your Claude login. Usage counts toward your plan's limits.",
		});
		info.createEl("p", {
			cls: "storyloom-muted",
			text: "Desktop only. Sign in once by running `claude` in a terminal. Anthropic's terms allow your own subscription for your own use of Claude Code; for anything shared with other people, use an API key.",
		});
		const status = new Setting(containerEl).setName("Sign-in").setDesc("Checks Claude Code's sign-in status (runs `claude auth status`).");
		status.addButton((b) =>
			b.setButtonText("Check").onClick(async () => {
				b.setDisabled(true).setButtonText("Checking…");
				this.plugin.llm(); // creates the desktop host on first use
				const r = await claudeCodeStatus(this.plugin.claudeHost ?? null, cfg.baseUrl || "claude");
				status.setDesc(r.message);
				status.descEl.toggleClass("mod-warning", !r.ok);
				b.setDisabled(false).setButtonText("Check");
			}),
		);
		new Setting(containerEl)
			.setName("Claude Code path")
			.setDesc("Leave empty to find it automatically. Otherwise the full path to the claude program.")
			.addText((t) => t.setPlaceholder("Auto-detect").setValue(cfg.baseUrl).onChange((v) => update({ baseUrl: v.trim() })));
		new Setting(containerEl)
			.setName("Model")
			.setDesc("A Claude Code model name: sonnet, opus or haiku (or a full model ID).")
			.addText((t) => t.setPlaceholder("sonnet").setValue(cfg.model).onChange((v) => update({ model: v.trim() || "sonnet" })));
	}

	private textSetting(name: string, desc: string, key: "manuscriptFolder" | "codexFolder" | "templatesFolder" | "bookPath" | "inlineEditKey") {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((t) =>
				t.setValue(this.plugin.settings[key]).onChange(async (v) => {
					this.plugin.settings[key] = v.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS[key];
					await this.plugin.saveSettings();
				}),
			);
	}

	private toggleSetting(name: string, desc: string, key: "highlightEntities" | "highlightOutsideManuscript" | "askAiButton" | "saveChats" | "showContextBeforeSending" | "debug" | "stream" | "remindStateUpdate" | "hideCodexFolder" | "separateRibbonButtons" | "statusBar" | "reviewStateChanges" | "writingNotes") {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((t) =>
				t.setValue(this.plugin.settings[key]).onChange(async (v) => {
					this.plugin.settings[key] = v;
					await this.plugin.saveSettings();
				}),
			);
	}

	private numberSetting(name: string, desc: string, key: "temperature" | "maxTokens" | "continueWords" | "contextBudget", min: number, max: number, float = false) {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(this.plugin.settings[key])).onChange(async (v) => {
					const n = float ? parseFloat(v) : parseInt(v, 10);
					if (!Number.isFinite(n)) return;
					this.plugin.settings[key] = Math.min(max, Math.max(min, n));
					await this.plugin.saveSettings();
				});
			});
	}
}
