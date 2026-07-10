/**
 * Boot-time DOM overlays — the loading gate, the capability-unsupported screen,
 * the global error overlay, and the graphics-context-lost message. Pure DOM +
 * CSS in its own layer above the canvas, matching the app-shell visual language
 * (system-ui, dark translucent panels) but WITHOUT importing THREE or Rapier, so
 * the unsupported screen can render on a machine that can't run the renderer.
 *
 * A dumb view driven by the boot wiring: BootFlow decides WHEN each screen
 * shows; this only knows HOW to draw them. One reused root element is mounted in
 * `document.body` (not the `#ui` layer, whose `pointer-events:none` would swallow
 * the reload button) and swapped between screens; `remove()` detaches it on the
 * handoff to the menu.
 */
import type { CapabilityReason } from "../boot/capabilities";

export class BootOverlay {
  private readonly root: HTMLDivElement;
  /** The mount parent, RETAINED for the process lifetime. `remove()` (at the
   *  handoff to the menu) detaches `root`, but a later error / context-loss
   *  screen must re-mount it — the boot overlay outlives the menu, because a
   *  fatal error can strike at any time after `ready`. */
  private readonly host: HTMLElement;
  private bar: HTMLDivElement | null = null;

  constructor(host: HTMLElement = document.body) {
    injectStyles();
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "ts-boot";
    host.appendChild(this.root);
  }

  /** Re-attach `root` if a prior `remove()` (the menu handoff) detached it, so a
   *  post-ready error / context-loss screen actually appears in the DOM. */
  private ensureMounted(): void {
    if (!this.root.isConnected) this.host.appendChild(this.root);
  }

  /** The loading gate. Progress is set separately from real awaited work. */
  showLoading(): void {
    this.ensureMounted();
    this.root.innerHTML = "";
    this.root.className = "ts-boot";
    const panel = div("ts-boot-panel");
    panel.append(
      el("h1", "ts-boot-title", "TORNADO SURVIVAL"),
      el("p", "ts-boot-sub", "Loading…"),
    );
    const track = div("ts-boot-track");
    this.bar = div("ts-boot-bar");
    track.append(this.bar);
    panel.append(track);
    this.root.append(panel);
    this.setProgress(0);
  }

  /** Drive the loading bar from resolved-task fraction (0..1). Never faked. */
  setProgress(fraction: number): void {
    if (this.bar) this.bar.style.width = `${Math.round(clamp01(fraction) * 100)}%`;
  }

  /** Terminal: the browser can't run the game. Copy is selected from the single
   *  primary `reason` (a lost graphics stack reads differently to a phone that
   *  simply lacks a mouse); the game never starts. Static — no renderer bundle
   *  needed to show it. */
  showUnsupported(reason: CapabilityReason): void {
    const panel = this.fill("ts-boot-error");
    if (reason === "pointerlock") {
      // Not a "your browser is broken" message — the game renders fine here, it
      // just can't be CONTROLLED without a mouse + pointer lock. No apology, no
      // "coming soon", no email capture; the ask is to open it on a desktop.
      panel.append(
        el("h1", "ts-boot-title", "Desktop only, for now"),
        el(
          "p",
          "ts-boot-sub",
          "Tornado Survival needs a mouse and keyboard — it uses pointer lock for mouse look, which this browser doesn't provide.",
        ),
        el(
          "p",
          "ts-boot-hint",
          "Open it on a laptop or desktop in Chrome, Edge, Firefox, or Safari.",
        ),
      );
      return;
    }
    const feature =
      reason === "webgl2"
        ? "WebGL2 (hardware-accelerated 3D graphics)"
        : "WebAssembly (the physics engine)";
    panel.append(
      el("h1", "ts-boot-title", "Can't run this browser"),
      el("p", "ts-boot-sub", "Tornado Survival needs a feature this browser or device doesn't provide:"),
    );
    const list = document.createElement("ul");
    list.className = "ts-boot-list";
    list.append(el("li", "", feature));
    panel.append(
      list,
      el(
        "p",
        "ts-boot-hint",
        "Try a current desktop version of Chrome, Edge, Firefox, or Safari with hardware acceleration enabled.",
      ),
    );
  }

  /**
   * The global error overlay. With `?debug` the stack is shown; otherwise a
   * short message and a reload button. Shown ONCE (BootFlow's error state is
   * idempotent); the render loop is cancelled by the wiring, not here.
   */
  showError(message: string, stack: string | null): void {
    const panel = this.fill("ts-boot-error");
    panel.append(
      el("h1", "ts-boot-title", "Something went wrong"),
      el("p", "ts-boot-sub", message),
    );
    if (stack) {
      const pre = document.createElement("pre");
      pre.className = "ts-boot-stack";
      pre.textContent = stack;
      panel.append(pre);
    }
    panel.append(this.reloadButton());
  }

  /** WebGL context loss — distinct message from a generic error (it's a DOM
   *  event, not an exception, and a reload is the fix). */
  showContextLost(): void {
    const panel = this.fill("ts-boot-error");
    panel.append(
      el("h1", "ts-boot-title", "Graphics context lost"),
      el(
        "p",
        "ts-boot-sub",
        "The GPU dropped this page's graphics context. Reload to restart the game.",
      ),
      this.reloadButton(),
    );
  }

  /** Handoff to the menu: detach the overlay entirely. */
  remove(): void {
    this.bar = null;
    this.root.remove();
  }

  private reloadButton(): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "ts-boot-btn";
    b.textContent = "Reload";
    b.addEventListener("click", () => location.reload());
    return b;
  }

  /** Reset the root to a single centered panel and return it for content. */
  private fill(panelClass: string): HTMLDivElement {
    this.ensureMounted();
    this.bar = null;
    this.root.innerHTML = "";
    this.root.className = "ts-boot";
    const panel = div(`ts-boot-panel ${panelClass}`);
    this.root.append(panel);
    return panel;
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .ts-boot {
      position: fixed; inset: 0; z-index: 2000;
      display: flex; align-items: center; justify-content: center;
      background: #0a0d0a; color: #e8f0e8;
      font-family: system-ui, sans-serif;
      padding: 24px; box-sizing: border-box;
    }
    .ts-boot-panel {
      max-width: 480px; width: 100%; text-align: center;
      background: rgba(12, 18, 12, 0.85);
      border: 1px solid rgba(120, 160, 120, 0.25);
      border-radius: 10px; padding: 32px 28px;
    }
    .ts-boot-title { margin: 0 0 8px; font-size: 22px; letter-spacing: 0.06em; }
    .ts-boot-sub { margin: 0 0 16px; font-size: 14px; opacity: 0.85; line-height: 1.5; }
    .ts-boot-hint { margin: 12px 0 0; font-size: 13px; opacity: 0.7; line-height: 1.5; }
    .ts-boot-list { text-align: left; margin: 0 auto 4px; padding-left: 22px; font-size: 14px; line-height: 1.6; }
    .ts-boot-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.12); overflow: hidden; margin-top: 6px; }
    .ts-boot-bar { height: 100%; width: 0%; background: #6cc66c; transition: width 120ms linear; }
    .ts-boot-error { border-color: rgba(200, 120, 120, 0.4); }
    .ts-boot-stack {
      text-align: left; margin: 12px 0 0; max-height: 40vh; overflow: auto;
      font: 11px/1.4 monospace; color: #ffb3b3;
      background: rgba(0,0,0,0.4); border-radius: 6px; padding: 10px; white-space: pre-wrap;
    }
    .ts-boot-btn {
      margin-top: 18px; padding: 10px 22px; font: 600 14px system-ui, sans-serif;
      color: #0a0d0a; background: #6cc66c; border: none; border-radius: 6px; cursor: pointer;
    }
    .ts-boot-btn:hover { background: #7fd67f; }
  `;
  document.head.appendChild(style);
}
