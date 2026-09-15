import type { SVGProps } from 'react';

interface CanvasHandleProps extends Omit<SVGProps<SVGGElement>, 'x' | 'y'> {
  x: number;
  y: number;
  shape?: 'corner' | 'edge' | 'rotate' | 'pivot';
  angle?: number;
  label: string;
}

/** Small visual handles with a 44px target for fingers. */
export function CanvasHandle({ x, y, shape = 'corner', angle = 0, label, className = '', ...events }: CanvasHandleProps) {
  return (
    <g {...events} className={`canvas-handle ${className}`} transform={`translate(${x}, ${y})`}>
      <title>{label}</title>
      <circle className="canvas-handle-hit" r={22} />
      {shape === 'edge' ? (
        <rect className="canvas-handle-grip" x={-9} y={-3.5} width={18} height={7} rx={3.5} transform={`rotate(${angle})`} />
      ) : (
        <circle className="canvas-handle-grip" r={shape === 'corner' ? 5.5 : 15} />
      )}
      {shape === 'rotate' && <path className="canvas-handle-glyph" d="M-6-2a6 6 0 0 1 10-3L6-3M6-7v4H2M6 2A6 6 0 0 1-4 5l-2-2m0 4V3h4" />}
      {shape === 'pivot' && <path className="canvas-handle-glyph" d="M-6 0H6M0-6V6" />}
    </g>
  );
}
