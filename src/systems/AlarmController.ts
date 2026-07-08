/**
 * Edge-triggered alarm gate.
 *
 * The siren must start/stop EXACTLY once per state transition — never
 * re-triggered every frame (which would restart-spam the WebAudio graph). This
 * tiny state machine takes the desired on/off each tick and fires onStart /
 * onStop only on the edge; a same-state tick is a no-op.
 *
 * Deliberately pure — no THREE, no WebAudio — so the "audible only when no
 * tornado is present" rule is one testable decision a terminating script can
 * drive through a synthetic state sequence and assert the edges on
 * (see scripts/verify-lightning.ts). The `starts`/`stops` counters back both
 * that assertion and the ?debug readout.
 */
export class AlarmController {
  private on = false;
  /** Transition counters (edge-triggering proof + debug readout). */
  starts = 0;
  stops = 0;

  constructor(
    private readonly onStart: () => void,
    private readonly onStop: () => void,
  ) {}

  /** Push the desired alarm state; fires a callback only when it changes. */
  set(desired: boolean): void {
    if (desired === this.on) return; // no edge — never re-trigger per frame
    this.on = desired;
    if (desired) {
      this.starts++;
      this.onStart();
    } else {
      this.stops++;
      this.onStop();
    }
  }

  get playing(): boolean {
    return this.on;
  }
}
