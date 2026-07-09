import { GameConfig } from "../config/GameConfig";
import {
  clampSensitivity,
  loadSettings,
  saveSettings,
  SENSITIVITY_MIN,
  SENSITIVITY_MAX,
} from "../config/Settings";

/**
 * Application-shell DOM overlays: the main MENU, the SURVIVED / DIED result
 * screens, and the "click to resume" overlay shown when pointer lock is lost
 * mid-round. Pure DOM in the #ui layer above the canvas — no THREE, no UI
 * framework — matching the existing HUD / RoundUI visual language (system-ui,
 * dark translucent panels).
 *
 * Screens is a dumb view: buttons fire the callbacks Game supplies, which drive
 * the AppFlow and (for Play / resume) request pointer lock from the click
 * gesture. The goal line and result prose come from the Objective's describe()
 * — no duplicated strings. The menu's sensitivity slider is the only stateful
 * control; it persists straight to Settings and is applied on entry to playing.
 */
export interface ScreenCallbacks {
  onPlay: () => void;
  /** Re-enter playing from a terminal (survived/died "play again"/"retry") OR
   *  from the pause overlay ("restart round") — one event, one teardown path. */
  onRestart: () => void;
  /** Return to the main menu (from a terminal or from the pause overlay). */
  onToMenu: () => void;
  onResume: () => void;
}

export interface ResultSummary {
  passesSurvived: number;
  passesTotal: number;
  timeSec: number;
}

const LEGEND = "WASD move · mouse look · Space jump · Shift sprint · C crouch · F flashlight · E hold on";

export class Screens {
  private readonly menu: HTMLDivElement;
  private readonly result: HTMLDivElement;
  private readonly resume: HTMLDivElement;
  private readonly resultHeading: HTMLHeadingElement;
  private readonly resultBody: HTMLParagraphElement;
  private readonly resultPrimary: HTMLButtonElement;
  private readonly resultPrimaryLabel: HTMLSpanElement;

  constructor(
    private readonly uiRoot: HTMLElement,
    cb: ScreenCallbacks,
    goalText: string,
  ) {
    injectStyles();

    // --- MENU ---------------------------------------------------------------
    this.menu = overlay("ts-screen ts-menu");
    const title = el("h1", "ts-title", "TORNADO SURVIVAL");
    const goal = el("p", "ts-goal", goalText);
    const play = button("PLAY", cb.onPlay, "ts-primary");
    const legend = el("p", "ts-legend", LEGEND);
    const sens = this.buildSensitivityRow();
    this.menu.append(title, goal, play, sens, legend);

    // --- RESULT (survived / died) ------------------------------------------
    this.result = overlay("ts-screen ts-result2");
    this.resultHeading = el("h1", "ts-result-h", "");
    this.resultBody = el("p", "ts-result-body", "");
    const goalEcho = el("p", "ts-goal", goalText);
    this.resultPrimary = button("", cb.onRestart, "ts-primary");
    this.resultPrimaryLabel = el("span", "", "");
    this.resultPrimary.replaceChildren(this.resultPrimaryLabel);
    // One primary button for both terminals: only its LABEL differs (Play again
    // vs Retry, set in showResult); the action is the single restart event.
    const menuBtn = button("MENU", cb.onToMenu, "ts-secondary");
    const btnRow = el("div", "ts-btn-row", "");
    btnRow.append(this.resultPrimary, menuBtn);
    this.result.append(this.resultHeading, this.resultBody, goalEcho, btnRow);

    // --- RESUME (pointer lock lost) ----------------------------------------
    this.resume = overlay("ts-screen ts-resume");
    const resumePanel = el("div", "ts-resume-panel", "");
    resumePanel.append(
      el("h2", "ts-resume-h", "PAUSED"),
      el("p", "ts-resume-p", "Click to resume"),
    );
    this.resume.append(resumePanel);
    // The whole overlay is the click target — clicking it re-requests lock.
    this.resume.onclick = cb.onResume;

    this.uiRoot.append(this.menu, this.result, this.resume);
    this.hideAll();
  }

  /** Show the main menu (all other screens hidden). */
  showMenu(): void {
    this.hideAll();
    this.menu.style.display = "flex";
  }

  /** Show the survived / died result screen with the round summary. */
  showResult(kind: "survived" | "died", summary: ResultSummary | null): void {
    this.hideAll();
    this.result.dataset.kind = kind;
    if (kind === "survived") {
      this.resultHeading.textContent = "YOU SURVIVED";
      this.resultHeading.style.color = "#9fc48f";
      this.resultPrimaryLabel.textContent = "PLAY AGAIN";
    } else {
      this.resultHeading.textContent = "YOU DIED";
      this.resultHeading.style.color = "#c0453a";
      this.resultPrimaryLabel.textContent = "RETRY";
    }
    this.resultBody.textContent = summary
      ? `Passes survived: ${summary.passesSurvived} of ${summary.passesTotal}` +
        ` · Time: ${summary.timeSec.toFixed(0)}s`
      : "";
    this.result.style.display = "flex";
  }

  /** Toggle the "click to resume" overlay (pointer lock lost while playing). */
  setResumeVisible(visible: boolean): void {
    this.resume.style.display = visible ? "flex" : "none";
  }

  /** Hide the menu + result screens (called on entry to playing). Leaves the
   *  resume overlay alone — Game drives that from the lock state. */
  hideAll(): void {
    this.menu.style.display = "none";
    this.result.style.display = "none";
  }

  /** The menu sensitivity slider, bound to persisted Settings. Its value is read
   *  at entry to playing (Game.buildSession) — changing it here just persists. */
  private buildSensitivityRow(): HTMLDivElement {
    const row = el("div", "ts-sens", "");
    const label = el("label", "ts-sens-label", "Mouse sensitivity");
    const value = el("span", "ts-sens-value", "");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "ts-slider";
    slider.min = String(SENSITIVITY_MIN);
    slider.max = String(SENSITIVITY_MAX);
    slider.step = "0.05";
    const initial = clampSensitivity(loadSettings().sensitivity);
    slider.value = String(initial);
    value.textContent = `${initial.toFixed(2)}×`;
    slider.addEventListener("input", () => {
      const v = clampSensitivity(parseFloat(slider.value));
      value.textContent = `${v.toFixed(2)}×`;
      saveSettings({ sensitivity: v });
    });
    const head = el("div", "ts-sens-head", "");
    head.append(label, value);
    row.append(head, slider);
    return row;
  }
}

// --- tiny DOM helpers -------------------------------------------------------

function overlay(className: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  d.style.display = "none";
  return d;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `ts-btn ${className}`;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const fade = GameConfig.shell.fadeDuration;
  const style = document.createElement("style");
  style.textContent = `
    .ts-screen {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 14px;
      background: rgba(5, 8, 5, .82); color: #cfd6c3;
      font: 15px system-ui; text-align: center;
      pointer-events: auto; animation: ts-fade ${fade}s ease-out;
    }
    @keyframes ts-fade { from { opacity: 0; } to { opacity: 1; } }
    .ts-title { font-size: 46px; letter-spacing: 6px; margin: 0; color: #e6ecdd; }
    .ts-result-h { font-size: 44px; letter-spacing: 4px; margin: 0; }
    .ts-goal { margin: 0; opacity: .75; max-width: 32em; }
    .ts-result-body { margin: 0; opacity: .9; }
    .ts-legend { margin: 6px 2px 0; opacity: .55; font-size: 12px; max-width: 40em; line-height: 1.6; }
    .ts-btn {
      font: 600 15px system-ui; letter-spacing: 2px; cursor: pointer;
      padding: 11px 30px; border-radius: 5px; color: #e6ecdd;
      border: 1px solid rgba(255,255,255,.2); background: rgba(60,74,60,.55);
      transition: background .12s, border-color .12s;
    }
    .ts-btn:hover { background: rgba(90,110,90,.7); border-color: rgba(255,255,255,.4); }
    .ts-primary { background: rgba(120,30,20,.75); border-color: rgba(210,120,90,.5); }
    .ts-primary:hover { background: rgba(150,45,30,.85); }
    .ts-btn-row { display: flex; gap: 14px; margin-top: 4px; }
    .ts-sens { display: flex; flex-direction: column; gap: 6px; width: 260px; margin-top: 4px; }
    .ts-sens-head { display: flex; justify-content: space-between; font-size: 12px; opacity: .8; }
    .ts-slider { width: 100%; accent-color: #6ab04c; cursor: pointer; }
    .ts-resume { background: rgba(5, 8, 5, .55); }
    .ts-resume-panel {
      background: rgba(0,0,0,.6); padding: 20px 34px; border-radius: 8px;
    }
    .ts-resume-h { margin: 0 0 6px; letter-spacing: 4px; font-size: 22px; color: #e6ecdd; }
    .ts-resume-p { margin: 0; opacity: .75; }
  `;
  document.head.appendChild(style);
}
