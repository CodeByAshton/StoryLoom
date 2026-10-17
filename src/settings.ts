import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { PROVIDERS, providerConfig, type ClientSettings, type ProviderConfig, type ProviderId } from "./llm/client";
import { claudeCodeStatus } from "./llm/claudeCodeNode";
import { ENTITY_TYPES, type EntityType } from "./codex/types";
import type MotifPlugin from "./main";
import type { SyncedLine } from "./codex/write";
import type { ChapterNotes } from "./notes/model";

export interface MotifSettings extends ClientSettings {
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
	/** One Motif ribbon button with a menu, or a button per view. */
	separateRibbonButtons: boolean;
	statusBar: boolean;
	/** Show the proposed codex changes for approval before a chapter sync writes them. */
	reviewStateChanges: boolean;
	/** Size of Motif's own text (panels, views, cards, pop-ups), relative to the default. */
	textSize: "small" | "default" | "large";
	/** A faint red underline for spelling notes; every other writing note stays gray. */
	redSpelling: boolean;
	/** Proofread the chapter (spelling, grammar, word choice, run-ons) when it's synced. */
	writingNotes: boolean;
	/** Chapter path -> the notes from its last proofread. */
	chapterNotes: Record<string, ChapterNotes>;
}

export const DEFAULT_SETTINGS: MotifSettings = {
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
	textSize: "default",
	redSpelling: true,
	chapterNotes: {},
};

export class MotifSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: MotifPlugin,
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
			keyDesc.appendText("Stored locally and unencrypted in this vault's .obsidian/plugins/motif/data.json. Don't sync or commit that file.");
			new Setting(containerEl)
				.setName("API key")
				.setDesc(keyDesc)
				.addText((t) => {
					t.inputEl.type = "password";
					t.setPlaceholder(PROVIDERS[s.provider].needsKey ? "sk-…" : "(none)")
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
						new Notice(`Motif: connected. The model replied “${out}”.`);
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

		new Setting(containerEl).setName("Sync and AI review").setHeading();
		this.toggleSetting("AI review", "Proofread each chapter when you sync it: spelling, grammar, word choice, run-on sentences and repetition. Hover a writing note to fix or dismiss it.", "writingNotes");
		this.toggleSetting("Remind me to sync", "When you leave a chapter you've changed since its last sync, offer to sync it.", "remindStateUpdate");
		this.toggleSetting("Review codex changes", "Approve each change before Sync chapter saves it to the codex. When off, changes are saved right away.", "reviewStateChanges");

		new Setting(containerEl).setName("Writing").setHeading();
		this.toggleSetting("Show the Ask AI button", "A small button appears above selections of three or more words.", "askAiButton");
		this.textSetting("Ask AI shortcut", "Opens Ask AI in the editor, e.g. Mod-k or Mod-Shift-e (Mod is Cmd on macOS, Ctrl elsewhere). Replaces Obsidian's Mod-k (insert link) in notes. Leave empty to turn off. Takes effect after reloading the plugin.", "inlineEditKey");
		new Setting(containerEl)
			.setName("Ask AI shortcuts")
			.setDesc("One-tap instructions shown in the Ask AI panel, one per line.")
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
		this.numberSetting("Continue length", "About how many words Continue writing adds.", "continueWords", 50, 3000);

		new Setting(containerEl).setName("Book").setHeading();
		this.textSetting("Manuscript folder", "Where your chapter notes live.", "manuscriptFolder");
		this.textSetting("Codex folder", "Where your characters, locations and lore live.", "codexFolder");
		this.toggleSetting("Hide the Codex folder", "Keep it out of the file explorer and browse it in the Codex view instead. The notes stay in your vault as plain Markdown.", "hideCodexFolder");
		this.textSetting("Templates folder", "Templates for new chapters, characters, locations and lore.", "templatesFolder");
		this.textSetting("Book note", "The note with your premise, style guide and voice sample.", "bookPath");

		new Setting(containerEl).setName("Appearance").setHeading();
		new Setting(containerEl)
			.setName("Text size")
			.setDesc("The size of Motif's text in its views, panels and pop-ups. Your chapters follow Obsidian's own font size.")
			.addDropdown((d) =>
				d
					.addOptions({ small: "Small", default: "Default", large: "Large" })
					.setValue(s.textSize)
					.onChange(async (v) => {
						s.textSize = v as MotifSettings["textSize"];
						await this.plugin.saveSettings();
					}),
			);
		this.toggleSetting("Red underline for spelling", "Spelling notes get a faint red underline. Other writing notes stay gray.", "redSpelling");
		this.toggleSetting("Underline codex names", "Underline character, location and lore names in chapters. Hover one to see it as of that chapter.", "highlightEntities");
		this.toggleSetting("Underline outside chapters", "Also underline codex names in notes that aren't chapters.", "highlightOutsideManuscript");
		this.toggleSetting("Status bar", "Show the current chapter, its writing notes and whether it needs syncing. Click it for chapter actions.", "statusBar");
		this.toggleSetting("Separate ribbon buttons", "A ribbon button for each view instead of one Motif button with a menu. Takes effect after reloading the plugin.", "separateRibbonButtons");
		new Setting(containerEl).setName("Graph colors").setDesc("Motif is black and white except where color carries information: the story graph uses these, and the timeline gives each place its own muted tone.");
		for (const type of ENTITY_TYPES) {
			new Setting(containerEl).setName(`${type.charAt(0).toUpperCase() + type.slice(1)}`).addColorPicker((c) =>
				c.setValue(s.entityColors[type]).onChange(async (v) => {
					s.entityColors[type] = v;
					await this.plugin.saveSettings();
				}),
			);
		}

		new Setting(containerEl).setName("Advanced").setHeading();
		this.numberSetting("Temperature", "0 to 1. Higher is more surprising. Newer Claude models ignore this.", "temperature", 0, 2, true);
		this.numberSetting("Max output tokens", "The longest answer the AI may give. Thinking models need headroom.", "maxTokens", 256, 64000);
		this.numberSetting("Context budget", "How many characters of book context go with each request.", "contextBudget", 4000, 2000000);
		this.toggleSetting("Stream responses", "Show text as it's written. Turns itself off for the session if a provider blocks it (e.g. a local server without CORS enabled).", "stream");
		this.toggleSetting("Save chats", "Keep Story assistant conversations in .motif/chats/.", "saveChats");
		this.toggleSetting("Show the prompt before sending", "Preview everything that will be sent to the AI before each request.", "showContextBeforeSending");
		this.toggleSetting("Debug mode", "Log context sizes and requests to the developer console.", "debug");
	}

	private claudeCodeSettings(containerEl: HTMLElement, cfg: ProviderConfig, update: (p: Partial<ProviderConfig>) => Promise<void>) {
		const info = containerEl.createDiv({ cls: "storyloom-provider-note" });
		info.createEl("p", {
			text: "Motif runs the Claude Code app installed on this computer, so requests use whatever Claude Code is signed in with, such as your Pro or Max subscription. Motif never sees or stores your Claude login. Usage counts toward your plan's limits.",
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

	private toggleSetting(name: string, desc: string, key: "highlightEntities" | "highlightOutsideManuscript" | "askAiButton" | "saveChats" | "showContextBeforeSending" | "debug" | "stream" | "remindStateUpdate" | "hideCodexFolder" | "separateRibbonButtons" | "statusBar" | "reviewStateChanges" | "writingNotes" | "redSpelling") {
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
