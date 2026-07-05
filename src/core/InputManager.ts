/**
 * Input abstraction layer.
 *
 * Gameplay code reads the InputState snapshot returned by poll() and never
 * touches keyboard/mouse events directly. That keeps the seam for a future
 * touch implementation (Capacitor mobile port): a new source fills the same
 * InputState and no gameplay code changes.
 */

export interface InputState {
  /** Movement on the ground plane: x = strafe (right +), y = forward (+) / back (−). Normalized. */
  moveX: number;
  moveY: number;
  /** Mouse-look delta accumulated since the last poll (pixels). */
  lookX: number;
  lookY: number;
  /** True only on the frame the key went down (edge-triggered). */
  jumpPressed: boolean;
  /** True while the grip key is held. */
  gripHeld: boolean;
  /** True only on the frame restart was pressed. */
  restartPressed: boolean;
}

export class InputManager {
  private readonly keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private jumpQueued = false;
  private restartQueued = false;
  private pointerLocked = false;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "Space") this.jumpQueued = true;
      if (e.code === "KeyR") this.restartQueued = true;
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    // First-person mouse look needs pointer lock, and the browser only
    // grants it on a user gesture — so we request it when the canvas is
    // clicked.
    canvas.addEventListener("click", () => canvas.requestPointerLock());
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });

    // Alt-tab etc.: drop held keys so the player doesn't keep running.
    window.addEventListener("blur", () => this.keys.clear());
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /** Snapshot input for this frame; consumes accumulated deltas and edges. */
  poll(): InputState {
    const state: InputState = {
      moveX: (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
      moveY: (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0),
      lookX: this.lookX,
      lookY: this.lookY,
      jumpPressed: this.jumpQueued,
      gripHeld: this.keys.has("ShiftLeft") || this.keys.has("KeyE"),
      restartPressed: this.restartQueued,
    };

    // Normalize diagonals so W+D isn't faster than W alone.
    const len = Math.hypot(state.moveX, state.moveY);
    if (len > 1) {
      state.moveX /= len;
      state.moveY /= len;
    }

    this.lookX = 0;
    this.lookY = 0;
    this.jumpQueued = false;
    this.restartQueued = false;
    return state;
  }
}
