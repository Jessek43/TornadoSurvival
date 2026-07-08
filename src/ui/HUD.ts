/**
 * In-game HTML overlay: health + stamina bars, a crosshair dot, and the
 * "click to play" prompt shown while the pointer isn't locked. Lives in the
 * #ui layer above the canvas (pointer-events disabled).
 */
export class HUD {
  private readonly healthFill: HTMLDivElement;
  private readonly staminaFill: HTMLDivElement;
  private readonly sprintFill: HTMLDivElement;
  private readonly prompt: HTMLDivElement;

  constructor(uiRoot: HTMLElement) {
    const bars = document.createElement("div");
    bars.style.cssText =
      "position:absolute;left:24px;bottom:24px;width:240px;" +
      "font:11px system-ui;color:rgba(255,255,255,.6);user-select:none;";
    uiRoot.appendChild(bars);
    this.healthFill = makeBar(bars, "HEALTH", "#a83a2e");
    this.staminaFill = makeBar(bars, "GRIP", "#c9a13b");
    this.sprintFill = makeBar(bars, "SPRINT", "#6ab04c");

    const crosshair = document.createElement("div");
    crosshair.style.cssText =
      "position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;" +
      "border-radius:50%;background:rgba(255,255,255,.55);";
    uiRoot.appendChild(crosshair);

    this.prompt = document.createElement("div");
    this.prompt.style.cssText =
      "position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);" +
      "background:rgba(0,0,0,.6);color:#cfd6c3;padding:14px 22px;border-radius:6px;" +
      "font:14px system-ui;text-align:center;line-height:1.7;";
    this.prompt.innerHTML =
      "<b>Click to play</b><br>WASD move · mouse look · Space jump<br>" +
      "Shift sprint · C crouch · F flashlight<br>" +
      "E hold on in wind · R restart";
    uiRoot.appendChild(this.prompt);
  }

  update(health: number, grip: number, sprint: number, showPrompt: boolean): void {
    this.healthFill.style.width = `${Math.max(health, 0)}%`;
    this.staminaFill.style.width = `${Math.max(grip, 0)}%`;
    this.sprintFill.style.width = `${Math.max(sprint, 0)}%`;
    this.prompt.style.display = showPrompt ? "block" : "none";
  }
}

function makeBar(parent: HTMLElement, label: string, color: string): HTMLDivElement {
  const caption = document.createElement("div");
  caption.textContent = label;
  caption.style.cssText = "margin-top:8px;letter-spacing:1px;";
  parent.appendChild(caption);

  const outer = document.createElement("div");
  outer.style.cssText =
    "height:9px;margin-top:3px;background:rgba(0,0,0,.55);" +
    "border:1px solid rgba(255,255,255,.15);border-radius:2px;overflow:hidden;";
  parent.appendChild(outer);

  const fill = document.createElement("div");
  fill.style.cssText = `height:100%;width:100%;background:${color};transition:width .15s;`;
  outer.appendChild(fill);
  return fill;
}
