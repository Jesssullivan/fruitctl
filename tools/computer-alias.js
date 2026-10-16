// SPDX-License-Identifier: MIT
// Computer-use alias layer. Agents trained on the Anthropic `computer` tool or
// the OpenAI `computer_call` action shapes can drive Fruitctl without learning
// `vnc_command`. Every alias call is translated into ordinary Fruitctl actions
// and executed as one bounded batch through the same session, deadline,
// ownership and D7 labelling as `action_queue`; it is not a second input path.
//
// A translation never invents behaviour the backend lacks. Each Fruitctl
// action a plan needs must be supported: the shipped baseline when capability
// metadata is unknown, otherwise exactly the advertised list. Anything else is
// refused before input with a typed `unsupported_action` error naming the alias
// action, so newer backend methods (mouse_down, key_down, zoom, ...) light up
// here as soon as a backend advertises them, with no alias change.

import { z } from 'zod';

export const COMPUTER_TOOL_NAME = 'computer';

// Fruitctl methods shipped by this MCP surface (the vnc_command enum). An older
// backend without capability metadata is assumed to support only these.
export const BASELINE_ACTIONS = Object.freeze(new Set([
  'screenshot', 'cursor_crop', 'diff_check', 'set_baseline',
  'mouse_click', 'mouse_double_click', 'mouse_move', 'hover', 'nudge',
  'mouse_drag', 'scroll', 'key_tap', 'key_combo', 'key_type', 'paste',
  'detect_elements', 'configure', 'get_timing', 'wait', 'health', 'shutdown',
]));

// Same bound as action_queue: one alias call stays a short, deadline-bounded batch.
export const MAX_ALIAS_STEPS = 20;
const MAX_COORDINATE = 0x7fffffff;
// OpenAI scroll deltas are pixels; Fruitctl scrolls in wheel ticks.
export const SCROLL_PIXELS_PER_TICK = 100;

export const ANTHROPIC_ACTIONS = Object.freeze([
  'screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'key', 'hold_key',
  'type', 'scroll', 'cursor_position', 'zoom', 'wait',
]);
export const OPENAI_ACTIONS = Object.freeze([
  'click', 'double_click', 'drag', 'keypress', 'type', 'scroll', 'move', 'screenshot', 'wait',
]);

export class ComputerAliasError extends Error {
  constructor(code, action, message) {
    super(message);
    this.code = code;
    this.action = action;
  }
}

const unsupported = (action, message) => new ComputerAliasError('unsupported_action', action,
  `Unsupported computer action ${action}: ${message}`);
const invalid = (action, message) => new ComputerAliasError('invalid_arguments', action,
  `Invalid arguments for computer action ${action}: ${message}`);

// ── Keys ────────────────────────────────────────────────────────────────────
// xdotool (Anthropic) and DOM-style (OpenAI) names → names KeySymbols.swift
// resolves. Modifiers keep their literal meaning: ctrl is Control, not Command;
// super/meta/win/cmd are Command, matching namedKeyToKeysym.
const KEY_NAMES = new Map(Object.entries({
  ctrl: 'ctrl', control: 'ctrl', control_l: 'ctrl', ctrl_l: 'ctrl', control_r: 'rctrl', ctrl_r: 'rctrl',
  shift: 'shift', shift_l: 'shift', shift_r: 'rshift',
  alt: 'alt', alt_l: 'alt', option: 'alt', opt: 'alt', alt_r: 'ralt', option_r: 'ralt',
  super: 'cmd', super_l: 'cmd', meta: 'cmd', meta_l: 'cmd', cmd: 'cmd', command: 'cmd',
  win: 'cmd', windows: 'cmd', os: 'cmd', super_r: 'rcmd', meta_r: 'rcmd', cmd_r: 'rcmd',
  return: 'return', enter: 'return', kp_enter: 'return', ret: 'return',
  escape: 'escape', esc: 'escape', tab: 'tab', space: 'space', spacebar: 'space',
  backspace: 'backspace', back_space: 'backspace', delete: 'delete', del: 'delete',
  insert: 'insert', ins: 'insert', home: 'home', end: 'end',
  page_up: 'pageup', pageup: 'pageup', prior: 'pageup', pgup: 'pageup',
  page_down: 'pagedown', pagedown: 'pagedown', next: 'pagedown', pgdn: 'pagedown',
  up: 'up', down: 'down', left: 'left', right: 'right',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  caps_lock: 'capslock', capslock: 'capslock', num_lock: 'numlock', numlock: 'numlock',
  scroll_lock: 'scrolllock', scrolllock: 'scrolllock', print: 'printscreen',
  printscreen: 'printscreen', pause: 'pause', break: 'pause', menu: 'menu', contextmenu: 'menu',
  // xdotool keysym names for punctuation resolve to their single characters.
  minus: '-', plus: '+', equal: '=', comma: ',', period: '.', slash: '/', backslash: '\\',
  semicolon: ';', colon: ':', apostrophe: "'", quotedbl: '"', grave: '`', asciitilde: '~',
  bracketleft: '[', bracketright: ']', braceleft: '{', braceright: '}', parenleft: '(',
  parenright: ')', less: '<', greater: '>', question: '?', exclam: '!', at: '@',
  numbersign: '#', dollar: '$', percent: '%', asciicircum: '^', ampersand: '&',
  asterisk: '*', underscore: '_', bar: '|',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `f${i + 1}`])),
}));

/** Translate one key name to Fruitctl key syntax, or throw unsupported_key. */
export function translateKey(name, action) {
  if (typeof name !== 'string' || !name.length) throw invalid(action, 'empty key name');
  const mapped = KEY_NAMES.get(name.toLowerCase());
  if (mapped) return mapped;
  // A single printable scalar resolves directly. Letters are lowercased so a
  // chord such as ["CTRL","A"] sends a plain a; use `type` for case-sensitive text.
  if ([...name].length === 1 && name.codePointAt(0) >= 0x20 && name.codePointAt(0) !== 0x7f) {
    return /^[A-Z]$/.test(name) ? name.toLowerCase() : name;
  }
  throw new ComputerAliasError('unsupported_key', action, `Unsupported key for computer action ${action}: ${name}`);
}

// "ctrl+shift+t" → ["ctrl","shift","t"]; a trailing "++" means the plus key.
function chordKeys(chord, action) {
  if (/[^+]\+$/.test(chord)) throw invalid(action, `malformed chord ${chord}`);
  const parts = chord.split(/\+(?=.)/);
  if (parts.length > 16 || parts.some(part => !part.length)) throw invalid(action, `malformed chord ${chord}`);
  return parts.map(part => translateKey(part, action));
}

function chordStep(keys) {
  return keys.length === 1 ? { action: 'key_tap', key: keys[0] } : { action: 'key_combo', keys };
}

// ── Argument checks ──────────────────────────────────────────────────────────

function coordinateValue(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_COORDINATE;
}

function point(value, action, field) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(coordinateValue)) {
    throw invalid(action, `${field} must be [x, y] non-negative integers`);
  }
  return { x: value[0], y: value[1] };
}

function xy(input, action) {
  if (!coordinateValue(input.x) || !coordinateValue(input.y)) {
    throw invalid(action, 'x and y must be non-negative integers');
  }
  return { x: input.x, y: input.y };
}

function text(value, action, field = 'text') {
  if (typeof value !== 'string' || !value.length) throw invalid(action, `${field} is required`);
  return value;
}

function secondsToMs(value, action, { min = 50 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(action, 'duration must be a number of seconds');
  const ms = Math.round(value * 1000);
  if (ms < min || ms > 10000) throw invalid(action, 'duration must be between 0.05 and 10 seconds');
  return ms;
}

// Anthropic click/scroll modifiers ("shift", "ctrl+shift") are held with
// key_down/key_up inside the same batch; the backend force-releases any hold
// still live at batch end or abort (D27).
const MODIFIER_ACTIONS = new Set(['left_click', 'right_click', 'middle_click', 'double_click',
  'triple_click', 'scroll']);

function withModifiers(steps, modifiers, action) {
  if (modifiers === undefined || modifiers === '') return steps;
  const keys = chordKeys(text(modifiers, action, 'text (modifiers)'), action);
  return [...keys.map(key => ({ action: 'key_down', key })), ...steps,
    ...keys.toReversed().map(key => ({ action: 'key_up', key }))];
}

// ── Anthropic computer tool ──────────────────────────────────────────────────

function anthropicSteps(input) {
  const action = input.action;
  const at = () => point(input.coordinate, action, 'coordinate');
  switch (action) {
    case 'screenshot': return [{ action: 'screenshot' }];
    case 'left_click': case 'right_click': case 'middle_click':
      return withModifiers([{ action: 'mouse_click', ...at(), button: action.split('_')[0] }], input.text, action);
    case 'double_click': return withModifiers([{ action: 'mouse_double_click', ...at() }], input.text, action);
    case 'triple_click': return withModifiers([{ action: 'mouse_triple_click', ...at() }], input.text, action);
    case 'mouse_move': return [{ action: 'mouse_move', ...at() }];
    case 'left_click_drag': {
      if (input.start_coordinate === undefined) throw invalid(action, 'start_coordinate is required');
      const from = point(input.start_coordinate, action, 'start_coordinate');
      const to = at();
      return [{ action: 'mouse_drag', x: from.x, y: from.y, toX: to.x, toY: to.y }];
    }
    case 'left_mouse_down': case 'left_mouse_up':
      // D27: a mouse hold lives within one batch and is force-released at its
      // end, so a press cannot wait for a later tool call to release it.
      throw unsupported(action, 'a mouse hold cannot span tool calls; use left_click_drag');
    case 'key': {
      const chords = text(input.text, action).trim().split(/\s+/);
      if (chords.length > MAX_ALIAS_STEPS) throw invalid(action, `at most ${MAX_ALIAS_STEPS} chords`);
      return chords.map(chord => chordStep(chordKeys(chord, action)));
    }
    case 'hold_key': {
      const keys = chordKeys(text(input.text, action), action);
      const ms = secondsToMs(input.duration, action);
      return [...keys.map(key => ({ action: 'key_down', key })), { action: 'wait', ms },
        ...keys.toReversed().map(key => ({ action: 'key_up', key }))];
    }
    case 'type': return [{ action: 'key_type', text: text(input.text, action) }];
    case 'scroll': {
      const direction = input.scroll_direction;
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw invalid(action, 'scroll_direction must be up, down, left or right');
      }
      const amount = input.scroll_amount ?? 3;
      if (!Number.isInteger(amount) || amount < 1 || amount > 20) {
        throw invalid(action, 'scroll_amount must be an integer from 1 to 20');
      }
      return withModifiers([{ action: 'scroll', ...at(), direction, amount }], input.text, action);
    }
    case 'cursor_position': return [{ action: 'cursor_position' }];
    case 'zoom': {
      const region = input.region;
      if (!Array.isArray(region) || region.length !== 4 || !region.every(coordinateValue) ||
          region[2] <= region[0] || region[3] <= region[1]) {
        throw invalid(action, 'region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0');
      }
      // Zoom must be a fresh capture of the region; it is never a crop of an
      // earlier screenshot, so only a backend zoom method can serve it.
      return [{ action: 'zoom', x: region[0], y: region[1], toX: region[2], toY: region[3] }];
    }
    case 'wait':
      return [input.duration === undefined ? { action: 'wait' } : { action: 'wait', ms: secondsToMs(input.duration, action) }];
    default:
      throw unsupported(String(action), 'not an Anthropic computer action');
  }
}

// ── OpenAI computer_call ─────────────────────────────────────────────────────

function openaiSteps(input) {
  const action = input.type;
  switch (action) {
    case 'screenshot': return [{ action: 'screenshot' }];
    case 'click': {
      const button = { left: 'left', right: 'right', wheel: 'middle', middle: 'middle' }[input.button ?? 'left'];
      if (!button) throw unsupported(action, `button ${input.button} does not exist; use left, right or wheel`);
      return [{ action: 'mouse_click', ...xy(input, action), button }];
    }
    case 'double_click': return [{ action: 'mouse_double_click', ...xy(input, action) }];
    case 'move': return [{ action: 'mouse_move', ...xy(input, action) }];
    case 'drag': {
      const path = input.path;
      if (!Array.isArray(path) || path.length < 2 || path.length > MAX_ALIAS_STEPS - 2) {
        throw invalid(action, `path must hold 2 to ${MAX_ALIAS_STEPS - 2} points`);
      }
      const points = path.map(entry => xy(entry ?? {}, action));
      if (points.length === 2) {
        return [{ action: 'mouse_drag', ...points[0], toX: points[1].x, toY: points[1].y }];
      }
      // A multi-point path needs a held button across moves, inside this batch.
      return [{ action: 'mouse_move', ...points[0] }, { action: 'mouse_down', ...points[0], button: 'left' },
        ...points.slice(1).map(p => ({ action: 'mouse_move', ...p })),
        { action: 'mouse_up', ...points.at(-1), button: 'left' }];
    }
    case 'keypress': {
      const keys = input.keys;
      if (!Array.isArray(keys) || !keys.length || keys.length > 16) throw invalid(action, 'keys must list 1 to 16 keys');
      return [chordStep(keys.map(key => translateKey(key, action)))];
    }
    case 'type': return [{ action: 'key_type', text: text(input.text, action) }];
    case 'scroll': {
      const at = xy(input, action);
      const steps = [];
      for (const [delta, positive, negative] of [[input.scroll_y ?? 0, 'down', 'up'], [input.scroll_x ?? 0, 'right', 'left']]) {
        if (typeof delta !== 'number' || !Number.isFinite(delta)) throw invalid(action, 'scroll_x and scroll_y must be numbers');
        if (delta === 0) continue;
        const amount = Math.min(20, Math.max(1, Math.round(Math.abs(delta) / SCROLL_PIXELS_PER_TICK)));
        steps.push({ action: 'scroll', ...at, direction: delta > 0 ? positive : negative, amount });
      }
      if (!steps.length) throw invalid(action, 'scroll_x or scroll_y must be nonzero');
      return steps;
    }
    case 'wait': return [{ action: 'wait' }];
    default:
      throw unsupported(String(action), 'not an OpenAI computer_call action');
  }
}

/**
 * Translate one alias call into a Fruitctl plan without executing anything.
 * Returns {shape, action, steps}; throws ComputerAliasError for refusals.
 */
export function translateComputerAction(input) {
  const raw = input?.action;
  let plan;
  if (typeof raw === 'string') {
    plan = { shape: 'anthropic', action: raw, steps: anthropicSteps(input) };
    // A refusal names what the caller asked for, including held modifiers.
    if (MODIFIER_ACTIONS.has(raw) && input.text) plan.label = `${raw} with modifiers`;
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.type === 'string') {
    plan = { shape: 'openai', action: raw.type, steps: openaiSteps(raw) };
    if (raw.type === 'drag' && plan.steps.length > 1) plan.label = 'drag with a multi-point path';
  } else {
    throw invalid('unknown', 'action must be an Anthropic action name or an OpenAI action object with type');
  }
  if (plan.steps.length > MAX_ALIAS_STEPS) throw invalid(plan.action, `translation exceeds ${MAX_ALIAS_STEPS} steps`);
  return plan;
}

/** Fruitctl methods a plan needs that are not in the shipped baseline. */
export function extendedActions(plan) {
  return [...new Set(plan.steps.map(step => step.action).filter(action => !BASELINE_ACTIONS.has(action)))];
}

/**
 * Admit a plan against capability metadata ({known, actions}) or refuse it
 * before any input. Unknown or missing metadata grants only the baseline.
 */
export function admitComputerPlan(plan, capabilities) {
  const supported = capabilities?.known === true
    ? new Set(capabilities.actions) : BASELINE_ACTIONS;
  const missing = [...new Set(plan.steps.map(step => step.action).filter(action => !supported.has(action)))];
  if (missing.length) {
    const error = unsupported(plan.label ?? plan.action, `backend does not advertise ${missing.join(', ')}`);
    error.action = plan.action;
    error.missing = missing;
    throw error;
  }
  return plan;
}

/** Stable `computer` MCP tool definition. Arguments are checked by translation
 * so every refusal is typed; the schema only describes the accepted shapes. */
export function computerTool() {
  return {
    name: COMPUTER_TOOL_NAME,
    description: [
      'Computer-use alias for the configured remote desktop, accepting Anthropic computer tool',
      'and OpenAI computer_call action shapes. Each call runs as one bounded Fruitctl batch.',
      'Coordinates use the current scaled display space returned by screenshot.',
      '',
      `Anthropic: action is a name (${ANTHROPIC_ACTIONS.join(', ')}) with`,
      '  coordinate [x,y], start_coordinate, text (keys, typed text or click modifiers),',
      '  scroll_direction, scroll_amount, duration (seconds) or region [x0,y0,x1,y1].',
      `OpenAI: action is an object {type: ${OPENAI_ACTIONS.join('|')}, ...}, e.g.`,
      '  {type:"click",button,x,y}, {type:"drag",path:[{x,y},...]}, {type:"keypress",keys:[...]},',
      '  {type:"scroll",x,y,scroll_x,scroll_y}.',
      '',
      'Actions the connected backend does not advertise fail with code unsupported_action.',
      'Results carry route and indicator labels. Verify input with a new screenshot.',
    ].join('\n'),
    inputSchema: {
      action: z.union([
        z.string().describe('Anthropic computer action name'),
        z.object({ type: z.string() }).passthrough().describe('OpenAI computer_call action object'),
      ]).describe('Anthropic action name, or OpenAI computer_call action object'),
      coordinate: z.array(z.number()).optional().describe('Anthropic [x, y] in the current scaled display'),
      start_coordinate: z.array(z.number()).optional().describe('Anthropic left_click_drag start [x, y]'),
      text: z.string().optional().describe('Keys (xdotool syntax), typed text, or click/scroll modifiers'),
      scroll_direction: z.string().optional().describe('Anthropic scroll direction: up, down, left or right'),
      scroll_amount: z.number().optional().describe('Anthropic scroll ticks (1-20, default 3)'),
      duration: z.number().optional().describe('Seconds for wait or hold_key (0.05-10)'),
      region: z.array(z.number()).optional().describe('Anthropic zoom region [x0, y0, x1, y1]'),
    },
  };
}
