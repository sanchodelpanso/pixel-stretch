import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Capture workspace gestures before canvas tools see them. */
export function useWorkspacePan(onTouchStart: () => void, onPanStart: () => void) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [commandHeld, setCommandHeld] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number; target: Element }>());
  const gesture = useRef<{ x: number; y: number; origin: typeof offset } | null>(null);
  const suppress = useRef(false);
  const cancelling = useRef(false);

  useEffect(() => {
    const key = (event: KeyboardEvent) => setCommandHeld(event.metaKey);
    const blur = () => {
      setCommandHeld(false);
      setIsPanning(false);
      pointers.current.clear();
      gesture.current = null;
      suppress.current = false;
    };
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const center = () => {
    const points = [...pointers.current.values()];
    return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
  };
  const stop = (event: ReactPointerEvent) => { event.preventDefault(); event.stopPropagation(); };

  return {
    offset, isPanning, commandHeld,
    reset: () => setOffset({ x: 0, y: 0 }),
    handlers: {
      onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
        if (event.pointerType !== 'touch' && !(event.metaKey && event.button === 0)) return;
        if (!pointers.current.size) onTouchStart();
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, target: event.target as Element });
        if (event.pointerType === 'touch' && pointers.current.size < 2 && !suppress.current) return;
        stop(event);
        if (!suppress.current) {
          // Cancel a first finger's path/handle drag before taking over for panning.
          cancelling.current = true;
          for (const [id, point] of pointers.current) {
            if (id !== event.pointerId) point.target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: id, pointerType: event.pointerType }));
          }
          cancelling.current = false;
          onPanStart();
        }
        suppress.current = true;
        for (const id of pointers.current.keys()) event.currentTarget.setPointerCapture(id);
        gesture.current = { ...center(), origin: offset };
        setIsPanning(true);
      },
      onPointerMoveCapture(event: ReactPointerEvent<HTMLElement>) {
        const point = pointers.current.get(event.pointerId);
        if (point) { point.x = event.clientX; point.y = event.clientY; }
        if (!suppress.current) return;
        stop(event);
        if (!gesture.current) return;
        const current = center();
        setOffset({ x: gesture.current.origin.x + current.x - gesture.current.x,
          y: gesture.current.origin.y + current.y - gesture.current.y });
      },
      onPointerUpCapture(event: ReactPointerEvent<HTMLElement>) {
        pointers.current.delete(event.pointerId);
        if (!suppress.current) return;
        stop(event);
        // Remaining fingers cannot accidentally resume editing or jump the view.
        gesture.current = null;
        setIsPanning(false);
        if (!pointers.current.size) suppress.current = false;
      },
      onPointerCancelCapture(event: ReactPointerEvent<HTMLElement>) {
        if (cancelling.current) return;
        pointers.current.delete(event.pointerId);
        if (suppress.current) stop(event);
        gesture.current = null;
        setIsPanning(false);
        if (!pointers.current.size) suppress.current = false;
      },
    },
  };
}
