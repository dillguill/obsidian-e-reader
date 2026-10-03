// Noticing a long-press selection on a touchscreen.
//
// A long press selects a word while the finger is still down, and iOS then
// takes the gesture over: the page gets `touchcancel` rather than `touchend`,
// so a reader listening for the release never hears that a selection was
// made, and the selection bar waited for a second tap. This reports the press
// twice over — once when it has been held long enough to have selected
// something, and again if the platform cancels it — and the caller reads the
// selection back each time, so a press that selected nothing does no harm.

/** A little past the platforms' own long-press delay (about 500ms), so the word is already selected. */
const LONG_PRESS_MS = 650;

export function watchLongPress(target: Document | HTMLElement, signal: AbortSignal | undefined, onPress: () => void): void {
  const doc = "defaultView" in target ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  let timer: number | null = null;
  const clear = (): void => {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  };
  const options = { signal, passive: true };

  target.addEventListener(
    "touchstart",
    ((event: TouchEvent) => {
      clear();
      if (event.touches.length !== 1) return;
      timer = win.setTimeout(() => {
        timer = null;
        onPress();
      }, LONG_PRESS_MS);
    }) as EventListener,
    options,
  );
  // A finger that moves is scrolling, not holding.
  target.addEventListener("touchmove", clear, options);
  target.addEventListener("touchend", clear, options);
  target.addEventListener(
    "touchcancel",
    () => {
      clear();
      onPress();
    },
    options,
  );
  signal?.addEventListener("abort", clear);
}
