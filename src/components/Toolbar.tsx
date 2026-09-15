import type { EditorTool } from '../types/editor';
import { Icon, type IconName } from './Icon';
import './Toolbar.css';

interface ToolbarProps {
  tool: EditorTool;
  onToolChange: (tool: EditorTool) => void;
  /** Selection tools need a model, and are disabled while one is loading. */
  disabled: boolean;
  layersOpen: boolean;
  onLayersClick: () => void;
}

/** Tools that don't need a segmentation model and stay live while one loads. */
const MODEL_FREE: EditorTool[] = ['stretch'];

interface ToolSpec {
  id: EditorTool;
  label: string;
  hint: string;
  icon: IconName;
}

const TOOLS: ToolSpec[] = [
  {
    id: 'stretch',
    label: 'Stretch',
    hint: 'Draw a sample path; the main subject is lifted above the stretch automatically',
    icon: 'stretch',
  },
  {
    id: 'select-auto',
    label: 'Auto',
    hint: 'Detect the main subject of the active layer',
    icon: 'auto',
  },
  {
    id: 'select-tap',
    label: 'Tap',
    hint: 'Click the object to select it, Alt-click to exclude',
    icon: 'tap',
  },
];

export function Toolbar({ tool, onToolChange, disabled, layersOpen, onLayersClick }: ToolbarProps) {
  return (
    <nav className={`toolbar ${layersOpen ? 'panel-open' : ''}`} aria-label="Editing tools">
      {TOOLS.map((spec) => {
        const isDisabled = disabled && !MODEL_FREE.includes(spec.id);
        return (
          <button
            key={spec.id}
            className={`tool-btn ${tool === spec.id ? 'active' : ''}`}
            aria-pressed={tool === spec.id}
            title={`${spec.label} — ${spec.hint}`}
            disabled={isDisabled}
            onClick={() => onToolChange(spec.id)}
          >
            <span className="tool-icon"><Icon name={spec.icon} /></span>
            <span className="tool-label">{spec.label}</span>
          </button>
        );
      })}
      <button
        className={`tool-btn mobile-layers-button ${layersOpen ? 'active' : ''}`}
        aria-expanded={layersOpen}
        aria-controls="layers-and-properties"
        title="Layers and properties"
        onClick={onLayersClick}
      >
        <span className="tool-icon"><Icon name="layers" /></span>
        <span className="tool-label">Layers</span>
      </button>
    </nav>
  );
}
