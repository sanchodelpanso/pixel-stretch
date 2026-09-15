import { useRef } from 'react';
import type { PointerEvent } from 'react';

const TAP_SLOP = 8;
const TAP_DURATION = 300;
const DOUBLE_TAP_INTERVAL = 350;

interface Tap {
  x: number;
  y: number;
  time: number;
  pointerId: number;
  pointerType: string;
}

/** Pointer events also recognize touch taps when dragging suppresses click events. */
export function useDoubleTap(onDoubleTap: () => void) {
  const down = useRef<Tap | null>(null);
  const previous = useRef<Tap | null>(null);

  const cancel = () => {
    down.current = null;
    previous.current = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) {
      cancel();
      return;
    }
    down.current = {
      x: event.clientX, y: event.clientY, time: event.timeStamp,
      pointerId: event.pointerId, pointerType: event.pointerType,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    const start = down.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP) cancel();
  };

  const onPointerUp = (event: PointerEvent) => {
    const start = down.current;
    down.current = null;
    if (!start || event.pointerId !== start.pointerId) return;
    if (event.timeStamp - start.time > TAP_DURATION
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP) {
      previous.current = null;
      return;
    }
    const last = previous.current;
    if (last && last.pointerType === start.pointerType
      && event.timeStamp - last.time <= DOUBLE_TAP_INTERVAL
      && Math.hypot(start.x - last.x, start.y - last.y) <= TAP_SLOP * 2) {
      previous.current = null;
      onDoubleTap();
    } else {
      previous.current = { ...start, time: event.timeStamp };
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: cancel };
}
