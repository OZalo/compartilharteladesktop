export interface GamepadButtonMapping {
  buttonA: number;
  buttonB: number;
  buttonX: number;
  buttonY: number;
  shoulderL: number;
  shoulderR: number;
  triggerL: number;
  triggerR: number;
  back: number;
  start: number;
  thumbL: number;
  thumbR: number;
  dpadUp: number;
  dpadDown: number;
  dpadLeft: number;
  dpadRight: number;
  guide: number;
}

export interface GamepadConfig {
  deadzoneLeft: number;
  deadzoneRight: number;
  invertYLeft: boolean;
  invertYRight: boolean;
  buttonMap: GamepadButtonMapping;
}

export const DEFAULT_GAMEPAD_CONFIG: GamepadConfig = {
  deadzoneLeft: 0.15,
  deadzoneRight: 0.15,
  invertYLeft: false,
  invertYRight: false,
  buttonMap: {
    buttonA: 0,
    buttonB: 1,
    buttonX: 2,
    buttonY: 3,
    shoulderL: 4,
    shoulderR: 5,
    triggerL: 6,
    triggerR: 7,
    back: 8,
    start: 9,
    thumbL: 10,
    thumbR: 11,
    dpadUp: 12,
    dpadDown: 13,
    dpadLeft: 14,
    dpadRight: 15,
    guide: 16,
  },
};

const STORAGE_KEY = "ss_gamepad_config";

export function loadGamepadConfig(): GamepadConfig {
  if (typeof window === "undefined") return DEFAULT_GAMEPAD_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_GAMEPAD_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      deadzoneLeft: typeof parsed.deadzoneLeft === "number" ? parsed.deadzoneLeft : DEFAULT_GAMEPAD_CONFIG.deadzoneLeft,
      deadzoneRight: typeof parsed.deadzoneRight === "number" ? parsed.deadzoneRight : DEFAULT_GAMEPAD_CONFIG.deadzoneRight,
      invertYLeft: Boolean(parsed.invertYLeft),
      invertYRight: Boolean(parsed.invertYRight),
      buttonMap: {
        ...DEFAULT_GAMEPAD_CONFIG.buttonMap,
        ...(parsed.buttonMap || {}),
      },
    };
  } catch {
    return DEFAULT_GAMEPAD_CONFIG;
  }
}

export function saveGamepadConfig(config: GamepadConfig): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

export interface VirtualGamepadState {
  buttonA: boolean;
  buttonB: boolean;
  buttonX: boolean;
  buttonY: boolean;
  shoulderL: boolean;
  shoulderR: boolean;
  thumbL: boolean;
  thumbR: boolean;
  start: boolean;
  back: boolean;
  guide: boolean;
  dpadUp: boolean;
  dpadDown: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;
  triggerL: number;
  triggerR: number;
  axisLeftX: number;
  axisLeftY: number;
  axisRightX: number;
  axisRightY: number;
}

function applyDeadzone(value: number, deadzone: number): number {
  if (Math.abs(value) < deadzone) return 0;
  // Normaliza o restante suavemente
  const sign = Math.sign(value);
  const normalized = (Math.abs(value) - deadzone) / (1 - deadzone);
  return Math.min(1, Math.max(-1, sign * normalized));
}

export function sampleGamepad(pad: Gamepad, config: GamepadConfig): VirtualGamepadState {
  const getBtn = (idx: number): boolean => {
    if (idx < 0 || idx >= pad.buttons.length) return false;
    const b = pad.buttons[idx];
    return typeof b === "object" ? b.pressed || b.value > 0.45 : false;
  };

  const getTrigger = (idx: number): number => {
    if (idx < 0 || idx >= pad.buttons.length) return 0;
    const b = pad.buttons[idx];
    return typeof b === "object" ? b.value : 0;
  };

  const bMap = config.buttonMap;

  // Analógicos padrão W3C:
  // axes[0] = Left stick X (-1 left, 1 right)
  // axes[1] = Left stick Y (-1 up, 1 down)
  // axes[2] = Right stick X
  // axes[3] = Right stick Y
  const rawLX = pad.axes[0] ?? 0;
  const rawLY = pad.axes[1] ?? 0;
  const rawRX = pad.axes[2] ?? 0;
  const rawRY = pad.axes[3] ?? 0;

  const leftX = applyDeadzone(rawLX, config.deadzoneLeft);
  let leftY = applyDeadzone(-rawLY, config.deadzoneLeft); // ViGEm usa 1.0 = Cima, -1.0 = Baixo
  if (config.invertYLeft) leftY = -leftY;

  const rightX = applyDeadzone(rawRX, config.deadzoneRight);
  let rightY = applyDeadzone(-rawRY, config.deadzoneRight);
  if (config.invertYRight) rightY = -rightY;

  return {
    buttonA: getBtn(bMap.buttonA),
    buttonB: getBtn(bMap.buttonB),
    buttonX: getBtn(bMap.buttonX),
    buttonY: getBtn(bMap.buttonY),
    shoulderL: getBtn(bMap.shoulderL),
    shoulderR: getBtn(bMap.shoulderR),
    thumbL: getBtn(bMap.thumbL),
    thumbR: getBtn(bMap.thumbR),
    start: getBtn(bMap.start),
    back: getBtn(bMap.back),
    guide: getBtn(bMap.guide),
    dpadUp: getBtn(bMap.dpadUp),
    dpadDown: getBtn(bMap.dpadDown),
    dpadLeft: getBtn(bMap.dpadLeft),
    dpadRight: getBtn(bMap.dpadRight),
    triggerL: Math.max(0, Math.min(1, getTrigger(bMap.triggerL))),
    triggerR: Math.max(0, Math.min(1, getTrigger(bMap.triggerR))),
    axisLeftX: leftX,
    axisLeftY: leftY,
    axisRightX: rightX,
    axisRightY: rightY,
  };
}

export function isGamepadStateDifferent(a: VirtualGamepadState | null, b: VirtualGamepadState): boolean {
  if (!a) return true;
  return (
    a.buttonA !== b.buttonA ||
    a.buttonB !== b.buttonB ||
    a.buttonX !== b.buttonX ||
    a.buttonY !== b.buttonY ||
    a.shoulderL !== b.shoulderL ||
    a.shoulderR !== b.shoulderR ||
    a.thumbL !== b.thumbL ||
    a.thumbR !== b.thumbR ||
    a.start !== b.start ||
    a.back !== b.back ||
    a.guide !== b.guide ||
    a.dpadUp !== b.dpadUp ||
    a.dpadDown !== b.dpadDown ||
    a.dpadLeft !== b.dpadLeft ||
    a.dpadRight !== b.dpadRight ||
    Math.abs(a.triggerL - b.triggerL) > 0.02 ||
    Math.abs(a.triggerR - b.triggerR) > 0.02 ||
    Math.abs(a.axisLeftX - b.axisLeftX) > 0.02 ||
    Math.abs(a.axisLeftY - b.axisLeftY) > 0.02 ||
    Math.abs(a.axisRightX - b.axisRightX) > 0.02 ||
    Math.abs(a.axisRightY - b.axisRightY) > 0.02
  );
}

