/**
 * Round messaging: the pulsing warning banner during the siren phase, and
 * the survived/died result screen with restart.
 */
export class RoundUI {
  /** Wired by Game; fired when the player clicks the result screen. */
  onRestart: (() => void) | null = null;

  private readonly banner: HTMLDivElement;
  private resultShown = false;
  private resultScreen: HTMLDivElement | null = null;

  constructor(private readonly uiRoot: HTMLElement) {
    injectStylesOnce();

    this.banner = document.createElement("div");
    this.banner.className = "ts-banner";
    this.banner.style.display = "none";
    uiRoot.appendChild(this.banner);
  }

  showWarning(secondsLeft: number): void {
    this.banner.style.display = "block";
    this.banner.textContent = `⚠ TORNADO WARNING — seek shelter (${Math.max(
      Math.ceil(secondsLeft),
      0,
    )})`;
  }

  hideWarning(): void {
    this.banner.style.display = "none";
  }

  /**
   * Live pass state during the active phase: incoming (a pass is bearing down)
   * vs receding / clear-for-now (the gap between passes — the near-miss
   * tension). Kept light: one banner line + a pass counter.
   */
  showPassState(
    phase: "incoming" | "receding" | "clear" | "done" | "idle",
    pass: number,
    total: number,
    funnelCount = 1,
  ): void {
    if (phase === "incoming") {
      this.banner.style.display = "block";
      this.banner.className = "ts-banner ts-incoming";
      // Announce twin funnels up front — funnelCount is the per-round roll
      // (decided in TornadoSystem.begin before this banner ever shows), so the
      // player learns it's a double from the banner, not from spotting funnel 2.
      const lead = funnelCount >= 2 ? "TWIN TORNADOES INCOMING" : "TORNADO INCOMING";
      this.banner.textContent = `⚠ ${lead} — pass ${pass} of ${total}`;
    } else if (phase === "receding") {
      this.banner.style.display = "block";
      this.banner.className = "ts-banner ts-clear";
      this.banner.textContent = "Tornado receding…";
    } else if (phase === "clear") {
      this.banner.style.display = "block";
      this.banner.className = "ts-banner ts-clear";
      this.banner.textContent =
        pass < total ? `Clear for now — is it circling back? (${pass}/${total})` : "";
      if (pass >= total) this.banner.style.display = "none";
    } else {
      this.banner.style.display = "none";
    }
  }

  showResult(kind: "survived" | "died"): void {
    if (this.resultShown) return;
    this.resultShown = true;
    document.exitPointerLock();

    const screen = document.createElement("div");
    screen.className = "ts-result";
    screen.innerHTML =
      kind === "survived"
        ? `<h1 style="color:#9fc48f">YOU SURVIVED</h1><p>The funnel has passed.</p>`
        : `<h1 style="color:#c0453a">YOU DIED</h1><p>The storm took you.</p>`;
    const hint = document.createElement("p");
    hint.textContent = "Click or press R to restart";
    hint.style.opacity = "0.7";
    screen.appendChild(hint);
    screen.addEventListener("click", () => this.onRestart?.());
    this.uiRoot.appendChild(screen);
    this.resultScreen = screen;
  }

  /** Remove the result overlay so an in-place restart starts clean. */
  hideResult(): void {
    this.resultScreen?.remove();
    this.resultScreen = null;
    this.resultShown = false;
  }
}

let stylesInjected = false;
function injectStylesOnce(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .ts-banner {
      position: absolute; top: 40px; left: 50%; transform: translateX(-50%);
      background: rgba(120, 30, 20, .8); color: #f2d9c9;
      font: bold 17px system-ui; letter-spacing: 1px;
      padding: 10px 26px; border-radius: 4px;
      animation: ts-pulse 1.2s ease-in-out infinite;
    }
    @keyframes ts-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
    /* Calm state between passes — muted, no pulse. */
    .ts-banner.ts-clear {
      background: rgba(38, 52, 44, .82); color: #b9c6b4;
      font-weight: 500; animation: none;
    }
    .ts-result {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 6px;
      background: rgba(5, 8, 5, .78); color: #cfd6c3;
      font: 15px system-ui; text-align: center;
      pointer-events: auto; cursor: pointer;
    }
    .ts-result h1 { font-size: 44px; letter-spacing: 4px; margin: 0 0 8px; }
    .ts-result p { margin: 2px; }
  `;
  document.head.appendChild(style);
}
