interface SubjectOnlyToggleProps {
  on: boolean;
  x: number;
  y: number;
  onToggle: () => void;
}

/** Canvas button: stretch only the lifted subject's pixels, or everything on the path. */
export function SubjectOnlyToggle({ on, x, y, onToggle }: SubjectOnlyToggleProps) {
  return (
    <g
      className={`rect-mode ${on ? 'on' : ''}`}
      transform={`translate(${x}, ${y})`}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
    >
      <title>{on
        ? 'Subject only — background the path crosses stays clear. Tap to stretch everything on the path'
        : 'Stretching everything on the path. Tap to stretch only the subject'}</title>
      <rect x={0} y={0} width={28} height={28} rx={7} />
      <g transform="translate(6, 5)" className="rect-mode-glyph">
        {/* A figure over a broken line: pixels read from the subject, gaps skipped. */}
        <circle cx={8} cy={3} r={2.5} />
        <path d="M8,6 V12 M4,9 H12" />
        <path d={on ? 'M0,17 H5 M11,17 H16' : 'M0,17 H16'} />
      </g>
    </g>
  );
}
