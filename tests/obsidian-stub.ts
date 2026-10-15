/** Minimal stand-in for the `obsidian` package in unit tests (the real one only exists inside the app). */
export const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export class TFile {}
export class TFolder {}
export class Notice {}
export class Modal {}
export class Setting {}
export class SuggestModal {}
