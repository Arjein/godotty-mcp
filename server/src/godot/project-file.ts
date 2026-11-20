import { JOY_AXIS_NAMES, JOY_BUTTON_NAMES, KEY_NAMES, MOUSE_BUTTON_NAMES } from './input-names.js';
import { getProp, parseSectionFile, type Section } from './section-file.js';
import { isCall, isDict, isObject, type GdObject, type GdValue } from './variant.js';

export interface Autoload {
  name: string;
  path: string;
  /** True when registered as a global singleton (`*` prefix in project.godot). */
  singleton: boolean;
}

export interface InputAction {
  name: string;
  deadzone: number | undefined;
  /** Human-readable bindings, e.g. "W (physical)", "Ctrl+S", "Mouse LEFT", "Joy LEFT_X-". */
  events: string[];
}

export interface ProjectSettings {
  name: string | undefined;
  description: string | undefined;
  mainScene: string | undefined;
  /** `config/features`, e.g. ["4.5", "GL Compatibility"]. */
  features: string[];
  renderer: string | undefined;
  autoloads: Autoload[];
  inputActions: InputAction[];
  /** res:// paths of enabled editor plugins' plugin.cfg files. */
  enabledPlugins: string[];
  /** Raw access to every section, for settings not modelled above. */
  sections: readonly Section[];
}

const SINGLETON_PREFIX = '*';

/** Parses project.godot text into the settings agents usually need. */
export function parseProjectFile(text: string): ProjectSettings {
  const sections = parseSectionFile(text);
  const section = (tag: string): Section | undefined => sections.find((s) => s.tag === tag);
  const application = section('application');
  return {
    name: asString(getProp(application, 'config/name')),
    description: asString(getProp(application, 'config/description')),
    mainScene: asString(getProp(application, 'run/main_scene')),
    features: stringArray(getProp(application, 'config/features')),
    renderer: asString(getProp(section('rendering'), 'renderer/rendering_method')),
    autoloads: parseAutoloads(section('autoload')),
    inputActions: parseInputActions(section('input')),
    enabledPlugins: stringArray(getProp(section('editor_plugins'), 'enabled')),
    sections,
  };
}

function parseAutoloads(section: Section | undefined): Autoload[] {
  return (section?.props ?? []).flatMap((prop) => {
    const value = asString(prop.value);
    if (value === undefined) return [];
    const singleton = value.startsWith(SINGLETON_PREFIX);
    return [{ name: prop.key, path: singleton ? value.slice(1) : value, singleton }];
  });
}

function parseInputActions(section: Section | undefined): InputAction[] {
  return (section?.props ?? []).map((prop) => {
    const dict = isDict(prop.value) ? prop.value.entries : {};
    const deadzone = dict.deadzone;
    const events = Array.isArray(dict.events) ? (dict.events as readonly GdValue[]) : [];
    return {
      name: prop.key,
      deadzone: typeof deadzone === 'number' ? deadzone : undefined,
      events: events.filter(isObject).map(describeInputEvent),
    };
  });
}

/** Renders one serialized InputEvent as a short binding label. */
export function describeInputEvent(event: GdObject): string {
  const p = event.props;
  switch (event.className) {
    case 'InputEventKey':
      return describeKey(p);
    case 'InputEventMouseButton':
      return `${modifiers(p)}Mouse ${enumName(MOUSE_BUTTON_NAMES, p.button_index)}`;
    case 'InputEventJoypadButton':
      return `Joy ${enumName(JOY_BUTTON_NAMES, p.button_index)}`;
    case 'InputEventJoypadMotion': {
      const sign = typeof p.axis_value === 'number' && p.axis_value < 0 ? '-' : '+';
      return `Joy ${enumName(JOY_AXIS_NAMES, p.axis)}${sign}`;
    }
    default:
      return event.className;
  }
}

function describeKey(p: Readonly<Record<string, GdValue>>): string {
  const physical = numberOr(p.physical_keycode, 0);
  const logical = numberOr(p.keycode, 0);
  const label = numberOr(p.key_label, 0);
  const code = physical !== 0 ? physical : logical !== 0 ? logical : label;
  const suffix = physical !== 0 ? ' (physical)' : '';
  return `${modifiers(p)}${enumName(KEY_NAMES, code)}${suffix}`;
}

const MODIFIERS: readonly [string, string][] = [
  ['ctrl_pressed', 'Ctrl'],
  ['shift_pressed', 'Shift'],
  ['alt_pressed', 'Alt'],
  ['meta_pressed', 'Meta'],
];

function modifiers(p: Readonly<Record<string, GdValue>>): string {
  return MODIFIERS.filter(([key]) => p[key] === true)
    .map(([, label]) => `${label}+`)
    .join('');
}

function enumName(table: ReadonlyMap<number, string>, value: GdValue | undefined): string {
  const n = numberOr(value, -1);
  return table.get(n) ?? `#${n}`;
}

function numberOr(value: GdValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function asString(value: GdValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Accepts `PackedStringArray("a", "b")` or a plain array of strings. */
function stringArray(value: GdValue | undefined): string[] {
  const items = isCall(value, 'PackedStringArray') ? value.args : Array.isArray(value) ? value : [];
  return (items as readonly GdValue[]).filter((v): v is string => typeof v === 'string');
}
